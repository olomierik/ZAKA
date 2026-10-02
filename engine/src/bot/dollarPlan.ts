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
//   size      20% of what the bot's wallet is worth, at least $2 and at most $50, since 2026-10-01 15:00 UTC (owner:
//             "change the cap according to increase on capital"): it grows and shrinks with the capital. $2 flat at
//             first, then $8 from 14:30 (still capped at 20% of the wallet).
//   no stops  live bots on the plan are never stopped by losses (owner, same time: "do not allow the bot to be stopped
//             even if there is a rug"): no daily loss limit, no pause after losing trades, no switch back to paper.
//             They trade as long as the wallet can pay $2 and gas. A rug still costs most of its trade.
//   exit      all of it once selling nets +7.5% after costs (about +10% on the price, $0.60 on $8), else out at −7%,
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
//
// Version 3, out before the launcher dumps (2026-10-02, owner: "improve the engine trade size and profitability and
// also signal firing rate"). Live bots' snipe-scalps had won 34 of 44 on version 2 and lost $48.38: every win was
// +$0.12 to +$1.09, every loss a serial launcher selling its $2,500 launch bag 50-150 seconds after launch (−75%, the
// rug guard selling after it). Those launchers' coins rise about 0.2% a second until then; version 2 bought about 44s
// after launch and held for +10%, which took another ~45s, into the dump.
//   signals   snipes fire earlier (signals/rules.ts: 10 market buyers, $60 bought, no wallet over 15%; median 32s).
//   exit      a snipe (clean or risky) is sold once selling nets +3% after costs (about +4% on the price), or after 30
//             seconds, at −7%, or when the creator sells (SNIPE_EXITS). Other kinds keep their exits.
//   size      20% of what the wallet is worth, at least $2, as before; no longer capped at $50 but at 0.5% of the
//             coin's liquidity (a bigger buy moves the price more than the take-profit is worth) and $500, so it keeps
//             growing with the capital.
// Replayed on 11 hours of production's trades (652 coins; the signal 2.4s after the rule is met, the buy 2.5s later,
// 1% a side): version 2's rule and exits, 95 trades, −2.7% a trade, 10 rugs; version 3, 170 trades, 90% won, +1.8% a
// trade (+0.9% and +2.7% in the halves), 3 rugs. Most trades are small wins and a rug still costs most of its trade.

import type { SignalFeatures, SignalRule } from '../../../api/_marketProtocol'
import type { Position, Strategy, StrategyParams } from '../trading/paper'
import { CREATOR_MEMORY, launcherRate } from './creatorMemory'
import { defaultTuning, type LearnOptions, type Tuning } from './learner'

export const DOLLAR_PLAN = {
  /** Bumped when the plan's exits change: a live bot's learned filters start over on a new version. */
  version: 3,
  /**
   * The reference size: the replays and their dollar figures, and the platform's own bot. Visitors' live bots trade
   * `wallet` below instead.
   */
  sizeUsd: 8,
  /**
   * A live bot's trade: this share of what its wallet is worth (USDC plus open trades at cost), at least `minUsd`, at
   * most `maxUsd` and at most `maxLiquidityPct` of the coin's liquidity (version 3: the cap follows the pool, not $50).
   */
  wallet: { sharePct: 20, minUsd: 2, maxUsd: 500, maxLiquidityPct: 0.5 },
  /** Live bots on the plan are never stopped by losses: no daily loss limit, no pause after losses, no switch back to paper. */
  neverStops: true,
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
  since: Date.UTC(2026, 9, 2, 13),
}

/**
 * A snipe's exits on the plan (version 3), whatever kind of trade carries it (a clean coin's snipe, a risky coin's fast
 * scalp): all of it once selling nets +3% after costs (about +4% on the price), out at −7%, when the creator sells, or
 * after 30 seconds. +4% within 30s, +5% within 30s and +4% within 20s did about as well; +8.7% within 3 minutes (version
 * 2) lost 2.7% a trade.
 */
export const SNIPE_EXITS = { netGain: 0.03, stopLoss: 0.93, maxHoldMin: 0.5 }

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

/**
 * A volume spike's exits (owner, 2026-10-01: "take 25% of profit"): all of it at +25% on the price (+22.5% after costs),
 * out at −10%, when the creator sells, or after 20 minutes. Its own, whatever kind of trade carries it (signals/rules.ts
 * RULES.volume: +25% made more than +10% or +15% on the same signals).
 */
export const VOLUME_EXITS = { netGain: 0.225, stopLoss: 0.9, maxHoldMin: 20 }

/** A volume spike's trade: all of it at +25% on the price, −10%, out when the creator sells, 20 minutes at most. */
export function volumeParams(o: { costIn: number; costOut: number; sizeUsd: number }): StrategyParams {
  return {
    sizeUsd: o.sizeUsd, stopLoss: VOLUME_EXITS.stopLoss, tp1Multiple: dollarTakeProfit({ netGain: VOLUME_EXITS.netGain, costIn: o.costIn, costOut: o.costOut }), tp1SellPct: 1, trailFromPeak: 0.25,
    timeStopMin: VOLUME_EXITS.maxHoldMin, timeStopMinGain: 0, maxHoldMin: VOLUME_EXITS.maxHoldMin, exitOnCreatorSell: true,
  }
}

