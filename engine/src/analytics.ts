// The owner's analytics (2026-10-17: "an analytics page where I can see the number of users who have logged in, who are
// trading, and how much has been traded, and the fees we've collected; an admin to monitor how the money is performing").
//
// What's counted, and where each number comes from:
//   sign-ins   a wallet in use on the site (Privy's, a wallet app, the trading wallet, a Solana wallet's account), sent by
//              the page once per wallet and session (POST /v1/analytics/signin). A wallet is one user, however many
//              times it comes back. Unverified (the page says so), so one IP brings at most 30 new wallets an hour.
//   trades     every trade the site sends, on any chain (POST /v1/analytics/trade): chain, venue, side, size in dollars,
//              ARCDEX's fee in dollars, and the transaction. Each one is then checked on its own chain: the
//              transaction must have succeeded and been sent by that wallet (`checkPending`). Only checked trades count
//              as trades and volume; the rest are listed as pending, failed or unverifiable. Plus ARCDEX's Arc router
//              trades from the trade book (social/book.ts), which are read from the chain itself; a trade both sent and
//              read counts once (by transaction).
//   fees       the fee ledger (fees/ledger.ts): every fee ARCDEX received or accrued, from on-chain evidence.
//   visitors   the traffic counter (traffic.ts).
// GET /v1/admin/analytics (an admin session) returns them all, with a day-by-day series.

import type { FeeRow } from './fees/ledger'
import type { TrafficCounts } from './traffic'
import { errMsg, log } from './log'

export const ANALYTICS = {
  newWalletsPerIpHour: 30,
  tradesPerIpHour: 240,
  /** A sign-in is written at most this often per wallet (it still counts as active in between). */
  writeEveryMs: 30 * 60_000,
  checkEveryMs: 15_000,
  checkBatch: 25,
  /** A transaction not found after this long stops being looked for: 'unverified'. */
  giveUpMs: 20 * 60_000,
  maxUsd: 10_000_000,
  days: 30,
}

export const SIGNIN_KINDS = ['privy', 'wallet', 'trading', 'solana'] as const
export type SigninKind = typeof SIGNIN_KINDS[number]
export const TRADE_CHAINS = ['arc', 'robinhood', 'solana', 'bnb', 'base', 'arbitrum', 'ethereum', 'hyperliquid', 'starknet'] as const
export type TradeChain = typeof TRADE_CHAINS[number]
export type TradeStatus = 'pending' | 'ok' | 'failed' | 'mismatch' | 'unverified'

export interface SigninRow { address: string; kind: SigninKind; firstAt: number; lastAt: number; signIns: number }
export interface SiteTradeRow {
  /** `${chain}:${tx}` */
  id: string
  chain: TradeChain
  venue: string
  side: 'buy' | 'sell'
  address: string
  usd: number
  feeUsd: number
  coin: string
  tx: string
  at: number
  status: TradeStatus
  checkedAt: number | null
}

export interface AnalyticsStore {
  signinSeen(r: SigninRow): void
  /** Adds a trade not stored yet (by id); true when it was new. */
  siteTradeAdd(t: SiteTradeRow): Promise<boolean>
  siteTradeChecked(id: string, status: TradeStatus, at: number): void
  siteTradesPending(limit: number): Promise<SiteTradeRow[]>
  analyticsSince(since: number): Promise<{ users: SigninRow[]; trades: SiteTradeRow[] }>
}

/** A router trade read from the chain (social/book.ts), as analytics counts it. */
export interface ChainTrade { tx: string; at: number; trader: string; usd: number; feeUsd: number; side: 'buy' | 'sell'; token: string }

