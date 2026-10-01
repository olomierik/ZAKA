// Whales: is the coin being handed out (distribution) or collected
// (accumulation)? Read from who sold and bought in the last minutes and what
// they held before (balances rebuilt from the coin's own trades, the creator
// included). A strong distribution score invalidates a buy signal, a middling
// one costs it points (quant/score.ts), and an open position is sold when it
// crosses the exit level (quant/positions.ts).
//
// Distribution:
//   top holders selling      wallets that held 1%+ of the supply selling a large part of it
//   coordinated selling      several large sellers within 2 minutes
//   large-wallet exits       wallets that held 2%+ selling half of it or more
//   rising sell pressure     the last minute's sell share over the last 15 minutes'
//   liquidity deteriorating  the pool's depth falling
//   repeated large sells     many large sales in 5 minutes
// Accumulation: large buys outweighing large sales, the largest holders adding,
// new buyers arriving, rising buy pressure.

import type { TokenTape, WindowStats } from './tape'
import { ramp } from './util'

export interface DistributionView {
  distribution_score: number
  accumulation_score: number
  /** Wallets that held 1%+ of the supply and sold some of it in 5 minutes, with the share they sold (0–1). */
  top_sellers: { wallet: string; heldPct: number; soldShare: number }[]
  large_wallet_exits: number
  creator_sold_5m: boolean
}

export function distributionView(tape: TokenTape, now: number, w: { m1: WindowStats; m2: WindowStats; m5: WindowStats; m15: WindowStats }, o: { liquidityChange5m: number | null; largeTradeImbalance: number; buyPressure1m: number | null; buyPressure15m: number | null; newBuyers5m: number }): DistributionView {
  const supply = tape.supply
  const sold = new Map<string, number>(), bought = new Map<string, number>()
  for (let i = tape.trades.length - 1; i >= 0; i--) {
    const t = tape.trades[i]
    if (t.ts > now) continue
    if (now - t.ts > 300_000) break
    if (!t.wallet) continue
    if (t.side === 'SELL') sold.set(t.wallet, (sold.get(t.wallet) ?? 0) + t.tokens)
    else bought.set(t.wallet, (bought.get(t.wallet) ?? 0) + t.tokens)
  }
  const topSellers: DistributionView['top_sellers'] = []
  let exits = 0
  if (supply && supply > 0) {
    for (const [wallet, s] of sold) {
      const now_ = Math.max(0, tape.holdings.get(wallet)?.tokens ?? 0)
      const before = now_ + s - (bought.get(wallet) ?? 0)
      if (before <= 0) continue
      const heldPct = (before / supply) * 100
      const soldShare = Math.min(1, s / before)
      if (heldPct >= 1) topSellers.push({ wallet, heldPct, soldShare })
      if (heldPct >= 2 && soldShare >= 0.5) exits++
    }
  }
  topSellers.sort((a, b) => b.heldPct * b.soldShare - a.heldPct * a.soldShare)
  const sellShare = (x: WindowStats) => (x.buyUsd + x.sellUsd > 0 ? x.sellUsd / (x.buyUsd + x.sellUsd) : null)
  const s1 = sellShare(w.m1), s15 = sellShare(w.m15)
  const dist =
    25 * ramp(topSellers.reduce((m, x) => Math.max(m, x.soldShare), 0), 0.1, 0.6) +
    20 * ramp(w.m2.largeSellers, 1, 4) +
    15 * ramp(exits, 0, 2) +
    15 * (s1 !== null && s15 !== null ? ramp(s1 - s15, 0.05, 0.3) : 0) +
    15 * ramp(-(o.liquidityChange5m ?? 0), 0.05, 0.25) +
    10 * ramp(w.m5.largeSells, 1, 5)
  // The largest holders adding in the last 5 minutes.
  const top = new Set(tape.topHolders(10).map(h => h.wallet))
  let adding = 0
  for (const [wallet, b] of bought) if (top.has(wallet) && b > (sold.get(wallet) ?? 0)) adding++
  const acc =
    30 * ramp(o.largeTradeImbalance, 0, 0.6) +
    25 * ramp(adding, 0, 4) +
    25 * ramp(o.newBuyers5m, 5, 50) +
    20 * (o.buyPressure1m !== null && o.buyPressure15m !== null ? ramp(o.buyPressure1m - o.buyPressure15m, 0, 0.25) : 0)
  return {
    distribution_score: Math.round(Math.min(100, dist) * 10) / 10,
    accumulation_score: Math.round(Math.min(100, acc) * 10) / 10,
    top_sellers: topSellers.slice(0, 5),
    large_wallet_exits: exits,
    creator_sold_5m: !!tape.creator && (sold.get(tape.creator) ?? 0) > 0,
  }
}
