// Historical storage: every normalized trade, completed candles, launches,
// pools and liquidity samples — in ARCDEX's existing Supabase Postgres
// (tables from supabase/migrations/20260928000000_arcdex_market_engine.sql).
//
// Writes are queued and sent in batches once a second (500 rows per request,
// idempotent upserts keyed by trade id / candle bucket), so the live path
// never waits on the database. Failed batches are retried; the queue is
// bounded, and anything dropped is counted in metrics.
//
// The interface is storage-agnostic: at very high volume, implement it for
// an analytical store (e.g. ClickHouse) and swap it in main.ts.

import type { Interval, LaunchInfo, Trade, WireCandle } from '../../../api/_marketProtocol'
import { DbError, adminReady, db } from '../../../api/_supabaseAdmin'
import type { PoolInfo } from '../dex/pools'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { Candle } from '../market/candles'

export interface LiquidityRow { pool: string; token: string; block: number; ts: number; usd: number }

export interface HistoryStore {
  readonly enabled: boolean
  trade(t: Trade): void
  candle(token: string, interval: Interval, c: Candle): void
  launch(l: LaunchInfo): void
  pool(p: PoolInfo): void
  liquidity(r: LiquidityRow): void
  repair(token: string, interval: Interval, bucket: number): void
  getCursor(): Promise<number | null>
  setCursor(block: number): Promise<void>
  trades(token: string, limit: number, beforeTs?: number): Promise<Trade[]>
  candles(token: string, interval: Interval, limit: number, beforeTs?: number): Promise<WireCandle[]>
  launches(limit: number): Promise<LaunchInfo[]>
  token(token: string): Promise<LaunchInfo | null>
  cleanup(tradeRetentionHours: number): Promise<void>
  flush(): Promise<void>
  close(): void
  status(): { enabled: boolean; queued: number; lastWriteMs: number | null; lastError: string | null }
}

const iso = (ms: number) => new Date(ms).toISOString()
const MAX_QUEUED = 200_000
const CHUNK = 500

type Row = Record<string, unknown>

export class SupabaseHistoryStore implements HistoryStore {
  readonly enabled = true
  private tradesQ: Row[] = []
  private candlesQ = new Map<string, Row>()
  private tokensQ = new Map<string, Row>()
  private poolsQ = new Map<string, Row>()
  private liqQ: Row[] = []
  private repairsQ = new Map<string, { token: string; interval: Interval; bucket: number }>()
  private timer: ReturnType<typeof setInterval>
  private flushing: Promise<void> | null = null
  private lastWriteMs: number | null = null
  private lastError: string | null = null
  private schemaMissing = false

  constructor() {
    if (!adminReady) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for history')
    this.timer = setInterval(() => void this.flush(), 1_000)
  }

  trade(t: Trade) {
    if (this.tradesQ.length >= MAX_QUEUED) { this.tradesQ.shift(); metrics.inc('history_dropped') }
    this.tradesQ.push({
      trade_id: t.tradeId, token: t.token, pool: t.pool, quote: t.quote, side: t.side,
      token_amount: t.tokenAmount, quote_amount: t.quoteAmount, price: t.price, price_usd: t.priceUsd, usd_value: t.usdValue,
      wallet: t.wallet, tx_hash: t.txHash, block_number: t.blockNumber, log_index: t.logIndex, ts: iso(t.timestamp),
      dex: t.dex, launchpad: t.launchpad, liquidity_usd: t.liquidity,
    })
  }
  candle(token: string, interval: Interval, c: Candle) {
    this.candlesQ.set(`${token}|${interval}|${c.t}`, { token, interval, bucket: iso(c.t * 1000), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n })
  }
  launch(l: LaunchInfo) {
    this.tokensQ.set(l.token, {
      token: l.token, name: l.name, symbol: l.symbol, decimals: l.decimals, creator: l.creator, launchpad: l.launchpad,
      portal: l.portal ?? null, launch_tx: l.txHash, launch_block: l.blockNumber, launched_at: iso(l.timestamp),
      pool: l.pool, quote: l.quote, image: l.image ?? null, status: l.status,
    })
  }
  pool(p: PoolInfo) {
    this.poolsQ.set(p.pool, {
      pool: p.pool, dex: p.dex, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tick_spacing: p.tickSpacing, hooks: p.hooks,
      base: p.base, quote: p.quote, base_decimals: p.baseDecimals, quote_decimals: p.quoteDecimals,
    })
  }
  liquidity(r: LiquidityRow) {
    if (this.liqQ.length < 50_000) this.liqQ.push({ pool: r.pool, token: r.token, block_number: r.block, ts: iso(r.ts), liquidity_usd: r.usd })
  }
  repair(token: string, interval: Interval, bucket: number) {
    this.repairsQ.set(`${token}|${interval}|${bucket}`, { token, interval, bucket })
  }