export interface DayRow { day: string; signIns: number; newUsers: number; traders: number; trades: number; volumeUsd: number; feesUsd: number }
export interface AnalyticsReport {
  at: number
  days: number
  visitors: TrafficCounts | null
  users: { total: number; new24h: number; active24h: number; active7d: number; byKind: Record<string, number> }
  traders: { total: number; d1: number; d7: number; d30: number }
  trades: { total: number; d1: number; d7: number; d30: number; volume: { total: number; d1: number; d7: number; d30: number }; byChain: Record<string, { trades: number; volumeUsd: number }>; byVenue: Record<string, { trades: number; volumeUsd: number }> }
  fees: { total: number; d1: number; d7: number; d30: number; bySource: Record<string, number>; reportedByTrades: number }
  funnel: { visitorsToday: number | null; signedIn24h: number; traded24h: number }
  checks: Record<TradeStatus, number>
  daily: DayRow[]
  topTraders: { address: string; trades: number; volumeUsd: number; feesUsd: number }[]
  latest: (Pick<SiteTradeRow, 'chain' | 'venue' | 'side' | 'address' | 'usd' | 'feeUsd' | 'coin' | 'tx' | 'at' | 'status'>)[]
}

const EVM = /^0x[0-9a-fA-F]{40}$/
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_TX = /^0x[0-9a-fA-F]{64}$/
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/
const HL_ID = /^[0-9]{1,24}$/
const STRK_TX = /^0x[0-9a-fA-F]{1,64}$/
const isOne = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v)
const day = (t: number) => new Date(t - (t % 86_400_000)).toISOString().slice(0, 10)
const round2 = (n: number) => Math.round(n * 100) / 100
/** Fees keep fractions of a cent (2026-10-18: a $0.50 trade's fee is $0.0025, which rounded to $0.00 on the page). */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** A wallet address as stored: EVM lower-cased, Solana as written; null when it's neither. */
export function walletOf(a: unknown): string | null {
  if (typeof a !== 'string') return null
  if (EVM.test(a)) return a.toLowerCase()
  return SOL.test(a) ? a : null
}

/** A trade the page sent, as stored (status pending), or why it isn't taken. */
export function parseTrade(b: unknown, now: number): SiteTradeRow | { error: string } {
  const o = (b ?? {}) as Record<string, unknown>
  if (!isOne(o.chain, TRADE_CHAINS)) return { error: 'unknown chain' }
  const chain = o.chain
  const address = walletOf(o.address)
  if (!address) return { error: 'bad address' }
  if (o.side !== 'buy' && o.side !== 'sell') return { error: 'bad side' }
  const usd = Number(o.usd), feeUsd = Number(o.feeUsd ?? 0)
  if (!Number.isFinite(usd) || usd <= 0 || usd > ANALYTICS.maxUsd) return { error: 'bad amount' }
  if (!Number.isFinite(feeUsd) || feeUsd < 0 || feeUsd > usd) return { error: 'bad fee' }
  const tx = typeof o.tx === 'string' ? o.tx.trim() : ''
  const txOk = chain === 'solana' ? SOL_SIG.test(tx) : chain === 'hyperliquid' ? HL_ID.test(tx) : chain === 'starknet' ? STRK_TX.test(tx) : EVM_TX.test(tx)
  if (!txOk) return { error: 'bad transaction' }
  const venue = typeof o.venue === 'string' && /^[a-z0-9-]{1,24}$/.test(o.venue) ? o.venue : 'other'
  const coin = typeof o.coin === 'string' ? o.coin.slice(0, 64) : ''
  const norm = chain === 'solana' || chain === 'hyperliquid' ? tx : tx.toLowerCase()
  // Hyperliquid's orders and Starknet's transactions aren't looked up here: kept, listed as unverifiable.
  const status: TradeStatus = chain === 'hyperliquid' || chain === 'starknet' ? 'unverified' : 'pending'
  return { id: `${chain}:${norm}`, chain, venue, side: o.side, address, usd: round2(usd), feeUsd: Math.round(feeUsd * 1e4) / 1e4, coin, tx: norm, at: now, status, checkedAt: status === 'pending' ? null : now }
}

