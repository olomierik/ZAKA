// How a coin has actually traded since launch, from its own trades (each
// with its wallet, block and amounts, as the engine parses them). Pure: the
// tape comes in, numbers come out, so every rule is testable.
//
//   bundling   several wallets buying a large share of the supply in the
//              launch block and the two after it: one buyer split across
//              wallets, or insiders, holding the supply from the start
//   wash       a few wallets making most of the volume by buying and
//              selling back and forth: fake activity
//   creator    buying at launch (dev snipe) and selling early (a dump)
//   sellable   someone other than the creator has sold: whatever the probe
//              says, a real holder got out
//   path       the peak since launch and the fall from it (second leg)

import type { Trade } from '../../../api/_marketProtocol'

export interface TapeTrade {
  block: number
  ts: number
  wallet: string | null
  side: 'BUY' | 'SELL' | 'UNKNOWN'
  usd: number
  tokens: number
  price: number | null
}

export const tapeTrade = (t: Trade): TapeTrade => ({
  block: t.blockNumber, ts: t.timestamp, wallet: t.wallet?.toLowerCase() ?? null, side: t.side,
  usd: t.usdValue ?? 0, tokens: t.tokenAmount, price: t.priceUsd,
})

export interface Flow {
  trades: number
  buyers: number
  sellers: number
  buyUsd: number
  sellUsd: number
  /** Buyers other than the creator who later sold: the coin is sellable in practice. */
  outsideSellers: number
  /** Launch block and the next two. */
  bundle: { wallets: number; supplyPct: number | null; usd: number }
  creator: { boughtUsd: number; soldUsd: number; soldTokensPct: number | null; boughtAtLaunch: boolean }
  /** Share of all volume made by the three busiest wallets. */
  top3VolumePct: number
  /** Share of volume from wallets that both bought and sold, round trips within 10 minutes. */
  roundTripVolumePct: number
  /** The largest single buyer's share of buy volume. */
  topBuyerPct: number
  firstPrice: number | null
  peakPrice: number | null
  lastPrice: number | null
  /** peak / first */
  peakMultiple: number | null
  /** 1 − last / peak */
  drawdownFromPeak: number | null
  /**
   * The market's own buying: the creator's buys and the launch blocks' left
   * out (the creator's stake and any bundle are the scanner's checks), every
   * sale counted. The snipe rule reads this (2026-09-30): a creator who
   * bought $2,500 at launch was "one buyer" with most of the buy volume, so no
   * snipe could pass on a dev-sniped coin, and the same buy made "$200 bought"
   * and "buys over sells" true on its own. Prices are from after the launch
   * blocks, so "not late" is measured from the market's first price.
   */
  organic: { buyers: number; buyUsd: number; sellUsd: number; topBuyerPct: number; firstPrice: number | null; peakPrice: number | null; lastPrice: number | null }
}

const ROUND_TRIP_MS = 10 * 60_000

