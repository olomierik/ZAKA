// The policy: the reflex's decision through the gates, then sized by fractional Kelly. Code, not
// the model, owns all of it.
//
// Gates (the prompt's): setup quality at least 2, calibrated confidence above 0.80, risk state
// safe, a direction, no toxic flow, a calibrated reflex, and a positive expectation after costs.
// Size: Kelly's fraction f* = p − (1 − p) / b from the calibrated probability p and the net payoff
// b (take-profit after costs over stop-loss plus costs), times the Kelly fraction (a quarter),
// capped at the risk layer's most risk a trade. Notional = risk / (stop + costs); leverage is the
// least that fits, never above the cap, and always leaves the liquidation price at least twice as
// far as the stop.

import type { AlgoDecision, AlgoGate, AlgoPlan, AlgoState } from '../../../api/_algoProtocol'
import type { AlgoConfig } from './config'

export interface PlanInput {
  state: AlgoState
  decision: AlgoDecision
  calibrated: boolean
  equityUsd: number
  cfg: AlgoConfig
  /** The contract's smallest collateral (USD). */
  minCollateralUsd?: number
}

/** Round-trip costs over the horizon, % of size: both fees and the borrow fee. */
export function costPct(cfg: AlgoConfig): number {
  return (cfg.costs.openFeeBps + cfg.costs.closeFeeBps) / 100 + cfg.costs.borrowPctPerHour * (cfg.geometry.horizonMin / 60)
}

export function kellyOf(p: number, b: number): number {
  if (!(b > 0)) return -1
  return p - (1 - p) / b
}

const r = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d

export function planTrade(i: PlanInput): { gate: AlgoGate; plan: AlgoPlan | null } {
  const { state: s, decision: d, cfg } = i
  const g = cfg.gates, L = cfg.limits
  const checks: AlgoGate['checks'] = []
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })
  add('direction', d.direction !== 'neutral', d.direction === 'neutral' ? 'no direction' : `${d.direction}`)
  add('regime', d.regime !== 'crisis' && d.regime !== 'high_vol', `regime ${d.regime}`)
  add('toxic', !d.toxic_flow, d.toxic_flow ? 'toxic flow' : 'clean flow')
  add('quality', d.setup_quality >= g.minSetupQuality, `setup quality ${d.setup_quality} (at least ${g.minSetupQuality})`)
  add('calibrated', i.calibrated, i.calibrated ? 'confidence calibrated' : `confidence not calibrated yet (needs ${cfg.minLabels} labeled decisions)`)
  add('confidence', d.confidence > g.minConfidence, `confidence ${d.confidence.toFixed(3)} (above ${g.minConfidence})`)
  add('risk_state', d.risk_state === 'safe', `risk state ${d.risk_state}`)

  const sigma = s.sigmaH
  const cost = costPct(cfg)
  const tpPct = sigma ? cfg.geometry.tpSigma * sigma : 0
  const slPct = sigma ? cfg.geometry.slSigma * sigma : 0
  add('volatility', !!sigma, sigma ? `horizon σ ${sigma.toFixed(2)}%` : 'volatility unknown')
  add('target', tpPct >= 3 * cost, `take-profit ${tpPct.toFixed(2)}% vs ${cost.toFixed(2)}% costs (at least 3×)`)
  const b = slPct > 0 ? (tpPct - cost) / (slPct + cost) : 0
  const p = d.confidence
  const kelly = kellyOf(p, b)
  const ev = p * (tpPct - cost) - (1 - p) * (slPct + cost)
  add('edge', kelly > 0 && ev > 0, `expected ${ev.toFixed(3)}% a trade after costs, Kelly ${kelly.toFixed(3)}`)

  if (!checks.every(c => c.ok) || d.direction === 'neutral') return { gate: { passed: false, checks }, plan: null }

  const fraction = Math.min(g.kellyFraction * kelly, L.maxRiskPerTradePct / 100)
  const riskUsd = fraction * i.equityUsd
  let sizeUsd = riskUsd / ((slPct + cost) / 100)
  sizeUsd = Math.min(sizeUsd, (L.maxPositionPct / 100) * i.equityUsd)
  // Liquidation (1% maintenance + fees) at least twice as far as the stop.
  const liqRoom = 2 * slPct / 100 + 0.01 + cost / 100
  const leverage = Math.max(1, Math.min(L.maxLeverage, Math.floor(1 / liqRoom)))
  const collateralUsd = sizeUsd / leverage
  const minCol = i.minCollateralUsd ?? 1
  const sized = collateralUsd >= minCol
  checks.push({ id: 'size', ok: sized, detail: sized ? `$${sizeUsd.toFixed(2)} at ${leverage}×` : `collateral $${collateralUsd.toFixed(2)} under the contract's minimum $${minCol}` })
  if (!sized) return { gate: { passed: false, checks }, plan: null }
  const long = d.direction === 'long'
  return {
    gate: { passed: true, checks },
    plan: {
      side: long ? 'long' : 'short',
      entry: s.px,
      tp: r(long ? s.px * (1 + tpPct / 100) : s.px * (1 - tpPct / 100), 6),
      sl: r(long ? s.px * (1 - slPct / 100) : s.px * (1 + slPct / 100), 6),
      tpPct: r(tpPct), slPct: r(slPct),
      kelly: r(kelly), fraction: r(fraction, 5),
      riskUsd: r(riskUsd, 2), sizeUsd: r(sizeUsd, 2), collateralUsd: r(collateralUsd, 2), leverage,
      expectedValuePct: r(ev),
    },
  }
}
