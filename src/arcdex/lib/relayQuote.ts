// Quotes for trading Solana and BNB Chain coins through Relay (https://api.relay.link, 2026-10-04), and the checks every
// quote must pass before anything is signed. No wallet code here (lib/relay.ts sends), so the checks run offline in
// scripts/test-solana.ts and scripts/test-bsc.ts.
//
// Solana (`chain: 'solana'`):
//  • buy:  USDC on Arc → the coin on Solana, delivered to the buyer's Solana address. Signed on Arc (USDC pays the
//          gas): an approval of exactly the amount to Relay's depository, then its depositErc20. Relay's solver delivers
//          the coin in about a second and pays Solana's fees, the coin's token account included: no SOL needed.
//  • sell: the coin on Solana → USDC on Arc. Signed on Solana by the wallet holding it (a few cents of SOL in fees):
//          Relay's instructions swap it (DFlow or Jupiter) and deposit the USDC with Relay, which pays it out on Arc.
//  • gas:  a little USDC on Arc → SOL on Solana, for selling later.
//  • swap: on Solana alone, signed by the Solana wallet (2026-10-05, owner: "users with Solana wallets can't buy"): SOL
//          or USDC on Solana → the coin, or the coin → SOL or USDC. No Arc wallet needed.
// BNB Chain (`chain: 'bsc'`, 2026-10-05), at the trader's same EVM address:
//  • buy / sell / gas as above, with BNB Chain in Solana's place (sales and swaps signed on BNB Chain, BNB pays gas).
//  • swap: on BNB Chain alone: BNB or USDT → the coin, or back.
//
// ARCDEX's fee is Relay's app fee: 2% (the swap router's feeBps) of what goes in, accrued for the fee wallet
// 0x2742…86Bb as a USDC balance at Relay and claimed from there (Relay pays app fees out on a claim, signed by that
// wallet; https://docs.relay.link/features/app-fees). The gas top-ups carry no fee.
//
// A quote is refused unless it's exactly the trade asked for: who pays and who receives, the coins, the amount, only
// Relay's own contracts as Relay publishes them (GET /chains) with approvals for exactly the amount, and on Solana only
// the programs a trade uses (`SOL_PROGRAMS`), signed by the trader alone, any SOL sent only to Relay's own solvers, with
// Relay's memo naming the quote. On BNB Chain the router's calldata is Relay's own: it must name the trader, and
// lib/relay.ts simulates it from the trader before sending.

import { decodeFunctionData, erc20Abi, formatUnits, type Hex } from 'viem'
import { FEE_WALLET } from './platform'
import { ARC_USDC, QUOTE_LIMITS, quoteVerdict, type QuoteValue, type QuoteVerdict } from './acrossQuote'
import { t as T } from './i18n'

export const RELAY_API = 'https://api.relay.link'
export const ARC_ID = 5042
/** Relay's id for Solana. */
export const SOLANA_ID = 792703809
export const BSC_ID = 56
/** Relay's name for native SOL. */
export const SOL_NATIVE = '11111111111111111111111111111111'
/** Relay's name for an EVM chain's native coin (BNB). */
export const EVM_NATIVE = '0x0000000000000000000000000000000000000000'
/** Relay's depository on Arc (and BNB Chain): takes buys' USDC (Relay's /chains, checked 2026-10-04). */
export const RELAY_ARC_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
/** Relay's contracts on BNB Chain (its /chains: `erc20Router`, `approvalProxy`; checked 2026-10-05). The router takes
 * native BNB; ERC-20s are approved to the approval proxy, which pulls exactly the amount for the router. */
export const RELAY_BSC = { router: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', approvalProxy: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be' } as const
/** Relay's solvers on Solana (its /chains `solverAddresses`): where a same-chain swap's fee is sent. */
export const RELAY_SOL_SOLVERS = new Set(['F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe', 'DNLbQ4t95LLPevvLdcFzN8RHNN83ntQJLt26E8VTnE7p'])
/** depositErc20(address depositor, address token, uint256 amount, bytes32 id). */
const DEPOSIT_SELECTOR = '0xe8017952'

