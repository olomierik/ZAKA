// The liquidity engine: is the pool deep enough for the planned size, both
// ways? The engine's per-trade liquidity is the main pool's USD depth around
// the current price; it is treated as a constant-product pool with half its
// depth on the USDC side, so a trade of s USDC moves the price by about
// s / (Q + s) against it (Q = depth / 2). That's a conservative model for a
// concentrated v4 pool near its range; the coin's own probe round trip (fees,
// hook taxes, token taxes) is added on top when the scanner has measured it.

import { ratio } from './util'

export interface LiquidityFeatures {
  liquidity: number | null
  market_cap: number | null
  liquidity_to_mcap: number | null
  /** Volume over 5 minutes / liquidity (turnover). */
  volume_to_liquidity: number | null
  liquidity_change_5m: number | null
  liquidity_change_15m: number | null
  /** The pool's depth against its 15-minute high (0 … 1; 1 = at the high). */
  liquidity_of_high_15m: number | null
}

/** The share of a trade of `usd` lost to price impact in a pool of USD depth `liquidity` (0 … 1); 1 with no pool. */
export function impactOf(usd: number, liquidity: number | null): number {
  if (!(usd > 0)) return 0
  if (!liquidity || !(liquidity > 0)) return 1
  const q = liquidity / 2
  return usd / (q + usd)
}

/** The largest trade whose impact stays at or under `maxImpact` (a share, 0 … 1) in a pool of depth `liquidity`. */
export function maxSizeFor(liquidity: number | null, maxImpact: number): number {
  if (!liquidity || !(liquidity > 0) || !(maxImpact > 0) || maxImpact >= 1) return 0
  const q = liquidity / 2
  return (maxImpact * q) / (1 - maxImpact)
}

export interface Costs {
  /** Price impact buying and selling the size (shares of value). */
  entrySlippage: number
  exitSlippage: number
  /** The coin's buy and sell taxes (shares), when known. */
  buyTax: number
  sellTax: number
  /** Pool fees and hook costs a side (share), from the probe's round trip, else the default fee. */
  feePerSide: number
  gasUsd: number
  /** Everything as a share of the size, both ways. */
  roundTrip: number
}

/**
 * What a round trip of `usd` costs. `probeRoundTripPct` (the scanner's $1 probe: fees, hook taxes, token taxes) covers
 * the fixed part; `buyTaxPct` is the share of tokens lost on the buy, already part of the probe's figure.
 */
export function costsOf(usd: number, liquidity: number | null, o: { probeRoundTripPct: number | null; buyTaxPct: number | null; defaultFeePct: number; gasUsdPerTx: number }): Costs {
  const entrySlippage = impactOf(usd, liquidity)
  const exitSlippage = impactOf(usd * (1 - entrySlippage), liquidity)
  // The probe's round trip is fees + taxes both ways (its $1 moves no price): the buy tax is what it measured on the
  // buy, the pool fee is the default a side, and whatever is left over is the sale's tax.
  const probed = o.probeRoundTripPct !== null && o.probeRoundTripPct >= 0
  const fixed = probed ? o.probeRoundTripPct! / 100 : (2 * o.defaultFeePct) / 100
  const buyTax = probed ? Math.min(fixed, Math.max(0, (o.buyTaxPct ?? 0) / 100)) : 0
  const feePerSide = Math.min(o.defaultFeePct / 100, (fixed - buyTax) / 2)
  const sellTax = Math.max(0, fixed - buyTax - 2 * feePerSide)
  const gasUsd = 2 * o.gasUsdPerTx
  const roundTrip = Math.min(1, fixed + entrySlippage + exitSlippage + (usd > 0 ? gasUsd / usd : 0))
  return { entrySlippage, exitSlippage, buyTax, sellTax, feePerSide, gasUsd, roundTrip }
}

export function liquidityFeatures(o: { liquidity: number | null; liq5mAgo: number | null; liq15mAgo: number | null; liqHigh15m: number | null; price: number | null; supply: number | null; volume5m: number }): LiquidityFeatures {
  const mcap = o.price && o.supply ? o.price * o.supply : null
  const ch = (then: number | null) => (o.liquidity !== null && then && then > 0 ? o.liquidity / then - 1 : null)
  return {
    liquidity: o.liquidity, market_cap: mcap,
    liquidity_to_mcap: ratio(o.liquidity, mcap),
    volume_to_liquidity: ratio(o.volume5m, o.liquidity),
    liquidity_change_5m: ch(o.liq5mAgo), liquidity_change_15m: ch(o.liq15mAgo),
    liquidity_of_high_15m: o.liquidity !== null && o.liqHigh15m ? Math.min(1, o.liquidity / o.liqHigh15m) : null,
  }
}
