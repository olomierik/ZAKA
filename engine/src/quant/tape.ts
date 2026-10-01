// One coin's market data for the signal engine: its trades of the last hour
// (for the 5s … 1h rolling windows) and, since its launch, every wallet's
// position (holders, the creator's bag, first buys). Fed event by event from
// the engine's normalized trades: nothing here queries the chain.
//
// Duplicate events (a reconcile re-delivering a log) are dropped by trade id;
// a late event is put back in chain order (block, log index). A window is
// computed on demand by walking back from the newest trade, so adding a trade
// is O(1) and reading the windows costs one pass over the last hour at most.

import type { Trade } from '../../../api/_marketProtocol'

export interface QTrade {
  id: string
  ts: number
  /** Chain order: block × 100,000 + log index. */
  ord: number
  side: 'BUY' | 'SELL'
  usd: number
  tokens: number
  /** The coin's USD price after the trade (its main pool); null for a side pool's trade. */
  price: number | null
  wallet: string | null
  /** The main pool's USD depth after the trade, when known. */
  liquidity: number | null
}

export const KEEP_MS = 3_600_000 + 120_000
/** Ids remembered for dedupe, per coin. */
const IDS_KEPT = 20_000

export interface Holding { tokens: number; boughtUsd: number; soldUsd: number; boughtTokens: number; firstBuyAt: number; lastAt: number }

export interface WindowStats {
  ms: number
  trades: number
  buys: number
  sells: number
  buyUsd: number
  sellUsd: number
  buyers: number
  sellers: number
  /** Wallets whose first ever buy of the coin is in the window. */
  newBuyers: number
  avgBuy: number
  avgSell: number
  largeBuys: number
  largeSells: number
  largeBuyUsd: number
  largeSellUsd: number
  /** The price at the window's start (the last price before it, else its first), its last, high and low. */
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  /** Volume-weighted average price of the window's priced trades. */
  vwap: number | null
  /** Herfindahl index of the buyers' shares of the window's buying (1: one wallet; near 0: many equal ones). */
  buyerHHI: number
  /** Share of the window's buying by its 5 largest buyers, and by its largest one (0–1). */
  top5BuyShare: number
  topBuyerShare: number
  /** Distinct wallets among the large sells. */
  largeSellers: number
}

export interface Bucket { t: number; o: number; h: number; l: number; c: number; buyUsd: number; sellUsd: number; n: number }

export class TokenTape {
  readonly trades: QTrade[] = []
  private ids = new Set<string>()
  private idOrder: string[] = []
  readonly holdings = new Map<string, Holding>()
  /** Wallets holding a positive balance, kept as trades arrive. */
  holders = 0
  /** Holders at the end of each minute (minute → count), for holder growth. */
  private holderMinutes = new Map<number, number>()
  firstPrice: number | null = null
  peakPrice: number | null = null
  lastPrice: number | null = null
  lastTs = 0
  lastLiquidity: number | null = null
  totalBuyUsd = 0
  totalSellUsd = 0
  creatorBoughtTokens = 0
  creatorSoldTokens = 0
  /** Bumped on every change to the holdings (caches the largest holders). */
  private version = 0
  private topCache: { version: number; key: string; rows: { wallet: string; tokens: number; pct: number | null }[] } | null = null

  constructor(readonly token: string, readonly launchedAt: number, readonly creator: string | null, public supply: number | null, readonly launchpad: string | null = null, readonly symbol: string = '') {}

