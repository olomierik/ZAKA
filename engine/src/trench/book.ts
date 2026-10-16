// One chain's live Trenches state (see api/_trenchProtocol.ts): the coins launched while the engine has been watching,
// every followed coin's trades rolled into one tick a second, and which wallets win.
//
// Smart wallets are measured from the trades this book sees (quant/wallets.ts WalletBook): a position opens with a
// wallet's first buy of a coin and closes once it has sold nearly all of it; a closed position is one trade, won or
// lost by what it got out over what it put in. A wallet counts as smart on a chain (SMART_RULES) with enough closed
// trades over several coins, most of them won, a real profit overall, a positive median return, not buying more coins
// a day than a person would, and holding longer than a bot's same-minute flip. Nothing here is a label from elsewhere:
// a wallet that traded before the engine started following the chain is judged only on what came after.

import type {
  SmartBuyingWire, SmartTradeWire, SmartWalletWire, TrenchChain, TrenchCoinWire, TrenchSmartView, TrenchTick,
} from '../../../api/_trenchProtocol'
import { WalletBook, type SavedWallet, type SmartConfig, type WalletStats } from '../quant/wallets'

export interface FeedTrade {
  token: string
  wallet: string | null
  side: 'buy' | 'sell'
  /** Dollars, coin amount (whole units), time (ms). */
  usd: number
  tokens: number
  ts: number
  priceUsd?: number | null
  mcapUsd?: number | null
  liquidityUsd?: number | null
  /** 0–100 along its curve, when the trade went through one. */
  progress?: number | null
  graduated?: boolean
  /** Name, symbol and picture, when the feed knows them (Arc's launches): used if the book doesn't. */
  meta?: { symbol: string; name: string; image: string | null } | null
}

export interface FeedLaunch {
  token: string
  symbol: string
  name: string
  image: string | null
  launchpad: string
  quote: string
  pool: string | null
  createdAt: number
  creator: string | null
  priceUsd: number
  mcapUsd: number
  liquidityUsd: number
  progress: number | null
}

export interface SmartRules extends SmartConfig {
  /** A wallet whose closed trades average under this hold is a bot flipping in the same minute, never smart. */
  minHoldMs: number
}

const BASE: Omit<SmartRules, 'minRealizedUsd' | 'maxWallets'> = {
  minClosedTrades: 4, minTokens: 3, minWinRate: 0.6, minProfitFactor: 2, minMedianReturnPct: 5,
  earlyEntrySec: 300, maxTokensPerDay: 80, windowMin: 30, clusterWindowMin: 5, clusterMin: 3, minHoldMs: 45_000,
}
/** Per chain: how much realized profit makes a wallet's record count, and how many wallets are kept in memory. */
export const SMART_RULES: Record<TrenchChain, SmartRules> = {
  sol: { ...BASE, minRealizedUsd: 250, maxWallets: 150_000 },
  bnb: { ...BASE, minRealizedUsd: 150, maxWallets: 60_000 },
  hood: { ...BASE, minClosedTrades: 3, minTokens: 2, minRealizedUsd: 40, maxWallets: 20_000 },
  arc: { ...BASE, minClosedTrades: 3, minTokens: 2, minRealizedUsd: 25, maxWallets: 40_000 },
}

const LAUNCH_KEEP_MS = 2 * 3_600_000
const MAX_LAUNCHES = 700
const MAX_COINS = 6_000
const TICK_MAX = 150
const SMART_RING = 400
const TRADER_CAP = 3_000

interface LiveCoin {
  a: string; s: string; n: string; i: string | null; lp: string; q: string; pool: string | null; c: number; cr: string | null
  o: number; p: number; m: number; l: number; v: number; b: number; x: number; w: number; g: number | null; gr: boolean
  traders: Set<string> | null
  launched: boolean
  lastAt: number
}

interface Pending { b: number; x: number; bu: number; xu: number; big: number }

export interface BookStore {
  load(): Promise<string | null>
  save(json: string): Promise<void>
}

export class TrenchBook {
  readonly wallets: WalletBook
  private coins = new Map<string, LiveCoin>()
  private launches: string[] = []
  private pending = new Map<string, Pending>()
  private smart = new Map<string, WalletStats>()
  private ring: SmartTradeWire[] = []
  /** Trades in each of the last 60 seconds (the newest last), and in the current one. */
  private secs: number[] = []
  private secCount = 0
  /** When this book started following its chain (kept across restarts). */
  since = Date.now()
  /** Every trade, as it comes (the wallet tracker, trench/walletWatch.ts). */
  onAnyTrade: ((t: FeedTrade) => void) | null = null
  lastEventAt = 0

