// Hot state for one token, updated incrementally from each trade — never
// by re-querying history. 24h stats use a ring of 1,440 one-minute buckets:
// adding a trade touches one bucket, and minutes falling out of the 24h
// window are subtracted as time moves on (amortised O(1)).

import type { TokenStats, Trade } from '../../../api/_marketProtocol'

const MIN_MS = 60_000
const SLOTS = 1_440
// per-slot fields
const F_MIN = 0, F_VOL = 1, F_BVOL = 2, F_SVOL = 3, F_BUYS = 4, F_SELLS = 5, F_CLOSE = 6, F_ORD = 7
const W = 8

export class TokenState {
  priceUsd: number | null = null
  price: number | null = null
  quote: string | null = null
  mainPool: string | null = null
  liquidityUsd: number | null = null
  supply: number | null = null
  latestBlock = 0
  latestTs = 0
  lastOrd = -1
  firstPriceUsd: number | null = null
  lastTradeAt = 0

  vol24 = 0; buyVol24 = 0; sellVol24 = 0; buys24 = 0; sells24 = 0
  private ring = new Float64Array(SLOTS * W).fill(-1)
  private rolledTo = 0 // newest minute already expired from the window

  constructor(readonly token: string) {}

  /** Returns true if this trade is now the latest one for the token. */
  add(t: Trade, ord: number, now = Date.now()): boolean {
    this.roll(now)
    const latest = ord > this.lastOrd
    if (latest && t.priceUsd !== null) {
      this.lastOrd = ord
      this.priceUsd = t.priceUsd
      this.price = t.price
      this.quote = t.quote
      this.latestBlock = t.blockNumber
      this.latestTs = t.timestamp
    }
    if (this.firstPriceUsd === null && t.priceUsd !== null) this.firstPriceUsd = t.priceUsd
    this.lastTradeAt = now
    if (t.liquidity !== null && latest && (this.mainPool === null || t.pool === this.mainPool || t.liquidity > (this.liquidityUsd ?? 0))) {
      this.mainPool = t.pool
      this.liquidityUsd = t.liquidity
    }
    const m = Math.floor(t.timestamp / MIN_MS)
    const nowMin = Math.floor(now / MIN_MS)
    if (m <= nowMin - SLOTS || m > nowMin + 1) return latest // outside the 24h window
    const base = (m % SLOTS) * W
    if (this.ring[base + F_MIN] !== m) this.resetSlot(base, m)
    const usd = t.usdValue ?? 0
    this.ring[base + F_VOL] += usd; this.vol24 += usd
    if (t.side === 'BUY') { this.ring[base + F_BVOL] += usd; this.buyVol24 += usd; this.ring[base + F_BUYS]++; this.buys24++ }
    else if (t.side === 'SELL') { this.ring[base + F_SVOL] += usd; this.sellVol24 += usd; this.ring[base + F_SELLS]++; this.sells24++ }
    if (t.priceUsd !== null && ord > this.ring[base + F_ORD]) { this.ring[base + F_CLOSE] = t.priceUsd; this.ring[base + F_ORD] = ord }
    return latest
  }

  private resetSlot(base: number, minute: number) {
    // A slot being reused held a minute that's out of the window: take it out of the totals.
    if (this.ring[base + F_MIN] >= 0) this.subtract(base)
    this.ring.fill(0, base, base + W)
    this.ring[base + F_MIN] = minute
    this.ring[base + F_CLOSE] = -1
    this.ring[base + F_ORD] = -1
  }

  private subtract(base: number) {
    this.vol24 -= this.ring[base + F_VOL]; this.buyVol24 -= this.ring[base + F_BVOL]; this.sellVol24 -= this.ring[base + F_SVOL]
    this.buys24 -= this.ring[base + F_BUYS]; this.sells24 -= this.ring[base + F_SELLS]
    // Guard against float drift below zero.
    if (this.vol24 < 1e-9) this.vol24 = 0
    if (this.buyVol24 < 1e-9) this.buyVol24 = 0
    if (this.sellVol24 < 1e-9) this.sellVol24 = 0
  }

