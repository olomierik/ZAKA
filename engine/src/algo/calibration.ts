// Calibration: the reflex's raw score turned into an honest probability, and measured.
//
// Isotonic regression (pool-adjacent-violators) maps raw scores to the share of labeled decisions
// that reached their take-profit before their stop, each block shrunk toward the base rate so a
// thin block can't claim 100%. Brier score, reliability bins and expected calibration error are
// measured on a held-out window the fit never saw.

import type { AlgoCalibration, AlgoCalibrationBin } from '../../../api/_algoProtocol'

export interface Sample { p: number; win: boolean; at?: number }

interface Block { xMax: number; sum: number; n: number }

/** Pool-adjacent-violators: non-decreasing blocks over x. */
export function isotonic(points: { x: number; y: number }[]): Block[] {
  const pts = [...points].sort((a, b) => a.x - b.x)
  const blocks: Block[] = []
  for (const pt of pts) {
    blocks.push({ xMax: pt.x, sum: pt.y, n: 1 })
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2]
      if (a.sum / a.n <= b.sum / b.n) break
      blocks.splice(blocks.length - 2, 2, { xMax: b.xMax, sum: a.sum + b.sum, n: a.n + b.n })
    }
  }
  return blocks
}

export class Calibrator {
  private blocks: Block[] = []
  n = 0
  baseRate: number | null = null
  /** Prior weight: how many labels a block needs before it speaks mostly for itself. */
  constructor(private prior = 50) {}

  fit(samples: Sample[]) {
    this.n = samples.length
    if (!samples.length) { this.blocks = []; this.baseRate = null; return this }
    this.baseRate = samples.filter(s => s.win).length / samples.length
    this.blocks = isotonic(samples.map(s => ({ x: s.p, y: s.win ? 1 : 0 })))
    return this
  }

  /** The calibrated probability for a raw score (the base rate before any fit). */
  map(p: number): number {
    if (!this.blocks.length || this.baseRate === null) return this.baseRate ?? p
    const b = this.blocks.find(x => p <= x.xMax) ?? this.blocks[this.blocks.length - 1]
    const shrunk = (b.sum + this.prior * this.baseRate) / (b.n + this.prior)
    return Math.min(0.99, Math.max(0.01, shrunk))
  }

  toJSON() { return { blocks: this.blocks, n: this.n, baseRate: this.baseRate, prior: this.prior } }
  static from(j: { blocks: Block[]; n: number; baseRate: number | null; prior: number }): Calibrator {
    const c = new Calibrator(j.prior)
    c.blocks = j.blocks; c.n = j.n; c.baseRate = j.baseRate
    return c
  }
}

export function brier(preds: { p: number; win: boolean }[]): number | null {
  if (!preds.length) return null
  return preds.reduce((s, x) => s + (x.p - (x.win ? 1 : 0)) ** 2, 0) / preds.length
}

export function reliability(preds: { p: number; win: boolean }[], bins = 10): AlgoCalibrationBin[] {
  const out: AlgoCalibrationBin[] = []
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins
    const xs = preds.filter(x => x.p >= lo && (i === bins - 1 ? x.p <= hi : x.p < hi))
    if (!xs.length) continue
    out.push({ lo, hi, n: xs.length, predicted: xs.reduce((s, x) => s + x.p, 0) / xs.length, observed: xs.filter(x => x.win).length / xs.length })
  }
  return out
}

export function ece(preds: { p: number; win: boolean }[], bins = 10): number | null {
  if (!preds.length) return null
  return reliability(preds, bins).reduce((s, b) => s + (b.n / preds.length) * Math.abs(b.predicted - b.observed), 0)
}

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000)

/** The calibration report for predictions already mapped to probabilities. */
export function reportOf(preds: { p: number; win: boolean }[], baseRate: number | null, nTrain: number, at: number): AlgoCalibration {
  const b = brier(preds)
  const bBase = baseRate === null ? null : brier(preds.map(x => ({ p: baseRate, win: x.win })))
  return {
    n: nTrain, nTest: preds.length,
    brier: r4(b), brierBaseRate: r4(bBase),
    skill: b !== null && bBase ? r4(1 - b / bBase) : null,
    ece: r4(ece(preds)), baseRate: r4(baseRate),
    bins: reliability(preds).map(x => ({ ...x, predicted: r4(x.predicted)!, observed: r4(x.observed)! })),
    fittedAt: at,
  }
}

/** Fits on `train`, measures on `test` (which the fit never saw). */
export function evaluate(train: Sample[], test: Sample[], at: number): { calibrator: Calibrator; report: AlgoCalibration } {
  const calibrator = new Calibrator().fit(train)
  return { calibrator, report: reportOf(test.map(s => ({ p: calibrator.map(s.p), win: s.win })), calibrator.baseRate, train.length, at) }
}