/** How a chain's transaction is looked up: EVM receipts and senders, Solana's signature status and signers. */
export type ChainCall = (chain: TradeChain, method: string, params: unknown[]) => Promise<unknown>

/** Whether the transaction went through, from the trader's wallet. null: not found yet. */
export async function verifyTrade(t: SiteTradeRow, call: ChainCall): Promise<TradeStatus | null> {
  if (t.chain === 'solana') {
    const tx = await call('solana', 'getTransaction', [t.tx, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]) as
      { meta?: { err: unknown } | null; transaction?: { message?: { accountKeys?: ({ pubkey: string; signer?: boolean } | string)[] } } } | null
    if (!tx) return null
    if (tx.meta?.err) return 'failed'
    const keys = tx.transaction?.message?.accountKeys ?? []
    const signers = keys.filter(k => typeof k === 'object' && k.signer).map(k => (k as { pubkey: string }).pubkey)
    return signers.includes(t.address) ? 'ok' : 'mismatch'
  }
  const r = await call(t.chain, 'eth_getTransactionReceipt', [t.tx]) as { status?: string; from?: string } | null
  if (!r) return null
  if (r.status !== '0x1') return 'failed'
  return (r.from ?? '').toLowerCase() === t.address ? 'ok' : 'mismatch'
}

export interface AnalyticsOptions {
  store: AnalyticsStore
  call: ChainCall
  fees?: () => Promise<FeeRow[]>
  chainTrades?: () => ChainTrade[]
  traffic?: () => Promise<TrafficCounts | null>
  /** The fee wallet: its own router trades pay their fee back to itself, so they aren't income. */
  feeWallet?: string
}

export class Analytics {
  private written = new Map<string, number>()
  private newPerIp = new Map<string, { hour: number; n: number }>()
  private tradesPerIp = new Map<string, { hour: number; n: number }>()
  private checking = false

  constructor(private o: AnalyticsOptions) {}

  private pub: { at: number; days: number; body: Promise<PublicStats> } | null = null
  /** The public stats, worked out at most every 30 seconds for each window (everyone's page asks). */
  publicStats(days = 30, now = Date.now()): Promise<PublicStats> {
    days = [1, 7, 30, 90].includes(days) ? days : 30
    if (this.pub && this.pub.days === days && now - this.pub.at < 30_000) return this.pub.body
    const body = this.report(days, now).then(publicStats)
    body.catch(() => { if (this.pub?.body === body) this.pub = null })
    this.pub = { at: now, days, body }
    return body
  }

  private take(map: Map<string, { hour: number; n: number }>, ip: string, max: number, now: number): boolean {
    const hour = Math.floor(now / 3_600_000)
    const seen = map.get(ip)
    const n = seen && seen.hour === hour ? seen.n : 0
    if (n >= max) return false
    if (map.size > 50_000) map.clear()
    map.set(ip, { hour, n: n + 1 })
    return true
  }

  /** A wallet in use on the site. */
  signin(b: unknown, ip: string, now = Date.now()): { ok: true } | { error: string } {
    const o = (b ?? {}) as Record<string, unknown>
    const address = walletOf(o.address)
    if (!address) return { error: 'bad address' }
    const kind: SigninKind = isOne(o.kind, SIGNIN_KINDS) ? o.kind : 'wallet'
    const w = this.written.get(address)
    if (w !== undefined && now - w < ANALYTICS.writeEveryMs) return { ok: true }
    if (w === undefined && !this.take(this.newPerIp, ip, ANALYTICS.newWalletsPerIpHour, now)) return { error: 'too many new wallets from here' }
    if (this.written.size > 200_000) this.written.clear()
    this.written.set(address, now)
    this.o.store.signinSeen({ address, kind, firstAt: now, lastAt: now, signIns: 1 })
    return { ok: true }
  }

