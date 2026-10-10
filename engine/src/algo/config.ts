// ARCDEX Algo's settings: every threshold the code owns. The gates and risk limits change only by
// the owner's signed control; the reflex's tuning (TUNABLE) may also change through the nightly
// review, inside its bounds and only after a replay shows the change does better.

import type { AlgoGates, AlgoLimits } from '../../../api/_algoProtocol'

export interface ReflexTuning {
  /** Trending when |trend| (5m EMA20 − EMA60, hourly sigmas) is at least this, and the 4 hours agree. */
  trendMin: number
  /** No trend entry once the price is this many hourly sigmas from the hour's mean (chasing). */
  trendMaxStretch: number
  /** Mean reversion fades a stretch of at least this many hourly sigmas. */
  mrMinStretch: number
  /** High volatility from this rv1h / rv24h. */
  highVolRatio: number
  /** Crisis: the hour moved this many hourly sigmas, or volatility this many times its day. */
  crisisSigma: number
  crisisVolRatio: number
  /** Toxic flow: the last minute moved this many one-minute sigmas, or signers disagree this much. */
  toxicJump: number
  toxicDispersionBps: number
  crisisDispersionBps: number
}

export interface Geometry {
  /** How long a trade may stay open, and the take-profit and stop in that horizon's sigmas. */
  horizonMin: number
  tpSigma: number
  slSigma: number
}

export interface Costs {
  openFeeBps: number
  closeFeeBps: number
  /** Borrow fee, % of size an hour. */
  borrowPctPerHour: number
  /** The keeper fills a market order with the first signed price after it: a few seconds. */
  fillDelayMs: number
}

export interface AlgoConfig {
  gates: AlgoGates
  limits: AlgoLimits
  reflex: ReflexTuning
  geometry: Geometry
  costs: Costs
  /** Labels needed before the calibration is trusted (until then, no trades), counted after thinning. */
  minLabels: number
  /** Calibration reads one label per market and family every this many minutes. */
  thinMin: number
  /** Prices older than this stop new orders. */
  staleMs: number
  /** The brain: escalations at most this often per position, and this many a day. */
  escalateEveryMs: number
  maxEscalationsPerDay: number
  startUsd: number
}

export const DEFAULT_CONFIG: AlgoConfig = {
  // The prompt's gates: quality at least 2, confidence above 0.80, risk state safe, quarter Kelly.
  gates: { minSetupQuality: 2, minConfidence: 0.8, escalateBelow: 0.6, kellyFraction: 0.25 },
  limits: { maxDrawdownPct: 15, maxDailyLossPct: 5, maxPositionPct: 100, maxRiskPerTradePct: 2, maxLeverage: 3, maxOpen: 3 },
  reflex: {
    trendMin: 0.5, trendMaxStretch: 2.5, mrMinStretch: 1.5, highVolRatio: 1.8,
    crisisSigma: 4, crisisVolRatio: 3, toxicJump: 4, toxicDispersionBps: 20, crisisDispersionBps: 50,
  },
  geometry: { horizonMin: 240, tpSigma: 1, slSigma: 1.5 },
  // As deployed (perps/shared.ts MARKET_DEFAULTS): 0.08% each way, 0.0025% an hour.
  costs: { openFeeBps: 8, closeFeeBps: 8, borrowPctPerHour: 0.0025, fillDelayMs: 15_000 },
  minLabels: 300,
  thinMin: 15,
  staleMs: 45_000,
  escalateEveryMs: 30 * 60_000,
  maxEscalationsPerDay: 24,
  startUsd: 10_000,
}

/** What the nightly review may change, and how far. */
export const TUNABLE: Record<string, { path: [keyof AlgoConfig, string]; min: number; max: number }> = {
  trendMin: { path: ['reflex', 'trendMin'], min: 0.3, max: 1.2 },
  trendMaxStretch: { path: ['reflex', 'trendMaxStretch'], min: 1.5, max: 3.5 },
  mrMinStretch: { path: ['reflex', 'mrMinStretch'], min: 1.2, max: 2.8 },
  highVolRatio: { path: ['reflex', 'highVolRatio'], min: 1.4, max: 2.5 },
  tpSigma: { path: ['geometry', 'tpSigma'], min: 0.6, max: 2 },
  slSigma: { path: ['geometry', 'slSigma'], min: 0.8, max: 2.5 },
}

/** The owner's gate changes, bounded: the confidence bar never under 0.6, quality never under 1,
 * never more than half Kelly, and the risk limits only tighter than the prompt's ceilings. */
export const GATE_BOUNDS = {
  minSetupQuality: [1, 3], minConfidence: [0.6, 0.99], escalateBelow: [0.4, 0.9], kellyFraction: [0.05, 0.5],
  maxDrawdownPct: [1, 15], maxDailyLossPct: [0.5, 10], maxPositionPct: [5, 300], maxRiskPerTradePct: [0.1, 5], maxLeverage: [1, 10], maxOpen: [1, 3],
} as const

export function cloneConfig(c: AlgoConfig): AlgoConfig {
  return JSON.parse(JSON.stringify(c)) as AlgoConfig
}

/** Applies the owner's patch of gates and limits, refusing anything out of bounds. */
export function applyGatePatch(c: AlgoConfig, patch: unknown): AlgoConfig {
  if (!patch || typeof patch !== 'object') throw new Error('expected an object')
  const next = cloneConfig(c)
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (GATE_BOUNDS as Record<string, readonly [number, number]>)[k]
    if (!b) throw new Error(`"${k}" can't be changed here`)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < b[0] || v > b[1]) throw new Error(`"${k}" must be a number from ${b[0]} to ${b[1]}`)
    if (k in next.gates) (next.gates as unknown as Record<string, number>)[k] = v
    else (next.limits as unknown as Record<string, number>)[k] = v
  }
  return next
}

export function tunedValue(c: AlgoConfig, param: string): number | null {
  const t = TUNABLE[param]
  if (!t) return null
  return (c[t.path[0]] as unknown as Record<string, number>)[t.path[1]] ?? null
}

/** A copy with one tunable changed, clamped to its bounds. */
export function withTuned(c: AlgoConfig, param: string, value: number): AlgoConfig {
  const t = TUNABLE[param]
  if (!t) throw new Error(`"${param}" isn't tunable`)
  const next = cloneConfig(c)
  ;(next[t.path[0]] as unknown as Record<string, number>)[t.path[1]] = Math.min(t.max, Math.max(t.min, value))
  return next
}
