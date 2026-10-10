// The reflex: one typed decision per market per candle, from the state alone.
//
// Reflex is an interface so a typed-decision model can replace the default; RuleReflex is plain,
// deterministic code. It names the regime, a direction, whether the flow looks toxic, and a setup
// quality from 0 to 3, plus a raw score. The raw score is only an ordering: Calibrators turn it
// into the probability the gate reads (confidence), fit on the reflex's own past decisions.
// risk_state is never the reflex's to say: the risk layer fills it in (risk.ts).

import type { AlgoDecision, AlgoDirection, AlgoRegime, AlgoState } from '../../../api/_algoProtocol'
import type { ReflexTuning } from './config'

export interface ReflexOutput {
  decision: Omit<AlgoDecision, 'risk_state' | 'confidence'>
  /** Uncalibrated score (0–1): higher should mean likelier to reach the take-profit first. */
  raw: number
  why: string[]
}

export interface Reflex {
  readonly provider: string
  decide(s: AlgoState, tuning: ReflexTuning): ReflexOutput
}

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
const dirOf = (x: number): AlgoDirection => (x > 0 ? 'long' : x < 0 ? 'short' : 'neutral')
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const n2 = (x: number | null) => (x === null ? '?' : x.toFixed(2))

/** The calibration family a decision belongs to: trend-following or fading. */
export function familyOf(regime: AlgoRegime): 'trend' | 'fade' | null {
  return regime === 'trending' ? 'trend' : regime === 'mean_reverting' ? 'fade' : null
}

export class RuleReflex implements Reflex {
  readonly provider = 'rules-v1'

  decide(s: AlgoState, k: ReflexTuning): ReflexOutput {
    const why: string[] = []
    const shock = s.r1h !== null && s.rv24h ? s.r1h / (s.rv24h * Math.sqrt(60)) : null
    const toxic = (s.jump !== null && Math.abs(s.jump) >= k.toxicJump) || (s.dispersionBps !== null && s.dispersionBps >= k.toxicDispersionBps)
    if (toxic) why.push(s.jump !== null && Math.abs(s.jump) >= k.toxicJump ? `toxic flow: the last minute moved ${n2(s.jump)}σ` : `toxic flow: the oracle's signers disagree by ${n2(s.dispersionBps)} bps`)

    // Regime.
    let regime: AlgoRegime
    const refCrash = s.refR1h !== null && s.rv24h ? s.refR1h / (s.rv24h * Math.sqrt(60)) <= -k.crisisSigma : false
    if ((shock !== null && Math.abs(shock) >= k.crisisSigma) || (s.volRatio !== null && s.volRatio >= k.crisisVolRatio && (s.r1h ?? 0) < 0)
      || (s.dispersionBps !== null && s.dispersionBps >= k.crisisDispersionBps) || refCrash) {
      regime = 'crisis'
      why.push(shock !== null && Math.abs(shock) >= k.crisisSigma ? `crisis: the hour moved ${n2(shock)} hourly σ` : refCrash ? 'crisis: the reference major is crashing' : s.dispersionBps !== null && s.dispersionBps >= k.crisisDispersionBps ? 'crisis: oracle signers disagree' : `crisis: volatility ${n2(s.volRatio)}× its day while falling`)
    } else if (s.volRatio !== null && s.volRatio >= k.highVolRatio) {
      regime = 'high_vol'
      why.push(`high volatility: ${n2(s.volRatio)}× the day's`)
    } else if (s.trend !== null && Math.abs(s.trend) >= k.trendMin && s.r4h !== null && sign(s.r4h) === sign(s.trend)) {
      regime = 'trending'
      why.push(`trending ${s.trend > 0 ? 'up' : 'down'}: EMA gap ${n2(s.trend)}σ, 4h ${n2(s.r4h)}%`)
    } else {
      regime = 'mean_reverting'
      why.push(`ranging: EMA gap ${n2(s.trend)}σ`)
    }

    // Direction and setup quality.
    let direction: AlgoDirection = 'neutral'
    let quality = 0
    let raw = 0.05
    if (regime === 'trending' && s.trend !== null) {
      if (s.z1h !== null && Math.abs(s.z1h) > k.trendMaxStretch && sign(s.z1h) === sign(s.trend)) {
        why.push(`no chase: ${n2(s.z1h)}σ from the hour's mean`)
      } else {
        direction = dirOf(s.trend)
        const d = sign(s.trend)
        if (s.r24h !== null && sign(s.r24h) === d) { quality++; why.push('the day agrees') }
        if (s.refR1h !== null && sign(s.refR1h) === d) { quality++; why.push('the reference major agrees') }
        if (s.volRatio !== null && s.volRatio >= 0.6 && s.volRatio <= 1.5) { quality++; why.push('volatility in its normal band') }
        raw = sigmoid(-1.2 + 0.55 * quality + 0.45 * Math.min(3, Math.abs(s.trend)) - (s.z1h !== null ? 0.15 * Math.max(0, d * s.z1h - 1) : 0))
      }
    } else if (regime === 'mean_reverting' && s.z1h !== null) {
      if (Math.abs(s.z1h) >= k.mrMinStretch) {
        direction = dirOf(-s.z1h)
        const d = -sign(s.z1h)
        if (s.trend === null || Math.abs(s.trend) < k.trendMin * 0.6) { quality++; why.push('no trend underneath') }
        if (s.volRatio !== null && s.volRatio >= 0.6 && s.volRatio <= 1.5) { quality++; why.push('volatility in its normal band') }
        if (s.range24 !== null && ((d > 0 && s.range24 <= 0.35) || (d < 0 && s.range24 >= 0.65))) { quality++; why.push(`at the ${d > 0 ? 'low' : 'high'} end of the day's range`) }
        raw = sigmoid(-1.2 + 0.55 * quality + 0.5 * Math.min(2, Math.abs(s.z1h) - k.mrMinStretch))
        why.push(`fade a ${n2(s.z1h)}σ stretch`)
      } else {
        why.push(`no stretch to fade (${n2(s.z1h)}σ)`)
      }
    } else if (regime === 'high_vol' || regime === 'crisis') {
      why.push('stand aside')
    }
    if (toxic && direction !== 'neutral') quality = Math.max(0, quality - 1)
    return {
      decision: { regime, direction, toxic_flow: toxic, setup_quality: Math.min(3, quality) as 0 | 1 | 2 | 3 },
      raw: Math.round(raw * 10_000) / 10_000,
      why,
    }
  }
}
