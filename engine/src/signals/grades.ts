// Signal grades (owner's request, 2026-09-30: "the highest tier gets the
// highest-quality signals, even at a small % gain, with a strategy made for
// them"). Every signal is graded when it fires:
//
//   prime     the cleanest: the market's own buying, spread wide and early.
//             Traded by the Precision strategy: all of it sold at a small gain
//             (+6%), fast. The top tier's signals.
//   core      clean, not Prime: a wide crowd of buyers, buying well ahead of
//             selling, not yet run up.
//   standard  every other signal a bot may trade (not on probation).
//
// Why these lines (every stored signal replayed at live speed on the coin's
// real trades, 2026-09-30, 43 bought of 52):
//   - The largest single buyer's share of the buying separated winners best:
//     11 signals at 10% or less won 72% (the default exits), those above 20%
//     won 26%. With 30+ buyers, buys at least 5× sells, the price not yet up
//     10% and a round trip of 3% or less, the 11 Prime signals sold in full at
//     +4% to +10% won 10 of 11 (at +6%: +3.1% a trade, the one loss −0.5%).
//     Their take-profit came 10–48s after the signal; the coin's creator first
//     sold 33–503s after it (about two minutes typically). Out before the creator.
//   - Every other signal, at the same exits: 8 of 12 won, −3.6% a trade.
//   - A risk flag (the creator holding a lot, a serial launcher) didn't mark
//     the losers: the Prime signals all had one.
//
// That's one day of signals, and most Prime coins came from one serial
// launcher's pattern. So a grade's own record is kept (every signal replayed
// at live speed with its grade's exits, GradeBook below), shown to everyone,
// and a grade whose record fails is put under review: its signals are handed
// out one grade lower until it recovers. Nothing here promises a win.

import type { SignalFeatures, SignalGrade, SignalRule } from '../../../api/_marketProtocol'

export const GRADES: readonly SignalGrade[] = ['prime', 'core', 'standard']

export const GRADE_RULES = {
  prime: { maxTopBuyerPct: 10, minBuyers: 30, minBuySellRatio: 5, maxRunUp: 1.1, maxRoundTripPct: 3, minLiquidityUsd: 5_000 },
  core: { maxTopBuyerPct: 20, minBuyers: 15, minBuySellRatio: 3, maxRunUp: 1.2, maxRoundTripPct: 5, minLiquidityUsd: 3_000 },
} as const

/** A grade's record fails review when its last replays (at least `minTrades`) average under `minAvg`, or win under `minWinRate`. */
export const GRADE_REVIEW = { minTrades: 10, window: 20, minAvg: 0, minWinRate: 0.6, days: 7 }

type Line = { ok: boolean; text: string }

function lines(f: SignalFeatures, r: (typeof GRADE_RULES)['prime' | 'core']): Line[] {
  const ratio = f.buySellRatio
  const rt = f.roundTripPct ?? 4
  return [
    { ok: f.topBuyerPct <= r.maxTopBuyerPct, text: `largest buyer ${Math.round(f.topBuyerPct)}% (≤ ${r.maxTopBuyerPct}%)` },
    { ok: f.buyers >= r.minBuyers, text: `${f.buyers} buyers (${r.minBuyers}+)` },
    { ok: ratio === null || ratio >= r.minBuySellRatio, text: ratio === null ? 'no sells yet' : `buys ${ratio.toFixed(1)}× sells (${r.minBuySellRatio}×+)` },
    { ok: (f.runUp ?? 1) <= r.maxRunUp, text: `run-up ${f.runUp === null ? 'none' : `+${Math.round((f.runUp - 1) * 100)}%`} (≤ +${Math.round((r.maxRunUp - 1) * 100)}%)` },
    { ok: rt <= r.maxRoundTripPct, text: `round trip ${rt.toFixed(1)}% (≤ ${r.maxRoundTripPct}%)` },
    { ok: (f.liquidityUsd ?? 0) >= r.minLiquidityUsd, text: `liquidity $${Math.round(f.liquidityUsd ?? 0).toLocaleString('en-US')} ($${r.minLiquidityUsd.toLocaleString('en-US')}+)` },
  ]
}

/** A signal's grade, and why: what it met of the grade it got, or what it missed of the one above. */
export function gradeOf(f: SignalFeatures | undefined, _rule?: SignalRule): { grade: SignalGrade; why: string[] } {
  if (!f) return { grade: 'standard', why: ['no numbers to grade it on'] }
  const prime = lines(f, GRADE_RULES.prime)
  if (prime.every(l => l.ok)) return { grade: 'prime', why: prime.map(l => l.text) }
  const core = lines(f, GRADE_RULES.core)
  const missedPrime = prime.filter(l => !l.ok).map(l => `Prime needs ${l.text}`)
  if (core.every(l => l.ok)) return { grade: 'core', why: missedPrime }
  return { grade: 'standard', why: core.filter(l => !l.ok).map(l => `Core needs ${l.text}`) }
}

/** One grade lower (a grade under review hands its signals out as the next one down). */
export const lower = (g: SignalGrade): SignalGrade => (g === 'prime' ? 'core' : 'standard')

export interface GradeRecord { grade: SignalGrade; trades: number; wins: number; winRate: number | null; avgReturn: number | null; review: string | null }

/** Each grade's signals, replayed at live speed with the exits that grade trades with: its public record, and its review. */
export class GradeBook {
  private results = new Map<string, { grade: SignalGrade; at: number; ret: number }>()
  /** Signals replayed and found not bought (the price moved too far first): not counted. */
  private skipped = new Set<string>()

  has(signalId: string) { return this.results.has(signalId) || this.skipped.has(signalId) }
  skip(signalId: string) { this.skipped.add(signalId) }
  add(signalId: string, grade: SignalGrade, at: number, ret: number) { this.results.set(signalId, { grade, at, ret }) }

  record(grade: SignalGrade, now = Date.now()): GradeRecord {
    const list = [...this.results.values()].filter(r => r.grade === grade && now - r.at <= GRADE_REVIEW.days * 86_400_000).sort((a, b) => a.at - b.at).slice(-GRADE_REVIEW.window)
    const n = list.length, wins = list.filter(r => r.ret > 0).length
    const avg = n ? list.reduce((s, r) => s + r.ret, 0) / n : null
    const winRate = n ? wins / n : null
    let review: string | null = null
    if (grade !== 'standard' && n >= GRADE_REVIEW.minTrades && (avg! < GRADE_REVIEW.minAvg || winRate! < GRADE_REVIEW.minWinRate)) {
      review = `${grade === 'prime' ? 'Prime' : 'Core'} signals won ${wins} of their last ${n} at live speed (${avg! >= 0 ? '+' : ''}${(avg! * 100).toFixed(1)}% a trade): handed out as ${lower(grade)} until that recovers`
    }
    return { grade, trades: n, wins, winRate, avgReturn: avg, review }
  }

  /** The grade a signal is handed out as: its own, or one lower while its grade is under review. */
  effective(grade: SignalGrade, now = Date.now()): { grade: SignalGrade; review: string | null } {
    let g = grade, review: string | null = null
    while (g !== 'standard') {
      const r = this.record(g, now).review
      if (!r) break
      review ??= r
      g = lower(g)
    }
    return { grade: g, review }
  }

  get size() { return this.results.size }
}
