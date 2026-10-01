// The three strategies, each switched on, off and tuned on its own
// (QuantConfig.strategies). A strategy's conditions say what kind of setup the
// coin is in; the score says how good it is; the gates (quant/engine.ts) say
// whether it may be traded. Each returns every condition with whether it was
// met, so a signal always explains itself.
//
//   A. early_momentum   a young coin with healthy liquidity, strong and broad
//                       buying, accelerating volume, more buyers each minute,
//                       holders not concentrated, not exhausted; smart money
//                       optional (or required, with noSmartMoneyPenalty)
//   B. breakout         an established coin that ranged for 15 minutes,
//                       breaking over the range's high on accelerating
//                       volume, with buying, rising prices and no distribution
//   C. smart_money      several historically profitable wallets entering
//                       within minutes, before the price ran far from their
//                       first entry, with liquidity and buying confirming

import { exitsFor, type ExitConfig, type QuantConfig, type StrategyId } from './config'
import type { Features } from './features'
import { clamp } from './util'

export interface Condition { id: string; ok: boolean; text: string }
export interface StrategyCheck { strategy: StrategyId; ok: boolean; conditions: Condition[]; minScore: number }

const pct = (x: number | null, d = 1) => (x === null ? '?' : `${(x * 100).toFixed(d)}%`)
const usd = (x: number | null) => (x === null ? '?' : `$${Math.round(x).toLocaleString('en-US')}`)
const cond = (id: string, ok: boolean, text: string): Condition => ({ id, ok, text })

export function earlyMomentum(f: Features, c: QuantConfig['strategies']['early_momentum']): StrategyCheck {
  const conditions = [
    cond('age', f.token_age_sec <= c.maxAgeMin * 60, `${Math.round(f.token_age_sec / 60)} min old (at most ${c.maxAgeMin})`),
    cond('liquidity', (f.liquidity ?? 0) >= c.minLiquidityUsd, `liquidity ${usd(f.liquidity)} (at least ${usd(c.minLiquidityUsd)})`),
    cond('buy_pressure', (f.buy_pressure_1m ?? 0) >= c.minBuyPressure1m, `buy pressure ${pct(f.buy_pressure_1m, 0)} over 1m (at least ${pct(c.minBuyPressure1m, 0)})`),
    cond('volume', (f.volume_acceleration ?? 0) >= c.minVolumeAccel, `volume ${(f.volume_acceleration ?? 0).toFixed(1)}× its 5-minute pace (at least ${c.minVolumeAccel}×)`),
    cond('buyers', (f.unique_buyer_growth ?? 0) >= c.minBuyerGrowth && f.unique_buyers_1m >= c.minUniqueBuyers1m, `${f.unique_buyers_1m} buyers in 1m, ${(f.unique_buyer_growth ?? 0).toFixed(1)}× the minute before`),
    cond('broad', f.broad_based, `organic flow ${(f.organic_flow_score * 100).toFixed(0)}/100 (broad buying, not a few wallets)`),
    cond('holders', f.holder_concentration === null || f.holder_concentration <= c.maxTop10Pct, `top 10 hold ${f.holder_concentration === null ? '?' : f.holder_concentration.toFixed(0) + '%'} (at most ${c.maxTop10Pct}%)`),
    cond('exhaustion', f.exhaustion_score <= c.maxExhaustion, `exhaustion ${f.exhaustion_score} (at most ${c.maxExhaustion})`),
  ]
  return { strategy: 'early_momentum', ok: conditions.every(x => x.ok), conditions, minScore: c.minScore + (f.smart_money_count > 0 ? 0 : c.noSmartMoneyPenalty) }
}

