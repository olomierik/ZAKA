// Walk-forward validation: parameters are never chosen on the whole history.
// The period is cut into folds; in each, every candidate setting is run on a
// training window, the best (by expectancy, with enough trades) must also
// make money on the validation window that follows (else the defaults are
// kept), and only then is it run on the out-of-sample window after that,
// which no choice has seen. The out-of-sample trades of all folds, together,
// are the result the live gate reads (quant/risk.ts).
//
//   |—— warm-up ——|—— train ——|— validate —|— test (OOS) —|
//                              fold 1
//                 |—— warm-up ——|—— train ——|— validate —|— test —|
//                              fold 2 … (each fold steps by the test window)

import { DEFAULT_CONFIG, type QuantConfig } from './config'
import { runBacktest, withPatch, type BacktestReport, type ReplayData } from './backtest'
import { bookStats, type BookStats, type QPosition } from './positions'

export interface Candidate { name: string; patch: unknown }

/** The default grid: the score a trade needs, and whether the momentum exit is on. Small on purpose (fewer ways to overfit). */
export const DEFAULT_GRID: Candidate[] = (() => {
  const out: Candidate[] = []
  for (const bar of [55, 60, 65, 70, 75]) for (const momentumExit of [true, false]) {
    out.push({ name: `score ${bar}, momentum exit ${momentumExit ? 'on' : 'off'}`, patch: { gates: { minSignalScore: bar }, exits: { momentumExit } } })
  }
  return out
})()

export interface FoldResult {
  fold: number
  train: [number, number]
  validate: [number, number]
  test: [number, number]
  chosen: string
  why: string
  trainStats: BookStats
  validateStats: BookStats
  testStats: BookStats
}

export interface WalkForwardReport {
  at: number
  folds: FoldResult[]
  /** All folds' out-of-sample trades together. */
  oos: BookStats
  oosPositions: number
  candidates: string[]
  ms: number
}

export interface WalkForwardOptions {
  base?: QuantConfig
  grid?: Candidate[]
  folds?: number
  /** Shares of each fold's span: train, validate, test. */
  split?: [number, number, number]
  warmupMs?: number
  minTrainTrades?: number
  onProgress?: (msg: string) => Promise<void> | void
}

export async function walkForward(data: ReplayData, o: WalkForwardOptions = {}): Promise<WalkForwardReport> {
  const t0 = Date.now()
  const base = o.base ?? DEFAULT_CONFIG
  const grid = o.grid ?? DEFAULT_GRID
  const k = o.folds ?? 3
  const [a, b, c] = o.split ?? [0.5, 0.25, 0.25]
  const warm = o.warmupMs ?? 6 * 3_600_000
  const ts = data.trades.map(t => t.timestamp)
  const start = Math.min(...ts) + warm, end = Math.max(...ts)
  // Folds share the span: each one's test window follows the last one's.
  const span = end - start
  const testLen = (span * c) / (a + b + c * k)
  const trainLen = (testLen * a) / c, valLen = (testLen * b) / c
  const folds: FoldResult[] = []
  const oosAll: QPosition[] = []
  const sliceFor = (from: number, to: number): ReplayData => ({ launches: data.launches, trades: data.trades.filter(t => t.timestamp >= from - warm && t.timestamp <= to) })
  const eq = base.sizing.paperEquityUsd
  for (let f = 0; f < k; f++) {
    const trainFrom = start + f * testLen, trainTo = trainFrom + trainLen, valTo = trainTo + valLen, testTo = Math.min(end, valTo + testLen)
    if (trainTo >= end) break
    let best: { cand: Candidate; stats: BookStats } | null = null
    for (const cand of grid) {
      const cfg = withPatch(base, cand.patch)
      const r = await runBacktest(sliceFor(trainFrom, trainTo), { config: cfg, from: trainFrom, to: trainTo })
      const s = r.report.totals
      await o.onProgress?.(`fold ${f + 1}: train ${cand.name}: ${s.trades} trades, ${s.expectancy_pct}% a trade`)
      if (s.trades >= (o.minTrainTrades ?? 5) && (!best || s.expectancy_pct > best.stats.expectancy_pct)) best = { cand, stats: s }
    }
    const fallback: Candidate = { name: 'defaults', patch: {} }
    let chosen = best?.cand ?? fallback
    let why = best ? `best on training: ${best.stats.expectancy_pct}% a trade over ${best.stats.trades}` : 'no candidate traded enough on training: defaults'
    const val = await runBacktest(sliceFor(trainTo, valTo), { config: withPatch(base, chosen.patch), from: trainTo, to: valTo })
    if (chosen !== fallback && !(val.report.totals.expectancy_pct > 0)) {
      why += `; lost on validation (${val.report.totals.expectancy_pct}% a trade): defaults instead`
      chosen = fallback
    }
    const test = await runBacktest(sliceFor(valTo, testTo), { config: withPatch(base, chosen.patch), from: valTo, to: testTo })
    oosAll.push(...test.positions.filter(p => p.status === 'closed'))
    const trainStats = best?.cand === chosen ? best.stats : (await runBacktest(sliceFor(trainFrom, trainTo), { config: withPatch(base, chosen.patch), from: trainFrom, to: trainTo })).report.totals
    folds.push({ fold: f + 1, train: [trainFrom, trainTo], validate: [trainTo, valTo], test: [valTo, testTo], chosen: chosen.name, why, trainStats, validateStats: val.report.totals, testStats: test.report.totals })
    await o.onProgress?.(`fold ${f + 1}: chose ${chosen.name}; out of sample ${test.report.totals.trades} trades, ${test.report.totals.expectancy_pct}% a trade`)
  }
  return { at: Date.now(), folds, oos: bookStats(oosAll, eq), oosPositions: oosAll.length, candidates: grid.map(g => g.name), ms: Date.now() - t0 }
}

export type { BacktestReport }
