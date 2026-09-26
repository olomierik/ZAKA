// Other Arc launchpads' own bonding curves — Mercuri, and SolonPad's Pons V2
// curve mode — traded straight from the trader's wallet, as their own sites
// do. Each launch has its own curve contract, found from the token through
// the launchpad's factory: native USDC (18 decimals, sent as msg.value) in,
// the token out, and back. Once a curve graduates the coin trades in its
// Uniswap v4 pool, and the usual routes (argusMarket.buildSwapRoute) take over.
//
// ARCDEX adds no fee on a curve: ArcDexSwapRouter can't call one, and a fee
// sent in a separate transaction wouldn't be atomic with the trade. Mercuri
// shares 0.20% of each trade (out of its own 1% fee) with the referrer a
// wallet names on its first Mercuri trade — ARCDEX's fee wallet — on every
// Mercuri trade of that wallet from then on, claimable from its FeeManager.
//
// Sources: github.com/mercuri-finance/mercuri-launch-contracts (v1.0.0 as
// deployed, deployments/5042.json) and github.com/solonlend/solonpad-skill
// (addresses.json, abis/, AGENT-GUIDE.md §2–4).

import { keccak256, parseAbi, toHex, type Address } from 'viem'
import { client } from './launchpad'

export const MERCURI_FACTORY = '0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB' as Address
/** Where Mercuri referrers (ARCDEX's fee wallet) claim their share: `claim(to)`. */
export const MERCURI_FEE_MANAGER = '0x31D1bfe59B783f4c077F853f962D1355AfB52580' as Address
export const SOLONPAD_FACTORY = '0xd6b86b9B1bB64b941b21AaA6a0e3A673e8405A3b' as Address
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

// Trade events, for the coin page's chart and trades list (api/poolSwaps.ts).
export const MERCURI_BUY = keccak256(toHex('Buy(address,uint256,uint256,uint256,uint256,uint256,uint256)'))
export const MERCURI_SELL = keccak256(toHex('Sell(address,uint256,uint256,uint256,uint256,uint256)'))
export const SOLON_BUY = keccak256(toHex('CurveBuy(address,address,uint256,uint256,uint256,uint256)'))
export const SOLON_SELL = keccak256(toHex('CurveSell(address,address,uint256,uint256,uint256,uint256)'))

export type CurveVenue = 'Mercuri' | 'SolonPad'

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
  abi: typeof MERCURI_CURVE_ABI | typeof SOLONPAD_CURVE_ABI
  functionName: 'buy' | 'sell'
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

// ── trade events → the coin page's trades ────────────────────────────

export interface CurveTrade {
  kind: 'buy' | 'sell'
  trader: string
  tokenAmount: number
  /** USDC paid in (buy, fees included) or received (sell, after fees). */
  usdc: number
  /** Price right after the trade (Mercuri, from the reserves in the event)
   * or the trade's own price on the curve, fees aside (SolonPad), USDC per token. */
  price: number
}

const w = (data: string, i: number) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64))
const addr = (topic: string) => ('0x' + topic.slice(26)).toLowerCase()

/** One of a curve's Buy/Sell logs, or null for any other log. */
export function decodeCurveTrade(l: { topics: string[]; data: string }, venue: CurveVenue, virtual?: { usdc: bigint; tokens: bigint }): CurveTrade | null {
  const t0 = l.topics[0]
  if (venue === 'Mercuri') {
    // Buy(trader indexed | usdcIn (net), tokensOut, fee, tax, realUsdc, sold)
    // Sell(trader indexed | tokensIn, usdcOut (net), fee, realUsdc, sold)
    const buy = t0 === MERCURI_BUY
    if ((!buy && t0 !== MERCURI_SELL) || l.topics.length < 2 || !virtual || l.data.length < 2 + 64 * (buy ? 6 : 5)) return null
    const tokens = buy ? w(l.data, 1) : w(l.data, 0)
    // What the trader paid (usdcIn + fee + tax) or received (usdcOut).
    const usdc = buy ? w(l.data, 0) + w(l.data, 2) + w(l.data, 3) : w(l.data, 1)
    const realUsdc = w(l.data, buy ? 4 : 3), sold = w(l.data, buy ? 5 : 4)
    const y = virtual.tokens - sold
    if (tokens === 0n || y <= 0n) return null
    return { kind: buy ? 'buy' : 'sell', trader: addr(l.topics[1]), tokenAmount: Number(tokens) / 1e18, usdc: Number(usdc) / 1e18, price: Number(virtual.usdc + realUsdc) / Number(y) }
  }
  // CurveBuy(buyer indexed, recipient indexed, quoteIn (gross), tokensOut, fee, tax)
  // CurveSell(seller indexed, recipient indexed, tokensIn, quoteOut (net), fee, tax)
  const buy = t0 === SOLON_BUY
  if ((!buy && t0 !== SOLON_SELL) || l.topics.length < 3 || l.data.length < 2 + 64 * 4) return null
  const [a, b, fee, tax] = [0, 1, 2, 3].map(i => w(l.data, i))
  const tokens = buy ? b : a
  if (tokens === 0n) return null
  // The curve's side of the trade, fees and taxes aside.
  const onCurve = buy ? a - fee - tax : b + fee + tax
  return { kind: buy ? 'buy' : 'sell', trader: addr(l.topics[2]), tokenAmount: Number(tokens) / 1e18, usdc: Number(buy ? a : b) / 1e18, price: Number(onCurve) / Number(tokens) }
}

/** The log filter for a curve's trades. */
export function curveTradeFilter(curve: string, venue: CurveVenue) {
  return { address: curve.toLowerCase(), topics: [venue === 'Mercuri' ? [MERCURI_BUY, MERCURI_SELL] : [SOLON_BUY, SOLON_SELL]] }
}
