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
