// Historical storage: every normalized trade, completed candles, launches,
// pools and liquidity samples.
//
// Two backends, same tables (arcdex_mkt_*):
//   PostgresHistoryStore  any Postgres via DATABASE_URL (e.g. Railway) —
//                         creates its own tables on first start
//                         (store/postgresHistory.ts)
//   SupabaseHistoryStore  ARCDEX's Supabase via its REST API (tables from
//                         supabase/migrations/20260928000000_arcdex_market_engine.sql)
// Writes are queued and sent in batches once a second (500 rows per
// statement/request, idempotent upserts keyed by trade id / candle bucket),
// so the live path never waits on the database. Failed batches are retried;
// the queue is bounded, and anything dropped is counted in metrics.
//
// At very high volume, implement HistoryStore for an analytical store (e.g.
// ClickHouse) and swap it in main.ts.

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
  status(): { enabled: boolean; backend: string; queued: number; lastWriteMs: number | null; lastError: string | null }
}

// ── rows (column names = the arcdex_mkt_* tables) ────────────────────────

export type Row = Record<string, unknown>
export const iso = (ms: number) => new Date(ms).toISOString()

export const TRADE_COLS = ['trade_id', 'token', 'pool', 'quote', 'side', 'token_amount', 'quote_amount', 'price', 'price_usd', 'usd_value', 'wallet', 'tx_hash', 'block_number', 'log_index', 'ts', 'dex', 'launchpad', 'liquidity_usd'] as const
export const CANDLE_COLS = ['token', 'interval', 'bucket', 'o', 'h', 'l', 'c', 'v', 'n'] as const
export const TOKEN_COLS = ['token', 'name', 'symbol', 'decimals', 'creator', 'launchpad', 'portal', 'launch_tx', 'launch_block', 'launched_at', 'pool', 'quote', 'image', 'status'] as const
export const POOL_COLS = ['pool', 'dex', 'currency0', 'currency1', 'fee', 'tick_spacing', 'hooks', 'base', 'quote', 'base_decimals', 'quote_decimals'] as const
export const LIQ_COLS = ['pool', 'token', 'block_number', 'ts', 'liquidity_usd'] as const

export const tradeRow = (t: Trade): Row => ({
  trade_id: t.tradeId, token: t.token, pool: t.pool, quote: t.quote, side: t.side,
  token_amount: t.tokenAmount, quote_amount: t.quoteAmount, price: t.price, price_usd: t.priceUsd, usd_value: t.usdValue,
  wallet: t.wallet, tx_hash: t.txHash, block_number: t.blockNumber, log_index: t.logIndex, ts: iso(t.timestamp),
  dex: t.dex, launchpad: t.launchpad, liquidity_usd: t.liquidity,
})
export const candleRow = (token: string, interval: Interval, c: Candle): Row =>
  ({ token, interval, bucket: iso(c.t * 1000), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n })
export const tokenRow = (l: LaunchInfo): Row => ({
  token: l.token, name: l.name, symbol: l.symbol, decimals: l.decimals, creator: l.creator, launchpad: l.launchpad,
  portal: l.portal ?? null, launch_tx: l.txHash, launch_block: l.blockNumber, launched_at: iso(l.timestamp),
  pool: l.pool, quote: l.quote, image: l.image ?? null, status: l.status,
})
export const poolRow = (p: PoolInfo): Row => ({
  pool: p.pool, dex: p.dex, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tick_spacing: p.tickSpacing, hooks: p.hooks,
  base: p.base, quote: p.quote, base_decimals: p.baseDecimals, quote_decimals: p.quoteDecimals,
})
export const liqRow = (r: LiquidityRow): Row => ({ pool: r.pool, token: r.token, block_number: r.block, ts: iso(r.ts), liquidity_usd: r.usd })

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const msOf = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)))

export const rowToTrade = (r: Row): Trade => ({
  tradeId: String(r.trade_id), chain: 'ARC', token: String(r.token), pair: `${r.token}/${r.quote}`, pool: String(r.pool), quote: String(r.quote),
  side: r.side as Trade['side'], baseAmount: Number(r.token_amount), quoteAmount: Number(r.quote_amount), tokenAmount: Number(r.token_amount),
  price: Number(r.price), priceUsd: numOrNull(r.price_usd), usdValue: numOrNull(r.usd_value),
  wallet: (r.wallet as string | null) ?? null, txHash: String(r.tx_hash), blockNumber: Number(r.block_number), logIndex: Number(r.log_index),
  timestamp: msOf(r.ts), dex: String(r.dex), launchpad: (r.launchpad as string | null) ?? null, liquidity: numOrNull(r.liquidity_usd),
})
export const rowToCandle = (r: Row): WireCandle =>
  [msOf(r.bucket) / 1000, Number(r.o), Number(r.h), Number(r.l), Number(r.c), Number(r.v), Number(r.n)]
