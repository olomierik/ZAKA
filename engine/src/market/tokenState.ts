// Hot state for one token, updated incrementally from each trade — never
// by re-querying history. 24h stats use a ring of 1,440 one-minute buckets:
// adding a trade touches one bucket, and minutes falling out of the 24h
// window are subtracted as time moves on (amortised O(1)).
//
// Each minute's close remembers its pool (2026-10-05). A coin's main pool can
// change (a deeper pool appears, or the first pool seen was a thin side pool),
// and closes from the old one made the 24h change compare two pools: ARGUS read
// −31.5% over 24h while its main pool had moved −4%. Changes now compare the
// main pool with itself only.

import type { TokenStats, Trade } from '../../../api/_marketProtocol'

const MIN_MS = 60_000
const SLOTS = 1_440
// per-slot fields
const F_MIN = 0, F_VOL = 1, F_BVOL = 2, F_SVOL = 3, F_BUYS = 4, F_SELLS = 5, F_CLOSE = 6, F_ORD = 7, F_POOL = 8
const W = 9
/** Slots saved before closes remembered their pool (8 fields): their closes are left out. */
const W_LEGACY = 8

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
  /** The pool `firstPriceUsd` came from. */
  firstPool: string | null = null
  lastTradeAt = 0
  /** Pools seen, by index (a slot's F_POOL). */
  private pools: string[] = []

  vol24 = 0; buyVol24 = 0; sellVol24 = 0; buys24 = 0; sells24 = 0
  private ring = new Float64Array(SLOTS * W).fill(-1)
  private rolledTo = 0 // newest minute already expired from the window

  constructor(readonly token: string) {}

  /**
   * Returns true if this trade now sets the token's price: the latest trade
   * in its main (deepest) pool. A coin can have side pools (one Argus coin
   * had a second pool charging an 80% fee, which arbitrage bots trade
   * through); their prices say nothing about the coin's, so they move neither
   * its price nor its candles. Their volume still counts.
   */
  add(t: Trade, ord: number, now = Date.now()): boolean {
    this.roll(now)
    const newer = ord > this.lastOrd
    if (t.liquidity !== null && newer && (this.mainPool === null || t.pool === this.mainPool || t.liquidity > (this.liquidityUsd ?? 0))) {
      this.mainPool = t.pool
      this.liquidityUsd = t.liquidity
    }
    const latest = newer && (this.mainPool === null || t.pool === this.mainPool)
    if (latest && t.priceUsd !== null) {
      this.lastOrd = ord
      this.priceUsd = t.priceUsd
      this.price = t.price
      this.quote = t.quote
      this.latestBlock = t.blockNumber
      this.latestTs = t.timestamp
    }
    if (t.priceUsd !== null && latest && (this.firstPriceUsd === null || this.firstPool !== this.mainPool)) { this.firstPriceUsd = t.priceUsd; this.firstPool = t.pool }
    this.lastTradeAt = now
    const m = Math.floor(t.timestamp / MIN_MS)
    const nowMin = Math.floor(now / MIN_MS)
    if (m <= nowMin - SLOTS || m > nowMin + 1) return latest // outside the 24h window
    const base = (m % SLOTS) * W
    if (this.ring[base + F_MIN] !== m) this.resetSlot(base, m)
    const usd = t.usdValue ?? 0
    this.ring[base + F_VOL] += usd; this.vol24 += usd
    if (t.side === 'BUY') { this.ring[base + F_BVOL] += usd; this.buyVol24 += usd; this.ring[base + F_BUYS]++; this.buys24++ }
    else if (t.side === 'SELL') { this.ring[base + F_SVOL] += usd; this.sellVol24 += usd; this.ring[base + F_SELLS]++; this.sells24++ }
    if (t.priceUsd !== null && (this.mainPool === null || t.pool === this.mainPool) && ord > this.ring[base + F_ORD]) { this.ring[base + F_CLOSE] = t.priceUsd; this.ring[base + F_ORD] = ord; this.ring[base + F_POOL] = this.poolIx(t.pool) }
    return latest
  }

  private poolIx(pool: string): number {
    const i = this.pools.indexOf(pool)
    if (i >= 0) return i
    this.pools.push(pool)
    return this.pools.length - 1
  }

  /** The main pool's index, or -2 (matches no slot) when there's none yet. */
  private mainIx(): number {
    const i = this.mainPool === null ? -1 : this.pools.indexOf(this.mainPool)
    return i >= 0 ? i : -2
  }

  private resetSlot(base: number, minute: number) {
    // A slot being reused held a minute that's out of the window: take it out of the totals.
    if (this.ring[base + F_MIN] >= 0) this.subtract(base)
    this.ring.fill(0, base, base + W)
    this.ring[base + F_MIN] = minute
    this.ring[base + F_CLOSE] = -1
    this.ring[base + F_ORD] = -1
    this.ring[base + F_POOL] = -1
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

  /** Trades and volume over the last `minutes`, this minute included (from the same one-minute ring). */
  activity(minutes: number, now = Date.now()): { trades: number; buys: number; sells: number; vol: number } {
    this.roll(now)
    const nowMin = Math.floor(now / MIN_MS)
    let buys = 0, sells = 0, vol = 0
    for (let m = nowMin - Math.min(minutes, SLOTS) + 1; m <= nowMin; m++) {
      const base = (((m % SLOTS) + SLOTS) % SLOTS) * W
      if (this.ring[base + F_MIN] !== m) continue
      buys += this.ring[base + F_BUYS]; sells += this.ring[base + F_SELLS]; vol += this.ring[base + F_VOL]
    }
    return { trades: buys + sells, buys, sells, vol }
  }

  /** The main pool's close at (or before) `minutesAgo`, within the window. */
  private priceAgo(minutesAgo: number, now: number): number | null {
    const main = this.mainIx()
    const target = Math.floor(now / MIN_MS) - minutesAgo
    for (let m = target; m > target - 90 && m > Math.floor(now / MIN_MS) - SLOTS; m--) {
      const base = (((m % SLOTS) + SLOTS) % SLOTS) * W
      if (this.ring[base + F_MIN] === m && this.ring[base + F_CLOSE] > 0 && this.ring[base + F_POOL] === main) return this.ring[base + F_CLOSE]
    }
    return null
  }

  /** The main pool's earliest close after `minutesAgo` (a coin younger than the period, or quiet before it). */
  private firstCloseSince(minutesAgo: number, now: number): number | null {
    const main = this.mainIx()
    const nowMin = Math.floor(now / MIN_MS)
    for (let m = nowMin - Math.min(minutesAgo, SLOTS - 1); m <= nowMin; m++) {
      const base = (((m % SLOTS) + SLOTS) % SLOTS) * W
      if (this.ring[base + F_MIN] === m && this.ring[base + F_CLOSE] > 0 && this.ring[base + F_POOL] === main) return this.ring[base + F_CLOSE]
    }
    return null
  }

  private chg(minutes: number, now: number): number | null {
    if (this.priceUsd === null) return null
    // Younger than the period (or quiet before it): measure from the main pool's first price seen.
    const first = this.firstPool !== null && this.firstPool === this.mainPool ? this.firstPriceUsd : null
    const then = this.priceAgo(minutes, now) ?? this.firstCloseSince(minutes, now) ?? first
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
      b: this.latestBlock, ts: this.latestTs, o: this.lastOrd, f: this.firstPriceUsd, fp: this.firstPool, at: this.lastTradeAt,
      r, rt: this.rolledTo, pi: this.pools,
    }
  }

  static restore(token: string, d: ReturnType<TokenState['serialize']>): TokenState {
    const s = new TokenState(token)
    s.priceUsd = d.p; s.price = d.pq; s.quote = d.q; s.mainPool = d.mp; s.liquidityUsd = d.lq; s.supply = d.s
    s.latestBlock = d.b; s.latestTs = d.ts; s.lastOrd = d.o; s.firstPriceUsd = d.f; s.lastTradeAt = d.at
    // Saved before first prices remembered their pool: unknown, so not used.
    s.firstPool = typeof d.fp === 'string' ? d.fp : null
    s.pools = Array.isArray(d.pi) ? d.pi.filter((x): x is string => typeof x === 'string') : []
    s.rolledTo = d.rt ?? 0
    const oldest = Math.floor(Date.now() / MIN_MS) - SLOTS + 1
    for (const raw of Array.isArray(d.r) ? d.r : []) {
      if (!Array.isArray(raw) || (raw.length !== W && raw.length !== W_LEGACY) || !(raw[F_MIN] >= oldest)) continue // gone from the window while down
      // A legacy slot's close has no pool: it's kept for volume and counts, not compared.
      const slot = raw.length === W ? raw : [...raw, -1]
      const base = (slot[F_MIN] % SLOTS) * W
      s.ring.set(slot, base)
      s.vol24 += slot[F_VOL]; s.buyVol24 += slot[F_BVOL]; s.sellVol24 += slot[F_SVOL]
      s.buys24 += slot[F_BUYS]; s.sells24 += slot[F_SELLS]
    }
    s.roll()
    return s
  }
}
