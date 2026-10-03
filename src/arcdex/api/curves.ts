// Other Arc launchpads' own bonding curves — Mercuri, and SolonPad's Pons V2
// curve mode — traded straight from the trader's wallet, as their own sites
// do. Each launch has its own curve contract, found from the token through
// the launchpad's factory: native USDC (18 decimals, sent as msg.value) in,
// the token out, and back. Once a curve graduates the coin trades in its
// Uniswap v4 pool, and the usual routes (argusMarket.buildSwapRoute) take over.
//
// ARCSENSE's fee on a curve trade comes from ArcDexCurveRouter
// (contracts/ArcDexCurveRouter.sol, deployed at api/_curves.ts CURVE_ROUTER):
// the trade goes through it and it takes the fee (2%, 15% of it to the
// trader's referrer) in the same transaction. VITE_ARCDEX_CURVE_ROUTER_ADDRESS
// can name another router, or `off`: trades then go to the curve directly
// and ARCSENSE adds no fee.
// Mercuri shares 0.20% of each trade (out of its own 1% fee) with the
// referrer a trader names on its first Mercuri trade: ARCSENSE's fee wallet,
// both for a wallet trading directly and for the router (Mercuri's trader
// then), claimable from Mercuri's FeeManager.
//
// Sources: github.com/mercuri-finance/mercuri-launch-contracts (v1.0.0 as
// deployed, deployments/5042.json) and github.com/solonlend/solonpad-skill
// (addresses.json, abis/, AGENT-GUIDE.md §2–4).

import { parseAbi, type Address } from 'viem'
import { client } from './launchpad'
import { MERCURI_FACTORY as M_FACTORY, MERCURI_FEE_MANAGER as M_FEES, SOLONPAD_FACTORY as S_FACTORY, curveRouterFrom } from '../../../api/_curves'

// Addresses, events and trade decoding are shared with the market engine (api/_curves.ts).
export { MERCURI_BUY, MERCURI_SELL, SOLON_BUY, SOLON_SELL, curveTradeFilter, decodeCurveTrade, type CurveTrade, type CurveVenue } from '../../../api/_curves'
import type { CurveVenue } from '../../../api/_curves'
export const MERCURI_FACTORY = M_FACTORY as Address
/** Where Mercuri referrers (ARCSENSE's fee wallet) claim their share: `claim(to)`. */
export const MERCURI_FEE_MANAGER = M_FEES as Address
export const SOLONPAD_FACTORY = S_FACTORY as Address
const ZERO = '0x0000000000000000000000000000000000000000'

export const MERCURI_FACTORY_ABI = parseAbi(['function curveOf(address token) view returns (address)'])
export const MERCURI_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function phase() view returns (uint8)',
  'function tradeFeeBps() view returns (uint256)',
  'function price() view returns (uint256)',
  'function progressBps() view returns (uint256)',
  'function virtualUsdc() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function quoteBuy(uint256 usdcIn) view returns (uint256 tokensOut, uint256 usdcUsed, uint256 fee, uint256 tax)',
  'function quoteSell(uint256 tokensIn) view returns (uint256 usdcOut, uint256 fee)',
  'function buy(uint256 minTokensOut, address referrer, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minUsdcOut, address referrer, uint256 deadline) returns (uint256 usdcOut)',
])
export const SOLONPAD_FACTORY_ABI = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
])
export const SOLONPAD_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function isNativeQuote() view returns (bool)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
])
const ERC20_META = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
])

export interface CurveInfo {
  venue: CurveVenue
  curve: Address
  token: Address
  /** The curve takes buys (Mercuri stops them while its sold-out curve graduates). */
  canBuy: boolean
  /** Closed for good: the coin trades in its Uniswap pool. */
  graduated: boolean
  /** The curve's own trade fee, on the USDC side. */
  feeBps: number
  /** SolonPad's optional creator tax (Mercuri's creator share is inside its fee). */
  creatorTaxBps: number
  /** Marginal price now, USDC per token (0 once graduated). */
  priceUsd: number
  /** Share of the way to graduation, 0–1. */
  progress: number
  name: string | null
  symbol: string | null
  /** Total supply in whole tokens. */
  supply: number | null
  /** Mercuri's virtual reserves (18 decimals): each trade event's price follows from them. */
  virtual?: { usdc: bigint; tokens: bigint }
}

