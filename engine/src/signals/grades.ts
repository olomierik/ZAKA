// Signal grades (owner's request, 2026-09-30: "the highest tier gets the
// highest-quality signals, even at a small % gain, with a strategy made for
// them"). Every signal is graded when it fires:
//
//   prime     one of the two strategies that held up on coins the search never
//             saw (2026-10-01, below): an early crowd, or a crowd momentum
//             burst. Traded by the Precision strategy: all of it sold at +10%,
//             fast. The top tier's signals, and the only ones live bots take
//             until another grade proves itself.
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
// The strategy search (2026-10-01): every coin of the engine's 72 hours with
// 15+ trades (139), walked trade by trade as the engine sees it, bought 2.5s
// after the rule and sold 2s after each exit trigger, costs both ways. Rules
// were chosen on the first half of the coins by launch time and judged on the
// second, which the choice never saw:
//   early crowd     20-75s after launch: 10+ buyers (the market's own), none
//                   over 20% of the buying, buys at least twice sells, not up
//                   more than 20%. All of it at +10%: 21 of 21, then 8 of 8
//                   (+7% a trade); still 28 of 29 with the signal 15s late.
//   late crowd      the same, 75s to 10 minutes after launch (coins whose crowd
//                   came later): 3 of 3, then 7 of 7 (+8.4%). Few trades in the
//                   first half: the grade's own record is the check.
//   crowd momentum  a minute or more old, not an early-crowd coin: 12+ buyers
//                   in two minutes, buying at least twice selling, up 2-15% in
//                   that window, no wallet over 20% of all its buying since
//                   launch, $5,000+ liquidity. At +10%: 14 of 16, then 21 of 23
//                   (+6.8%). On early-crowd coins it loses (they dump after
//                   their pump); with a 10% crowd limit, -90% trades come back.
// Rejected in the same search: dip rebounds (fell apart with small changes),
// momentum without the crowd limit (+16% then -0.5% on the unseen half).
//
// That's three days of coins, and many of them came from a few serial
// launchers' patterns. So a grade's own record is kept (every signal replayed
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

/** The two Prime strategies (the search above). */
export const PRIME_RULES = {
  /** `maxAgeSec`: an early crowd (the mark crowd momentum reads); `lateMaxAgeSec`: a late crowd, the same numbers later on. */
  early: { maxAgeSec: 75, lateMaxAgeSec: 600, minBuyers: 10, maxTopBuyerPct: 20, minBuySellRatio: 2, maxRunUp: 1.2, minLiquidityUsd: 5_000, maxRoundTripPct: 3 },
  momentum: { minBuyers: 12, minBuySellRatio: 2, minMove: 1.02, maxMove: 1.15, maxLaunchTopBuyerPct: 20, minLiquidityUsd: 5_000, maxRoundTripPct: 3 },
} as const

/** Whether a coin's market buying, `ageSec` after launch, is an early crowd (the engine marks such coins: crowd momentum leaves them out). */
export function isEarlyCrowd(f: Pick<SignalFeatures, 'buyers' | 'topBuyerPct' | 'buySellRatio' | 'runUp'>, ageSec: number): boolean {
  const r = PRIME_RULES.early
  return ageSec >= 20 && ageSec <= r.maxAgeSec && f.buyers >= r.minBuyers && f.topBuyerPct <= r.maxTopBuyerPct && (f.buySellRatio === null || f.buySellRatio >= r.minBuySellRatio) && (f.runUp ?? 1) <= r.maxRunUp
}

