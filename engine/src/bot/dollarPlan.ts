// Live trading on the $2 plan ("the dollar plan"; BOT_LIVE_GRADES=dollar, the default).
//
// Version 1 (2026-10-01 06:00 UTC, owner: "bring back LIVE trading using the snipe and fast scalp strategies …
// at only $2 a trade, take $1 profit and close; let the agent also self improve by learning from mistakes"): $2 a
// trade, all of it sold once it made $1 (about +52%), held up to 10–20 minutes. Its live bots took one trade in four
// hours: the filters they learned from the replays (no run-up over +8%, no copycat flag, …) and the losing patterns
// left almost nothing to buy.
//
// Version 2, quick take-profits (2026-10-01 12:45 UTC, owner: "Nothing happened, no trades, I hate waiting for hours
// in meme coin trading, I prefer quick take profits and leave"):
//
//   signals   snipes (clean coins, and risky coins as fast scalps), with the rules of the afternoon of 30 September
//             (signals/rules.ts), on coins with no more than 80 buyers in and no wallet over 15% of the buying.
//             Momentum bursts and comebacks are replayed and measured first, and traded live once their replays prove
//             them (PROVE_FIRST).
//   size      $2 a trade, flat.
//   exit      all of it once selling nets +7.5% after costs (about +10% on the price, $0.15 on $2), else out at −7%,
//             when the creator sells, or after 3 minutes.
//   learning  every signal is replayed on its coin's real trades at live speed with these exits (Bot.replayDue).
//             Each live bot learns its own entry filters per kind of signal from its own live trades and the team's,
//             starting open again on this version; a lesson that would turn away more than half of a kind's recent
//             signals isn't taken (QUICK_LEARN), so learning can't stop a bot from trading again.
//
// Measured before the switch: every snipe and momentum signal of the last two days (166 fired by the rules on 72
// hours of real trades, 64 production fired after its safety scanner), traded at live speed (buys 2.5s after the
// signal, sales 2s after their trigger, 1.2% a side), gains over +20% counted as +20 so one spike can't carry a result:
//   snipes, 80 buyers or fewer   research: 48 trades, 85% won, +3.1% a trade; production: 30 trades, 80% won,
//                                +0.7% a trade (+5.3% and −1.6% in its two halves). Half the trades were over in
//                                under 40 seconds.
//   … and no wallet over 15%     both together: 55 trades (about 30 a day), 87% won, +3.8% a trade, in profit in both
//     of the buying              halves (+5.7% and +1.3%), and no rug. Over 15%: 23 trades, −1.8% a trade, and both
//                                of the sample's rugs. The largest buyer's share was already the best separator of
//                                winners on 30 September (signals/grades.ts).
//   momentum bursts              production: 24 trades, 46% won, −7.9% a trade, with every exit tried.
//   80+ buyers already in        far worse in every version: the crowd has already bought.
// Then checked on the signals that fired on 1 October after that sample (06:00–12:48 UTC): with no wallet over 15%,
// 6 trades, 5 won, +$0.50; over 15%, 7 trades and −$4.71, among them all three of the day's rugs (NOAH 24.9%, UBI 17.2%,
// 四 20.9%: −76% to −86% each, which no stop catches at live speed). Small samples: nothing here guarantees a profit.

import type { SignalFeatures, SignalRule } from '../../../api/_marketProtocol'
import type { Position, Strategy, StrategyParams } from '../trading/paper'
import { defaultTuning, type LearnOptions, type Tuning } from './learner'

export const DOLLAR_PLAN = {
  /** Bumped when the plan's exits change: a live bot's learned filters start over on a new version. */
  version: 2,
  sizeUsd: 2,
  /** All of it is sold once selling nets this much over what it paid (+7.5%, about +10% on the price). */
  netGain: 0.075,
  /** The strategies live bots trade on the plan. */
  strategies: ['snipe', 'scalp', 'second-leg'] as const,
  exits: {
    snipe: { stopLoss: 0.93, maxHoldMin: 3 },
    scalp: { stopLoss: 0.93, maxHoldMin: 3 },
    'second-leg': { stopLoss: 0.93, maxHoldMin: 3 },
  },
  /** No coin with more buyers than this already in (the crowd has bought: far worse in every test). */
  maxBuyers: 80,
  /** No coin where one wallet bought more than this share of the market's own buying, in percent (who dumps first). */
  maxTopBuyerPct: 15,
  /** When this version started (its trades and the day's loss are counted from then). */
  since: Date.UTC(2026, 9, 1, 12, 45),
}

/** What one winning trade makes at the take-profit, before the platform's 15% fee. */
export const DOLLAR_TARGET_USD = Math.round(DOLLAR_PLAN.sizeUsd * DOLLAR_PLAN.netGain * 100) / 100