/** The only programs a Solana trade's transaction may call: Solana's token accounts, the swap aggregators Relay routes
 * through (DFlow, Jupiter), Relay's depository, and the memo naming the quote. Plus the system's own. */
export const SOL_PROGRAMS = new Set([
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated token accounts
  'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', // DFlow
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr', // Relay's depository on Solana
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // memo
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])
export const RELAY_SOL_DEPOSITORY = 'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const SYSTEM = '11111111111111111111111111111111'

export type RelaySide = 'buy' | 'sell' | 'gas' | 'swap'
export type RelayChain = 'solana' | 'bsc'

export interface RelayRequest {
  side: RelaySide
  /** The other chain: Solana (the default) or BNB Chain. */
  chain?: RelayChain
  /** The coin (a Solana mint, or a BNB Chain token; unused for gas). */
  mint: string
  /** What goes in, in its smallest units: USDC (6 decimals) for a buy or gas, the coin for a sale, `inToken` for a swap. */
  amount: bigint
  /** The trader on Arc (and on BNB Chain, the same address): pays a buy, is paid a sale. */
  evm: string
  /** The trader on Solana: receives a buy, signs a sale or a swap. Unused on BNB Chain. */
  sol: string
  /** ARCDEX's fee in basis points (200); 0 for gas. */
  feeBps: number
  /** A swap's currencies on the other chain (native SOL/BNB, a stablecoin, or the coin). */
  inToken?: string
  outToken?: string
}

export interface SolInstruction { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }

export interface RelayQuote {
  /** Relay's request id: what its status and memo name. */
  id: string
  side: RelaySide
  chain: RelayChain
  mint: string
  evm: string
  sol: string
  /** The chain the trader signs on. */
  signChain: number
  inputAmount: bigint
  expectedOut: bigint
  minOut: bigint
  outDecimals: number
  outSymbol: string
  /** ARCDEX's fee and Relay's own (its relayer and the other chain's gas), in dollars. */
  appFeeUsd: number
  relayFeeUsd: number
  /** Relay's own dollar values of what goes in and comes out (for the swap guard's input side). */
  inUsd: number
  outUsdRelay: number
  /** Seconds Relay expects delivery to take. */
  fillSeconds: number
  /** An EVM side (Arc, or BNB Chain): the approval it needs (null when none) and the call. */
  evmTx: { approve: { token: Hex; spender: Hex; amount: bigint } | null; call: { to: Hex; data: Hex; value: bigint } } | null
  /** Solana's side (sales and swaps): the instructions to sign and the lookup tables they use. */
  solTx: { instructions: SolInstruction[]; lookupTables: string[] } | null
}

export class RelayError extends Error {}

const lc = (v: unknown) => String(v ?? '').toLowerCase()
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')) } catch { return 0n } }
const word = (data: string, i: number) => data.slice(10 + 64 * i, 10 + 64 * (i + 1))
const chainOf = (r: RelayRequest): RelayChain => r.chain ?? 'solana'
const otherId = (c: RelayChain) => (c === 'bsc' ? BSC_ID : SOLANA_ID)

/** Where a request starts and ends, who signs and who's paid, and in what. */
function shape(r: RelayRequest) {
  const c = chainOf(r)
  const other = otherId(c)
  const me = c === 'bsc' ? r.evm : r.sol
  switch (r.side) {
    case 'buy': return { user: r.evm, recipient: me, origin: ARC_ID, dest: other, inCur: ARC_USDC, outCur: r.mint }
    case 'gas': return { user: r.evm, recipient: me, origin: ARC_ID, dest: other, inCur: ARC_USDC, outCur: c === 'bsc' ? EVM_NATIVE : SOL_NATIVE }
    case 'sell': return { user: me, recipient: r.evm, origin: other, dest: ARC_ID, inCur: r.mint, outCur: ARC_USDC }
    case 'swap': return { user: me, recipient: me, origin: other, dest: other, inCur: r.inToken ?? '', outCur: r.outToken ?? '' }
  }
}

