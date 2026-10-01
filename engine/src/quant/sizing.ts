// Position size: never one fixed amount. It starts from the risk a trade may
// take (a share of equity lost if the stop is hit, costs included), then
// shrinks with lower confidence and a strategy that has been losing, and is
// capped by the pool (the size's own price impact), the most a position may
// be, and what's left under the portfolio's exposure limit. Under the
// minimum order it isn't traded.

import type { QuantConfig } from './config'
import { maxSizeFor } from './liquidity'
import { clamp, ramp } from './util'

export interface SizeInput {
  equityUsd: number
  /** Open positions' cost now (the same book). */
  exposureUsd: number
  confidence: number
  /** The stop's distance below the entry (%). */
  stopPct: number
  /** A round trip's costs at about this size (share of value). */
  roundTrip: number
  liquidity: number | null
  /** The strategy's recent profit factor (null: no record yet). */
  strategyProfitFactor: number | null
}

export interface SizeResult { usd: number; limitedBy: string; why: string[] }

export function positionSize(i: SizeInput, c: QuantConfig): SizeResult {
  const s = c.sizing
  const why: string[] = []
  const risk = (i.equityUsd * s.riskPerTradePct) / 100
  const lossShare = Math.max(0.005, i.stopPct / 100 + i.roundTrip)
  let usd = risk / lossShare
  let limitedBy = 'risk per trade'
  why.push(`risk $${risk.toFixed(2)} (${s.riskPerTradePct}% of $${Math.round(i.equityUsd)}) over a ${(lossShare * 100).toFixed(1)}% loss at the stop: $${usd.toFixed(2)}`)
  const conf = s.minConfidenceMult + (1 - s.minConfidenceMult) * clamp(i.confidence, 0, 1)
  usd *= conf
  why.push(`× ${conf.toFixed(2)} for confidence ${(i.confidence * 100).toFixed(0)}%`)
  if (i.strategyProfitFactor !== null) {
    const m = i.strategyProfitFactor < 1 ? s.weakStrategyMult : s.weakStrategyMult + (1 - s.weakStrategyMult) * ramp(i.strategyProfitFactor, 1, 1.5)
    if (m < 1) { usd *= m; why.push(`× ${m.toFixed(2)}: the strategy's recent profit factor is ${i.strategyProfitFactor.toFixed(2)}`) }
  }
  const caps: [number, string][] = [
    [s.maxPositionUsd, 'the most a position may be'],
    [maxSizeFor(i.liquidity, Math.min(s.maxImpactPct, c.gates.maxPriceImpactPct) / 100), `the pool: ${Math.min(s.maxImpactPct, c.gates.maxPriceImpactPct)}% price impact at most`],
    [Math.max(0, (i.equityUsd * s.maxPortfolioExposurePct) / 100 - i.exposureUsd), `the portfolio's ${s.maxPortfolioExposurePct}% exposure limit`],
  ]
  for (const [cap, what] of caps) if (cap < usd) { usd = cap; limitedBy = what; why.push(`capped at $${cap.toFixed(2)} by ${what}`) }
  usd = Math.floor(usd * 100) / 100
  if (usd < s.minOrderUsd) { why.push(`$${usd.toFixed(2)} is under the $${s.minOrderUsd} minimum order: not traded`); return { usd: 0, limitedBy, why } }
  return { usd, limitedBy, why }
}
