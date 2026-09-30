// Which signals go to live bots (owner's request, 2026-09-30: "prioritize
// the signals: 80% to the live bots and 20% to paper bots; improve the signal
// quality"). Every signal gets a quality score, 0–100, from what the team's
// trades showed matters, and is ranked against the last 50 signals:
//
//   the top 80%      live-grade: every bot may trade it, live or paper
//   the bottom 20%   paper only: live bots pass it over, paper bots still
//                    trade it, so it's still measured
//
// Within live-grade, the top half is tier A: a bot puts 20% of its capital
// into it; the rest, and paper-only signals, 10% (bot/sizing.ts).
//
// The score (weights are a starting point, read from the trades up to then):
//
//   35  the rule's recent record: the win rate of its last 20 trades across
//       the team (every bot's and the engine's paper book, one per signal);
//       0.5 while it has fewer than 5
//   20  buyers over sellers: every clean snipe that won had no sells yet, or
//       buys 5× sells or more; BAGEY, bought at 1.6× with 10 wallets already
//       selling 22 seconds in, dumped 32% six seconds after the buy
//   20  the safety score
//   10  buyers (15 or more is full marks)
//   10  the largest buyer's share of the buying (none over 40%)
//    5  what buying and selling back costs (none at 8% or more)
//
// Nothing here promises a win: it ranks the signals so the best of them go
// where the money is.

import type { SignalFeatures, SignalQuality } from '../../../api/_marketProtocol'

export const QUALITY = {
  /** Signals the rank is taken over, and the fewest it needs (before that: live-grade, tier by score). */
  window: 50,
  minWindow: 8,
  /** Share of signals that are live-grade, and the top share of all that is tier A. */
  liveShare: 0.8,
  tierAShare: 0.4,
  /** Before the window fills: tier A from this score. */
  tierAScore: 80,
  /** A rule's record: its last this many trades, and it counts from this many. */
  ruleWindow: 20,
  ruleMinTrades: 5,
}

export interface RuleRecord { trades: number; winRate: number | null }

const clamp = (x: number) => Math.max(0, Math.min(1, x))

/** The score, 0–100, and its parts in words. */
export function qualityScore(f: SignalFeatures, rec: RuleRecord): { score: number; parts: string[] } {
  const ruleWr = rec.trades >= QUALITY.ruleMinTrades && rec.winRate !== null ? rec.winRate : 0.5
  const dominance = f.buySellRatio === null ? 1 : clamp((f.buySellRatio - 1) / 4)
  const parts: [number, string][] = [
    [35 * ruleWr, rec.trades >= QUALITY.ruleMinTrades ? `the rule won ${Math.round(ruleWr * 100)}% of its last ${rec.trades}` : 'the rule is new: counted as even'],
    [20 * dominance, f.buySellRatio === null ? 'no sells yet' : `buys ${f.buySellRatio.toFixed(1)}× sells`],
    [20 * clamp(f.score / 100), `safety ${f.score}`],
    [10 * clamp(f.buyers / 15), `${f.buyers} buyers`],
    [10 * (1 - clamp(f.topBuyerPct / 40)), `largest buyer ${Math.round(f.topBuyerPct)}%`],
    [5 * (1 - clamp((f.roundTripPct ?? 4) / 8)), f.roundTripPct === null ? 'round trip not measured' : `round trip ${f.roundTripPct.toFixed(1)}%`],
  ]
  return { score: Math.round(parts.reduce((s, [x]) => s + x, 0)), parts: parts.map(([, w]) => w) }
}

/** The last signals' scores, and where a new one ranks among them. */
export class QualityRank {
  private scores: number[] = []

  /** Grades `score` against the window, then adds it. */
  grade(score: number, add = true): Pick<SignalQuality, 'grade' | 'tier' | 'rank'> {
    const w = this.scores
    let out: Pick<SignalQuality, 'grade' | 'tier' | 'rank'>
    if (w.length < QUALITY.minWindow) out = { grade: 'live', tier: score >= QUALITY.tierAScore ? 'A' : 'B', rank: null }
    else {
      // The share of recent signals this one scores at least as well as.
      const rank = w.filter(x => x <= score).length / w.length
      out = { grade: rank >= 1 - QUALITY.liveShare ? 'live' : 'paper', tier: rank >= 1 - QUALITY.tierAShare ? 'A' : 'B', rank: Math.round(rank * 100) / 100 }
    }
    if (add) this.add(score)
    return out
  }

  add(score: number) {
    this.scores.push(score)
    if (this.scores.length > QUALITY.window) this.scores.shift()
  }

  get size() { return this.scores.length }
}
