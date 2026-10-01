// Live trading on the dollar plan (owner, 2026-10-01: "bring back LIVE trading
// using the snipe and fast scalp strategies that paper bots used yesterday
// afternoon and were self improving; live bots trade those signals at only $2
// a trade, take $1 profit and close; let the agent also self improve by
// learning from mistakes"). The default since then (BOT_LIVE_GRADES=dollar).
//
//   signals   snipes and fast scalps, with the rules as they were on the
//             afternoon of 30 September (signals/rules.ts). No grade, quality
//             or strategy-board gate: a live bot takes every one, whatever it
//             picked, unless its rule is on probation (below) or the bot
//             learned to skip it.
//   size      $2 a trade, flat (it no longer grows with profit).
//   exit      all of it once selling would make $1 (about +52% after the
//             sale's cost), else out at −10% (fast scalps −7%), when the
//             creator sells, or after 10 minutes (fast scalps 20). The $1 is
//             the trade's profit before the platform's 15% fee.
//   learning  every snipe and fast-scalp signal is replayed on its coin's real
//             trades at live speed with this plan (Bot.replayDue): a rule
//             whose last 20 replays lost money and won under half is on
//             probation, and live bots sit it out. Each live bot also learns
//             its own entry filters per kind of signal (bot/learner.ts) from
//             its own live trades and the team's (every other live bot's, and
//             the replays), and skips a kind that lost 3 of its last 4 for
//             12 hours. The take-profit stays at $1: learning changes what it
//             buys, never the target.
//
// Measured before it went live, on 72 hours of real trades (149 coins; buys
// 2.5s after the signal, sales 2s after their trigger, 1.2% a side), with the
// rules of that afternoon fired on every coin:
//   snipes       54 trades, 20 sold at +$1, 39 closed in profit, +$0.13 a
//                trade ($6.85 in all), in profit in both halves of the period
//                (+7.7% and +4.5% a trade); the average loser lost 32%, the
//                worst 90% (a rug no stop catches at live speed).
//   fast scalps  112 trades, +$0.02 to +$0.04 a trade: about break-even.
// On the signals production actually fired (after the safety scanner), the
// same plan made +3.4% a trade on snipes on risky coins (25 trades) and lost
// 20% a trade on momentum bursts (22): probation keeps those off live bots
// until their replays recover. Nothing here guarantees a profit.

import type { Position, Strategy, StrategyParams } from '../trading/paper'
import { defaultTuning, type Tuning } from './learner'

export const DOLLAR_PLAN = {
  sizeUsd: 2,
  targetUsd: 1,
  /**
   * The strategies live bots trade on the plan. A comeback (the dip-rebound rule, `second-leg`: a coin that ran, pulled
   * back and is being bought again) only once its own replays prove it (COMEBACK).
   */
  strategies: ['snipe', 'scalp', 'second-leg'] as const,
  exits: {
    snipe: { stopLoss: 0.9, maxHoldMin: 10 },
    scalp: { stopLoss: 0.93, maxHoldMin: 20 },
    'second-leg': { stopLoss: 0.9, maxHoldMin: 20 },
  },
  /** When the plan started (its trades and replays are judged from then). */
  since: Date.UTC(2026, 9, 1, 6, 0),
}

export type DollarStrategy = (typeof DOLLAR_PLAN.strategies)[number]
export const isDollarStrategy = (s: Strategy | string): s is DollarStrategy => s === 'snipe' || s === 'scalp' || s === 'second-leg'

/**
 * Comebacks are watched and measured from the start, and traded live only once proven (2026-10-01): re-entering a coin
 * after it dumped lost in every version tried on two days of trades. Live bots take a comeback once its last replays on
 * the plan number 10+, won half or more, and made money.
 */
export const COMEBACK = { minReplays: 10, minWinRate: 0.5 }

/**
 * The price, as a multiple of the entry the exits compare against, at which
 * selling all of it makes `targetUsd` on `sizeUsd`. `costIn`: the buy's cost
 * not yet in that entry (paper: the modelled cost; live: 0, its entry is what
 * it paid); `costOut`: the sale's.
 */
export function dollarTakeProfit(o: { sizeUsd?: number; targetUsd?: number; costIn: number; costOut: number }): number {
  const size = o.sizeUsd ?? DOLLAR_PLAN.sizeUsd, target = o.targetUsd ?? DOLLAR_PLAN.targetUsd
  return Math.round(((size + target) / size) * ((1 + o.costIn) / (1 - Math.min(0.5, o.costOut))) * 10_000) / 10_000
}

/** A trade's exits on the plan: all of it at +$1, the stop, out when the creator sells, the longest hold. */
export function dollarParams(s: DollarStrategy, o: { costIn: number; costOut: number; sizeUsd?: number }): StrategyParams {
  const e = DOLLAR_PLAN.exits[s]
  return {
    sizeUsd: o.sizeUsd ?? DOLLAR_PLAN.sizeUsd,
    stopLoss: e.stopLoss,
    tp1Multiple: dollarTakeProfit({ sizeUsd: o.sizeUsd, costIn: o.costIn, costOut: o.costOut }),
    tp1SellPct: 1,
    trailFromPeak: 0.25,
    // No early time stop: a trade gets its whole hold to reach +$1.
    timeStopMin: e.maxHoldMin,
    timeStopMinGain: 0,
    maxHoldMin: e.maxHoldMin,
    exitOnCreatorSell: true,
  }
}

/** A position traded on the plan (live bots' trades, and the replays of every signal). */
export const isDollarTrade = (p: Pick<Position, 'plan'>) => p.plan === 'dollar'

/** The plan in words, for the site. */
export function dollarPlanText(s: DollarStrategy): string {
  const e = DOLLAR_PLAN.exits[s]
  return `$${DOLLAR_PLAN.sizeUsd} a trade, all of it sold once it makes $${DOLLAR_PLAN.targetUsd}; out at −${Math.round((1 - e.stopLoss) * 100)}%, when the creator sells, or after ${e.maxHoldMin} minutes`
}

/**
 * A live bot's settings on the plan, per strategy: the plan's exits (fixed) and
 * the entry filters it learns per kind of signal (open to start with).
 */
export function defaultDollarTuning(s: DollarStrategy): Tuning {
  const e = DOLLAR_PLAN.exits[s]
  return { ...defaultTuning(s), takeProfit: 1 + DOLLAR_PLAN.targetUsd / DOLLAR_PLAN.sizeUsd, stopLoss: e.stopLoss, timeStopMin: e.maxHoldMin, maxHoldMin: e.maxHoldMin, targetUsd: DOLLAR_PLAN.targetUsd }
}
