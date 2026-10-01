// Every number the engine knows about a coin at one moment, computed from its
// tape (quant/tape.ts) and the wallet book, with nothing from after `now`.
// The same function runs live and in backtests, and the result is stored
// with every signal (arcdex_sig_signal_features): the feature vector for
// later model work (quant/labels.ts adds the outcomes).

import type { Regime } from './config'
import { distributionView, type DistributionView } from './distribution'
import { exhaustionScore, type ExhaustionParts } from './exhaustion'
import { flowFeatures, type FlowFeatures } from './flow'
import { liquidityFeatures, type LiquidityFeatures } from './liquidity'
import { momentumFeatures, WINDOWS, type MomentumFeatures } from './momentum'
import type { TokenTape, WindowStats } from './tape'
import { ratio } from './util'
import type { SmartView, WalletBook } from './wallets'

export interface VolumeFeatures {
  volume_5s: number
  volume_15s: number
  volume_30s: number
  volume_1m: number
  volume_3m: number
  volume_5m: number
  volume_15m: number
  volume_1h: number
  /** The last minute's volume over the 5-minute average a minute (> 1: accelerating). */
  volume_acceleration: number | null
  /** 5 minutes over the 15-minute average per 5 minutes. */
  volume_acceleration_5m: number | null
  trades_1m: number
  trades_5m: number
}

export interface HolderFeatures {
  holders: number
  /** Holders now over 15 minutes ago, minus 1 (null when the tape doesn't reach back). */
  holder_growth_15m: number | null
  holder_growth_5m: number | null
  /** Top-10 holders' share of the supply (%), the creator included; null without a supply. */
  holder_concentration: number | null
  creator_holding_pct: number | null
  /** The creator's unsold share of what they bought (0–1); null if they never bought. */
  creator_left: number | null
}

export type Features = FlowFeatures & MomentumFeatures & LiquidityFeatures & VolumeFeatures & HolderFeatures & {
  token_age_sec: number
  price: number | null
  smart_money_count: number
  smart_money_quality: number
  smart_money_exits: number
  smart_money_cluster: boolean
  /** Up since the first smart wallet's entry in the window (%). */
  smart_money_runup_pct: number | null
  exhaustion_score: number
  distribution_score: number
  accumulation_score: number
  large_wallet_exits: number
  creator_sold_5m: boolean
  market_regime: Regime
}

export interface FeatureContext {
  wallets: WalletBook | null
  regime: Regime
  large: { minUsd: number; liquidityPct: number }
  /** The pool's depth when the tape has none yet (the engine's token state). */
  liquidityFallback?: number | null
}

export interface FeatureResult {
  f: Features
  smart: SmartView | null
  distribution: DistributionView
  exhaustionParts: ExhaustionParts
  windows: { s5: WindowStats; s30: WindowStats; m1: WindowStats; m5: WindowStats; m15: WindowStats }
}