  /** A trade the site sent: stored as pending until its chain says it went through. */
  async trade(b: unknown, ip: string, now = Date.now()): Promise<{ ok: true; id: string; new: boolean } | { error: string }> {
    if (!this.take(this.tradesPerIp, ip, ANALYTICS.tradesPerIpHour, now)) return { error: 'too many trades from here' }
    const t = parseTrade(b, now)
    if ('error' in t) return t
    const added = await this.o.store.siteTradeAdd(t)
    return { ok: true, id: t.id, new: added }
  }

  /** Looks up pending trades on their chains (every 15 seconds). */
  async checkPending(now = Date.now()): Promise<number> {
    if (this.checking) return 0
    this.checking = true
    let done = 0
    try {
      const pending = await this.o.store.siteTradesPending(ANALYTICS.checkBatch)
      for (const t of pending) {
        let s: TradeStatus | null = null
        try { s = await verifyTrade(t, this.o.call) } catch (e) { log.debug('analytics: lookup failed', { id: t.id, error: errMsg(e) }) }
        if (s === null && now - t.at < ANALYTICS.giveUpMs) continue
        this.o.store.siteTradeChecked(t.id, s ?? 'unverified', now)
        done++
      }
    } finally { this.checking = false }
    return done
  }

  /** Everything the owner's analytics page shows. */
  async report(days = ANALYTICS.days, now = Date.now()): Promise<AnalyticsReport> {
    days = Math.max(1, Math.min(365, Math.floor(days)))
    const since = now - days * 86_400_000
    const [{ users, trades: site }, feeRows, visitors] = await Promise.all([
      this.o.store.analyticsSince(0),
      this.o.fees ? this.o.fees().catch(() => [] as FeeRow[]) : Promise.resolve([] as FeeRow[]),
      this.o.traffic ? this.o.traffic().catch(() => null) : Promise.resolve(null),
    ])
    const checks: Record<TradeStatus, number> = { pending: 0, ok: 0, failed: 0, mismatch: 0, unverified: 0 }
    for (const t of site) checks[t.status]++

    // Counted trades: the site's checked ones, then router trades read from the chain that the site didn't send.
    type T = { tx: string; at: number; address: string; usd: number; feeUsd: number; chain: string; venue: string }
    const counted: T[] = site.filter(t => t.status === 'ok').map(t => ({ tx: t.tx, at: t.at, address: t.address, usd: t.usd, feeUsd: t.feeUsd, chain: t.chain, venue: t.venue }))
    const seenTx = new Set(counted.map(t => t.tx))
    const book = this.o.chainTrades?.() ?? []
    for (const c of book) {
      if (seenTx.has(c.tx.toLowerCase())) continue
      seenTx.add(c.tx.toLowerCase())
      counted.push({ tx: c.tx.toLowerCase(), at: c.at, address: c.trader.toLowerCase(), usd: c.usd, feeUsd: c.feeUsd, chain: 'arc', venue: 'arc-router' })
    }

    const within = (t: number, d: number) => now - t <= d * 86_400_000
    const sumUsd = (xs: T[]) => round2(xs.reduce((s, x) => s + x.usd, 0))
    const traderSet = (xs: T[]) => new Set(xs.map(x => x.address)).size
    const d1 = counted.filter(t => within(t.at, 1)), d7 = counted.filter(t => within(t.at, 7)), d30 = counted.filter(t => within(t.at, 30))

    const byChain: Record<string, { trades: number; volumeUsd: number }> = {}
    const byVenue: Record<string, { trades: number; volumeUsd: number }> = {}
    for (const t of counted.filter(t => t.at >= since)) {
      const c = byChain[t.chain] ?? (byChain[t.chain] = { trades: 0, volumeUsd: 0 }); c.trades++; c.volumeUsd += t.usd
      const v = byVenue[t.venue] ?? (byVenue[t.venue] = { trades: 0, volumeUsd: 0 }); v.trades++; v.volumeUsd += t.usd
    }
    for (const m of [byChain, byVenue]) for (const k in m) m[k].volumeUsd = round2(m[k].volumeUsd)

    // Fees: what the ledger saw arrive (received or accrued), in dollars. The ledger's Arc rows start where the $ARCDEX
    // program's scan did (2026-10-04); router fees from before then come from the trade book's Swapped events (the
    // fee each one paid, on-chain), up to the ledger's first Arc router row, the fee wallet's own trades left out.
    type Income = { at: number; source: string; amountUsd: number }
    const income: Income[] = feeRows.filter(r => (r.status === 'received' || r.status === 'accrued') && r.amountUsd != null)
      .map(r => ({ at: r.at, source: r.source, amountUsd: r.amountUsd ?? 0 }))
    const arcRows = income.filter(r => r.source === 'arc-router' || r.source === 'arc-curve')
    const ledgerFrom = arcRows.length ? Math.min(...arcRows.map(r => r.at)) : Infinity
    const fw = (this.o.feeWallet ?? '').toLowerCase()
    for (const c of book) if (c.at < ledgerFrom && c.feeUsd > 0 && c.trader.toLowerCase() !== fw) income.push({ at: c.at, source: 'arc-router', amountUsd: c.feeUsd })
    const feeSum = (d: number | null) => round6(income.filter(r => d === null || within(r.at, d)).reduce((s, r) => s + r.amountUsd, 0))
    const bySource: Record<string, number> = {}
    for (const r of income) bySource[r.source] = round6((bySource[r.source] ?? 0) + r.amountUsd)

    const byKind: Record<string, number> = {}
    for (const u of users) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1

    // Day by day, oldest first.
    const series = new Map<string, DayRow & { tradersSet: Set<string> }>()
    for (let t = since - (since % 86_400_000); t <= now; t += 86_400_000) series.set(day(t), { day: day(t), signIns: 0, newUsers: 0, traders: 0, trades: 0, volumeUsd: 0, feesUsd: 0, tradersSet: new Set() })
    for (const u of users) {
      const a = series.get(day(u.lastAt)); if (a) a.signIns++
      const f = series.get(day(u.firstAt)); if (f) f.newUsers++
    }
    for (const t of counted) { const r = series.get(day(t.at)); if (r) { r.trades++; r.volumeUsd += t.usd; r.tradersSet.add(t.address) } }
    for (const f of income) { const r = series.get(day(f.at)); if (r) r.feesUsd += f.amountUsd }
    const daily = [...series.values()].map(({ tradersSet, ...r }) => ({ ...r, traders: tradersSet.size, volumeUsd: round2(r.volumeUsd), feesUsd: round6(r.feesUsd) }))

    const tops = new Map<string, { address: string; trades: number; volumeUsd: number; feesUsd: number }>()
    for (const t of counted.filter(t => t.at >= since)) {
      const x = tops.get(t.address) ?? tops.set(t.address, { address: t.address, trades: 0, volumeUsd: 0, feesUsd: 0 }).get(t.address)!
      x.trades++; x.volumeUsd += t.usd; x.feesUsd += t.feeUsd
    }
    const topTraders = [...tops.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 20).map(x => ({ ...x, volumeUsd: round2(x.volumeUsd), feesUsd: round6(x.feesUsd) }))

    return {
      at: now, days, visitors,
      users: {
        total: users.length,
        new24h: users.filter(u => within(u.firstAt, 1)).length,
        active24h: users.filter(u => within(u.lastAt, 1)).length,
        active7d: users.filter(u => within(u.lastAt, 7)).length,
        byKind,
      },
      traders: { total: traderSet(counted), d1: traderSet(d1), d7: traderSet(d7), d30: traderSet(d30) },
      trades: {
        total: counted.length, d1: d1.length, d7: d7.length, d30: d30.length,
        volume: { total: sumUsd(counted), d1: sumUsd(d1), d7: sumUsd(d7), d30: sumUsd(d30) },
        byChain, byVenue,
      },
      fees: { total: feeSum(null), d1: feeSum(1), d7: feeSum(7), d30: feeSum(30), bySource, reportedByTrades: round6(counted.filter(t => t.at >= since).reduce((s, t) => s + t.feeUsd, 0)) },
      funnel: { visitorsToday: visitors?.today ?? null, signedIn24h: users.filter(u => within(u.lastAt, 1)).length, traded24h: traderSet(d1) },
      checks,
      daily,
      topTraders,
      latest: [...site].sort((a, b) => b.at - a.at).slice(0, 50).map(({ chain, venue, side, address, usd, feeUsd, coin, tx, at, status }) => ({ chain, venue, side, address, usd, feeUsd, coin, tx, at, status })),
    }
  }
}