export function computeFlow(tape: TapeTrade[], o: { launchBlock: number; creator: string | null; supply: number | null }): Flow {
  const trades = [...tape].sort((a, b) => a.block - b.block || a.ts - b.ts)
  const creator = o.creator?.toLowerCase() ?? null
  const byWallet = new Map<string, { buyUsd: number; sellUsd: number; buyTokens: number; sellTokens: number; buys: number[]; sells: number[] }>()
  let buyUsd = 0, sellUsd = 0
  const bundle = { wallets: new Set<string>(), tokens: 0, usd: 0 }
  for (const t of trades) {
    if (t.side === 'BUY') buyUsd += t.usd; else if (t.side === 'SELL') sellUsd += t.usd
    if (!t.wallet) continue
    const w = byWallet.get(t.wallet) ?? { buyUsd: 0, sellUsd: 0, buyTokens: 0, sellTokens: 0, buys: [], sells: [] }
    if (t.side === 'BUY') { w.buyUsd += t.usd; w.buyTokens += t.tokens; w.buys.push(t.ts) }
    if (t.side === 'SELL') { w.sellUsd += t.usd; w.sellTokens += t.tokens; w.sells.push(t.ts) }
    byWallet.set(t.wallet, w)
    if (t.side === 'BUY' && t.block <= o.launchBlock + 2) { bundle.wallets.add(t.wallet); bundle.tokens += t.tokens; bundle.usd += t.usd }
  }
  const volume = buyUsd + sellUsd
  const wallets = [...byWallet.entries()]
  const vol = (w: { buyUsd: number; sellUsd: number }) => w.buyUsd + w.sellUsd
  const top3 = wallets.map(([, w]) => vol(w)).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0)
  // Round trips: a wallet selling within 10 minutes of buying (or buying back
  // within 10 minutes of selling). Its whole volume counts as churn.
  const churn = wallets.filter(([, w]) => w.buys.some(b => w.sells.some(s => Math.abs(s - b) <= ROUND_TRIP_MS))).reduce((s, [, w]) => s + vol(w), 0)
  const topBuyer = wallets.reduce((m, [, w]) => Math.max(m, w.buyUsd), 0)
  const c = creator ? byWallet.get(creator) : undefined
  const creatorTrades = creator ? trades.filter(t => t.wallet === creator) : []
  const prices = trades.map(t => t.price).filter((p): p is number => p !== null && p > 0)
  const firstPrice = prices[0] ?? null, peakPrice = prices.length ? Math.max(...prices) : null, lastPrice = prices[prices.length - 1] ?? null
  // The market's own buying (see Flow.organic).
  const afterLaunch = trades.filter(t => t.block > o.launchBlock + 2)
  const organicBuys = new Map<string, number>()
  let organicBuyUsd = 0
  for (const t of afterLaunch) {
    if (t.side !== 'BUY' || (creator && t.wallet === creator)) continue
    organicBuyUsd += t.usd
    if (t.wallet) organicBuys.set(t.wallet, (organicBuys.get(t.wallet) ?? 0) + t.usd)
  }
  const organicPrices = afterLaunch.map(t => t.price).filter((p): p is number => p !== null && p > 0)
  return {
    trades: trades.length,
    buyers: wallets.filter(([, w]) => w.buyUsd > 0).length,
    sellers: wallets.filter(([, w]) => w.sellUsd > 0).length,
    buyUsd, sellUsd,
    outsideSellers: wallets.filter(([a, w]) => a !== creator && w.buyUsd > 0 && w.sellUsd > 0).length,
    bundle: { wallets: bundle.wallets.size, supplyPct: o.supply ? (bundle.tokens / o.supply) * 100 : null, usd: bundle.usd },
    creator: {
      boughtUsd: c?.buyUsd ?? 0,
      soldUsd: c?.sellUsd ?? 0,
      soldTokensPct: c && c.buyTokens > 0 ? (c.sellTokens / c.buyTokens) * 100 : null,
      boughtAtLaunch: creatorTrades.some(t => t.side === 'BUY' && t.block <= o.launchBlock + 2),
    },
    top3VolumePct: volume > 0 ? (top3 / volume) * 100 : 0,
    roundTripVolumePct: volume > 0 ? (churn / volume) * 100 : 0,
    topBuyerPct: buyUsd > 0 ? (topBuyer / buyUsd) * 100 : 0,
    firstPrice, peakPrice, lastPrice,
    peakMultiple: firstPrice && peakPrice ? peakPrice / firstPrice : null,
    drawdownFromPeak: peakPrice && lastPrice ? 1 - lastPrice / peakPrice : null,
    organic: {
      buyers: organicBuys.size, buyUsd: organicBuyUsd, sellUsd,
      topBuyerPct: organicBuyUsd > 0 ? (Math.max(0, ...organicBuys.values()) / organicBuyUsd) * 100 : 0,
      firstPrice: organicPrices[0] ?? null, peakPrice: organicPrices.length ? Math.max(...organicPrices) : null, lastPrice: organicPrices[organicPrices.length - 1] ?? null,
    },
  }
}