export const rowToLaunch = (r: Row): LaunchInfo => ({
  token: String(r.token), name: String(r.name ?? ''), symbol: String(r.symbol ?? ''), decimals: Number(r.decimals ?? 18),
  creator: (r.creator as string | null) ?? null, txHash: String(r.launch_tx ?? ''), blockNumber: Number(r.launch_block ?? 0),
  timestamp: r.launched_at ? msOf(r.launched_at) : 0, pool: (r.pool as string | null) ?? null, quote: (r.quote as string | null) ?? null,
  launchpad: String(r.launchpad ?? ''), chain: 'ARC', status: 'LIVE', portal: r.portal === null || r.portal === undefined ? undefined : Number(r.portal),
  image: (r.image as string | null) ?? null,
})

// ── shared batching ──────────────────────────────────────────────────────

const MAX_QUEUED = 200_000

export interface Batch {
  tokens: Row[]; pools: Row[]; trades: Row[]; candles: Row[]; liquidity: Row[]
  repairs: { token: string; interval: Interval; bucket: number }[]
}

/** Queues rows and writes them once a second through `writeBatch`. */
export abstract class BatchedHistoryStore implements HistoryStore {
  readonly enabled = true
  abstract readonly backend: string
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
  /** Set when the tables are missing: writes pause instead of failing forever. */
  protected paused = false

  constructor() { this.timer = setInterval(() => void this.flush(), 1_000) }

  protected abstract writeBatch(b: Batch): Promise<void>
  /** True if this error means the tables don't exist. */
  protected abstract isSchemaError(e: unknown): boolean
  abstract getCursor(): Promise<number | null>
  abstract setCursor(block: number): Promise<void>
  abstract trades(token: string, limit: number, beforeTs?: number): Promise<Trade[]>
  abstract candles(token: string, interval: Interval, limit: number, beforeTs?: number): Promise<WireCandle[]>
  abstract launches(limit: number): Promise<LaunchInfo[]>
  abstract token(token: string): Promise<LaunchInfo | null>
  abstract cleanup(tradeRetentionHours: number): Promise<void>

  trade(t: Trade) {
    if (this.tradesQ.length >= MAX_QUEUED) { this.tradesQ.shift(); metrics.inc('history_dropped') }
    this.tradesQ.push(tradeRow(t))
  }
  candle(token: string, interval: Interval, c: Candle) { this.candlesQ.set(`${token}|${interval}|${c.t}`, candleRow(token, interval, c)) }
  launch(l: LaunchInfo) { this.tokensQ.set(l.token, tokenRow(l)) }
  pool(p: PoolInfo) { this.poolsQ.set(p.pool, poolRow(p)) }
  liquidity(r: LiquidityRow) { if (this.liqQ.length < 50_000) this.liqQ.push(liqRow(r)) }
  repair(token: string, interval: Interval, bucket: number) { this.repairsQ.set(`${token}|${interval}|${bucket}`, { token, interval, bucket }) }

  flush(): Promise<void> {
    if (this.flushing || this.paused) return this.flushing ?? Promise.resolve()
    const b: Batch = {
      trades: this.tradesQ, candles: [...this.candlesQ.values()], tokens: [...this.tokensQ.values()],
      pools: [...this.poolsQ.values()], liquidity: this.liqQ, repairs: [...this.repairsQ.values()].slice(0, 50),
    }
    this.tradesQ = []; this.candlesQ.clear(); this.tokensQ.clear(); this.poolsQ.clear(); this.liqQ = []
    for (const r of b.repairs) this.repairsQ.delete(`${r.token}|${r.interval}|${r.bucket}`)
    const rows = b.trades.length + b.candles.length + b.tokens.length + b.pools.length + b.liquidity.length
    if (!rows && !b.repairs.length) return Promise.resolve()
    const t0 = Date.now()
    this.flushing = (async () => {
      try {
        await this.writeBatch(b)
        this.lastWriteMs = Date.now() - t0
        this.lastError = null
        metrics.latency('db_write', this.lastWriteMs)
        metrics.inc('db_rows_written', rows)
      } catch (e) {
        this.lastError = errMsg(e)
        metrics.inc('db_errors')
        if (this.isSchemaError(e)) {
          this.paused = true
          log.error('history tables missing — history writes paused', { backend: this.backend, error: this.lastError })
          return
        }
        log.warn('history write failed — will retry', { backend: this.backend, error: this.lastError })
        // Back in the queue (ahead of anything queued since) for the next tick.
        this.tradesQ = [...b.trades, ...this.tradesQ].slice(-MAX_QUEUED)
        for (const c of b.candles) { const k = `${c.token}|${c.interval}|${c.bucket}`; if (!this.candlesQ.has(k)) this.candlesQ.set(k, c) }
        for (const t of b.tokens) if (!this.tokensQ.has(String(t.token))) this.tokensQ.set(String(t.token), t)
        for (const p of b.pools) if (!this.poolsQ.has(String(p.pool))) this.poolsQ.set(String(p.pool), p)
        for (const r of b.repairs) this.repairsQ.set(`${r.token}|${r.interval}|${r.bucket}`, r)
      } finally {
        this.flushing = null
        metrics.set('db_queue', this.queued())
      }
    })()
    return this.flushing
  }