/** The request Relay's /quote takes. */
export function quoteBody(r: RelayRequest): Record<string, unknown> {
  const s = shape(r)
  return {
    user: s.user,
    recipient: s.recipient,
    originChainId: s.origin,
    destinationChainId: s.dest,
    originCurrency: s.inCur,
    destinationCurrency: s.outCur,
    amount: r.amount.toString(),
    tradeType: 'EXACT_INPUT',
    ...(r.side !== 'gas' && r.feeBps > 0 ? { appFees: [{ recipient: FEE_WALLET, fee: String(r.feeBps) }] } : {}),
  }
}

interface ApiCurrency { currency?: { chainId?: number; address?: string; decimals?: number; symbol?: string }; amount?: string; amountUsd?: string; minimumAmount?: string }
interface ApiStep { id?: string; kind?: string; requestId?: string; items?: { data?: Record<string, unknown> }[] }
interface ApiQuote {
  steps?: ApiStep[]
  fees?: Record<string, ApiCurrency | undefined>
  details?: { sender?: string; recipient?: string; currencyIn?: ApiCurrency; currencyOut?: ApiCurrency; timeEstimate?: number }
  message?: string
  errorCode?: string
}

function fail(why: string): never {
  throw new RelayError(T('This quote didn’t pass ARCDEX’s checks ({why}), so nothing was sent.', { why }))
}

/** Checks a Relay answer against what was asked for, and returns it as a quote. Throws `RelayError` on anything
 * unexpected. */
export function checkRelayQuote(r: RelayRequest, j: ApiQuote): RelayQuote {
  const c = chainOf(r)
  const s = shape(r)
  const d = j.details
  const cin = d?.currencyIn, cout = d?.currencyOut
  const steps = j.steps ?? []
  if (!d || !cin?.currency || !cout?.currency || !steps.length) fail('Relay sent no trade')
  if (r.side === 'swap' && (!r.inToken || !r.outToken || r.inToken === r.outToken)) fail('a swap needs two currencies')
  // Who pays and who's paid: addresses on Solana are case-sensitive, on EVM chains not.
  const addrOk = (chain: number, a: string | undefined, b: string) => (chain === SOLANA_ID ? a === b : lc(a) === lc(b))
  if (!addrOk(s.origin, d.sender, s.user)) fail(s.origin === SOLANA_ID ? 'the trade isn’t from your Solana wallet' : 'the trade isn’t from you')
  if (!addrOk(s.dest, d.recipient, s.recipient)) fail(s.dest === SOLANA_ID ? 'the trade goes to another Solana address' : 'the trade pays another address')
  if (Number(cin.currency.chainId) !== s.origin || !addrOk(s.origin, cin.currency.address, s.inCur)) fail('the quote spends another token')
  if (Number(cout.currency.chainId) !== s.dest || !addrOk(s.dest, cout.currency.address, s.outCur)) fail('the quote delivers another token')
  if (big(cin.amount) !== r.amount) fail('the quote spends another amount')
  const expectedOut = big(cout.amount), minOut = big(cout.minimumAmount)
  if (minOut <= 0n || expectedOut < minOut) fail('the quote has no minimum received')

  const app = j.fees?.app
  const appFee = big(app?.amount)
  if (r.side === 'gas' && appFee !== 0n) fail('a fee on gas')
  if (r.side === 'buy' && r.feeBps > 0) {
    // A buy from Arc pays its fee in Arc USDC: its share of what goes in.
    const want = (r.amount * BigInt(r.feeBps)) / 10_000n
    if (Number(app?.currency?.chainId) !== ARC_ID || appFee < want - 1n || appFee > want + 1n) fail('the fee isn’t ARCDEX’s')
  }
  if ((r.side === 'sell' || r.side === 'swap') && r.feeBps > 0 && appFee <= 0n) fail('the fee isn’t ARCDEX’s')

  const ids = new Set(steps.map(x => x.requestId).filter(Boolean))
  if (ids.size !== 1) fail('the quote names no single request')
  const id = String([...ids][0])

  let evmTx: RelayQuote['evmTx'] = null, solTx: RelayQuote['solTx'] = null
  if (s.origin === SOLANA_ID) solTx = checkSolSteps(r, steps, id, c)
  else evmTx = checkEvmSteps(r, steps, s.origin, s.user, s.inCur)

  const usd = (k: string) => parseFloat(String(j.fees?.[k]?.amountUsd ?? '0')) || 0
  return {
    id, side: r.side, chain: c, mint: r.mint, evm: lc(r.evm), sol: r.sol, signChain: s.origin,
    inputAmount: r.amount, expectedOut, minOut,
    outDecimals: Number(cout.currency.decimals ?? 6),
    outSymbol: String(cout.currency.symbol ?? ''),
    appFeeUsd: usd('app'),
    relayFeeUsd: usd('relayer'),
    inUsd: parseFloat(String(cin.amountUsd ?? '0')) || 0,
    outUsdRelay: parseFloat(String(cout.amountUsd ?? '0')) || 0,
    fillSeconds: Number(d.timeEstimate ?? 0) || 0,
    evmTx, solTx,
  }
}

