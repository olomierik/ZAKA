// Native-USDC Uniswap v4 pools — Minara, SolonPad's instant launches and
// other launchpads open their pools against Arc's native USDC (currency
// 0x0). ArcDexSwapRouter only takes ERC-20 USDC pools, so these trade
// through Uniswap's own Universal Router, with the same ARCSENSE fee (and the
// referrer's share of it) taken off the USDC side in the same transaction:
//   buy:  TRANSFER each fee share out of msg.value, then V4_SWAP native → token
//         (SWAP_EXACT_IN_SINGLE, SETTLE_ALL native, TAKE_ALL token ≥ min out),
//         then SWEEP any unswapped USDC back to the trader
//   sell: V4_SWAP token → native into the router (SETTLE_ALL token through
//         Permit2, TAKE native to the router), PAY_PORTION_FULL_PRECISION each
//         fee share, then SWEEP the rest to the trader (≥ min out)
// Encodings follow the Universal Router releases deployed on Arc (2.1.1 and
// 2.1.2, github.com/Uniswap/universal-router deploy-addresses/arc.json), both
// built against v4-periphery whose ExactInputSingleParams has minHopPriceX36.

import { encodeAbiParameters, parseAbi, type Address, type Hex } from 'viem'
import { client } from './launchpad'

export const NATIVE = '0x0000000000000000000000000000000000000000' as Address
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Universal Router 2.1.2 then 2.1.1 on Arc; the first wired to Arc's PoolManager is used. */
const ROUTERS = ['0x8702463e73f74d0b6765aBceb314Ef07aCb92650', '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1'] as Address[]
/** Uniswap's V4Quoter on Arc (Uniswap's v4 deployments list), checked the same way before use. */
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address

// universal-router contracts/libraries/Commands.sol
export const CMD = { SWEEP: 0x04, TRANSFER: 0x05, PAY_PORTION_FULL_PRECISION: 0x07, V4_SWAP: 0x10 } as const
// v4-periphery src/libraries/Actions.sol
export const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const
/** ActionConstants.ADDRESS_THIS: "the router itself" as a TAKE recipient. */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address
/** ActionConstants.OPEN_DELTA: "all of it". */
const OPEN_DELTA = 0n

export interface NativeKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

const KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
export const EXACT_IN_SINGLE = [{ type: 'tuple', components: [
  { name: 'poolKey', type: 'tuple', components: KEY },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' },
  { name: 'minHopPriceX36', type: 'uint256' },
  { name: 'hookData', type: 'bytes' },
] }] as const
export const ACTIONS_ROUTER_INPUT = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const CURRENCY_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const
const CURRENCY_TO_AMOUNT = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const

export const UR_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function poolManager() view returns (address)',
])
const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}, { name: 'poolManager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const
export const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

/** A pool the Universal Router can trade for ARCSENSE: native USDC against the token. */
export function isNativePool(key: NativeKey, token: string): boolean {
  return key.currency0.toLowerCase() === NATIVE && key.currency1.toLowerCase() === token.toLowerCase()
}

// ── the router and quoter, checked before use ─────────────────────────

let routerP: Promise<Address> | null = null
/** The Universal Router to use: the first wired to Arc's Uniswap v4 PoolManager. */
export function universalRouter(): Promise<Address> {
  routerP ??= (async () => {
    for (const r of ROUTERS) {
      const pm = await client.readContract({ address: r, abi: UR_ABI, functionName: 'poolManager' }).catch(() => null)
      if (pm?.toLowerCase() === POOL_MANAGER) return r
    }
    throw new Error('No Universal Router on Arc answers for the v4 PoolManager')
  })().catch(e => { routerP = null; throw e })
  return routerP
}

let quoterOk: Promise<boolean> | null = null
/** Output of an exact-in swap in one pool, from Uniswap's V4Quoter (through the pool's hook). */
export async function quoteExactIn(key: NativeKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  quoterOk ??= client.readContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'poolManager' })
    .then(pm => pm.toLowerCase() === POOL_MANAGER).catch(() => { quoterOk = null; return false })
  if (!(await quoterOk)) throw new Error('Uniswap quoter unavailable')
  const { result } = await client.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }] })
  return result[0]
}

// ── fees ─────────────────────────────────────────────────────────────

/** Who gets the fee, in basis points of the trade's USDC side: the
 * referrer's share (as ArcDexSwapRouter pays it) and the fee wallet's. */
export interface FeeShare { to: Address; bps: number }

export function feeShares(feeBps: number, referralShareBps: number, feeWallet: Address, referrer: Address | null): FeeShare[] {
  if (feeBps <= 0) return []
  if (!referrer || referrer.toLowerCase() === NATIVE || referralShareBps <= 0) return [{ to: feeWallet, bps: feeBps }]
  // In 1/10,000ths of a basis point, so the two shares add up to the whole fee exactly.
  const ref = (feeBps * referralShareBps) / 10_000
  return [{ to: referrer, bps: ref }, { to: feeWallet, bps: feeBps - ref }]
}