  /** Expire minutes that have left the 24h window. */
  roll(now = Date.now()) {
    const oldestKept = Math.floor(now / MIN_MS) - SLOTS + 1
    const from = Math.max(this.rolledTo + 1, oldestKept - SLOTS)
    for (let m = from; m < oldestKept; m++) {
      const base = (((m % SLOTS) + SLOTS) % SLOTS) * W
      if (this.ring[base + F_MIN] === m) { this.subtract(base); this.ring.fill(0, base, base + W); this.ring[base + F_MIN] = -1; this.ring[base + F_CLOSE] = -1 }
    }
    this.rolledTo = Math.max(this.rolledTo, oldestKept - 1)
  }

  /** Close price at (or before) `minutesAgo`, within the window. */
  private priceAgo(minutesAgo: number, now: number): number | null {
    const target = Math.floor(now / MIN_MS) - minutesAgo
    for (let m = target; m > target - 90 && m > Math.floor(now / MIN_MS) - SLOTS; m--) {
      const base = (((m % SLOTS) + SLOTS) % SLOTS) * W
      if (this.ring[base + F_MIN] === m && this.ring[base + F_CLOSE] > 0) return this.ring[base + F_CLOSE]
    }
    return null
  }

  private chg(minutes: number, now: number): number | null {
    if (this.priceUsd === null) return null
    // Younger than the period (or quiet before it): measure from the first trade seen.
    const then = this.priceAgo(minutes, now) ?? this.firstPriceUsd
    return then && then > 0 ? (this.priceUsd / then - 1) * 100 : null
  }

  stats(now = Date.now()): TokenStats {
    this.roll(now)
    const trades24 = this.buys24 + this.sells24
    return {
      priceUsd: this.priceUsd,
      price: this.price,
      marketCapUsd: this.priceUsd !== null && this.supply ? this.priceUsd * this.supply : null,
      liquidityUsd: this.liquidityUsd,
      vol24: this.vol24, buyVol24: this.buyVol24, sellVol24: this.sellVol24,
      buys24: this.buys24, sells24: this.sells24, trades24,
      chg: { m5: this.chg(5, now), h1: this.chg(60, now), h6: this.chg(360, now), h24: this.chg(1_439, now) },
      latestBlock: this.latestBlock,
      latestTs: this.latestTs,
    }
  }

  /** Compact form for the hot store, with only the minutes that had trades
   * (so a restart keeps the 24h stats without storing 1,440 empty slots). */
  serialize() {
    const r: number[][] = []
    for (let i = 0; i < SLOTS; i++) {
      const base = i * W
      if (this.ring[base + F_MIN] >= 0) r.push(Array.from(this.ring.subarray(base, base + W)))
    }
    return {
      p: this.priceUsd, pq: this.price, q: this.quote, mp: this.mainPool, lq: this.liquidityUsd, s: this.supply,
      b: this.latestBlock, ts: this.latestTs, o: this.lastOrd, f: this.firstPriceUsd, at: this.lastTradeAt,
      r, rt: this.rolledTo,
    }
  }

  static restore(token: string, d: ReturnType<TokenState['serialize']>): TokenState {
    const s = new TokenState(token)
    s.priceUsd = d.p; s.price = d.pq; s.quote = d.q; s.mainPool = d.mp; s.liquidityUsd = d.lq; s.supply = d.s
    s.latestBlock = d.b; s.latestTs = d.ts; s.lastOrd = d.o; s.firstPriceUsd = d.f; s.lastTradeAt = d.at
    s.rolledTo = d.rt ?? 0
    const oldest = Math.floor(Date.now() / MIN_MS) - SLOTS + 1
    for (const slot of Array.isArray(d.r) ? d.r : []) {
      if (!Array.isArray(slot) || slot.length !== W || !(slot[F_MIN] >= oldest)) continue // gone from the window while down
      const base = (slot[F_MIN] % SLOTS) * W
      s.ring.set(slot, base)
      s.vol24 += slot[F_VOL]; s.buyVol24 += slot[F_BVOL]; s.sellVol24 += slot[F_SVOL]
      s.buys24 += slot[F_BUYS]; s.sells24 += slot[F_SELLS]
    }
    s.roll()
    return s
  }
}