/** An EVM side: Arc (Relay's depository) or BNB Chain (Relay's router, or its approval proxy for an ERC-20). An
 * approval, if any, is for exactly the amount, to the contract that then takes it. */
function checkEvmSteps(r: RelayRequest, steps: ApiStep[], chainId: number, user: string, inCur: string): NonNullable<RelayQuote['evmTx']> {
  const native = lc(inCur) === EVM_NATIVE
  let approve: { token: Hex; spender: Hex; amount: bigint } | null = null, call: { to: Hex; data: Hex; value: bigint } | null = null
  for (const st of steps) {
    if (st.id !== 'approve' && st.id !== 'deposit' && st.id !== 'swap') fail(`an unexpected step (${st.id ?? '?'})`)
    if (st.kind !== 'transaction' || (st.items?.length ?? 0) !== 1 || (st.id !== 'approve' && call)) fail('an unexpected step')
    const x = st.items![0].data ?? {}
    if (Number(x.chainId) !== chainId) fail('a transaction for another chain')
    const to = lc(x.to) as Hex, data = lc(x.data) as Hex, value = big(x.value)
    if (st.id === 'approve') {
      if (native) fail('an approval for a native coin')
      if (to !== lc(inCur)) fail('the approval is for another token')
      if (value !== 0n) fail('the transaction would send native funds')
      const a = (() => { try { return decodeFunctionData({ abi: erc20Abi, data }) } catch { return null } })()
      if (!a || a.functionName !== 'approve') fail('an unexpected approval')
      const [spender, amount] = a.args as readonly [string, bigint]
      const want = chainId === ARC_ID ? RELAY_ARC_DEPOSITORY : RELAY_BSC.approvalProxy
      if (lc(spender) !== want) fail('the approval is for a contract ARCDEX doesn’t know')
      if (amount !== r.amount) fail('the approval isn’t for exactly the amount')
      approve = { token: to, spender: lc(spender) as Hex, amount }
    } else {
      if (chainId === ARC_ID) {
        // Arc: Relay's depository, word by word.
        if (to !== RELAY_ARC_DEPOSITORY) fail('the deposit goes to a contract ARCDEX doesn’t know')
        if (value !== 0n) fail('the transaction would send native funds')
        if (!data.startsWith(DEPOSIT_SELECTOR) || data.length !== 10 + 64 * 4) fail('an unexpected deposit')
        if (`0x${word(data, 0).slice(24)}` !== lc(r.evm)) fail('the deposit isn’t from you')
        if (`0x${word(data, 1).slice(24)}` !== ARC_USDC) fail('the deposit isn’t USDC')
        if (BigInt(`0x${word(data, 2)}`) !== r.amount) fail('the deposit isn’t the amount asked for')
      } else {
        // BNB Chain: native BNB goes to Relay's router with exactly the amount; an ERC-20 through its approval proxy.
        if (native ? to !== RELAY_BSC.router : to !== RELAY_BSC.approvalProxy) fail('the trade goes to a contract ARCDEX doesn’t know')
        if (native ? value !== r.amount : value !== 0n) fail(native ? 'the trade sends another amount of BNB' : 'the transaction would send native funds')
        if (!data.includes(lc(user).slice(2))) fail('the trade’s instructions don’t name you')
      }
      call = { to, data, value }
    }
  }
  if (!call) fail('the quote has no transaction')
  return { approve, call }
}

