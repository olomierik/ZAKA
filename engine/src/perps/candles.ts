// The futures chart: candles built from every signed oracle price (one every 10 seconds per
// feed), the same prices the contract settles at. RedStone keeps no history the engine can
// fetch, so the chart starts when the engine first recorded a feed and grows from there.
//
// One-minute candles are kept 30 days and one-hour candles for good (Postgres when the engine
// has it); 5m and 15m are built from 1m, 4h and 1d from 1h.

import type { PerpsBar, PerpsFeedPrice, PerpsTf } from './shared'
import { errMsg, log } from '../log'

export const TF_MS: Record<PerpsTf, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

export interface CandleStore {
  load(feed: string, tf: '1m' | '1h', since: number): Promise<PerpsBar[]>
  save(feed: string, tf: '1m' | '1h', bar: PerpsBar): void
  prune(tf: '1m', before: number): void
}

export class MemoryCandleStore implements CandleStore {
  rows = new Map<string, Map<number, PerpsBar>>()
  async load(feed: string, tf: '1m' | '1h', since: number) {
    return [...(this.rows.get(`${feed}:${tf}`)?.values() ?? [])].filter(b => b[0] >= since).sort((a, b) => a[0] - b[0])
  }
  save(feed: string, tf: '1m' | '1h', bar: PerpsBar) {
    const k = `${feed}:${tf}`
    if (!this.rows.has(k)) this.rows.set(k, new Map())
    this.rows.get(k)!.set(bar[0], [...bar] as PerpsBar)
  }
  prune(tf: '1m', before: number) {
    for (const [k, m] of this.rows) if (k.endsWith(`:${tf}`)) for (const t of m.keys()) if (t < before) m.delete(t)
  }
}

const MIN_KEEP_MS = 3 * 86_400_000 // 1m candles held in memory
const MIN_STORE_MS = 30 * 86_400_000 // and in the store

function push(bars: PerpsBar[], tfMs: number, ts: number, price: number): PerpsBar {
  const t = ts - (ts % tfMs)
  const last = bars[bars.length - 1]
  if (last && last[0] === t) {
    last[2] = Math.max(last[2], price)
    last[3] = Math.min(last[3], price)
    last[4] = price
    return last
  }
  if (last && t < last[0]) return last // out of order: ignored
  const bar: PerpsBar = [t, last ? last[4] : price, Math.max(price, last ? last[4] : price), Math.min(price, last ? last[4] : price), price]
  // A new candle opens at the previous close, so the line has no gaps between candles.
  bars.push(bar)
  return bar
}

function aggregate(bars: PerpsBar[], tfMs: number): PerpsBar[] {
  const out: PerpsBar[] = []
  for (const b of bars) {
    const t = b[0] - (b[0] % tfMs)
    const last = out[out.length - 1]
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], b[2])
      last[3] = Math.min(last[3], b[3])
      last[4] = b[4]
    } else out.push([t, b[1], b[2], b[3], b[4]])
  }
  return out
}

export class PriceCandles {
  private m1 = new Map<string, PerpsBar[]>()
  private h1 = new Map<string, PerpsBar[]>()
  private last = new Map<string, { price: number; ts: number }>()
  private prunedAt = 0

  constructor(private store: CandleStore | null, private feeds: readonly string[]) {
    for (const f of feeds) {
      this.m1.set(f, [])
      this.h1.set(f, [])
    }
  }

  /** Loads what the store has (the last 3 days of 1m candles, every 1h candle). */
  async load(now = Date.now()) {
    if (!this.store) return
    for (const f of this.feeds) {
      try {
        const m = await this.store.load(f, '1m', now - MIN_KEEP_MS)
        const h = await this.store.load(f, '1h', 0)
        // Anything recorded before the load keeps its place after the stored bars.
        this.m1.set(f, [...m.filter(b => !this.m1.get(f)!.some(x => x[0] === b[0])), ...this.m1.get(f)!].sort((a, b) => a[0] - b[0]))
        this.h1.set(f, [...h.filter(b => !this.h1.get(f)!.some(x => x[0] === b[0])), ...this.h1.get(f)!].sort((a, b) => a[0] - b[0]))
        const lb = this.m1.get(f)!.at(-1)
        if (lb && !this.last.has(f)) this.last.set(f, { price: lb[4], ts: lb[0] })
      } catch (e) {
        log.warn('perps: candles not loaded', { feed: f, error: errMsg(e) })
      }
    }
  }

  /** One signed price. */
  tick(feed: string, price: number, ts: number) {
    const m = this.m1.get(feed)
    const h = this.h1.get(feed)
    if (!m || !h || !(price > 0)) return
    const prev = this.last.get(feed)
    if (prev && ts <= prev.ts) return
    this.last.set(feed, { price, ts })
    const bm = push(m, TF_MS['1m'], ts, price)
    const bh = push(h, TF_MS['1h'], ts, price)
    this.store?.save(feed, '1m', bm)
    this.store?.save(feed, '1h', bh)
    const cut = ts - MIN_KEEP_MS
    if (m.length && m[0][0] < cut) this.m1.set(feed, m.filter(b => b[0] >= cut))
    if (ts - this.prunedAt > 3_600_000) {
      this.prunedAt = ts
      this.store?.prune('1m', ts - MIN_STORE_MS)
    }
  }

  candles(feed: string, tf: PerpsTf, limit = 500): PerpsBar[] {
    const m = this.m1.get(feed)
    const h = this.h1.get(feed)
    if (!m || !h) return []
    let bars: PerpsBar[]
    if (tf === '1m') bars = m
    else if (tf === '5m' || tf === '15m') bars = aggregate(m, TF_MS[tf])
    else if (tf === '1h') bars = h
    else bars = aggregate(h, TF_MS[tf])
    return bars.slice(-limit).map(b => [...b] as PerpsBar)
  }

  /** The latest price, and the last 24 hours from the 1m candles. */
  stats(feed: string, now = Date.now()): PerpsFeedPrice | null {
    const last = this.last.get(feed)
    if (!last) return null
    const since = now - 86_400_000
    const day = (this.m1.get(feed) ?? []).filter(b => b[0] >= since)
    const enough = day.length > 0 && day[0][0] <= since + 30 * 60_000 // ~a full day recorded
    const open = day.length ? day[0][1] : null
    return {
      price: last.price,
      ts: last.ts,
      open24h: enough ? open : null,
      high24h: day.length ? Math.max(...day.map(b => b[2])) : null,
      low24h: day.length ? Math.min(...day.map(b => b[3])) : null,
      change24h: enough && open ? ((last.price - open) / open) * 100 : null,
    }
  }
}
