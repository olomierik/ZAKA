// How much a visitor's bot puts into a trade (owner's request, 2026-09-30:
// "the amount per trade should be minimum to be able to secure 1 to 4 dollar
// profit and close"). The visitor doesn't choose it: each trade gets the
// smallest size that, sold in full at the strategy's take-profit, nets its
// profit target after costs, both ways:
//
//   the probe's measured round trip (pool fee, hook and token taxes), half each way
//   price impact: a bigger trade moves a thin pool more, on the way in and out
//
// Impact grows with size, so past some size a bigger trade nets less. If no
// size up to the cap reaches the target (a pool too thin, a take-profit too
// close for the costs), the bot skips the trade rather than take one that
// can't pay.

import { costPerSide, type Strategy } from '../trading/paper'

/** Profit per winning trade, USD: [low, high] of the range, and the default target. Scalps: $1–2. */
export const TARGETS: Record<Strategy, { range: [number, number]; target: number }> = {
  scalp: { range: [1, 2], target: 1.5 },
  snipe: { range: [1, 4], target: 3 },
  'second-leg': { range: [1, 4], target: 3 },
}

export const SIZE_LIMITS = { minUsd: 5, maxUsd: 250, stepUsd: 0.5 }

/** What a trade of `sizeUsd` nets if all of it is sold at `takeProfit` × the entry price. */
export function netAtTakeProfit(sizeUsd: number, takeProfit: number, roundTripPct: number | null, liquidityUsd: number | null): number {
  const c = costPerSide(roundTripPct, sizeUsd, liquidityUsd)
  // Paid (1 + c) per token on the way in, got (1 − c) on the way out.
  return sizeUsd * ((takeProfit * (1 - c)) / (1 + c) - 1)
}

export interface Sized { sizeUsd: number; profitUsd: number; costPct: number }

/** The smallest size that nets `targetUsd` at `takeProfit`, or null if none up to the cap does. */
export function sizeForTarget(o: { targetUsd: number; takeProfit: number; roundTripPct: number | null; liquidityUsd: number | null; minUsd?: number; maxUsd?: number }): Sized | null {
  const min = o.minUsd ?? SIZE_LIMITS.minUsd, max = o.maxUsd ?? SIZE_LIMITS.maxUsd
  if (!(o.targetUsd > 0) || !(o.takeProfit > 1) || max < min) return null
  for (let size = min; size <= max + 1e-9; size += SIZE_LIMITS.stepUsd) {
    const net = netAtTakeProfit(size, o.takeProfit, o.roundTripPct, o.liquidityUsd)
    if (net >= o.targetUsd) {
      const s = Math.round(size * 100) / 100
      return { sizeUsd: s, profitUsd: Math.round(net * 100) / 100, costPct: Math.round(costPerSide(o.roundTripPct, s, o.liquidityUsd) * 10_000) / 100 }
    }
  }
  return null
}