/** A Solana side (a sale, or a swap): only the programs a trade uses, signed by the trader alone, SOL sent only to
 * Relay's solvers (a swap's fee, at most 5% of SOL going in, else 0.01 SOL), and Relay's memo naming the quote. A
 * sale (to Arc) deposits with Relay. */
function checkSolSteps(r: RelayRequest, steps: ApiStep[], id: string, _c: RelayChain): NonNullable<RelayQuote['solTx']> {
  const want = r.side === 'swap' ? 'swap' : 'deposit'
  if (steps.length !== 1 || steps[0].id !== want || steps[0].kind !== 'transaction' || (steps[0].items?.length ?? 0) !== 1) fail('an unexpected step')
  const x = steps[0].items![0].data as { instructions?: SolInstruction[]; addressLookupTableAddresses?: string[] }
  const ins = x.instructions ?? []
  if (!ins.length) fail('the trade has no instructions')
  let toSolvers = 0n
  for (const i of ins) {
    if (!SOL_PROGRAMS.has(i.programId)) fail(`a program ARCDEX doesn’t know (${i.programId.slice(0, 6)}…)`)
    for (const k of i.keys) if (k.isSigner && k.pubkey !== r.sol) fail('the trade needs another signer')
    if (!/^[0-9a-f]*$/i.test(i.data)) fail('the trade’s instructions can’t be read')
    // A system transfer (instruction 2): only to the trader's own accounts or Relay's solvers (its fee).
    if (i.programId === SYSTEM && i.data.startsWith('02000000') && i.keys.length >= 2) {
      const dest = i.keys[1].pubkey
      const lamports = i.data.length >= 24 ? BigInt('0x' + (i.data.slice(8, 24).match(/../g) ?? []).reverse().join('')) : 0n
      if (RELAY_SOL_SOLVERS.has(dest)) toSolvers += lamports
      else if (dest !== r.sol) fail('the trade sends SOL to an address ARCDEX doesn’t know')
    }
  }
  const cap = r.side === 'swap' && r.inToken === SOL_NATIVE ? (r.amount * 5n) / 100n : 10_000_000n
  if (toSolvers > (cap > 10_000_000n ? cap : 10_000_000n)) fail('the trade sends Relay more SOL than its fee')
  if (r.side === 'sell' && !ins.some(i => i.programId === RELAY_SOL_DEPOSITORY)) fail('the sale isn’t deposited with Relay')
  const memo = ins.find(i => i.programId === MEMO)
  if (lc(memo ? decodeHexAscii(memo.data) : '') !== lc(id)) fail('the trade’s memo names another request')
  return { instructions: ins, lookupTables: (x.addressLookupTableAddresses ?? []).filter(a => typeof a === 'string') }
}

function decodeHexAscii(h: string): string {
  let s = ''
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16))
  return s
}

// ── what a quote is worth (the same guard as Robinhood Chain's: lib/acrossQuote.ts) ──