/** What everyone may see (owner, 2026-10-17: "put it there for everyone to see the number of users, wallets, volume
 * traded, fees collected"): the totals and the day-by-day series. No wallet address, no transaction hash. */
export interface PublicStats {
  at: number
  days: number
  visitors: { online: number; today: number; total: number } | null
  users: { total: number; new24h: number; active24h: number; active7d: number; byKind: Record<string, number> }
  traders: AnalyticsReport['traders']
  trades: AnalyticsReport['trades']
  fees: { total: number; d1: number; d7: number; d30: number; bySource: Record<string, number> }
  daily: DayRow[]
  latest: { chain: string; venue: string; side: string; usd: number; coin: string | null; at: number }[]
}

export function publicStats(r: AnalyticsReport): PublicStats {
  const v = r.visitors as (TrafficCounts & Record<string, unknown>) | null
  return {
    at: r.at, days: r.days,
    visitors: v ? { online: Number(v.online ?? 0), today: Number(v.today ?? 0), total: Number(v.total ?? 0) } : null,
    users: r.users,
    traders: r.traders,
    trades: r.trades,
    fees: { total: r.fees.total, d1: r.fees.d1, d7: r.fees.d7, d30: r.fees.d30, bySource: r.fees.bySource },
    daily: r.daily,
    latest: r.latest.filter(t => t.status === 'ok').slice(0, 20).map(t => ({ chain: t.chain, venue: t.venue, side: t.side, usd: t.usd, coin: t.coin ?? null, at: t.at })),
  }
}

