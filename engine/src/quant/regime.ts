// The market regime: how Arc's meme coins are doing as a whole, from every
// coin of the scored launchpads that traded in the last minutes.
//
//   LIQUIDITY_STRESSED  a third or more of active coins losing half their pool depth, or raising rug alarms
//   HIGH_VOLATILITY     the median coin's volatility over its threshold
//   BULLISH             most coins up (volume-weighted breadth) with a positive median move
//   BEARISH             most coins down with a negative median move
//   NEUTRAL             anything else, or too few coins to say
//
// Each regime moves the bar a signal must clear (QuantConfig.regimeAdjust) and
// is worth 0–5 of the 100 points (quant/score.ts).

import type { Regime } from './config'
import { median } from './util'

export interface CoinSnapshot { volume: number; change: number | null; buyPressure: number | null; volatility: number | null; liquidityChange: number | null; alarm: boolean }

export interface RegimeView {
  regime: Regime
  at: number
  coins: number
  /** Volume-weighted share of coins up over the window (0–1). */
  breadth: number | null
  median_change_pct: number | null
  buy_pressure: number | null
  median_volatility_pct: number | null
  /** Share of coins whose pool depth fell `stressDropPct`%+ (or raised a rug alarm). */
  stress_share: number | null
  volume_usd: number
  why: string
}

export interface RegimeConfig { bullBreadth: number; bearBreadth: number; bullMedianPct: number; bearMedianPct: number; highVolPct: number; stressShare: number; stressDropPct: number; minTokens: number }

export const REGIME_POINTS: Record<Regime, number> = { BULLISH: 1, NEUTRAL: 0.6, HIGH_VOLATILITY: 0.4, BEARISH: 0.2, LIQUIDITY_STRESSED: 0 }

export function regimeOf(coins: CoinSnapshot[], c: RegimeConfig, at: number): RegimeView {
  const active = coins.filter(x => x.volume > 0)
  const volume = active.reduce((s, x) => s + x.volume, 0)
  const base = { at, coins: active.length, volume_usd: Math.round(volume) }
  if (active.length < c.minTokens || !(volume > 0)) {
    return { ...base, regime: 'NEUTRAL', breadth: null, median_change_pct: null, buy_pressure: null, median_volatility_pct: null, stress_share: null, why: `only ${active.length} active coins: not enough to call a regime` }
  }
  const withChange = active.filter(x => x.change !== null)
  const upVol = withChange.filter(x => x.change! > 0).reduce((s, x) => s + x.volume, 0)
  const chVol = withChange.reduce((s, x) => s + x.volume, 0)
  const breadth = chVol > 0 ? upVol / chVol : null
  const med = median(withChange.map(x => x.change! * 100))
  const bpCoins = active.filter(x => x.buyPressure !== null)
  const bp = bpCoins.length ? bpCoins.reduce((s, x) => s + x.buyPressure! * x.volume, 0) / bpCoins.reduce((s, x) => s + x.volume, 0) : null
  const vol = median(active.filter(x => x.volatility !== null).map(x => x.volatility!))
  const stress = active.filter(x => x.alarm || (x.liquidityChange !== null && x.liquidityChange <= -c.stressDropPct / 100)).length / active.length
  const view = { ...base, breadth, median_change_pct: med, buy_pressure: bp, median_volatility_pct: vol, stress_share: stress }
  const pct = (x: number | null) => (x === null ? '?' : `${x.toFixed(1)}%`)
  if (stress >= c.stressShare) return { ...view, regime: 'LIQUIDITY_STRESSED', why: `${Math.round(stress * 100)}% of active coins lost ${c.stressDropPct}%+ of their liquidity or raised a rug alarm` }
  if (vol !== null && vol >= c.highVolPct) return { ...view, regime: 'HIGH_VOLATILITY', why: `median volatility ${pct(vol)} a minute` }
  if (breadth !== null && med !== null && breadth >= c.bullBreadth && med >= c.bullMedianPct) return { ...view, regime: 'BULLISH', why: `${Math.round(breadth * 100)}% of the volume in rising coins, median ${pct(med)}` }
  if (breadth !== null && med !== null && breadth <= c.bearBreadth && med <= c.bearMedianPct) return { ...view, regime: 'BEARISH', why: `${Math.round((1 - breadth) * 100)}% of the volume in falling coins, median ${pct(med)}` }
  return { ...view, regime: 'NEUTRAL', why: `breadth ${breadth === null ? '?' : Math.round(breadth * 100) + '%'}, median ${pct(med)}` }
}