const meta = (token: Address) => Promise.all([
  client.readContract({ address: token, abi: ERC20_META, functionName: 'name' }).catch(() => null),
  client.readContract({ address: token, abi: ERC20_META, functionName: 'symbol' }).catch(() => null),
  client.readContract({ address: token, abi: ERC20_META, functionName: 'totalSupply' }).then(s => Number(s) / 1e18).catch(() => null),
])

async function readMercuri(token: Address, curve: Address): Promise<CurveInfo | null> {
  const read = <F extends 'token' | 'phase' | 'tradeFeeBps' | 'price' | 'progressBps' | 'virtualUsdc' | 'virtualTokens'>(functionName: F) =>
    client.readContract({ address: curve, abi: MERCURI_CURVE_ABI, functionName })
  const [owner, phase, fee, price, progress, vUsdc, vTokens, [name, symbol, supply]] = await Promise.all([
    read('token'), read('phase'), read('tradeFeeBps'), read('price'), read('progressBps'), read('virtualUsdc'), read('virtualTokens'), meta(token),
  ])
  // The factory's record is authoritative; the curve must agree on its token.
  if (owner.toLowerCase() !== token) return null
  return {
    venue: 'Mercuri', curve, token,
    canBuy: phase === 0, graduated: phase === 2,
    feeBps: Number(fee), creatorTaxBps: 0,
    priceUsd: Number(price) / 1e18, // native wei per whole token
    progress: Math.min(1, Number(progress) / 10_000),
    name, symbol, supply,
    virtual: { usdc: vUsdc, tokens: vTokens },
  }
}

async function readSolon(token: Address, curve: Address): Promise<CurveInfo | null> {
  const read = <F extends 'token' | 'isNativeQuote' | 'graduated' | 'feeBps' | 'creatorTaxBps' | 'getReserves' | 'realQuoteReserve' | 'graduationThreshold'>(functionName: F) =>
    client.readContract({ address: curve, abi: SOLONPAD_CURVE_ABI, functionName })
  const [owner, native, graduated, fee, creatorTax, [quoteReserve, tokenReserve], real, threshold, [name, symbol, supply]] = await Promise.all([
    read('token'), read('isNativeQuote'), read('graduated'), read('feeBps'), read('creatorTaxBps'), read('getReserves'), read('realQuoteReserve'), read('graduationThreshold'), meta(token),
  ])
  // Curves quoted in another ERC-20 (a tokenized stock, …) aren't traded here.
  if (owner.toLowerCase() !== token || !native) return null
  return {
    venue: 'SolonPad', curve, token,
    canBuy: !graduated, graduated,
    feeBps: Number(fee), creatorTaxBps: Number(creatorTax),
    priceUsd: tokenReserve > 0n ? Number(quoteReserve) / Number(tokenReserve) : 0, // both 18 decimals
    progress: threshold > 0n ? Math.min(1, Number(real) / Number(threshold)) : 0,
    name, symbol, supply,
  }
}

/** The token's curve on Mercuri or SolonPad, or null if it has none.
 * Throws if the chain can't be read (the caller retries). */
export async function getCurve(token: string): Promise<CurveInfo | null> {
  const t = token.toLowerCase() as Address
  const [mercuri, solon] = await Promise.all([
    // A plain mapping read that answers for any token: a failure is the chain, not the token.
    client.readContract({ address: MERCURI_FACTORY, abi: MERCURI_FACTORY_ABI, functionName: 'curveOf', args: [t] }),
    // May revert (TokenNotFound) for a token SolonPad didn't launch.
    client.readContract({ address: SOLONPAD_FACTORY, abi: SOLONPAD_FACTORY_ABI, functionName: 'getLaunchedToken', args: [t] }).catch(() => null),
  ])
  if (mercuri && mercuri.toLowerCase() !== ZERO) return readMercuri(t, mercuri.toLowerCase() as Address)
  if (solon?.exists && solon.token.toLowerCase() === t && solon.curve.toLowerCase() !== ZERO) return readSolon(t, solon.curve.toLowerCase() as Address)
  return null
}

// ── quotes ───────────────────────────────────────────────────────────

export interface CurveBuyQuote {
  tokensOut: bigint
  /** Native USDC the curve takes; a buy that sells the curve out refunds the rest. */
  used: bigint
  /** The curve's trade fee and the taxes on this buy (native USDC). */
  fee: bigint
  tax: bigint
  /** The launch snipe tax on this buy, in basis points (0 once the window has passed). */
  snipeBps: number
}