// ── encoders ─────────────────────────────────────────────────────────

const cmds = (list: number[]) => ('0x' + list.map(c => c.toString(16).padStart(2, '0')).join('')) as Hex
const actions = (list: number[]) => cmds(list)
const swapParams = (key: NativeKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint) =>
  encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' }])

export interface UrCall { commands: Hex; inputs: Hex[] }

/** Buy `key.currency1` with `value` native USDC (18 decimals, sent as msg.value).
 * Each fee share leaves first; the rest is swapped, and at least `minOut`
 * tokens must reach the trader. Any USDC the pool didn't take (a partial
 * fill, when the pool runs out of tokens) is swept back to `to`, never left
 * in the router. */
export function encodeNativeBuy(key: NativeKey, value: bigint, shares: FeeShare[], minOut: bigint, to: Address): UrCall & { swapIn: bigint; fees: { to: Address; amount: bigint }[] } {
  const fees = shares.map(s => ({ to: s.to, amount: (value * BigInt(Math.round(s.bps * 10_000))) / 100_000_000n })).filter(f => f.amount > 0n)
  const swapIn = value - fees.reduce((a, f) => a + f.amount, 0n)
  const v4 = encodeAbiParameters(ACTIONS_ROUTER_INPUT, [actions([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]), [
    swapParams(key, true, swapIn, minOut),
    encodeAbiParameters(CURRENCY_AMOUNT, [NATIVE, swapIn]),
    encodeAbiParameters(CURRENCY_AMOUNT, [key.currency1, minOut]),
  ]])
  return {
    commands: cmds([...fees.map(() => CMD.TRANSFER), CMD.V4_SWAP, CMD.SWEEP]),
    inputs: [...fees.map(f => encodeAbiParameters(CURRENCY_TO_AMOUNT, [NATIVE, f.to, f.amount])), v4, encodeAbiParameters(CURRENCY_TO_AMOUNT, [NATIVE, to, 0n])],
    swapIn, fees,
  }
}

/** Sell `tokensIn` of `key.currency1` for native USDC. The token comes in
 * through Permit2; the fee shares are paid out of the proceeds in turn
 * (each portion of what's left, so each gets its exact share of the whole),
 * then the rest — at least `minOut` — goes to `to`. */
export function encodeNativeSell(key: NativeKey, tokensIn: bigint, shares: FeeShare[], minOut: bigint, to: Address): UrCall & { portions: bigint[] } {
  const v4 = encodeAbiParameters(ACTIONS_ROUTER_INPUT, [actions([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE]), [
    swapParams(key, false, tokensIn, 0n),
    encodeAbiParameters(CURRENCY_AMOUNT, [key.currency1, tokensIn]),
    encodeAbiParameters(CURRENCY_TO_AMOUNT, [NATIVE, ADDRESS_THIS, OPEN_DELTA]),
  ]])
  const portions = sequentialPortions(shares.map(s => s.bps))
  const paid = shares.map((s, i) => ({ to: s.to, portion: portions[i] })).filter(p => p.portion > 0n)
  return {
    commands: cmds([CMD.V4_SWAP, ...paid.map(() => CMD.PAY_PORTION_FULL_PRECISION), CMD.SWEEP]),
    inputs: [v4, ...paid.map(p => encodeAbiParameters(CURRENCY_TO_AMOUNT, [NATIVE, p.to, p.portion])), encodeAbiParameters(CURRENCY_TO_AMOUNT, [NATIVE, to, minOut])],
    portions,
  }
}

/** PAY_PORTION_FULL_PRECISION takes a share (of 1e18) of what the router
 * holds at that moment. To pay each fee share of the whole proceeds, each
 * portion is its share of what's left after the ones before it. */
export function sequentialPortions(bps: number[]): bigint[] {
  const ONE = 10n ** 18n
  const SCALE = 100_000_000n // basis points × 10,000
  let left = SCALE
  return bps.map(b => {
    const part = BigInt(Math.round(b * 10_000))
    const p = left > 0n ? (part * ONE) / left : 0n
    left -= part
    return p
  })
}

/** The trader's net USDC from a sell, after the fee shares (18 decimals). */
export function netAfterFees(grossOut: bigint, shares: FeeShare[]): bigint {
  let left = grossOut
  for (const p of sequentialPortions(shares.map(s => s.bps))) left -= (left * p) / 10n ** 18n
  return left
}

// ── Permit2 (sells) ──────────────────────────────────────────────────

/** How much of `token` the router may pull from `owner` through Permit2 right now. */
export async function permit2Allowance(owner: Address, token: Address, spender: Address): Promise<bigint> {
  const [amount, expiration] = await client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [owner, token, spender] })
  return expiration > Math.floor(Date.now() / 1000) + 60 ? amount : 0n
}