/**
 * A trade's exits on the plan: all of it at +7.5% after costs, −7%, out when the creator sells, 3 minutes at most (a
 * snipe: +3% and 30 seconds, SNIPE_EXITS; a volume spike: its own).
 */
export function dollarParams(s: DollarStrategy, o: { costIn: number; costOut: number; sizeUsd?: number }, rule?: SignalRule | null): StrategyParams {
  if (rule === 'volume') return volumeParams({ ...o, sizeUsd: o.sizeUsd ?? DOLLAR_PLAN.sizeUsd })
  const e = rule === 'snipe' ? SNIPE_EXITS : { ...DOLLAR_PLAN.exits[s], netGain: DOLLAR_PLAN.netGain }
  return {
    sizeUsd: o.sizeUsd ?? DOLLAR_PLAN.sizeUsd,
    stopLoss: e.stopLoss,
    tp1Multiple: dollarTakeProfit({ netGain: e.netGain, costIn: o.costIn, costOut: o.costOut }),
    tp1SellPct: 1,
    trailFromPeak: 0.25,
    // No earlier time stop: the whole trade is 3 minutes (a snipe's 30 seconds).
    timeStopMin: e.maxHoldMin,
    timeStopMinGain: 0,
    maxHoldMin: e.maxHoldMin,
    exitOnCreatorSell: true,
  }
}

/**
 * Why live bots don't trade a signal on the plan whatever they learned, or null. A number the signal lacks isn't checked.
 * A volume spike has its own floors (signals/rules.ts RULES.volume: 30+ holders, $6k+ cap, $5k+ liquidity) and is
 * mostly on coins with a big crowd already, so the snipes' limits don't apply to it.
 */
export function planBlocks(f: SignalFeatures | undefined, rule?: SignalRule | null): { key: 'crowded' | 'top-buyer' | 'dumper'; label: string; why: string } | null {
  if (rule === 'volume') return null
  // A snipe on a launcher that dumped its recent coins early (bot/creatorMemory.ts), whatever else it shows.
  if (rule === 'snipe' && f?.launcherCoins != null && launcherRate(f.launcherDumps ?? 0, f.launcherCoins) > CREATOR_MEMORY.maxRate) {
    const label = `its launcher dumped ${f.launcherDumps} of its last ${f.launcherCoins} coin${f.launcherCoins === 1 ? '' : 's'} within 5 minutes`
    return { key: 'dumper', label, why: `${label} (live bots skip a launcher that sells its whole launch buy early, until three clean coins)` }
  }
  if (f?.totalBuyers != null && f.totalBuyers > DOLLAR_PLAN.maxBuyers) {
    const label = `${f.totalBuyers} buyers already in`
    return { key: 'crowded', label, why: `${label} (live bots buy coins with ${DOLLAR_PLAN.maxBuyers} or fewer: later, the crowd has bought)` }
  }
  if (f && f.topBuyerPct > DOLLAR_PLAN.maxTopBuyerPct) {
    const label = `one wallet bought ${Math.round(f.topBuyerPct)}% of the buying`
    return { key: 'top-buyer', label, why: `${label} (live bots buy coins where none is over ${DOLLAR_PLAN.maxTopBuyerPct}%: a big early wallet is who dumps)` }
  }
  return null
}

/**
 * A live bot's trade on the plan: 20% of what its wallet is worth, in $0.10 steps, at least $2, at most $500 and at
 * most 0.5% of the coin's liquidity when that's known (never under $2: the trader still checks what the wallet can pay).
 */
export function dollarTradeSize(worthUsd: number, liquidityUsd?: number | null): number {
  const w = DOLLAR_PLAN.wallet
  const pool = liquidityUsd && liquidityUsd > 0 ? Math.floor((liquidityUsd * w.maxLiquidityPct) / 10 + 1e-9) / 10 : Infinity
  return Math.max(w.minUsd, Math.min(w.maxUsd, pool, Math.floor((worthUsd * w.sharePct) / 10 + 1e-9) / 10))
}

/** A position traded on the plan (live bots' trades, and the replays of every signal). */
export const isDollarTrade = (p: Pick<Position, 'plan'>) => p.plan === 'dollar'

/** The plan in words, for the site. */
export function dollarPlanText(s: DollarStrategy): string {
  const e = DOLLAR_PLAN.exits[s]
  return `${DOLLAR_PLAN.wallet.sharePct}% of the wallet a trade (at least $${DOLLAR_PLAN.wallet.minUsd}), all of it sold at +${Math.round(DOLLAR_PLAN.netGain * 1_000) / 10}% after costs (about +10% on the price); out at −${Math.round((1 - e.stopLoss) * 100)}%, when the creator sells, or after ${e.maxHoldMin} minutes`
}

/** A snipe's exits in words (version 3). */
export const snipePlanText = () =>
  `snipes: ${DOLLAR_PLAN.wallet.sharePct}% of the wallet a trade (at least $${DOLLAR_PLAN.wallet.minUsd}, at most ${DOLLAR_PLAN.wallet.maxLiquidityPct}% of the coin's liquidity), all of it sold at +${Math.round(SNIPE_EXITS.netGain * 1_000) / 10}% after costs (about +4% on the price); out at −${Math.round((1 - SNIPE_EXITS.stopLoss) * 100)}%, when the creator sells, or after ${Math.round(SNIPE_EXITS.maxHoldMin * 60)} seconds`

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