/** A buy or sale through Arc, valued at the coin's market price. `input` is what's paid: dollars for a buy, coins for a
 * sale. */
export function relayValue(q: Pick<RelayQuote, 'side' | 'expectedOut' | 'outDecimals' | 'appFeeUsd' | 'relayFeeUsd'>, input: number, priceUsd: number): QuoteValue | null {
  if (q.side === 'gas' || q.side === 'swap' || !(priceUsd > 0) || !(input > 0)) return null
  const out = Number(formatUnits(q.expectedOut, q.outDecimals))
  if (q.side === 'buy') {
    const swapIn = input - q.appFeeUsd - q.relayFeeUsd
    if (!(swapIn > 0)) return null
    const rate = (out * priceUsd) / swapIn
    return { rate, impact: 1 - rate, cost: 1 - (out * priceUsd) / input }
  }
  const worth = input * priceUsd
  const rate = (out + q.appFeeUsd + q.relayFeeUsd) / worth
  return { rate, impact: 1 - rate, cost: 1 - out / worth }
}

/** A swap valued in dollars: what goes in and what comes out, each at its market price (the coin's from GeckoTerminal,
 * SOL's or BNB's likewise; a stablecoin at $1). */
export function relayValueUsd(q: Pick<RelayQuote, 'appFeeUsd' | 'relayFeeUsd'>, inputUsd: number, outUsd: number): QuoteValue | null {
  if (!(inputUsd > 0) || !(outUsd > 0)) return null
  const rate = (outUsd + q.appFeeUsd + q.relayFeeUsd) / inputUsd
  return { rate, impact: 1 - rate, cost: 1 - outUsd / inputUsd }
}

export { QUOTE_LIMITS, quoteVerdict, type QuoteVerdict }

/** Relay's own reasons, in words a trader can act on. */
export function relayErrorText(code: string | undefined, message: string | undefined): string {
  const m = `${code ?? ''} ${message ?? ''}`
  if (/NO_SWAP_ROUTES_FOUND|no routes/i.test(m)) return T('Relay can’t route this coin right now: it may have too little liquidity, or a token setup Relay doesn’t trade.')
  if (/AMOUNT_TOO_LOW|too low|too small/i.test(m)) return T('This amount is below what Relay can route: try a little more.')
  if (/INSUFFICIENT_LIQUIDITY|liquidity/i.test(m)) return T('Not enough liquidity for this amount right now: try less.')
  if (/INSUFFICIENT_FUNDS|insufficient/i.test(m)) return T('Not enough balance for this trade.')
  return message ? message.slice(0, 200) : T('Relay couldn’t quote this trade.')
}

/** A checked quote for `r`. Never cached: Relay's quotes follow the market. */
export async function getRelayQuote(r: RelayRequest, signal?: AbortSignal): Promise<RelayQuote> {
  const res = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteBody(r)), signal: signal ?? AbortSignal.timeout(20_000) })
  let j: ApiQuote
  try { j = await res.json() as ApiQuote } catch { throw new RelayError(T('Relay couldn’t quote this trade.')) }
  if (!res.ok || !j.steps) throw new RelayError(relayErrorText(j.errorCode, j.message))
  return checkRelayQuote(r, j)
}

export type RelayStatus = 'pending' | 'filled' | 'refunded' | 'failed'

/** Where a request stands at Relay, and the delivery's transaction once there is one. */
export async function relayStatus(id: string): Promise<{ status: RelayStatus; outTx: string | null }> {
  const res = await fetch(`${RELAY_API}/intents/status/v3?requestId=${id}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const j = await res.json().catch(() => ({})) as { status?: string; txHashes?: string[] }
  const s = j.status === 'success' ? 'filled' : j.status === 'refund' ? 'refunded' : j.status === 'failure' ? 'failed' : 'pending'
  return { status: s, outTx: j.txHashes?.[0] ?? null }
}