/** Each coin's tape since launch, capped (the engine feeds it every trade). */
export class Tapes {
  private tapes = new Map<string, TapeTrade[]>()
  constructor(private cap = 2_000) {}
  add(token: string, t: TapeTrade) {
    const list = this.tapes.get(token) ?? []
    if (list.length >= this.cap) return // the start of a coin's life is what the rules read
    list.push(t)
    this.tapes.set(token, list)
  }
  get(token: string): TapeTrade[] { return this.tapes.get(token) ?? [] }
  has(token: string) { return this.tapes.has(token) }
  drop(token: string) { this.tapes.delete(token) }
  get size() { return this.tapes.size }
  tokens() { return [...this.tapes.keys()] }
}

/** Each coin's last few minutes of trades (any age: the tape above keeps only
 * a coin's start). The rug guard and the momentum scalp rule read it. */
export class RecentTapes {
  private tapes = new Map<string, TapeTrade[]>()
  constructor(private keepMs = 180_000, private cap = 400) {}
  add(token: string, t: TapeTrade, now = t.ts) {
    let list = this.tapes.get(token)
    if (!list) { list = []; this.tapes.set(token, list) }
    list.push(t)
    let drop = 0
    while (drop < list.length && (now - list[drop].ts > this.keepMs || list.length - drop > this.cap)) drop++
    if (drop) list.splice(0, drop)
  }
  /** Trades of the last `ms` before `now`. */
  window(token: string, now: number, ms: number): TapeTrade[] { return (this.tapes.get(token) ?? []).filter(t => now - t.ts <= ms && t.ts <= now + 5_000) }
  drop(token: string) { this.tapes.delete(token) }
  tokens() { return [...this.tapes.keys()] }
  /** Coins that traded within the kept span, most recent trade first; forgets the rest. */
  active(now: number): string[] {
    const out: [string, number][] = []
    for (const [token, list] of this.tapes) {
      const last = list[list.length - 1]?.ts ?? 0
      if (now - last > this.keepMs) this.tapes.delete(token); else out.push([token, last])
    }
    return out.sort((x, y) => y[1] - x[1]).map(([t]) => t)
  }
  get size() { return this.tapes.size }
}

/** A short window of trading, in numbers (the momentum scalp rule). */
export interface Window {
  trades: number
  buyers: number
  sellers: number
  buyUsd: number
  sellUsd: number
  firstPrice: number | null
  lastPrice: number | null
  high: number | null
  low: number | null
  topBuyerPct: number
}

export function windowOf(trades: TapeTrade[]): Window {
  const buyers = new Map<string, number>(), sellers = new Set<string>()
  let buyUsd = 0, sellUsd = 0
  const prices: number[] = []
  for (const t of [...trades].sort((a, b) => a.ts - b.ts || a.block - b.block)) {
    if (t.side === 'BUY') { buyUsd += t.usd; if (t.wallet) buyers.set(t.wallet, (buyers.get(t.wallet) ?? 0) + t.usd) }
    else if (t.side === 'SELL') { sellUsd += t.usd; if (t.wallet) sellers.add(t.wallet) }
    if (t.price !== null && t.price > 0) prices.push(t.price)
  }
  const top = Math.max(0, ...buyers.values())
  return {
    trades: trades.length, buyers: buyers.size, sellers: sellers.size, buyUsd, sellUsd,
    firstPrice: prices[0] ?? null, lastPrice: prices[prices.length - 1] ?? null,
    high: prices.length ? Math.max(...prices) : null, low: prices.length ? Math.min(...prices) : null,
    topBuyerPct: buyUsd > 0 ? (top / buyUsd) * 100 : 0,
  }
}