  async getCursor() {
    try {
      const r = await db<{ block: number }[]>('arcdex_mkt_cursor?stream=eq.main&select=block')
      return r.length ? Number(r[0].block) : null
    } catch { return null }
  }
  async setCursor(block: number) {
    if (this.schemaMissing) return
    await db('arcdex_mkt_cursor?on_conflict=stream', { method: 'POST', body: [{ stream: 'main', block, updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' })
  }

  async trades(token: string, limit: number, beforeTs?: number): Promise<Trade[]> {
    const before = beforeTs ? `&ts=lt.${iso(beforeTs)}` : ''
    const rows = await db<Row[]>(`arcdex_mkt_trades?token=eq.${token}${before}&order=ts.desc,block_number.desc,log_index.desc&limit=${Math.min(500, limit)}`)
    return rows.map(r => ({
      tradeId: String(r.trade_id), chain: 'ARC', token: String(r.token), pair: `${r.token}/${r.quote}`, pool: String(r.pool), quote: String(r.quote),
      side: r.side as Trade['side'], baseAmount: Number(r.token_amount), quoteAmount: Number(r.quote_amount), tokenAmount: Number(r.token_amount),
      price: Number(r.price), priceUsd: r.price_usd === null ? null : Number(r.price_usd), usdValue: r.usd_value === null ? null : Number(r.usd_value),
      wallet: (r.wallet as string | null) ?? null, txHash: String(r.tx_hash), blockNumber: Number(r.block_number), logIndex: Number(r.log_index),
      timestamp: Date.parse(String(r.ts)), dex: String(r.dex), launchpad: (r.launchpad as string | null) ?? null,
      liquidity: r.liquidity_usd === null ? null : Number(r.liquidity_usd),
    }))
  }

  async candles(token: string, interval: Interval, limit: number, beforeTs?: number): Promise<WireCandle[]> {
    const before = beforeTs ? `&bucket=lt.${iso(beforeTs)}` : ''
    const rows = await db<Row[]>(`arcdex_mkt_candles?token=eq.${token}&interval=eq.${interval}${before}&order=bucket.desc&limit=${Math.min(1_000, limit)}`)
    return rows.reverse().map(r => [Date.parse(String(r.bucket)) / 1000, Number(r.o), Number(r.h), Number(r.l), Number(r.c), Number(r.v), Number(r.n)] as WireCandle)
  }

  private toLaunch(r: Row): LaunchInfo {
    return {
      token: String(r.token), name: String(r.name ?? ''), symbol: String(r.symbol ?? ''), decimals: Number(r.decimals ?? 18),
      creator: (r.creator as string | null) ?? null, txHash: String(r.launch_tx ?? ''), blockNumber: Number(r.launch_block ?? 0),
      timestamp: r.launched_at ? Date.parse(String(r.launched_at)) : 0, pool: (r.pool as string | null) ?? null, quote: (r.quote as string | null) ?? null,
      launchpad: String(r.launchpad ?? ''), chain: 'ARC', status: 'LIVE', portal: r.portal === null ? undefined : Number(r.portal), image: (r.image as string | null) ?? null,
    }
  }
  async launches(limit: number) {
    const rows = await db<Row[]>(`arcdex_mkt_tokens?launched_at=not.is.null&order=launched_at.desc&limit=${Math.min(500, limit)}`)
    return rows.map(r => this.toLaunch(r))
  }
  async token(token: string) {
    const rows = await db<Row[]>(`arcdex_mkt_tokens?token=eq.${token}&limit=1`)
    return rows.length ? this.toLaunch(rows[0]) : null
  }

  async cleanup(tradeRetentionHours: number) {
    if (this.schemaMissing) return
    try {
      const r = await db<unknown>('rpc/arcdex_mkt_cleanup', { method: 'POST', body: { p_trade_hours: tradeRetentionHours } })
      log.info('history cleanup', { result: r })
    } catch (e) { log.warn('history cleanup failed', { error: errMsg(e) }) }
  }

  private async post(table: string, rows: Row[], prefer: string) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db(table, { method: 'POST', body: rows.slice(i, i + CHUNK), prefer })
    }
  }

  flush(): Promise<void> {
    if (this.flushing || this.schemaMissing) return this.flushing ?? Promise.resolve()
    const trades = this.tradesQ; this.tradesQ = []
    const candles = [...this.candlesQ.values()]; this.candlesQ.clear()
    const tokens = [...this.tokensQ.values()]; this.tokensQ.clear()
    const pools = [...this.poolsQ.values()]; this.poolsQ.clear()
    const liq = this.liqQ; this.liqQ = []
    const repairs = [...this.repairsQ.values()].slice(0, 50)
    for (const r of repairs) this.repairsQ.delete(`${r.token}|${r.interval}|${r.bucket}`)
    if (!trades.length && !candles.length && !tokens.length && !pools.length && !liq.length && !repairs.length) return Promise.resolve()
    const t0 = Date.now()
    this.flushing = (async () => {
      try {
        // Tokens and pools first: trades reference them in queries.
        if (tokens.length) await this.post('arcdex_mkt_tokens?on_conflict=token', tokens, 'resolution=merge-duplicates,return=minimal')
        if (pools.length) await this.post('arcdex_mkt_pools?on_conflict=pool', pools, 'resolution=merge-duplicates,return=minimal')
        if (trades.length) await this.post('arcdex_mkt_trades?on_conflict=trade_id', trades, 'resolution=ignore-duplicates,return=minimal')
        if (candles.length) await this.post('arcdex_mkt_candles?on_conflict=token,interval,bucket', candles, 'resolution=merge-duplicates,return=minimal')
        if (liq.length) await this.post('arcdex_mkt_liquidity?on_conflict=pool,block_number', liq, 'resolution=ignore-duplicates,return=minimal')
        for (const r of repairs) {
          await db('rpc/arcdex_mkt_rebuild_candle', { method: 'POST', body: { p_token: r.token, p_interval: r.interval, p_bucket: iso(r.bucket * 1000) } })
        }
        this.lastWriteMs = Date.now() - t0
        this.lastError = null
        metrics.latency('db_write', this.lastWriteMs)
        metrics.inc('db_rows_written', trades.length + candles.length + tokens.length + pools.length + liq.length)
      } catch (e) {
        this.lastError = errMsg(e)
        metrics.inc('db_errors')
        if (e instanceof DbError && (e.status === 404 || /arcdex_mkt|PGRST20[25]|42P01/.test(e.body))) {
          this.schemaMissing = true
          log.error('history tables missing — run supabase/migrations/20260928000000_arcdex_market_engine.sql; history writes paused')
          return
        }
        log.warn('history write failed — will retry', { error: this.lastError })
        // Put everything back (ahead of anything queued since) and retry next tick.
        this.tradesQ = [...trades, ...this.tradesQ].slice(-MAX_QUEUED)
        for (const c of candles) { const k = `${c.token}|${c.interval}|${Date.parse(String(c.bucket)) / 1000}`; if (!this.candlesQ.has(k)) this.candlesQ.set(k, c) }
        for (const t of tokens) if (!this.tokensQ.has(String(t.token))) this.tokensQ.set(String(t.token), t)
        for (const p of pools) if (!this.poolsQ.has(String(p.pool))) this.poolsQ.set(String(p.pool), p)
        for (const r of repairs) this.repairsQ.set(`${r.token}|${r.interval}|${r.bucket}`, r)
      } finally {
        this.flushing = null
        metrics.set('db_queue', this.queued())
      }
    })()
    return this.flushing
  }

  close() { clearInterval(this.timer) }

  private queued() { return this.tradesQ.length + this.candlesQ.size + this.tokensQ.size + this.poolsQ.size + this.liqQ.length }

  status() { return { enabled: !this.schemaMissing, queued: this.queued(), lastWriteMs: this.lastWriteMs, lastError: this.lastError } }
}

/** History off (HISTORY_ENABLED=0 or no Supabase credentials). */
export class NullHistoryStore implements HistoryStore {
  readonly enabled = false
  trade() {} candle() {} launch() {} pool() {} liquidity() {} repair() {}
  async getCursor() { return null }
  async setCursor() {}
  async trades() { return [] }
  async candles() { return [] }
  async launches() { return [] }
  async token() { return null }
  async cleanup() {}
  async flush() {}
  close() {}
  status() { return { enabled: false, queued: 0, lastWriteMs: null, lastError: null } }
}
