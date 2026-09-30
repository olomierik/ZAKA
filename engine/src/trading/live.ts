// Live trading: the bot wallet buys and sells coins in their Uniswap v4
// pools through Uniswap's own Universal Router (not ARCDEX's fee router, so
// the bot's trades stay out of the site's fee totals, leaderboards and
// feeds). The same exits as paper trading decide when; this does the trades.
//
//   buy   one transaction: the USDC goes in as msg.value and the router pays
//         the pool from it (SETTLE, payer: the router), the coins come to the
//         bot (TAKE_ALL, at least the minimum), and anything the pool didn't
//         take is swept back. On Arc the native balance is the USDC ERC-20
//         balance, so this works for pools quoted in either. No USDC
//         approval is ever given.
//   sell  the coin comes in through Permit2 (approved right after the buy,
//         so exits don't wait on approvals), the USDC goes to the bot
//         (TAKE_ALL, at least the minimum)
//
// Every transaction is simulated first, sent one at a time with its own
// nonce, and read back from its receipt: what the bot really paid and got,
// and the gas. The encodings follow the Universal Router 2.1.x releases on
// Arc, whose ExactInputSingleParams carries minHopPriceX36 (checked against
// real Arc transactions, 2026-09-30).

import { createPublicClient, createWalletClient, decodeErrorResult, defineChain, encodeAbiParameters, encodeFunctionData, fallback, http, maxUint256, parseAbi, type Address, type Hex, type Log, type TransactionReceipt } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { PoolInfo } from '../dex/pools'

export const ARC = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockTime: 500,
})
export const USDC20 = '0x3600000000000000000000000000000000000000' as Address
export const NATIVE = '0x0000000000000000000000000000000000000000' as Address
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Universal Router 2.1.2, then 2.1.1 (the one most Arc swaps go through); the first wired to the PoolManager is used. */
export const ROUTERS = ['0x8702463e73f74d0b6765aBceb314Ef07aCb92650', '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1'] as Address[]
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address
/** Arc logs every USDC movement, native or ERC-20, from this address (18 decimals). */
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// universal-router Commands.sol, v4-periphery Actions.sol
const CMD = { SWEEP: 0x04, V4_SWAP: 0x10 } as const
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const
/** ActionConstants.OPEN_DELTA: settle whatever is owed. */
const OPEN_DELTA = 0n

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

const KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
const EXACT_IN_SINGLE = [{ type: 'tuple', components: [
  { name: 'poolKey', type: 'tuple', components: KEY },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' },
  { name: 'minHopPriceX36', type: 'uint256' },
  { name: 'hookData', type: 'bytes' },
] }] as const
const ACTIONS_INPUT = [{ type: 'bytes' }, { type: 'bytes[]' }] as const

const UR_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function poolManager() view returns (address)',
])
const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}, { name: 'poolManager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])
const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])
const MAX_UINT160 = (1n << 160n) - 1n
/** Common revert shapes, to name a failure in words. */
const ERRORS_ABI = parseAbi([
  'error Error(string)', 'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)', 'error DeadlinePassed(uint256 deadline)',
  // V4Quoter: it wraps what the pool said; NotEnoughLiquidity when the pool can't take the whole amount
  'error UnexpectedRevertBytes(bytes revertData)', 'error NotEnoughLiquidity(bytes32 poolId)',
])

// ── pools ─────────────────────────────────────────────────────────────

/** The v4 pool key, when the engine knows the whole key. */
export function keyOf(pool: PoolInfo | null): PoolKey | null {
  if (!pool || pool.dex !== 'uniswap-v4' || pool.tickSpacing === null) return null
  return { currency0: pool.currency0 as Address, currency1: pool.currency1 as Address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: (pool.hooks ?? NATIVE) as Address }
}

/** The pool's USDC side (ERC-20 or native) when the other side is `token`; null if the bot can't trade it. */
export function usdcSide(key: PoolKey, token: string): Address | null {
  const c0 = key.currency0.toLowerCase(), c1 = key.currency1.toLowerCase(), t = token.toLowerCase()
  const usdc = (a: string) => a === USDC20 || a === NATIVE
  if (c1 === t && usdc(c0)) return key.currency0
  if (c0 === t && usdc(c1)) return key.currency1
  return null
}

