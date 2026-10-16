// The trade book behind verified PnL: every Swapped event of ARCDEX's Arc routers (SOCIAL_ROUTERS), read from the chain
// every minute into the engine's own Postgres (arcdex_social_trades, append-only), and kept in memory for the boards.
// It never reads the Supabase index or anything a browser sends.
//
// A nightly check, after 00:50 UTC, scans the blocks recorded since the last check again on its own and compares them
// with the book, trade by trade, to the unit: missing, extra or changed trades are logged, counted and alerted, and the
// book is only "checked" to the last block that matched. Where the site's Supabase index (arcdex_trades) is readable,
// the same range is compared with it too, so a gap there shows up (the old profile and points numbers come from it).

import { SOCIAL_FROM_BLOCK, SOCIAL_ROUTERS } from '../../../api/_socialProtocol'
import { decodeTrades, T_SWAPPED, usd6, type BookTrade, type RouterLog } from './pnl'
import { log, errMsg } from '../log'

export interface SocialTradeStore {
  socialTrades(): Promise<BookTrade[]>
  /** Adds trades not stored yet (a trade seen again is ignored); how many were new. */
  appendSocialTrades(rows: BookTrade[]): Promise<number>
}
interface Settings { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }

export interface BookCheck {
  at: number
  from: number
  to: number
  trades: number
  ok: boolean
  missing: string[]
  extra: string[]
  changed: string[]
  /** The site's Supabase index over the same blocks, when it could be read. */
  supabase?: { rows: number; missing: string[]; extra: string[]; changed: string[] } | { error: string }
}

export interface IndexRow { tx_hash: string; log_index: number; trader: string; token: string; side: 'buy' | 'sell'; usdc: string; token_amount: string; block_number: number }

export interface TradeBookOptions {
  store: SocialTradeStore
  settings: Settings
  /** Logs for a filter over a block range: the contiguous prefix it finished, and how far that reached. */
  scan: (filter: { address: string[]; topics: (string | string[] | null)[] }, from: number, to: number) => Promise<{ logs: RouterLog[]; scannedTo: number }>
  head: () => Promise<number>
  /** Block times (ms) for blocks whose logs carry none. */
  times: (blocks: number[]) => Promise<Map<number, number | null>>
  /** The Supabase index's rows over a block range, when it's readable (null: not configured). */
  indexRows?: ((from: number, to: number) => Promise<IndexRow[]>) | null
  alert?: (text: string) => void
  /** The UTC minute of the day the nightly check starts after (default 00:50). */
  checkAfterMinute?: number
  from?: number
}

interface BookState { to: number; checked: number; day: string | null; checks: BookCheck[] }
const KEY = 'social-book'
/** Blocks left behind the head, so the book reads settled blocks. */
const SETTLE = 50

/** The chain's view of the book's fields that a check compares. */
const fingerprint = (t: Pick<BookTrade, 'trader' | 'token' | 'side' | 'usdc' | 'tokens' | 'block'>) => `${t.trader}|${t.token}|${t.side}|${t.usdc}|${t.tokens}|${t.block}`

export class TradeBook {
  private st: BookState | null = null
  private busy = false
  private byId = new Map<string, BookTrade>()
  private byTrader = new Map<string, BookTrade[]>()
  /** Bumped whenever trades are added: boards cache against it. */
  version = 0
  loaded = false

  constructor(private o: TradeBookOptions) {}

  private async state(): Promise<BookState> {
    if (this.st) return this.st
    const s = await this.o.settings.getSetting(KEY).catch(() => null)
    const start = (this.o.from ?? SOCIAL_FROM_BLOCK) - 1
    const saved = s ? JSON.parse(s) as Partial<BookState> : null
    this.st = { to: saved?.to ?? start, checked: saved?.checked ?? start, day: saved?.day ?? null, checks: saved?.checks ?? [] }
    return this.st
  }
  private async save() { if (this.st) await this.o.settings.setSetting(KEY, JSON.stringify({ ...this.st, checks: this.st.checks.slice(0, 30) })).catch(() => {}) }

  /** Reads what's stored into memory. */
  async load() {
    await this.state()
    this.index(await this.o.store.socialTrades().catch(e => { log.error('social book: not loaded', { error: errMsg(e) }); return [] }))
    this.loaded = true
  }

  private index(rows: BookTrade[]) {
    let added = 0
    for (const t of rows) {
      if (this.byId.has(t.id)) continue
      this.byId.set(t.id, t)
      const list = this.byTrader.get(t.trader) ?? this.byTrader.set(t.trader, []).get(t.trader)!
      list.push(t)
      added++
    }
    if (added) this.version++
    return added
  }

  get size() { return this.byId.size }
  all(): BookTrade[] { return [...this.byId.values()] }
  of(trader: string): BookTrade[] { return this.byTrader.get(trader.toLowerCase()) ?? [] }
  traders(): string[] { return [...this.byTrader.keys()] }
  async scannedTo() { return (await this.state()).to }
  async checkedTo() { return (await this.state()).checked }
  async checks() { return (await this.state()).checks }

  /** Reads the routers' new events into the book; then the nightly check when it's due. */
  async tick(now = Date.now()) {
    if (this.busy) return
    this.busy = true
    try {
      const st = await this.state()
      const head = (await this.o.head()) - SETTLE
      if (head > st.to) {
        const r = await this.o.scan({ address: Object.keys(SOCIAL_ROUTERS), topics: [T_SWAPPED] }, st.to + 1, head)
        if (r.scannedTo > st.to) {
          const logs = r.logs.filter(l => Number(BigInt(l.blockNumber)) <= r.scannedTo)
          const trades = await this.decode(logs)
          if (trades.length) {
            await this.o.store.appendSocialTrades(trades)
            this.index(trades)
          }
          st.to = r.scannedTo
          await this.save()
        }
      }
      const d = new Date(now)
      if (st.day !== d.toISOString().slice(0, 10) && d.getUTCHours() * 60 + d.getUTCMinutes() >= (this.o.checkAfterMinute ?? 50)) await this.check(now)
    } catch (e) {
      log.warn('social book: not read', { error: errMsg(e) })
    } finally {
      this.busy = false
    }
  }