  close() { clearInterval(this.timer) }
  private queued() { return this.tradesQ.length + this.candlesQ.size + this.tokensQ.size + this.poolsQ.size + this.liqQ.length }
  status() { return { enabled: !this.paused, backend: this.backend, queued: this.queued(), lastWriteMs: this.lastWriteMs, lastError: this.lastError } }
}

// ── Supabase (REST) ──────────────────────────────────────────────────────

const CHUNK = 500

export class SupabaseHistoryStore extends BatchedHistoryStore {
  readonly backend = 'supabase'

  constructor() {
    super()
    if (!adminReady) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for history')
  }

  protected isSchemaError(e: unknown) {
    return e instanceof DbError && (e.status === 404 || /arcdex_mkt|PGRST20[25]|42P01/.test(e.body))
  }

  private async post(table: string, rows: Row[], prefer: string) {
    for (let i = 0; i < rows.length; i += CHUNK) await db(table, { method: 'POST', body: rows.slice(i, i + CHUNK), prefer })
  }

  protected async writeBatch(b: Batch) {
    // Tokens and pools first: trades reference them in queries.
    if (b.tokens.length) await this.post('arcdex_mkt_tokens?on_conflict=token', b.tokens, 'resolution=merge-duplicates,return=minimal')
    if (b.pools.length) await this.post('arcdex_mkt_pools?on_conflict=pool', b.pools, 'resolution=merge-duplicates,return=minimal')
    if (b.trades.length) await this.post('arcdex_mkt_trades?on_conflict=trade_id', b.trades, 'resolution=ignore-duplicates,return=minimal')
    if (b.candles.length) await this.post('arcdex_mkt_candles?on_conflict=token,interval,bucket', b.candles, 'resolution=merge-duplicates,return=minimal')
    if (b.liquidity.length) await this.post('arcdex_mkt_liquidity?on_conflict=pool,block_number', b.liquidity, 'resolution=ignore-duplicates,return=minimal')
    for (const r of b.repairs) {
      await db('rpc/arcdex_mkt_rebuild_candle', { method: 'POST', body: { p_token: r.token, p_interval: r.interval, p_bucket: iso(r.bucket * 1000) } })
    }
  }

  async getCursor() {
    try {
      const r = await db<{ block: number }[]>('arcdex_mkt_cursor?stream=eq.main&select=block')
      return r.length ? Number(r[0].block) : null
    } catch { return null }
  }
  async setCursor(block: number) {
    if (this.paused) return
    await db('arcdex_mkt_cursor?on_conflict=stream', { method: 'POST', body: [{ stream: 'main', block, updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' })
  }
  async trades(token: string, limit: number, beforeTs?: number) {
    const before = beforeTs ? `&ts=lt.${iso(beforeTs)}` : ''
    return (await db<Row[]>(`arcdex_mkt_trades?token=eq.${token}${before}&order=ts.desc,block_number.desc,log_index.desc&limit=${Math.min(500, limit)}`)).map(rowToTrade)
  }
  async candles(token: string, interval: Interval, limit: number, beforeTs?: number) {
    const before = beforeTs ? `&bucket=lt.${iso(beforeTs)}` : ''
    return (await db<Row[]>(`arcdex_mkt_candles?token=eq.${token}&interval=eq.${interval}${before}&order=bucket.desc&limit=${Math.min(1_000, limit)}`)).reverse().map(rowToCandle)
  }
  async launches(limit: number) {
    return (await db<Row[]>(`arcdex_mkt_tokens?launched_at=not.is.null&order=launched_at.desc&limit=${Math.min(500, limit)}`)).map(rowToLaunch)
  }
  async token(token: string) {
    const rows = await db<Row[]>(`arcdex_mkt_tokens?token=eq.${token}&limit=1`)
    return rows.length ? rowToLaunch(rows[0]) : null
  }
  async cleanup(tradeRetentionHours: number) {
    if (this.paused) return
    try { log.info('history cleanup', { result: await db<unknown>('rpc/arcdex_mkt_cleanup', { method: 'POST', body: { p_trade_hours: tradeRetentionHours } }) }) }
    catch (e) { log.warn('history cleanup failed', { error: errMsg(e) }) }
  }
}

/** History off (no database configured, or HISTORY_ENABLED=0). */
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
  status() { return { enabled: false, backend: 'none', queued: 0, lastWriteMs: null, lastError: null } }
}