  constructor(
    readonly chain: TrenchChain,
    readonly rules: SmartRules = SMART_RULES[chain],
    /** Coins the chain's list (GeckoTerminal's, kept by the engine) shows: their trades tick too. */
    private listed: (token: string) => boolean = () => false,
  ) {
    this.wallets = new WalletBook(rules)
  }

  setListed(f: (token: string) => boolean) { this.listed = f }

  // ── input ──────────────────────────────────────────────────────────────

  /** A coin launched: shown at once, its numbers then follow its trades. Returns it as the wire shows it. */
  launch(l: FeedLaunch, now = Date.now()): TrenchCoinWire | null {
    if (this.coins.get(l.token)?.launched) return null
    const prev = this.coins.get(l.token)
    const c: LiveCoin = {
      a: l.token, s: l.symbol, n: l.name, i: l.image, lp: l.launchpad, q: l.quote, pool: l.pool, c: l.createdAt, cr: l.creator,
      o: l.priceUsd || prev?.o || 0, p: prev?.p || l.priceUsd, m: prev?.m || l.mcapUsd, l: prev?.l || l.liquidityUsd, v: prev?.v ?? 0, b: prev?.b ?? 0, x: prev?.x ?? 0,
      w: prev?.w ?? 0, g: prev?.g ?? l.progress, gr: false, traders: prev?.traders ?? new Set(), launched: true, lastAt: now,
    }
    this.coins.set(l.token, c)
    this.launches.push(l.token)
    this.lastEventAt = now
    this.trim(now)
    return wire(c)
  }

  /** A launch's picture, once its metadata answers. */
  setImage(token: string, image: string | null): boolean {
    const c = this.coins.get(token)
    if (!c || c.i === image) return false
    c.i = image
    return true
  }

  /** Name and symbol for a coin first seen through a trade (a smart wallet's buy of a coin launched before the watch). */
  setMeta(token: string, m: { symbol?: string; name?: string; image?: string | null }) {
    const c = this.coins.get(token)
    if (!c) return
    if (m.symbol && !c.s) c.s = m.symbol
    if (m.name && !c.n) c.n = m.name
    if (m.image && !c.i) c.i = m.image
  }

  /** Its curve sold out: it's moving to its pool. */
  markGraduated(token: string) {
    const c = this.coins.get(token)
    if (c) { c.gr = true; c.g = 100 }
  }

  knows(token: string): boolean { return this.coins.has(token) }
  metaOf(token: string): { symbol: string; name: string; image: string | null; mcap: number } | null {
    const c = this.coins.get(token)
    return c ? { symbol: c.s, name: c.n, image: c.i, mcap: c.m } : null
  }