  /** Adds a trade; false if it was already seen. */
  add(t: QTrade): boolean {
    if (this.ids.has(t.id)) return false
    this.ids.add(t.id); this.idOrder.push(t.id)
    if (this.idOrder.length > IDS_KEPT) { for (const id of this.idOrder.splice(0, this.idOrder.length - IDS_KEPT)) this.ids.delete(id) }
    // In chain order; a late event goes back to its place.
    const n = this.trades.length
    if (!n || this.trades[n - 1].ord <= t.ord) this.trades.push(t)
    else {
      let lo = 0, hi = n
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.trades[mid].ord <= t.ord) lo = mid + 1; else hi = mid }
      this.trades.splice(lo, 0, t)
    }
    if (t.side === 'BUY') this.totalBuyUsd += t.usd; else this.totalSellUsd += t.usd
    if (t.price !== null && t.price > 0) {
      if (this.firstPrice === null) this.firstPrice = t.price
      if (this.peakPrice === null || t.price > this.peakPrice) this.peakPrice = t.price
      if (t.ts >= this.lastTs) { this.lastPrice = t.price; if (t.liquidity !== null) this.lastLiquidity = t.liquidity }
    }
    if (t.ts > this.lastTs) this.lastTs = t.ts
    if (t.wallet) this.hold(t)
    this.prune(t.ts)
    return true
  }

  private hold(t: QTrade) {
    const w = t.wallet!
    const h = this.holdings.get(w) ?? { tokens: 0, boughtUsd: 0, soldUsd: 0, boughtTokens: 0, firstBuyAt: Infinity, lastAt: 0 }
    const had = h.tokens > 1e-9
    if (t.side === 'BUY') { h.tokens += t.tokens; h.boughtUsd += t.usd; h.boughtTokens += t.tokens; h.firstBuyAt = Math.min(h.firstBuyAt, t.ts) }
    else { h.tokens -= t.tokens; h.soldUsd += t.usd }
    h.lastAt = Math.max(h.lastAt, t.ts)
    this.holdings.set(w, h)
    this.version++
    const has = h.tokens > 1e-9
    this.holders += (has && !had ? 1 : 0) - (had && !has ? 1 : 0)
    this.holderMinutes.set(Math.floor(t.ts / 60_000), this.holders)
    if (this.creator && w === this.creator) { if (t.side === 'BUY') this.creatorBoughtTokens += t.tokens; else this.creatorSoldTokens += t.tokens }
  }

  private prune(now: number) {
    let drop = 0
    while (drop < this.trades.length && now - this.trades[drop].ts > KEEP_MS) drop++
    if (drop) this.trades.splice(0, drop)
    if (this.holderMinutes.size > 90) { const oldest = Math.floor((now - KEEP_MS) / 60_000); for (const m of this.holderMinutes.keys()) if (m < oldest) this.holderMinutes.delete(m) }
  }

  /** Holders `ms` ago (the count at the end of the last minute with trades before then), or null if unknown. */
  holdersAgo(now: number, ms: number): number | null {
    const target = Math.floor((now - ms) / 60_000)
    let best: number | null = null, bestM = -Infinity
    for (const [m, c] of this.holderMinutes) if (m <= target && m > bestM) { best = c; bestM = m }
    return best
  }

  /** The index of the last trade at or before `ts` (−1 if none). Block times rise with chain order, so this is a binary search. */
  indexAt(ts: number): number {
    let lo = 0, hi = this.trades.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.trades[mid].ts <= ts) lo = mid + 1; else hi = mid }
    return lo - 1
  }

  /** The last price at or before `ts`, else null. */
  priceAt(ts: number): number | null {
    for (let i = this.indexAt(ts); i >= 0; i--) { const p = this.trades[i].price; if (p !== null) return p }
    return null
  }

  /** The main pool's depth at or before `ts` (the last known), else null. */
  liquidityAt(ts: number): number | null {
    for (let i = this.indexAt(ts); i >= 0; i--) { const l = this.trades[i].liquidity; if (l !== null) return l }
    return null
  }

  /** USD traded in the window (now − ms, now]: the cheap sum for long windows. */
  volume(now: number, ms: number): number {
    let v = 0
    for (let i = this.indexAt(now); i >= 0 && this.trades[i].ts > now - ms; i--) v += this.trades[i].usd
    return v
  }

  /** The highest pool depth of the window (the liquidity-pull check). */
  liquidityHigh(now: number, ms: number): number | null {
    let hi: number | null = null
    for (let i = this.indexAt(now); i >= 0 && now - this.trades[i].ts <= ms; i--) { const l = this.trades[i].liquidity; if (l !== null && l > (hi ?? -1)) hi = l }
    return hi
  }

  /** A trade is large at max(minUsd, liquidityPct % of the pool's depth then). */
  static isLarge(t: QTrade, minUsd: number, liquidityPct: number, liq: number | null): boolean {
    const depth = t.liquidity ?? liq
    return t.usd >= Math.max(minUsd, depth ? (depth * liquidityPct) / 100 : 0)
  }

  /** The window of `ms` ending at `now` (trades with now − ms < ts ≤ now). */
  window(now: number, ms: number, large: { minUsd: number; liquidityPct: number } = { minUsd: 250, liquidityPct: 1 }): WindowStats {
    const from = now - ms
    let buys = 0, sells = 0, buyUsd = 0, sellUsd = 0, largeBuys = 0, largeSells = 0, largeBuyUsd = 0, largeSellUsd = 0, newBuyers = 0
    let close: number | null = null, first: number | null = null, high: number | null = null, low: number | null = null, pv = 0, vol = 0
    const buyers = new Map<string, number>(), sellers = new Set<string>(), bigSellers = new Set<string>(), counted = new Set<string>()
    let open: number | null = null
    let i = this.indexAt(now)
    for (; i >= 0; i--) {
      const t = this.trades[i]
      if (t.ts <= from) break
      if (t.side === 'BUY') {
        buys++; buyUsd += t.usd
        if (t.wallet) {
          buyers.set(t.wallet, (buyers.get(t.wallet) ?? 0) + t.usd)
          const h = this.holdings.get(t.wallet)
          if (h && h.firstBuyAt === t.ts && !counted.has(t.wallet)) { newBuyers++; counted.add(t.wallet) }
        }
      } else { sells++; sellUsd += t.usd; if (t.wallet) sellers.add(t.wallet) }
      if (TokenTape.isLarge(t, large.minUsd, large.liquidityPct, this.lastLiquidity)) {
        if (t.side === 'BUY') { largeBuys++; largeBuyUsd += t.usd } else { largeSells++; largeSellUsd += t.usd; if (t.wallet) bigSellers.add(t.wallet) }
      }
      if (t.price !== null && t.price > 0) {
        if (close === null) close = t.price
        first = t.price
        high = high === null ? t.price : Math.max(high, t.price)
        low = low === null ? t.price : Math.min(low, t.price)
        pv += t.price * t.usd; vol += t.usd
      }
    }
    // The window's opening price: the last price before it, else its first.
    for (; i >= 0; i--) { const p = this.trades[i].price; if (p !== null && p > 0) { open = p; break } }
    if (open === null) open = first
    const shares = [...buyers.values()].map(v => (buyUsd > 0 ? v / buyUsd : 0)).sort((a, b) => b - a)
    return {
      ms, trades: buys + sells, buys, sells, buyUsd, sellUsd, buyers: buyers.size, sellers: sellers.size, newBuyers,
      avgBuy: buys ? buyUsd / buys : 0, avgSell: sells ? sellUsd / sells : 0,
      largeBuys, largeSells, largeBuyUsd, largeSellUsd, largeSellers: bigSellers.size,
      open, close, high, low, vwap: vol > 0 ? pv / vol : null,
      buyerHHI: shares.reduce((s, x) => s + x * x, 0),
      top5BuyShare: shares.slice(0, 5).reduce((s, x) => s + x, 0),
      topBuyerShare: shares[0] ?? 0,
    }
  }

  /** Price buckets of `bucketMs` over the last `count` buckets ending at `now` (only buckets with priced trades). */
  buckets(now: number, bucketMs: number, count: number): Bucket[] {
    const from = now - bucketMs * count
    const out = new Map<number, Bucket>()
    for (let i = this.indexAt(now); i >= 0; i--) {
      const t = this.trades[i]
      if (t.ts <= from) break
      const k = Math.floor((t.ts - from - 1) / bucketMs)
      let b = out.get(k)
      if (t.price !== null && t.price > 0) {
        if (!b) { b = { t: from + k * bucketMs, o: t.price, h: t.price, l: t.price, c: t.price, buyUsd: 0, sellUsd: 0, n: 0 }; out.set(k, b) }
        b.o = t.price // walking backwards: the earliest seen last
        b.h = Math.max(b.h, t.price); b.l = Math.min(b.l, t.price)
      }
      if (b) { b.n++; if (t.side === 'BUY') b.buyUsd += t.usd; else b.sellUsd += t.usd }
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
  }

  /** The largest holders now (by tokens), the creator excluded or not. */
  topHolders(n: number, o: { excludeCreator?: boolean } = {}): { wallet: string; tokens: number; pct: number | null }[] {
    const key = `${n}:${o.excludeCreator ? 1 : 0}:${this.supply}`
    if (this.topCache && this.topCache.version === this.version && this.topCache.key === key) return this.topCache.rows
    // The n largest in one pass (no full sort).
    const top: { wallet: string; tokens: number }[] = []
    for (const [wallet, h] of this.holdings) {
      if (!(h.tokens > 1e-9) || (o.excludeCreator && wallet === this.creator)) continue
      if (top.length < n) { top.push({ wallet, tokens: h.tokens }); if (top.length === n) top.sort((a, b) => b.tokens - a.tokens); continue }
      if (h.tokens <= top[n - 1].tokens) continue
      let j = n - 1
      while (j > 0 && top[j - 1].tokens < h.tokens) { top[j] = top[j - 1]; j-- }
      top[j] = { wallet, tokens: h.tokens }
    }
    if (top.length < n) top.sort((a, b) => b.tokens - a.tokens)
    const rows = top.map(r => ({ ...r, pct: this.supply ? (r.tokens / this.supply) * 100 : null }))
    this.topCache = { version: this.version, key, rows }
    return rows
  }

  /** The creator's unsold share of what they bought (0–1), or null if they never bought. */
  creatorLeft(): number | null {
    if (!(this.creatorBoughtTokens > 0)) return null
    return Math.max(0, this.creatorBoughtTokens - this.creatorSoldTokens) / this.creatorBoughtTokens
  }
}

/** The engine's trade, in the tape's terms; `mainPool` says whether its price and depth are the coin's. */
export function qtradeOf(t: Trade, mainPool: boolean): QTrade | null {
  if (t.side !== 'BUY' && t.side !== 'SELL') return null
  return {
    id: t.tradeId, ts: t.timestamp, ord: t.blockNumber * 100_000 + t.logIndex, side: t.side,
    usd: Number.isFinite(t.usdValue ?? NaN) ? Math.max(0, t.usdValue ?? 0) : 0,
    tokens: Number.isFinite(t.tokenAmount) ? Math.max(0, t.tokenAmount) : 0,
    price: mainPool && t.priceUsd !== null && t.priceUsd > 0 && Number.isFinite(t.priceUsd) ? t.priceUsd : null,
    wallet: t.wallet?.toLowerCase() ?? null,
    liquidity: mainPool && t.liquidity !== null && Number.isFinite(t.liquidity) ? t.liquidity : null,
  }
}