/** A buy of `value` native USDC (18 decimals) by `me`. Mercuri quotes it in
 * a view; SolonPad's curve has none, so the buy itself is simulated from
 * `me` (as SolonPad's own reference tool does), with its snipe tax read for
 * the same wallet — the tax depends on the recipient. */
export async function quoteCurveBuy(c: CurveInfo, value: bigint, me: Address): Promise<CurveBuyQuote> {
  if (c.venue === 'Mercuri') {
    const [tokensOut, used, fee, tax] = await client.readContract({ address: c.curve, abi: MERCURI_CURVE_ABI, functionName: 'quoteBuy', args: [value] })
    // Mercuri's snipe tax is charged on what's left after the fee.
    return { tokensOut, used, fee, tax, snipeBps: used > fee ? Number((tax * 10_000n) / (used - fee)) : 0 }
  }
  const [snipe, { result }] = await Promise.all([
    client.readContract({ address: c.curve, abi: SOLONPAD_CURVE_ABI, functionName: 'currentSnipeTaxBps', args: [me] }),
    // minTokensOut 1, not 0: a zero minimum can revert on SolonPad's curve path (MinimumOutputRequired).
    client.simulateContract({ address: c.curve, abi: SOLONPAD_CURVE_ABI, functionName: 'buy', args: [value, 1n, me], value, account: me }),
  ])
  const fee = (value * BigInt(c.feeBps)) / 10_000n
  return { tokensOut: result, used: value, fee, tax: (value * (BigInt(c.creatorTaxBps) + snipe)) / 10_000n, snipeBps: Number(snipe) }
}

/** Native USDC (18 decimals) `me` would receive for `tokensIn`, after the
 * curve's fee and taxes. SolonPad's is simulated, so the curve must already
 * be approved for the amount. */
export async function quoteCurveSell(c: CurveInfo, tokensIn: bigint, me: Address): Promise<bigint> {
  if (c.venue === 'Mercuri') {
    const [usdcOut] = await client.readContract({ address: c.curve, abi: MERCURI_CURVE_ABI, functionName: 'quoteSell', args: [tokensIn] })
    return usdcOut
  }
  const { result } = await client.simulateContract({ address: c.curve, abi: SOLONPAD_CURVE_ABI, functionName: 'sell', args: [tokensIn, 1n, me], account: me })
  return result
}

// ── calls ────────────────────────────────────────────────────────────

export interface CurveCall {
  address: Address
  abi: typeof MERCURI_CURVE_ABI | typeof SOLONPAD_CURVE_ABI | typeof CURVE_ROUTER_ABI
  functionName: 'buy' | 'sell' | 'buyMercuri' | 'sellMercuri' | 'buySolon' | 'sellSolon'
  args: readonly unknown[]
  value?: bigint
}

/** Buy with `value` native USDC; at least `minOut` tokens, to `me`. Mercuri
 * names `referrer` if this is the wallet's first Mercuri trade (it's ignored
 * after that); SolonPad has no referral. */
export function curveBuyCall(c: CurveInfo, value: bigint, minOut: bigint, me: Address, referrer: Address, deadline: bigint): CurveCall {
  return c.venue === 'Mercuri'
    ? { address: c.curve, abi: MERCURI_CURVE_ABI, functionName: 'buy', args: [minOut, referrer, deadline], value }
    : { address: c.curve, abi: SOLONPAD_CURVE_ABI, functionName: 'buy', args: [value, minOut, me], value }
}

/** Sell `tokensIn` (approved to the curve, exact amount) for at least `minOut` native USDC, to `me`. */
export function curveSellCall(c: CurveInfo, tokensIn: bigint, minOut: bigint, me: Address, referrer: Address, deadline: bigint): CurveCall {
  return c.venue === 'Mercuri'
    ? { address: c.curve, abi: MERCURI_CURVE_ABI, functionName: 'sell', args: [tokensIn, minOut, referrer, deadline] }
    : { address: c.curve, abi: SOLONPAD_CURVE_ABI, functionName: 'sell', args: [tokensIn, minOut, me] }
}

// ── ARCSENSE's curve router ────────────────────────────────────────────

/** ArcDexCurveRouter: the deployed one, unless VITE_ARCDEX_CURVE_ROUTER_ADDRESS
 * names another. `off` leaves it '': curve trades then go to the curve
 * directly and ARCSENSE takes no fee on them. */
export const CURVE_ROUTER_ADDRESS = curveRouterFrom(import.meta.env.VITE_ARCDEX_CURVE_ROUTER_ADDRESS as string | undefined) as Address
export const curveRouterConfigured = /^0x[0-9a-f]{40}$/.test(CURVE_ROUTER_ADDRESS)