/** USD (as a decimal) in the units of the pool's USDC side: 6 decimals for the ERC-20, 18 for native. */
export function usdcUnits(usdc: Address, usd: number): bigint {
  const micro = BigInt(Math.round(usd * 1e6))
  return usdc.toLowerCase() === NATIVE ? micro * 10n ** 12n : micro
}

// ── encoders (pure) ──────────────────────────────────────────────────

const bytes = (list: number[]) => ('0x' + list.map(c => c.toString(16).padStart(2, '0')).join('')) as Hex
const swapParams = (key: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint) =>
  encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' }])
const executeData = (commands: Hex, inputs: Hex[], deadline: bigint) => encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [commands, inputs, deadline] })

export interface Call { to: Address; data: Hex; value: bigint }

/** Buy `token` with `amountIn` of the pool's USDC (its own units), at least `minOut` back, sent as msg.value. */
export function encodeBuy(router: Address, key: PoolKey, token: Address, usdc: Address, amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint): Call {
  const native = usdc.toLowerCase() === NATIVE
  const zeroForOne = key.currency0.toLowerCase() === usdc.toLowerCase()
  // Native pools: as the site's buys (SETTLE_ALL native from msg.value). ERC-20 USDC
  // pools: the router pays from the USDC msg.value gave it (SETTLE, payer: router).
  const settle = native
    ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [NATIVE, amountIn])
    : encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [usdc, OPEN_DELTA, false])
  const v4 = encodeAbiParameters(ACTIONS_INPUT, [bytes([ACT.SWAP_EXACT_IN_SINGLE, native ? ACT.SETTLE_ALL : ACT.SETTLE, ACT.TAKE_ALL]), [
    swapParams(key, zeroForOne, amountIn, minOut),
    settle,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, minOut]),
  ]])
  const sweep = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [native ? NATIVE : usdc, recipient, 0n])
  return { to: router, data: executeData(bytes([CMD.V4_SWAP, CMD.SWEEP]), [v4, sweep], deadline), value: native ? amountIn : amountIn * 10n ** 12n }
}

/** Sell `tokensIn` of `token` (through Permit2) for at least `minOut` of the pool's USDC, to the caller. */
export function encodeSell(router: Address, key: PoolKey, token: Address, usdc: Address, tokensIn: bigint, minOut: bigint, deadline: bigint): Call {
  const zeroForOne = key.currency0.toLowerCase() === token.toLowerCase()
  const v4 = encodeAbiParameters(ACTIONS_INPUT, [bytes([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]), [
    swapParams(key, zeroForOne, tokensIn, minOut),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, tokensIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [usdc, minOut]),
  ]])
  return { to: router, data: executeData(bytes([CMD.V4_SWAP]), [v4], deadline), value: 0n }
}

/** `quote` less `slippageBps`. */
export const minOutOf = (quote: bigint, slippageBps: number) => (quote * BigInt(10_000 - Math.min(9_900, Math.max(0, Math.round(slippageBps))))) / 10_000n

// ── receipts (pure) ──────────────────────────────────────────────────

type RLog = Pick<Log, 'address' | 'topics' | 'data'>
const topicAddr = (t: string | undefined) => (t ? '0x' + t.slice(26) : '').toLowerCase()

/** What a transaction moved for `wallet`: net tokens of `token` in, and net USDC in (18 decimals; negative = paid). */
export function deltasOf(logs: RLog[], wallet: string, token: string): { tokens: bigint; usdc18: bigint } {
  const w = wallet.toLowerCase(), t = token.toLowerCase()
  let tokens = 0n, usdc18 = 0n
  for (const l of logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length < 3) continue
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), amt = BigInt(l.data)
    const sign = (to === w ? 1n : 0n) - (from === w ? 1n : 0n)
    if (sign === 0n) continue
    const a = l.address.toLowerCase()
    if (a === t) tokens += sign * amt
    else if (a === NATIVE_LOGGER) usdc18 += sign * amt // native and ERC-20 USDC alike (the ERC-20's own log would count it twice)
  }
  return { tokens, usdc18 }
}

export const gasUsdOf = (r: Pick<TransactionReceipt, 'gasUsed' | 'effectiveGasPrice'>) => Number(r.gasUsed * r.effectiveGasPrice) / 1e18
export const usdOf18 = (x: bigint) => Number(x) / 1e18

// ── the executor ─────────────────────────────────────────────────────