export class MemoryAnalyticsStore implements AnalyticsStore {
  users = new Map<string, SigninRow>()
  trades = new Map<string, SiteTradeRow>()
  signinSeen(r: SigninRow) {
    const u = this.users.get(r.address)
    this.users.set(r.address, u ? { ...u, lastAt: Math.max(u.lastAt, r.lastAt), signIns: u.signIns + 1, kind: r.kind } : { ...r })
  }
  async siteTradeAdd(t: SiteTradeRow) { if (this.trades.has(t.id)) return false; this.trades.set(t.id, { ...t }); return true }
  siteTradeChecked(id: string, status: TradeStatus, at: number) { const t = this.trades.get(id); if (t) this.trades.set(id, { ...t, status, checkedAt: at }) }
  async siteTradesPending(limit: number) { return [...this.trades.values()].filter(t => t.status === 'pending').sort((a, b) => a.at - b.at).slice(0, limit).map(t => ({ ...t })) }
  async analyticsSince(since: number) {
    return { users: [...this.users.values()].filter(u => u.lastAt >= since).map(u => ({ ...u })), trades: [...this.trades.values()].filter(t => t.at >= since).map(t => ({ ...t })) }
  }
}

/** The public RPCs each chain's transactions are looked up on. */
export const ANALYTICS_RPCS: Record<Exclude<TradeChain, 'hyperliquid' | 'starknet'>, string[]> = {
  arc: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io'],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
  solana: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  bnb: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
}
