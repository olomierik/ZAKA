// The flow engine: who is buying and selling a coin, how much, and how
// broadly. $100k of buying from 5 wallets is not $100k from 300: the organic
// flow score rewards many buyers of similar size (low concentration) and
// marks buying that a few wallets make.

import type { WindowStats } from './tape'
import { ramp, ratio } from './util'

export interface FlowFeatures {
  buy_volume_1m: number
  sell_volume_1m: number
  buy_count_1m: number
  sell_count_1m: number
  unique_buyers_1m: number
  unique_sellers_1m: number
  unique_buyers_5m: number
  unique_sellers_5m: number
  new_buyers_5m: number
  avg_buy_size_1m: number
  avg_sell_size_1m: number
  large_buy_count_5m: number
  large_sell_count_5m: number
  /** (large buy USD − large sell USD) / (both), over 5 minutes: −1 … 1, 0 when there were none. */
  large_trade_imbalance: number
  /** buy volume / (buy + sell volume); null when nothing traded. */
  buy_pressure_30s: number | null
  buy_pressure_1m: number | null
  buy_pressure_5m: number | null
  buy_pressure_15m: number | null
  /** Distinct buyers in the last minute over the minute before (ratio; ≥ 1 is growth). */
  unique_buyer_growth: number | null
  unique_seller_growth: number | null
  /** Trades in the last minute over the 5-minute average a minute. */
  transaction_acceleration: number | null
  buyer_hhi_5m: number
  top5_buy_share_5m: number
  top_buyer_share_5m: number
  /** 0–1: broad (many similar buyers) to concentrated (a few wallets). */
  organic_flow_score: number
  broad_based: boolean
}

export const buyPressure = (w: Pick<WindowStats, 'buyUsd' | 'sellUsd'>): number | null => {
  const total = w.buyUsd + w.sellUsd
  return total > 0 ? w.buyUsd / total : null
}

/** Growth of a count over the previous window: (now + 1) / (before + 1), so 0 → 3 buyers is 4×, not infinite. */
export const growth = (now: number, before: number) => (now + 1) / (before + 1)

/**
 * 0–1. Breadth: distinct buyers in 5 minutes (3 → 0, 40 → 1). Dispersion: the 5
 * largest buyers' share (90% → 0, 40% → 1). Evenness: 1 − the Herfindahl index
 * of the buyers' shares (0.5 → 0, 0.1 → 1).
 */
export function organicFlowScore(w5m: Pick<WindowStats, 'buyers' | 'top5BuyShare' | 'buyerHHI' | 'buyUsd'>): number {
  if (!(w5m.buyUsd > 0) || w5m.buyers === 0) return 0
  const breadth = ramp(w5m.buyers, 3, 40)
  const dispersion = 1 - ramp(w5m.top5BuyShare, 0.4, 0.9)
  const evenness = 1 - ramp(w5m.buyerHHI, 0.1, 0.5)
  return 0.4 * breadth + 0.3 * dispersion + 0.3 * evenness
}

export function flowFeatures(w: { s30: WindowStats; m1: WindowStats; prev1m: WindowStats; m5: WindowStats; m15: WindowStats }): FlowFeatures {
  const big = w.m5.largeBuyUsd + w.m5.largeSellUsd
  const organic = organicFlowScore(w.m5)
  return {
    buy_volume_1m: w.m1.buyUsd, sell_volume_1m: w.m1.sellUsd,
    buy_count_1m: w.m1.buys, sell_count_1m: w.m1.sells,
    unique_buyers_1m: w.m1.buyers, unique_sellers_1m: w.m1.sellers,
    unique_buyers_5m: w.m5.buyers, unique_sellers_5m: w.m5.sellers,
    new_buyers_5m: w.m5.newBuyers,
    avg_buy_size_1m: w.m1.avgBuy, avg_sell_size_1m: w.m1.avgSell,
    large_buy_count_5m: w.m5.largeBuys, large_sell_count_5m: w.m5.largeSells,
    large_trade_imbalance: big > 0 ? (w.m5.largeBuyUsd - w.m5.largeSellUsd) / big : 0,
    buy_pressure_30s: buyPressure(w.s30), buy_pressure_1m: buyPressure(w.m1), buy_pressure_5m: buyPressure(w.m5), buy_pressure_15m: buyPressure(w.m15),
    unique_buyer_growth: w.m1.trades + w.prev1m.trades > 0 ? growth(w.m1.buyers, w.prev1m.buyers) : null,
    unique_seller_growth: w.m1.trades + w.prev1m.trades > 0 ? growth(w.m1.sellers, w.prev1m.sellers) : null,
    transaction_acceleration: ratio(w.m1.trades, w.m5.trades / 5),
    buyer_hhi_5m: w.m5.buyerHHI, top5_buy_share_5m: w.m5.top5BuyShare, top_buyer_share_5m: w.m5.topBuyerShare,
    organic_flow_score: organic,
    broad_based: organic >= 0.5,
  }
}