export class LiveError extends Error { constructor(msg: string, readonly hash?: Hex) { super(msg) } }

export interface Fill { hash: Hex; tokens: bigint; usd: number; gasUsd: number; at: number }

export interface LiveOptions {
  privateKey: Hex
  /** Reads (simulations, quotes, receipts): the first answering. */
  readUrls: string[]
  /** Transactions go to one endpoint only: a fallback could send one twice. */
  sendUrl: string
}

export class LiveExecutor {
  readonly address: Address
  private account: PrivateKeyAccount
  private reader
  private wallet
  private router: Address | null = null
  private nonce: number | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(o: LiveOptions) {
    this.account = privateKeyToAccount(o.privateKey)
    this.address = this.account.address
    this.reader = createPublicClient({ chain: ARC, transport: fallback(o.readUrls.map(u => http(u, { timeout: 10_000 }))) })
    this.wallet = createWalletClient({ account: this.account, chain: ARC, transport: http(o.sendUrl, { timeout: 15_000 }) })
  }

  /** The Universal Router wired to Arc's PoolManager, and a quoter that answers for it. */
  async ready(): Promise<Address> {
    if (this.router) return this.router
    for (const r of ROUTERS) {
      const pm = await this.reader.readContract({ address: r, abi: UR_ABI, functionName: 'poolManager' }).catch(() => null)
      if (pm?.toLowerCase() === POOL_MANAGER) { this.router = r; break }
    }
    if (!this.router) throw new LiveError('no Universal Router on Arc answers for the v4 PoolManager')
    const qpm = await this.reader.readContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'poolManager' }).catch(() => null)
    if (qpm?.toLowerCase() !== POOL_MANAGER) throw new LiveError('the Uniswap quoter is unavailable')
    return this.router
  }

  /** The wallet's USDC (native balance, which is also its ERC-20 USDC). */
  async balanceUsd(): Promise<number> {
    return usdOf18(await this.reader.getBalance({ address: this.address }))
  }

  async quote(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
    const { result } = await this.reader.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }] })
    return result[0]
  }

  /** Buy `token` for `usd` of USDC in `pool`, accepting `slippageBps` less than quoted. */
  async buy(pool: PoolInfo, token: Address, usd: number, slippageBps: number): Promise<Fill> {
    const router = await this.ready()
    const key = keyOf(pool), usdc = key && usdcSide(key, token)
    if (!key || !usdc) throw new LiveError('not a v4 pool against USDC')
    const amountIn = usdcUnits(usdc, usd)
    const quoted = await this.quote(key, key.currency0.toLowerCase() === usdc.toLowerCase(), amountIn)
    if (quoted === 0n) throw new LiveError('the pool quotes nothing for this buy')
    const call = encodeBuy(router, key, token, usdc, amountIn, minOutOf(quoted, slippageBps), this.address, this.deadline())
    const r = await this.send(call, 'buy')
    const d = deltasOf(r.logs, this.address, token)
    if (d.tokens <= 0n) throw new LiveError('the buy went through but no coins arrived', r.transactionHash)
    // What left the wallet (the swept remainder came back), or what was sent if the logs didn't say.
    const paid = d.usdc18 < 0n ? -d.usdc18 : amountIn * (usdc.toLowerCase() === NATIVE ? 1n : 10n ** 12n)
    return { hash: r.transactionHash, tokens: d.tokens, usd: usdOf18(paid), gasUsd: gasUsdOf(r), at: Date.now() }
  }

  /** Lets the router take `token` through Permit2 (once per coin), so selling needs no approval later. */
  async approveForSale(token: Address): Promise<Fill[]> {
    const router = await this.ready()
    const out: Fill[] = []
    const erc = await this.reader.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [this.address, PERMIT2] })
    if (erc < maxUint256 / 2n) {
      const r = await this.send({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] }), value: 0n }, 'approve')
      out.push({ hash: r.transactionHash, tokens: 0n, usd: 0, gasUsd: gasUsdOf(r), at: Date.now() })
    }
    const [amount, expiration] = await this.reader.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [this.address, token, router] })
    if (amount < MAX_UINT160 / 2n || expiration < Math.floor(Date.now() / 1000) + 86_400) {
      const until = Math.floor(Date.now() / 1000) + 30 * 86_400
      const r = await this.send({ to: PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, MAX_UINT160, until] }), value: 0n }, 'approve')
      out.push({ hash: r.transactionHash, tokens: 0n, usd: 0, gasUsd: gasUsdOf(r), at: Date.now() })
    }
    return out
  }

  /** The wallet's balance of `token`, in its smallest unit. */
  async tokenBalance(token: Address): Promise<bigint> {
    return this.reader.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address] })
  }

  /** Sell `amount` of `token` in `pool`, accepting `slippageBps` less than quoted. */
  async sell(pool: PoolInfo, token: Address, amount: bigint, slippageBps: number): Promise<Fill> {
    const router = await this.ready()
    const key = keyOf(pool), usdc = key && usdcSide(key, token)
    if (!key || !usdc) throw new LiveError('not a v4 pool against USDC')
    if (amount <= 0n) throw new LiveError('nothing to sell')
    const quoted = await this.quote(key, key.currency0.toLowerCase() === token.toLowerCase(), amount).catch(() => 0n)
    const call = encodeSell(router, key, token, usdc, amount, minOutOf(quoted, slippageBps), this.deadline())
    const r = await this.send(call, 'sell')
    const d = deltasOf(r.logs, this.address, token)
    return { hash: r.transactionHash, tokens: -d.tokens, usd: usdOf18(d.usdc18 > 0n ? d.usdc18 : 0n), gasUsd: gasUsdOf(r), at: Date.now() }
  }

  /** Sends `usd` of USDC (native) to `to`: a fee on a winning trade, a withdrawal. */
  async sendUsdc(to: Address, usd: number): Promise<Fill> {
    if (!(usd > 0)) throw new LiveError('nothing to send')
    const r = await this.send({ to, data: '0x', value: BigInt(Math.round(usd * 1e6)) * 10n ** 12n }, 'transfer')
    return { hash: r.transactionHash, tokens: 0n, usd, gasUsd: gasUsdOf(r), at: Date.now() }
  }

  private deadline() { return BigInt(Math.floor(Date.now() / 1000) + 120) }

  /** One transaction at a time: simulated (retried briefly: a lagging node may not see the last approval yet), sent with the next nonce, confirmed. */
  private send(call: Call, label: string): Promise<TransactionReceipt> {
    const run = async () => {
      let lastErr: unknown = null
      for (let i = 0; i < 4; i++) {
        try { await this.reader.call({ account: this.address, to: call.to, data: call.data, value: call.value }); lastErr = null; break }
        catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600)) }
      }
      if (lastErr) throw new LiveError(`${label} would fail: ${reason(lastErr)}`)
      const pending = await this.reader.getTransactionCount({ address: this.address, blockTag: 'pending' })
      const nonce = Math.max(pending, this.nonce ?? 0)
      const hash = await this.wallet.sendTransaction({ to: call.to, data: call.data, value: call.value, nonce })
      this.nonce = nonce + 1
      const r = await this.reader.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 90_000 })
      if (r.status !== 'success') throw new LiveError(`${label} reverted on-chain`, hash)
      return r
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}