export function computeFeatures(tape: TokenTape, now: number, ctx: FeatureContext): FeatureResult {
  const w = (ms: number) => tape.window(now, ms, ctx.large)
  // Full windows where wallets and prices matter; plain volume sums for the rest.
  const s5 = w(WINDOWS.s5), s30 = w(WINDOWS.s30), m1 = w(WINDOWS.m1), m2 = w(120_000), m5 = w(WINDOWS.m5), m15 = w(WINDOWS.m15)
  const prev1m = tape.window(now - 60_000, 60_000, ctx.large)
  const vol = (x: WindowStats) => x.buyUsd + x.sellUsd
  const flow = flowFeatures({ s30, m1, prev1m, m5, m15 })
  const mom = momentumFeatures(tape, now, m5.vwap)
  const price = tape.priceAt(now)
  const liquidity = tape.liquidityAt(now) ?? ctx.liquidityFallback ?? null
  const liq = liquidityFeatures({
    liquidity, liq5mAgo: tape.liquidityAt(now - 300_000), liq15mAgo: tape.liquidityAt(now - 900_000),
    liqHigh15m: tape.liquidityHigh(now, 900_000), price, supply: tape.supply, volume5m: vol(m5),
  })
  const volume: VolumeFeatures = {
    volume_5s: vol(s5), volume_15s: tape.volume(now, WINDOWS.s15), volume_30s: vol(s30), volume_1m: vol(m1), volume_3m: tape.volume(now, WINDOWS.m3), volume_5m: vol(m5), volume_15m: vol(m15), volume_1h: tape.volume(now, WINDOWS.h1),
    volume_acceleration: ratio(vol(m1), vol(m5) / 5), volume_acceleration_5m: ratio(vol(m5), vol(m15) / 3),
    trades_1m: m1.trades, trades_5m: m5.trades,
  }
  const holdersAgo = (ms: number) => { const then = tape.holdersAgo(now, ms); return then && then > 0 ? tape.holders / then - 1 : null }
  const top10 = tape.topHolders(10)
  const creatorTokens = tape.creator ? Math.max(0, tape.holdings.get(tape.creator)?.tokens ?? 0) : 0
  const holders: HolderFeatures = {
    holders: tape.holders, holder_growth_15m: holdersAgo(900_000), holder_growth_5m: holdersAgo(300_000),
    holder_concentration: tape.supply ? (top10.reduce((s, h) => s + h.tokens, 0) / tape.supply) * 100 : null,
    creator_holding_pct: tape.supply ? (creatorTokens / tape.supply) * 100 : null,
    creator_left: tape.creatorLeft(),
  }
  const smart = ctx.wallets ? ctx.wallets.smartView(tape, now) : null
  const dist = distributionView(tape, now, { m1, m2, m5, m15 }, { liquidityChange5m: liq.liquidity_change_5m, largeTradeImbalance: flow.large_trade_imbalance, buyPressure1m: flow.buy_pressure_1m, buyPressure15m: flow.buy_pressure_15m, newBuyers5m: flow.new_buyers_5m })
  const ex = exhaustionScore(mom, flow, m5)
  const f: Features = {
    ...flow, ...mom, ...liq, ...volume, ...holders,
    token_age_sec: Math.max(0, (now - tape.launchedAt) / 1000),
    price,
    smart_money_count: smart?.smart_money_count ?? 0,
    smart_money_quality: smart?.smart_money_quality ?? 0,
    smart_money_exits: smart?.smart_money_exits ?? 0,
    smart_money_cluster: smart?.cluster ?? false,
    smart_money_runup_pct: smart?.first_entry_price && price ? (price / smart.first_entry_price - 1) * 100 : null,
    exhaustion_score: ex.score,
    distribution_score: dist.distribution_score,
    accumulation_score: dist.accumulation_score,
    large_wallet_exits: dist.large_wallet_exits,
    creator_sold_5m: dist.creator_sold_5m,
    market_regime: ctx.regime,
  }
  return { f, smart, distribution: dist, exhaustionParts: ex.parts, windows: { s5, s30, m1, m5, m15 } }
}

/** The fields kept as the model's feature vector (Phase 20), in a fixed order: numbers, booleans as 0/1, the regime as an index. */
export const VECTOR_FIELDS = [
  'price_change_5s', 'price_change_15s', 'price_change_30s', 'price_change_1m', 'price_change_3m', 'price_change_5m', 'price_change_15m',
  'volume_1m', 'volume_5m', 'volume_acceleration', 'volume_acceleration_5m', 'buy_pressure_30s', 'buy_pressure_1m', 'buy_pressure_5m',
  'unique_buyers_1m', 'unique_buyers_5m', 'unique_buyer_growth', 'unique_seller_growth', 'transaction_acceleration', 'organic_flow_score',
  'liquidity', 'liquidity_change_5m', 'liquidity_change_15m', 'market_cap', 'liquidity_to_mcap', 'volume_to_liquidity',
  'holders', 'holder_growth_15m', 'holder_concentration', 'creator_holding_pct', 'smart_money_count', 'smart_money_quality', 'smart_money_exits',
  'large_buy_count_5m', 'large_sell_count_5m', 'large_trade_imbalance', 'volatility', 'volatility_ratio', 'dist_from_vwap_5m',
  'token_age_sec', 'exhaustion_score', 'distribution_score', 'accumulation_score',
] as const

export function featureVector(f: Features, extra: { tax: number | null; slippage: number | null; signalScore: number; regimeIndex: number }): Record<string, number | null> {
  const v: Record<string, number | null> = {}
  for (const k of VECTOR_FIELDS) { const x = (f as unknown as Record<string, unknown>)[k]; v[k] = typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'boolean' ? (x ? 1 : 0) : null }
  v.tax = extra.tax; v.slippage = extra.slippage; v.signal_score = extra.signalScore; v.market_regime = extra.regimeIndex
  return v
}