export const CURVE_ROUTER_ABI = parseAbi([
  'function feeBps() view returns (uint256)',
  'function referralShareBps() view returns (uint256)',
  'function buyMercuri(address token, uint256 minTokensOut, uint256 deadline, address referrer) payable returns (uint256 tokensOut)',
  'function sellMercuri(address token, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline, address referrer) returns (uint256 usdcOut)',
  'function buySolon(address token, uint256 minTokensOut, uint256 deadline, address referrer) payable returns (uint256 tokensOut)',
  'function sellSolon(address token, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline, address referrer) returns (uint256 usdcOut)',
])

export interface CurveRouter {
  address: Address
  /** ARCSENSE's fee on a curve trade, on the USDC side (at most 2%). */
  feeBps: number
  /** The trader's referrer's share of that fee. */
  referralShareBps: number
}

let routerRead: Promise<CurveRouter | null> | null = null
/** The curve router and the fee it charges now, read from the chain; null
 * when none is configured. Rejects if the chain can't be read (and reads
 * again next time): a configured router is never skipped. */
export function loadCurveRouter(): Promise<CurveRouter | null> {
  if (!curveRouterConfigured) return Promise.resolve(null)
  if (!routerRead) {
    routerRead = Promise.all([
      client.readContract({ address: CURVE_ROUTER_ADDRESS, abi: CURVE_ROUTER_ABI, functionName: 'feeBps' }),
      client.readContract({ address: CURVE_ROUTER_ADDRESS, abi: CURVE_ROUTER_ABI, functionName: 'referralShareBps' }),
    ]).then(([fee, share]) => ({ address: CURVE_ROUTER_ADDRESS, feeBps: Number(fee), referralShareBps: Number(share) }))
    routerRead.catch(() => { routerRead = null })
  }
  return routerRead
}

/** Who a sell's tokens are approved to: the router when there is one, else the curve. */
export const curveSpender = (c: CurveInfo): Address => curveRouterConfigured ? CURVE_ROUTER_ADDRESS : c.curve

/** What of `value` reaches the curve once the router has taken its fee. */
export const routerSpend = (r: CurveRouter, value: bigint) => value - (value * BigInt(r.feeBps)) / 10_000n

/** A buy of `value` native USDC through the router: the curve's quote for
 * what's left after ARCSENSE's fee, the tokens going to `me` as the router
 * delivers them (SolonPad's snipe tax is `me`'s either way). */
export function quoteRouterBuy(c: CurveInfo, r: CurveRouter, value: bigint, me: Address): Promise<CurveBuyQuote> {
  return quoteCurveBuy(c, routerSpend(r, value), me)
}

/** Native USDC (18 decimals) `me` receives for `tokensIn` through the
 * router, after every fee. SolonPad's is simulated, so the router must
 * already be approved for the amount. */
export async function quoteRouterSell(c: CurveInfo, r: CurveRouter, tokensIn: bigint, me: Address): Promise<bigint> {
  if (c.venue === 'Mercuri') {
    const proceeds = await quoteCurveSell(c, tokensIn, me)
    return proceeds - (proceeds * BigInt(r.feeBps)) / 10_000n
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  const { result } = await client.simulateContract({ address: r.address, abi: CURVE_ROUTER_ABI, functionName: 'sellSolon', args: [c.token, tokensIn, 1n, deadline, ZERO], account: me })
  return result
}

/** Buy through the router with `value` native USDC: at least `minOut` tokens to the caller. */
export function routerBuyCall(c: CurveInfo, r: CurveRouter, value: bigint, minOut: bigint, referrer: Address, deadline: bigint): CurveCall {
  return { address: r.address, abi: CURVE_ROUTER_ABI, functionName: c.venue === 'Mercuri' ? 'buyMercuri' : 'buySolon', args: [c.token, minOut, deadline, referrer], value }
}

/** Sell `tokensIn` (approved to the router, exact amount) through it: at least `minOut` native USDC to the caller. */
export function routerSellCall(c: CurveInfo, r: CurveRouter, tokensIn: bigint, minOut: bigint, referrer: Address, deadline: bigint): CurveCall {
  return { address: r.address, abi: CURVE_ROUTER_ABI, functionName: c.venue === 'Mercuri' ? 'sellMercuri' : 'sellSolon', args: [c.token, tokensIn, minOut, deadline, referrer] }
}
