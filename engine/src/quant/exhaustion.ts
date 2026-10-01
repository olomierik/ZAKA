// Pump exhaustion: a coin that has already run hard and is running out of
// buyers. A high score keeps the engine out of new entries even while the
// momentum numbers still look good (the late buyer is the exit liquidity).
//
//   extension        up a lot over 15 minutes, or far over its 5-minute VWAP
//   parabolic        the last minute's move outsized and speeding up
//   buying fading    buy pressure in the last 30s well under the last 5m's
//   buyers flat      the price rising without new buyers coming in
//   large sellers    large sales outweighing large buys
//   volatility       short-term volatility well over its 15-minute level
//   one-way tape     a long run of buys at ever higher prices

import type { FlowFeatures } from './flow'
import type { MomentumFeatures } from './momentum'
import { ramp } from './util'

export interface ExhaustionParts { extension: number; parabolic: number; buyingFading: number; buyersFlat: number; largeSellers: number; volatility: number; oneWay: number }

const WEIGHTS: ExhaustionParts = { extension: 25, parabolic: 15, buyingFading: 15, buyersFlat: 15, largeSellers: 10, volatility: 10, oneWay: 10 }

export function exhaustionScore(m: MomentumFeatures, f: FlowFeatures, w5m: { largeBuyUsd: number; largeSellUsd: number }): { score: number; parts: ExhaustionParts } {
  const up3m = (m.price_change_3m ?? 0) > 0.03
  const parts: ExhaustionParts = {
    extension: Math.max(ramp(m.price_change_15m, 0.5, 2), ramp(m.dist_from_vwap_5m, 15, 50)),
    parabolic: Math.max(ramp(m.price_change_1m, 0.15, 0.4), (m.price_change_1m ?? 0) > 0.05 ? ramp(m.acceleration, 2, 5) : 0),
    buyingFading: (m.price_change_5m ?? 0) > 0 && f.buy_pressure_30s !== null && f.buy_pressure_5m !== null ? ramp(f.buy_pressure_5m - f.buy_pressure_30s, 0.05, 0.3) : 0,
    buyersFlat: ramp(1 - (f.unique_buyer_growth ?? 1), 0, 0.5) * (up3m ? 1 : 0.3),
    largeSellers: w5m.largeSellUsd > 0 ? ramp(w5m.largeSellUsd / (w5m.largeBuyUsd + 1), 0.5, 2) : 0,
    volatility: ramp(m.volatility_ratio, 1.5, 3),
    oneWay: ramp(m.consecutive_up, 8, 25),
  }
  const score = (Object.keys(WEIGHTS) as (keyof ExhaustionParts)[]).reduce((s, k) => s + WEIGHTS[k] * parts[k], 0)
  return { score: Math.round(Math.min(100, score) * 10) / 10, parts }
}