function primeLines(f: SignalFeatures, rule?: SignalRule): Line[] | null {
  const rt = f.roundTripPct ?? 4
  const pct = (x: number) => `${Math.round((x - 1) * 100)}%`
  if (rule === 'snipe') {
    const r = PRIME_RULES.early
    return [
      // The late crowd (to 10 minutes) was taken back out the same day: its first live trade, DEGEN at 399s, was rugged -94% in 12s.
      { ok: f.ageSec <= r.maxAgeSec, text: `early crowd: ${f.ageSec}s after launch (≤ ${r.maxAgeSec}s)` },
      { ok: f.buyers >= r.minBuyers, text: `${f.buyers} buyers (${r.minBuyers}+)` },
      { ok: f.topBuyerPct <= r.maxTopBuyerPct, text: `largest buyer ${Math.round(f.topBuyerPct)}% (≤ ${r.maxTopBuyerPct}%)` },
      { ok: f.buySellRatio === null || f.buySellRatio >= r.minBuySellRatio, text: f.buySellRatio === null ? 'no sells yet' : `buys ${f.buySellRatio.toFixed(1)}× sells (${r.minBuySellRatio}×+)` },
      { ok: (f.runUp ?? 1) <= r.maxRunUp, text: `up ${pct(f.runUp ?? 1)} (≤ ${pct(r.maxRunUp)})` },
      { ok: (f.liquidityUsd ?? 0) >= r.minLiquidityUsd, text: `liquidity $${Math.round(f.liquidityUsd ?? 0).toLocaleString('en-US')} ($${r.minLiquidityUsd.toLocaleString('en-US')}+)` },
      { ok: rt <= r.maxRoundTripPct, text: `round trip ${rt.toFixed(1)}% (≤ ${r.maxRoundTripPct}%)` },
    ]
  }
  if (rule === 'momentum') {
    const r = PRIME_RULES.momentum
    const lt = f.launchTopBuyerPct ?? 100
    return [
      { ok: !f.earlyCrowd, text: f.earlyCrowd ? 'it had an early crowd (they dump after it)' : 'no early crowd' },
      { ok: f.buyers >= r.minBuyers, text: `crowd momentum: ${f.buyers} buyers in 2 minutes (${r.minBuyers}+)` },
      { ok: f.buySellRatio === null || f.buySellRatio >= r.minBuySellRatio, text: f.buySellRatio === null ? 'no sells in the window' : `buys ${f.buySellRatio.toFixed(1)}× sells (${r.minBuySellRatio}×+)` },
      { ok: (f.runUp ?? 1) >= r.minMove && (f.runUp ?? 1) <= r.maxMove, text: `up ${pct(f.runUp ?? 1)} in the window (${pct(r.minMove)} to ${pct(r.maxMove)})` },
      { ok: lt <= r.maxLaunchTopBuyerPct, text: `largest buyer since launch ${Math.round(lt)}% (≤ ${r.maxLaunchTopBuyerPct}%)` },
      { ok: (f.liquidityUsd ?? 0) >= r.minLiquidityUsd, text: `liquidity $${Math.round(f.liquidityUsd ?? 0).toLocaleString('en-US')} ($${r.minLiquidityUsd.toLocaleString('en-US')}+)` },
      { ok: rt <= r.maxRoundTripPct, text: `round trip ${rt.toFixed(1)}% (≤ ${r.maxRoundTripPct}%)` },
    ]
  }
  return null
}

/** A signal's grade, and why: what it met of the grade it got, or what it missed of the one above. */
export function gradeOf(f: SignalFeatures | undefined, rule?: SignalRule): { grade: SignalGrade; why: string[] } {
  if (!f) return { grade: 'standard', why: ['no numbers to grade it on'] }
  const prime = primeLines(f, rule)
  if (prime?.every(l => l.ok)) return { grade: 'prime', why: prime.map(l => l.text) }
  const core = lines(f, GRADE_RULES.core)
  const missedPrime = (prime ?? []).filter(l => !l.ok).map(l => `Prime needs ${l.text}`)
  if (core.every(l => l.ok)) return { grade: 'core', why: missedPrime }
  return { grade: 'standard', why: [...missedPrime, ...core.filter(l => !l.ok).map(l => `Core needs ${l.text}`)].slice(0, 4) }
}

/**
 * Which grades live bots trade (2026-09-30, owner: "let live accounts enjoy
 * a performance they'll market"): Prime, unless it's under review, and any
 * other grade once it's proven at live speed (the same bar as the review: 10+
 * replays, at least 60% won, a profit). On that day's replays only Prime was
 * (10 of 11 won); Standard won 1 of 12. So live bots trade Prime signals, and
 * start on another grade by themselves once its record earns it.
 */
export function liveGrade(book: GradeBook, grade: SignalGrade, now = Date.now()): { ok: boolean; why: string | null } {
  const r = book.record(grade, now)
  if (grade === 'prime' && !r.review) return { ok: true, why: null }
  const ok = r.trades >= GRADE_REVIEW.minTrades && (r.avgReturn ?? -1) >= GRADE_REVIEW.minAvg && (r.winRate ?? 0) >= GRADE_REVIEW.minWinRate
  if (ok) return { ok: true, why: null }
  const name = grade === 'prime' ? 'Prime' : grade === 'core' ? 'Core' : 'Standard'
  const rec = r.trades ? `${name} signals won ${r.wins} of their last ${r.trades} at live speed (${(r.avgReturn ?? 0) >= 0 ? '+' : ''}${((r.avgReturn ?? 0) * 100).toFixed(1)}% a trade)` : `${name} signals have no record at live speed yet`
  return { ok: false, why: `live bots trade Prime signals, and other grades once proven at live speed (${GRADE_REVIEW.minTrades}+ replays, ${Math.round(GRADE_REVIEW.minWinRate * 100)}% won, a profit): ${rec}` }
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
