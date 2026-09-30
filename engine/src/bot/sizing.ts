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
// close for the costs), the trade is sized for the low end of the strategy's
// range ($1) instead; only if not even that can be netted does the bot skip
// it rather than take one that can't pay. (Before 2026-09-30 it skipped at the
// target: a fast scalp's $1.50 at +15% needs about $2,500 of liquidity at a
// 4% round trip and $5,000 at 6%, while the momentum rule fires from $2,000,
// so bots passed over many scalp signals as "too thin".)
//
// The balance comes first (owner's request, 2026-10-01: "auto check the
// balance and don't use a high amount per trade on a small-capital bot"): no
// trade is more than 20% of what the bot is worth (paper: cash plus open
// trades; live: its wallet's USDC, read again before every buy, plus open
// trades). A bot too small for its target at that share trades the 20% and
// aims for what it nets, as long as that's at least $0.25; below that it
// waits. A pool too thin for the target isn't a reason to put more in: that
// case keeps the rule above.

import { costPerSide, type Strategy } from '../trading/paper'

/** Profit per winning trade, USD: [low, high] of the range, and the default target. Scalps $1–2, the others $1–5 (owner, 2026-09-30). */
export const TARGETS: Record<Strategy, { range: [number, number]; target: number }> = {
  scalp: { range: [1, 2], target: 1.5 },
  snipe: { range: [1, 5], target: 3 },
  'second-leg': { range: [1, 5], target: 3 },
}

export const SIZE_LIMITS = {
  minUsd: 2, maxUsd: 250, stepUsd: 0.5,
  /** No trade over this share of what the bot is worth. */
  maxShareOfBalance: 0.2,
  /** A small bot's trade must still net at least this at its take-profit. */
  minNetUsd: 0.25,
}

/** The most one trade may put in, for a bot worth `balanceUsd` (in $0.50 steps). */
export function maxTradeFor(balanceUsd: number): number {
  const cap = Math.floor(Math.max(0, balanceUsd) * SIZE_LIMITS.maxShareOfBalance / SIZE_LIMITS.stepUsd) * SIZE_LIMITS.stepUsd
  return Math.min(SIZE_LIMITS.maxUsd, Math.round(cap * 100) / 100)
}

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

/**
 * A trade's size: the smallest that nets `targetUsd`, else the smallest that
 * nets the low end of the strategy's range (`targetUsd` in the answer says
 * which), or null when not even that can be netted. With `balanceUsd`, no
 * size over 20% of it: a bot too small for its target trades that 20% and
 * aims for what it nets (`small`), if at least $0.25.
 */
export function sizeForTrade(o: { strategy: Strategy; targetUsd: number; takeProfit: number; roundTripPct: number | null; liquidityUsd: number | null; balanceUsd?: number }): (Sized & { targetUsd: number; small?: boolean }) | null {
  const cap = o.balanceUsd === undefined ? SIZE_LIMITS.maxUsd : maxTradeFor(o.balanceUsd)
  const full = sizeForTarget({ ...o, maxUsd: cap })
  if (full) return { ...full, targetUsd: o.targetUsd }
  // Whether the bot's balance, not the pool, is what keeps it from the full target.
  const small = cap < SIZE_LIMITS.maxUsd && !!sizeForTarget(o)
  const floor = TARGETS[o.strategy].range[0]
  if (floor < o.targetUsd) {
    const low = sizeForTarget({ ...o, targetUsd: floor, maxUsd: cap })
    if (low) return { ...low, targetUsd: floor, ...(small ? { small } : {}) }
  }
  // The pool could take the trade, the bot's balance can't: the 20% share, for what it nets.
  if (cap >= SIZE_LIMITS.minUsd && cap < SIZE_LIMITS.maxUsd && sizeForTarget({ ...o, targetUsd: Math.min(floor, o.targetUsd), maxUsd: SIZE_LIMITS.maxUsd })) {
    const net = netAtTakeProfit(cap, o.takeProfit, o.roundTripPct, o.liquidityUsd)
    if (net >= SIZE_LIMITS.minNetUsd) {
      const profit = Math.round(net * 100) / 100
      return { sizeUsd: cap, profitUsd: profit, costPct: Math.round(costPerSide(o.roundTripPct, cap, o.liquidityUsd) * 10_000) / 100, targetUsd: profit, small: true }
    }
  }
  return null
}

/** Why `sizeForTrade` found no size, in words (for the bot's list of signals passed over). */
export function noSizeWhy(o: { strategy: Strategy; takeProfit: number; roundTripPct: number | null; liquidityUsd: number | null; balanceUsd?: number }): { key: 'small-balance' | 'too-thin'; why: string } {
  const floor = TARGETS[o.strategy].range[0]
  const pct = `${o.takeProfit >= 1 ? '+' : ''}${Math.round((o.takeProfit - 1) * 100)}%`
  if (o.balanceUsd !== undefined && sizeForTarget({ targetUsd: floor, takeProfit: o.takeProfit, roundTripPct: o.roundTripPct, liquidityUsd: o.liquidityUsd })) {
    const cap = maxTradeFor(o.balanceUsd)
    return { key: 'small-balance', why: `the bot is worth $${o.balanceUsd.toFixed(2)}: a trade is at most ${Math.round(SIZE_LIMITS.maxShareOfBalance * 100)}% of it ($${cap.toFixed(2)}), too little to net $${SIZE_LIMITS.minNetUsd.toFixed(2)} at ${pct} in this pool` }
  }
  return { key: 'too-thin', why: `the pool is too thin (or the coin too costly to trade) to net even $${floor} at ${pct}` }
}