  /** A trade. Returns the smart-wallet trade it was, if any (also kept for the view). */
  trade(t: FeedTrade, launchedAt = 0): SmartTradeWire | null {
    if (!(t.usd > 0) || !(t.tokens > 0)) return null
    this.lastEventAt = Math.max(this.lastEventAt, Date.now())
    if (this.onAnyTrade) try { this.onAnyTrade(t) } catch { /* a tracker failure never stops the book */ }
    this.secCount++
    const followed = this.coins.get(t.token)?.launched || this.listed(t.token)
    let c = this.coins.get(t.token)
    if (!c && (followed || (t.wallet && this.smart.has(t.wallet)))) {
      c = { a: t.token, s: '', n: '', i: null, lp: '', q: '', pool: null, c: launchedAt, cr: null, o: 0, p: 0, m: 0, l: 0, v: 0, b: 0, x: 0, w: 0, g: null, gr: false, traders: new Set(), launched: false, lastAt: t.ts }
      this.coins.set(t.token, c)
      if (this.coins.size > MAX_COINS) this.trim(Date.now())
    }
    if (c) {
      if (t.meta && !c.s) { c.s = t.meta.symbol; c.n = t.meta.name; c.i = c.i ?? t.meta.image }
      if (t.priceUsd && t.priceUsd > 0) { c.p = t.priceUsd; if (!c.o) c.o = t.priceUsd }
      if (t.mcapUsd && t.mcapUsd > 0) c.m = t.mcapUsd
      if (t.liquidityUsd && t.liquidityUsd > 0) c.l = t.liquidityUsd
      if (t.progress !== undefined && t.progress !== null) c.g = t.progress
      if (t.graduated) { c.gr = true; c.g = 100 }
      c.v += t.usd
      if (t.side === 'buy') c.b++; else c.x++
      if (t.wallet && c.traders) {
        if (!c.traders.has(t.wallet)) { c.traders.add(t.wallet); c.w++ }
        if (c.traders.size >= TRADER_CAP) c.traders = null
      }
      c.lastAt = t.ts
      if (followed) {
        const p = this.pending.get(t.token) ?? { b: 0, x: 0, bu: 0, xu: 0, big: 0 }
        if (t.side === 'buy') { p.b++; p.bu += t.usd } else { p.x++; p.xu += t.usd }
        if (t.usd > Math.abs(p.big)) p.big = t.side === 'buy' ? t.usd : -t.usd
        this.pending.set(t.token, p)
      }
    }
    // Every trade teaches the wallet book, followed coin or not.
    this.wallets.onTrade(t.wallet, t.token, t.side === 'buy' ? 'BUY' : 'SELL', t.usd, t.tokens, t.ts, launchedAt || c?.c || 0)
    const s = t.wallet ? this.smart.get(t.wallet) : undefined
    if (!s || !t.wallet) return null
    const meta = this.coins.get(t.token)
    const st: SmartTradeWire = {
      w: t.wallet, t: t.token, s: meta?.s ?? '', i: meta?.i ?? null, side: t.side === 'buy' ? 'B' : 'S', u: round2(t.usd), ts: t.ts,
      m: Math.round(t.mcapUsd ?? meta?.m ?? 0), n: s.trade_count, wr: round3(s.win_rate), pnl: Math.round(s.realized_profit - s.realized_loss),
    }
    this.ring.push(st)
    if (this.ring.length > SMART_RING) this.ring.splice(0, this.ring.length - SMART_RING)
    return st
  }

  // ── output ─────────────────────────────────────────────────────────────

  /** The last second's trades of followed coins, the busiest first; empties the buffer. Called once a second. */
  ticks(): TrenchTick[] {
    this.secs.push(this.secCount)
    this.secCount = 0
    if (this.secs.length > 60) this.secs.shift()
    if (!this.pending.size) return []
    const rows: TrenchTick[] = []
    for (const [token, p] of this.pending) {
      const c = this.coins.get(token)
      rows.push([token, p.b, p.x, round2(p.bu), round2(p.xu), c?.p ?? 0, Math.round(c?.m ?? 0), c?.g ?? -1, round2(p.big)])
    }
    this.pending.clear()
    return rows.sort((a, b) => b[3] + b[4] - (a[3] + a[4])).slice(0, TICK_MAX)
  }

  /** Re-judges the wallets whose record changed (a position closed) since the last call. */
  refreshSmart(now = Date.now()) {
    for (const w of this.wallets.changed) {
      const s = this.wallets.stats(w, now)
      if (s && this.isSmart(s)) this.smart.set(w, s)
      else this.smart.delete(w)
    }
    this.wallets.changed.clear()
  }

  isSmart(s: WalletStats): boolean { return s.class === 'SMART_MONEY' && s.average_hold_ms >= this.rules.minHoldMs }

  get smartCount() { return this.smart.size }

  /** Trades in the last minute, across everything the feed reads. */
  perMin(): number { return this.secs.reduce((a, n) => a + n, 0) + this.secCount }

  recentLaunches(limit = 300): TrenchCoinWire[] {
    const out: TrenchCoinWire[] = []
    for (let i = this.launches.length - 1; i >= 0 && out.length < limit; i--) {
      const c = this.coins.get(this.launches[i])
      if (c) out.push(wire(c))
    }
    return out
  }