export type DollarStrategy = (typeof DOLLAR_PLAN.strategies)[number]
export const isDollarStrategy = (s: Strategy | string): s is DollarStrategy => s === 'snipe' || s === 'scalp' || s === 'second-leg'

/**
 * Kinds of signal measured first and traded live only once proven: momentum bursts (production's lost 8% a trade with
 * quick exits) and comebacks (re-entering a coin after it dumped lost in every version tried). Live bots take one once
 * its last replays on the plan number 10+, won half or more, and made money.
 */
export const PROVE_FIRST: { rules: readonly SignalRule[]; minReplays: number; minWinRate: number } = { rules: ['momentum', 'second-leg'], minReplays: 10, minWinRate: 0.5 }

/** How a live bot learns on the plan: the take-profit never moves, and no lesson may turn away over half the signals. */
export const QUICK_LEARN: LearnOptions = { pinTakeProfit: true, minAdmitShare: 0.5 }

/**
 * The price, as a multiple of the entry the exits compare against, at which selling all of it nets `netGain`.
 * `costIn`: the buy's cost not yet in that entry (paper: the modelled cost; live: 0, its entry is what it paid);
 * `costOut`: the sale's.
 */
export function dollarTakeProfit(o: { netGain?: number; costIn: number; costOut: number }): number {
  const net = o.netGain ?? DOLLAR_PLAN.netGain
  return Math.round((1 + net) * ((1 + o.costIn) / (1 - Math.min(0.5, o.costOut))) * 10_000) / 10_000
}

/** A trade's exits on the plan: all of it at +7.5% after costs, −7%, out when the creator sells, 3 minutes at most. */
export function dollarParams(s: DollarStrategy, o: { costIn: number; costOut: number; sizeUsd?: number }): StrategyParams {
  const e = DOLLAR_PLAN.exits[s]
  return {
    sizeUsd: o.sizeUsd ?? DOLLAR_PLAN.sizeUsd,
    stopLoss: e.stopLoss,
    tp1Multiple: dollarTakeProfit({ costIn: o.costIn, costOut: o.costOut }),
    tp1SellPct: 1,
    trailFromPeak: 0.25,
    // No earlier time stop: the whole trade is 3 minutes.
    timeStopMin: e.maxHoldMin,
    timeStopMinGain: 0,
    maxHoldMin: e.maxHoldMin,
    exitOnCreatorSell: true,
  }
}

/** Why live bots don't trade a signal on the plan whatever they learned, or null. A number the signal lacks isn't checked. */
export function planBlocks(f: SignalFeatures | undefined): { key: 'crowded' | 'top-buyer'; why: string } | null {
  if (f?.totalBuyers != null && f.totalBuyers > DOLLAR_PLAN.maxBuyers) return { key: 'crowded', why: `${f.totalBuyers} buyers already in (live bots buy coins with ${DOLLAR_PLAN.maxBuyers} or fewer: later, the crowd has bought)` }
  if (f && f.topBuyerPct > DOLLAR_PLAN.maxTopBuyerPct) return { key: 'top-buyer', why: `one wallet bought ${Math.round(f.topBuyerPct)}% of the buying (live bots buy coins where none is over ${DOLLAR_PLAN.maxTopBuyerPct}%: a big early wallet is who dumps)` }
  return null
}

/** A position traded on the plan (live bots' trades, and the replays of every signal). */
export const isDollarTrade = (p: Pick<Position, 'plan'>) => p.plan === 'dollar'

/** The plan in words, for the site. */
export function dollarPlanText(s: DollarStrategy): string {
  const e = DOLLAR_PLAN.exits[s]
  return `$${DOLLAR_PLAN.sizeUsd} a trade, all of it sold at +${Math.round(DOLLAR_PLAN.netGain * 1_000) / 10}% after costs (about +10% on the price); out at −${Math.round((1 - e.stopLoss) * 100)}%, when the creator sells, or after ${e.maxHoldMin} minutes`
}

/**
 * A live bot's settings on the plan, per strategy: the plan's exits (fixed) and the entry filters it learns per kind of
 * signal (open to start with). `livePlan` says which version they were learned on.
 */
export function defaultDollarTuning(s: DollarStrategy): Tuning {
  const e = DOLLAR_PLAN.exits[s]
  return { ...defaultTuning(s), takeProfit: 1 + DOLLAR_PLAN.netGain, stopLoss: e.stopLoss, timeStopMin: e.maxHoldMin, maxHoldMin: e.maxHoldMin, targetUsd: DOLLAR_TARGET_USD, livePlan: DOLLAR_PLAN.version }
}

/** A live bot's settings learned on an earlier version of the plan start over (their filters were learned on other exits). */
export const onThisPlan = (t: Tuning | undefined): t is Tuning => !!t && t.livePlan === DOLLAR_PLAN.version