export function breakout(f: Features, c: QuantConfig['strategies']['breakout']): StrategyCheck {
  const conditions = [
    cond('established', f.token_age_sec >= c.minAgeMin * 60, `${Math.round(f.token_age_sec / 60)} min old (at least ${c.minAgeMin})`),
    cond('range', f.range_15m_pct !== null && f.range_15m_pct <= c.maxRangePct, `ranged ${f.range_15m_pct === null ? '?' : f.range_15m_pct.toFixed(0) + '%'} over 15 minutes (at most ${c.maxRangePct}%)`),
    cond('break', (f.break_pct ?? -1) >= c.minBreakPct, `${f.break_pct === null ? '?' : f.break_pct.toFixed(1) + '%'} over the range's high (at least ${c.minBreakPct}%)`),
    cond('volume', (f.volume_acceleration ?? 0) >= c.minVolumeAccel, `volume ${(f.volume_acceleration ?? 0).toFixed(1)}× its pace (at least ${c.minVolumeAccel}×)`),
    cond('buy_pressure', (f.buy_pressure_1m ?? 0) >= c.minBuyPressure1m, `buy pressure ${pct(f.buy_pressure_1m, 0)} (at least ${pct(c.minBuyPressure1m, 0)})`),
    cond('momentum', (f.price_change_1m ?? 0) > 0 && (f.price_change_5m ?? 0) > 0 && !f.rolling_over, `up ${pct(f.price_change_1m)} in 1m, ${pct(f.price_change_5m)} in 5m`),
    cond('liquidity', (f.liquidity ?? 0) >= c.minLiquidityUsd, `liquidity ${usd(f.liquidity)} (at least ${usd(c.minLiquidityUsd)})`),
    cond('distribution', f.distribution_score <= c.maxDistribution, `distribution ${f.distribution_score} (at most ${c.maxDistribution})`),
    cond('exhaustion', f.exhaustion_score <= c.maxExhaustion, `exhaustion ${f.exhaustion_score} (at most ${c.maxExhaustion})`),
  ]
  return { strategy: 'breakout', ok: conditions.every(x => x.ok), conditions, minScore: c.minScore }
}

export function smartMoney(f: Features, c: QuantConfig['strategies']['smart_money'], cluster: { windowMin: number }): StrategyCheck {
  const conditions = [
    cond('wallets', f.smart_money_count >= c.minWallets, `${f.smart_money_count} smart wallets bought in the last ${cluster.windowMin} min (at least ${c.minWallets})`),
    cond('not_exiting', f.smart_money_exits === 0, f.smart_money_exits ? `${f.smart_money_exits} smart wallets already selling` : 'none of them selling'),
    cond('runup', f.smart_money_runup_pct === null || f.smart_money_runup_pct <= c.maxRunupPct, `up ${f.smart_money_runup_pct === null ? '?' : f.smart_money_runup_pct.toFixed(0) + '%'} since their first entry (at most ${c.maxRunupPct}%)`),
    cond('liquidity', (f.liquidity ?? 0) >= c.minLiquidityUsd, `liquidity ${usd(f.liquidity)} (at least ${usd(c.minLiquidityUsd)})`),
    cond('flow', (f.buy_pressure_1m ?? 0) >= c.minBuyPressure1m, `buy pressure ${pct(f.buy_pressure_1m, 0)} (at least ${pct(c.minBuyPressure1m, 0)})`),
    cond('exhaustion', f.exhaustion_score <= c.maxExhaustion, `exhaustion ${f.exhaustion_score} (at most ${c.maxExhaustion})`),
  ]
  return { strategy: 'smart_money', ok: conditions.every(x => x.ok), conditions, minScore: c.minScore }
}

/** Every enabled strategy's check, in a fixed order. */
export function checkStrategies(f: Features, c: QuantConfig): StrategyCheck[] {
  const out: StrategyCheck[] = []
  if (c.strategies.smart_money.enabled) out.push(smartMoney(f, c.strategies.smart_money, { windowMin: c.smartMoney.windowMin }))
  if (c.strategies.early_momentum.enabled) out.push(earlyMomentum(f, c.strategies.early_momentum))
  if (c.strategies.breakout.enabled) out.push(breakout(f, c.strategies.breakout))
  return out
}

/** The stop below the entry: `volMult` × the coin's volatility a minute, kept between the configured bounds (%). */
export function stopPctFor(volatilityPct: number | null, e: ExitConfig): number {
  if (volatilityPct === null || !Number.isFinite(volatilityPct)) return e.stop.maxPct
  return clamp(e.stop.volMult * volatilityPct, e.stop.minPct, e.stop.maxPct)
}

export interface Plan {
  exits: ExitConfig
  entry: { price: number; maxSlippagePct: number }
  stop: { price: number; pct: number }
  targets: { price: number; gainPct: number; sellPct: number }[]
}

export function planFor(s: StrategyId, price: number, volatilityPct: number | null, c: QuantConfig): Plan {
  const exits = exitsFor(c, s)
  const stopPct = stopPctFor(volatilityPct, exits)
  return {
    exits,
    entry: { price, maxSlippagePct: Math.min(c.risk.maxSlippagePct, c.execution.buySlippageBps / 100) },
    stop: { price: price * (1 - stopPct / 100), pct: Math.round(stopPct * 100) / 100 },
    targets: exits.ladder.map(t => ({ price: price * (1 + t.gainPct / 100), gainPct: t.gainPct, sellPct: t.sellPct })),
  }
}