  private async decode(logs: RouterLog[]): Promise<BookTrade[]> {
    const unstamped = [...new Set(logs.filter(l => !l.blockTimestamp).map(l => Number(BigInt(l.blockNumber))))]
    const times = unstamped.length ? await this.o.times(unstamped) : new Map<number, number | null>()
    // A range with a block whose time couldn't be read is left for the next tick: no trade is stored without its time.
    const untimed = unstamped.filter(b => times.get(b) == null)
    if (untimed.length) throw new Error(`no block time for ${untimed.length} block(s)`)
    return decodeTrades(logs, b => times.get(b) ?? null)
  }

  /** Every log in the range, in as many pieces as it takes; null if a piece makes no progress. */
  private async scanAll(from: number, to: number): Promise<RouterLog[] | null> {
    const out: RouterLog[] = []
    for (let a = from; a <= to;) {
      const r = await this.o.scan({ address: Object.keys(SOCIAL_ROUTERS), topics: [T_SWAPPED] }, a, to)
      if (r.scannedTo < a) return null
      out.push(...r.logs.filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= a && b <= r.scannedTo }))
      a = r.scannedTo + 1
    }
    return out
  }

  /** Checks the blocks read since the last check against a scan of their own (see the header). */
  async check(now = Date.now()): Promise<BookCheck | null> {
    const st = await this.state()
    const from = st.checked + 1, to = st.to
    const day = new Date(now).toISOString().slice(0, 10)
    if (to < from) { st.day = day; await this.save(); return null }
    const logs = await this.scanAll(from, to)
    if (!logs) { log.warn('social book: check incomplete (scan stalled)', { from, to }); return null }
    let chain: BookTrade[]
    try { chain = await this.decode(logs) } catch (e) { log.warn('social book: check incomplete', { error: errMsg(e) }); return null }
    const chainById = new Map(chain.map(t => [t.id, t]))
    const mine = this.all().filter(t => t.block >= from && t.block <= to)
    const mineById = new Map(mine.map(t => [t.id, t]))
    const missing = [...chainById.keys()].filter(id => !mineById.has(id))
    const extra = [...mineById.keys()].filter(id => !chainById.has(id))
    const changed = [...chainById.values()].filter(t => mineById.has(t.id) && fingerprint(mineById.get(t.id)!) !== fingerprint(t)).map(t => t.id)
    const res: BookCheck = { at: now, from, to, trades: chain.length, ok: !missing.length && !extra.length && !changed.length, missing: missing.slice(0, 20), extra: extra.slice(0, 20), changed: changed.slice(0, 20) }
    if (missing.length) {
      // What the book missed goes in now; it's checked again tomorrow with the rest.
      const add = missing.map(id => chainById.get(id)!)
      await this.o.store.appendSocialTrades(add)
      this.index(add)
    }
    if (this.o.indexRows) {
      try {
        const rows = await this.o.indexRows(from, to)
        const idx = new Map(rows.map(r => [`${r.tx_hash.toLowerCase()}:${r.log_index}`, r]))
        const sMissing = chain.filter(t => !idx.has(t.id)).map(t => t.id)
        const sExtra = [...idx.keys()].filter(id => !chainById.has(id))
        const sChanged = chain.filter(t => {
          const r = idx.get(t.id)
          if (!r) return false
          // The index keeps USDC as a decimal with 6 places, tokens raw.
          return r.trader.toLowerCase() !== t.trader || r.token.toLowerCase() !== t.token || r.side !== t.side || Number(r.block_number) !== t.block
            || BigInt(String(r.token_amount).split('.')[0]) !== t.tokens || Number(r.usdc).toFixed(6) !== usd6(t.usdc)
        }).map(t => t.id)
        res.supabase = { rows: rows.length, missing: sMissing.slice(0, 20), extra: sExtra.slice(0, 20), changed: sChanged.slice(0, 20) }
      } catch (e) { res.supabase = { error: errMsg(e).slice(0, 200) } }
    }
    st.checks = [res, ...st.checks].slice(0, 30)
    st.day = day
    // Checked to the end of the range only when it matched; otherwise from the same block tomorrow.
    if (res.ok) st.checked = to
    await this.save()
    if (!res.ok) this.o.alert?.(`ARCDEX social book mismatch in blocks ${from}-${to}: ${missing.length} missing, ${extra.length} extra, ${changed.length} changed`)
    const s = res.supabase && 'rows' in res.supabase ? res.supabase : null
    if (s && (s.missing.length || s.extra.length || s.changed.length)) log.warn('social book: the Supabase index differs from the chain', { from, to, missing: s.missing.length, extra: s.extra.length, changed: s.changed.length })
    log.info('social book checked', { from, to, trades: chain.length, ok: res.ok })
    return res
  }
}

/** Trades kept in memory (dev, tests). */
export class MemorySocialTradeStore implements SocialTradeStore {
  private rows = new Map<string, BookTrade>()
  async socialTrades() { return [...this.rows.values()].map(t => ({ ...t })) }
  async appendSocialTrades(rows: BookTrade[]) {
    let n = 0
    for (const r of rows) if (!this.rows.has(r.id)) { this.rows.set(r.id, { ...r }); n++ }
    return n
  }
}