/** A failure in words: the revert reason when there is one. */
export function reason(e: unknown): string {
  const raw = (e as { raw?: Hex; cause?: { raw?: Hex; data?: Hex }; data?: Hex })
  let data = raw?.raw ?? raw?.cause?.raw ?? raw?.cause?.data ?? raw?.data
  // viem nests the node's error: find the revert data wherever it is
  if (!data && e && typeof e === 'object' && 'walk' in e) data = ((e as { walk: (f: (x: unknown) => boolean) => unknown }).walk(x => typeof (x as { data?: unknown })?.data === 'string') as { data?: Hex } | null)?.data
  for (let depth = 0; data && data.length >= 10 && depth < 3; depth++) {
    try {
      const d = decodeErrorResult({ abi: ERRORS_ABI, data })
      if (d.errorName === 'UnexpectedRevertBytes') { data = d.args[0] as Hex; continue }
      if (d.errorName === 'NotEnoughLiquidity') return 'not enough liquidity in the pool for this size'
      return d.errorName === 'Error' ? String(d.args?.[0]) : d.errorName
    } catch { return `reverted ${data.slice(0, 10)}` }
  }
  const m = (e as Error)?.message ?? String(e)
  return (m.split('\n').find(l => l.trim()) ?? m).slice(0, 160)
}
