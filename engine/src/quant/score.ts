// The 100-point signal score. Each component is a 0–1 reading of its
// features, multiplied by its weight (QuantConfig.weights: flow 20, momentum
// 15, volume 15, liquidity 15, smart money 10, holders 10, safety 10, regime
// 5 by default). Every component is reported, so a score is never a black
// box. Distribution costs up to 10 points from its penalty level and
// invalidates the signal at its invalidation level.
//
//   flow        buy pressure over 1m (7) and 5m (3), organic breadth (6), buyer growth (2), large-trade imbalance (2)
//   momentum    rising on 15s/30s/1m/3m/5m (5), higher highs and lows or a breakout (5), speeding up (2),
//               the last minute's strength (3), minus 4 when rolling over
//   volume      last minute over the 5-minute pace (6), 5 minutes over the 15-minute pace (3),
//               trades speeding up (2), turnover against the pool (4)
//   liquidity   depth (6, log scale from the minimum to $50k), the size's price impact (4),
//               depth against market cap (2), depth steady or growing (3)
//   smart money smart wallets in (6), their quality (3), a cluster (1), minus their exits (up to 5)
//   holders     holder count (3), top-10 concentration (3), the creator's bag (2), holder growth (2)
//   safety      the safety score / 100
//   regime      BULLISH 1, NEUTRAL 0.6, HIGH_VOLATILITY 0.4, BEARISH 0.2, LIQUIDITY_STRESSED 0

import type { QuantConfig } from './config'
import type { Features } from './features'
import { REGIME_POINTS } from './regime'
import { ramp } from './util'

export type Band = 'NO_TRADE' | 'WATCH' | 'WEAK' | 'TRADE_CANDIDATE' | 'HIGH_CONVICTION'

export interface ScoreComponents { flow: number; momentum: number; volume: number; liquidity: number; smartMoney: number; holders: number; safety: number; regime: number }

export interface Score {
  signal_score: number
  components: ScoreComponents
  /** Points taken off for distribution. */
  distribution_penalty: number
  invalidated: string | null
  band: Band
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

export function flowPart(f: Features): number {
  return sum([
    7 * ramp(f.buy_pressure_1m, 0.5, 0.75),
    3 * ramp(f.buy_pressure_5m, 0.5, 0.7),
    6 * f.organic_flow_score,
    2 * ramp(f.unique_buyer_growth, 1, 2),
    2 * ramp(f.large_trade_imbalance, 0, 0.6),
  ]) / 20
}

export function momentumPart(f: Features): number {
  const ups = [f.price_change_15s, f.price_change_30s, f.price_change_1m, f.price_change_3m, f.price_change_5m].filter(x => (x ?? 0) > 0).length
  const structure = Math.min(5, f.higher_highs + f.higher_lows * 0.67 + ((f.break_pct ?? -1) > 0 ? 2 : 0))
  const raw = sum([ups, structure, 2 * ramp(f.acceleration, 1, 2), 3 * ramp(f.price_change_1m, 0.01, 0.08)]) - (f.rolling_over ? 4 : 0)
  return Math.max(0, Math.min(15, raw)) / 15
}

export function volumePart(f: Features): number {
  return sum([
    6 * ramp(f.volume_acceleration, 1, 3),
    3 * ramp(f.volume_acceleration_5m, 1, 2),
    2 * ramp(f.transaction_acceleration, 1, 2.5),
    4 * ramp(f.volume_to_liquidity, 0.05, 0.5),
  ]) / 15
}

export function liquidityPart(f: Features, o: { minLiquidityUsd: number; impactPct: number; maxImpactPct: number }): number {
  if (!f.liquidity || !(f.liquidity > 0)) return 0
  return sum([
    6 * ramp(Math.log10(f.liquidity), Math.log10(Math.max(1, o.minLiquidityUsd)), Math.log10(50_000)),
    4 * (1 - ramp(o.impactPct, 0.5, o.maxImpactPct)),
    2 * ramp(f.liquidity_to_mcap, 0.05, 0.3),
    3 * (f.liquidity_change_15m === null ? 0.5 : ramp(f.liquidity_change_15m, -0.2, 0)),
  ]) / 15
}

export function smartPart(f: Features): number {
  const raw = 6 * ramp(f.smart_money_count, 0, 3) + 3 * f.smart_money_quality + (f.smart_money_cluster ? 1 : 0) - 5 * ramp(f.smart_money_exits, 0, 2)
  return Math.max(0, Math.min(10, raw)) / 10
}

export function holderPart(f: Features): number {
  return sum([
    3 * ramp(f.holders, 20, 300),
    3 * (f.holder_concentration === null ? 0.5 : 1 - ramp(f.holder_concentration, 20, 60)),
    2 * (f.creator_holding_pct === null ? 0.5 : 1 - ramp(f.creator_holding_pct, 2, 15)),
    2 * ramp(f.holder_growth_5m, 0, 0.2),
  ]) / 10
}

export function bandOf(score: number, b: QuantConfig['bands']): Band {
  return score >= b.highConviction ? 'HIGH_CONVICTION' : score >= b.candidate ? 'TRADE_CANDIDATE' : score >= b.weak ? 'WEAK' : score >= b.watch ? 'WATCH' : 'NO_TRADE'
}

export function scoreSignal(f: Features, o: { safetyScore: number; impactPct: number }, c: QuantConfig): Score {
  const w = c.weights
  const r1 = (x: number) => Math.round(x * 10) / 10
  const components: ScoreComponents = {
    flow: r1(w.flow * flowPart(f)),
    momentum: r1(w.momentum * momentumPart(f)),
    volume: r1(w.volume * volumePart(f)),
    liquidity: r1(w.liquidity * liquidityPart(f, { minLiquidityUsd: c.gates.minLiquidityUsd, impactPct: o.impactPct, maxImpactPct: c.gates.maxPriceImpactPct })),
    smartMoney: r1(w.smartMoney * smartPart(f)),
    holders: r1(w.holders * holderPart(f)),
    safety: r1(w.safety * Math.max(0, Math.min(100, o.safetyScore)) / 100),
    regime: r1(w.regime * REGIME_POINTS[f.market_regime]),
  }
  const g = c.gates
  const penalty = r1(10 * ramp(f.distribution_score, g.distributionPenaltyFrom, g.distributionInvalidate))
  const total = Math.max(0, Math.min(100, r1(sum(Object.values(components)) - penalty)))
  const invalidated = f.distribution_score >= g.distributionInvalidate ? `distribution ${f.distribution_score} (whales or top holders selling)` : null
  return { signal_score: total, components, distribution_penalty: penalty, invalidated, band: invalidated ? 'NO_TRADE' : bandOf(total, c.bands) }
}