  smartView(now = Date.now()): TrenchSmartView {
    const r = this.rules
    const from = now - r.windowMin * 60_000
    const agg = new Map<string, { buyers: Set<string>; sellers: Set<string>; bu: number; su: number; first: number; last: number; m: number }>()
    for (const t of this.ring) {
      if (t.ts < from) continue
      const a = agg.get(t.t) ?? { buyers: new Set(), sellers: new Set(), bu: 0, su: 0, first: t.ts, last: t.ts, m: 0 }
      if (t.side === 'B') { a.buyers.add(t.w); a.bu += t.u } else { a.sellers.add(t.w); a.su += t.u }
      a.first = Math.min(a.first, t.ts); a.last = Math.max(a.last, t.ts)
      if (t.m) a.m = t.m
      agg.set(t.t, a)
    }
    const buying: SmartBuyingWire[] = [...agg.entries()]
      .filter(([, a]) => a.buyers.size > 0 && a.bu > a.su)
      .map(([t, a]) => {
        const c = this.coins.get(t)
        return { t, s: c?.s ?? '', n: c?.n ?? '', i: c?.i ?? null, m: Math.round(c?.m || a.m), buyers: a.buyers.size, sellers: a.sellers.size, buyUsd: round2(a.bu), sellUsd: round2(a.su), first: a.first, last: a.last, wallets: [...a.buyers].slice(0, 5) }
      })
      .sort((a, b) => b.buyers - a.buyers || (b.buyUsd - b.sellUsd) - (a.buyUsd - a.sellUsd) || b.last - a.last)
      .slice(0, 20)
    const top: SmartWalletWire[] = [...this.smart.values()]
      .sort((a, b) => (b.realized_profit - b.realized_loss) - (a.realized_profit - a.realized_loss))
      .slice(0, 12)
      .map(s => ({ w: s.wallet, n: s.trade_count, wr: round3(s.win_rate), pnl: Math.round(s.realized_profit - s.realized_loss), hold: Math.round(s.average_hold_ms), coins: s.tokens_traded, last: this.lastOf(s.wallet) }))
    return {
      since: this.since, followed: this.wallets.wallets.size, smart: this.smart.size, windowMin: r.windowMin,
      rule: { minTrades: r.minClosedTrades, minWinRate: r.minWinRate, minProfitUsd: r.minRealizedUsd, minHoldSec: Math.round(r.minHoldMs / 1000) },
      top, buying, trades: this.ring.slice(-60).reverse(),
    }
  }

  private lastOf(wallet: string): number {
    for (let i = this.ring.length - 1; i >= 0; i--) if (this.ring[i].w === wallet) return this.ring[i].ts
    return 0
  }

  /** Drops launches older than two hours (and beyond the cap) and coins nobody has traded for a while. */
  private trim(now: number) {
    while (this.launches.length > MAX_LAUNCHES || (this.launches.length && (this.coins.get(this.launches[0])?.c ?? 0) < now - LAUNCH_KEEP_MS)) {
      const t = this.launches.shift()!
      const c = this.coins.get(t)
      if (c && c.lastAt < now - 10 * 60_000) this.coins.delete(t)
      else if (c) c.launched = false
    }
    if (this.coins.size > MAX_COINS) {
      const idle = [...this.coins.values()].filter(c => !c.launched).sort((a, b) => a.lastAt - b.lastAt)
      for (const c of idle.slice(0, this.coins.size - MAX_COINS + 500)) this.coins.delete(c.a)
    }
  }

  // ── kept across restarts ───────────────────────────────────────────────

  async load(store: BookStore) {
    const raw = await store.load().catch(() => null)
    if (!raw) return
    try {
      const j = JSON.parse(raw) as { since?: number; wallets?: SavedWallet[] }
      if (typeof j.since === 'number' && j.since > 0) this.since = j.since
      if (Array.isArray(j.wallets)) {
        this.wallets.importRecords(j.wallets)
        for (const s of j.wallets) this.wallets.changed.add(s.w)
        this.refreshSmart()
      }
    } catch { /* a damaged copy: start over */ }
  }

  async save(store: BookStore) {
    await store.save(JSON.stringify({ since: this.since, wallets: this.wallets.exportRecords(2, 6_000) }))
  }
}

function wire(c: LiveCoin): TrenchCoinWire {
  return { a: c.a, s: c.s, n: c.n, i: c.i, lp: c.lp, q: c.q, pool: c.pool, c: c.c, cr: c.cr, o: c.o, p: c.p, m: Math.round(c.m), l: Math.round(c.l), v: round2(c.v), b: c.b, x: c.x, w: c.w, g: c.g === null ? null : Math.round(c.g * 10) / 10, gr: c.gr }
}
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
