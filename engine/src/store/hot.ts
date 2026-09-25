// Hot data: the low-latency state the engine and the API read from.
//
// Redis layout (prefix arcdex:, TTLs so nothing grows forever):
//   cursor                 string   last fully processed block        (no TTL)
//   tok:{token}            string   token state + 24h stats JSON        7 days
//   trades:{token}         list     latest 200 wire trades, newest first 2 days
//   candle:{token}:{iv}    string   last few candles of an interval     1h–3d
//   meta:{token}           string   launch / token metadata JSON       30 days
//   pool:{pool}            string   pool registry entry JSON           30 days
//   active                 zset     token → last trade time (ms)       pruned to 24h
//   launches               list     latest 500 launches, newest first  capped
//   stats                  string   market statistics                  2 min
//   subs                   string   live subscription counts           2 min
//   events                 pub/sub  every outgoing WebSocket message (multi-process fan-out)
// Redis is never the permanent record — that's the history store.
// Writes are staged in memory and flushed as one pipeline every 250ms, so
// the trade path never waits on Redis.

import type { Interval, LaunchInfo, WireTrade } from '../../../api/_marketProtocol'
import type { PoolInfo } from '../dex/pools'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { Candle } from '../market/candles'

export const P = 'arcdex:'
const DAY = 86_400
const CANDLE_TTL: Record<Interval, number> = { '1s': 3_600, '5s': 3_600, '15s': 3_600, '1m': 6 * 3_600, '5m': 6 * 3_600, '15m': 6 * 3_600, '1h': 3 * DAY, '4h': 3 * DAY, '1d': 3 * DAY }
const TRADES_KEPT = 200

export interface StoredState { state: unknown; stats: unknown }

export interface HotStore {
  readonly kind: 'redis' | 'memory'
  putState(token: string, v: StoredState): void
  pushTrade(token: string, t: WireTrade): void
  putCandles(token: string, interval: Interval, candles: Candle[]): void
  putMeta(token: string, meta: LaunchInfo): void
  pushLaunch(l: LaunchInfo): void
  putPool(p: PoolInfo): void
  putMarketStats(s: unknown): void
  putSubscriptions(s: Record<string, number>): void
  setCursor(block: number): Promise<void>
  getCursor(): Promise<number | null>
  getState(token: string): Promise<StoredState | null>
  getTrades(token: string, limit: number): Promise<WireTrade[]>
  getCandles(token: string, interval: Interval): Promise<Candle[]>
  getMeta(token: string): Promise<LaunchInfo | null>
  getLaunches(limit: number): Promise<LaunchInfo[]>
  getActive(limit: number): Promise<string[]>
  getPools(): Promise<PoolInfo[]>
  publish(message: string): void
  onEvent(cb: (message: string) => void): Promise<void>
  flush(): Promise<void>
  ping(): Promise<number>
  close(): void
}

const parse = <T>(s: unknown): T | null => { if (typeof s !== 'string') return null; try { return JSON.parse(s) as T } catch { return null } }

/** Minimal command surface — Bun's RedisClient, or a fake in tests. */
export interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>
  subscribe?(channel: string, listener: (message: string, channel: string) => void): Promise<number>
  close(): void
}

export class RedisHotStore implements HotStore {
  readonly kind = 'redis' as const
  private staged = new Map<string, string[]>() // dedupe key → one command
  private lists: string[][] = []                // commands that must all run (pushes)
  private timer: ReturnType<typeof setInterval>
  private flushing: Promise<void> | null = null

  constructor(private redis: RedisLike, private makeSubscriber?: () => RedisLike) {
    this.timer = setInterval(() => void this.flush(), 250)
  }

  private stage(key: string, cmd: string[]) { this.staged.set(key, cmd) }

  putState(token: string, v: StoredState) {
    this.stage(`tok:${token}`, ['SET', `${P}tok:${token}`, JSON.stringify(v), 'EX', String(7 * DAY)])
  }
  pushTrade(token: string, t: WireTrade) {
    this.lists.push(['LPUSH', `${P}trades:${token}`, JSON.stringify(t)])
    this.stage(`trim:${token}`, ['LTRIM', `${P}trades:${token}`, '0', String(TRADES_KEPT - 1)])
    this.stage(`tex:${token}`, ['EXPIRE', `${P}trades:${token}`, String(2 * DAY)])
    this.stage(`act:${token}`, ['ZADD', `${P}active`, String(t.ts), token])
  }
  putCandles(token: string, interval: Interval, candles: Candle[]) {
    this.stage(`c:${token}:${interval}`, ['SET', `${P}candle:${token}:${interval}`, JSON.stringify(candles), 'EX', String(CANDLE_TTL[interval])])
  }
  putMeta(token: string, meta: LaunchInfo) {
    this.stage(`m:${token}`, ['SET', `${P}meta:${token}`, JSON.stringify(meta), 'EX', String(30 * DAY)])
  }
  pushLaunch(l: LaunchInfo) {
    this.lists.push(['LPUSH', `${P}launches`, JSON.stringify(l)])
    this.stage('trim:launches', ['LTRIM', `${P}launches`, '0', '499'])
  }
  putPool(p: PoolInfo) {
    this.stage(`p:${p.pool}`, ['SET', `${P}pool:${p.pool}`, JSON.stringify(p), 'EX', String(30 * DAY)])
  }
  putMarketStats(s: unknown) { this.stage('stats', ['SET', `${P}stats`, JSON.stringify(s), 'EX', '120']) }
  putSubscriptions(s: Record<string, number>) { this.stage('subs', ['SET', `${P}subs`, JSON.stringify(s), 'EX', '120']) }

  async setCursor(block: number) { await this.redis.send('SET', [`${P}cursor`, String(block)]) }
  async getCursor() {
    const v = await this.redis.send('GET', [`${P}cursor`])
    const n = v === null || v === undefined ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
  }
  async getState(token: string) { return parse<StoredState>(await this.redis.send('GET', [`${P}tok:${token}`])) }
  async getTrades(token: string, limit: number) {
    const r = (await this.redis.send('LRANGE', [`${P}trades:${token}`, '0', String(Math.min(TRADES_KEPT, limit) - 1)])) as string[] | null
    return (r ?? []).map(s => parse<WireTrade>(s)).filter((x): x is WireTrade => x !== null)
  }
  async getCandles(token: string, interval: Interval) { return parse<Candle[]>(await this.redis.send('GET', [`${P}candle:${token}:${interval}`])) ?? [] }
  async getMeta(token: string) { return parse<LaunchInfo>(await this.redis.send('GET', [`${P}meta:${token}`])) }
  async getLaunches(limit: number) {
    const r = (await this.redis.send('LRANGE', [`${P}launches`, '0', String(Math.min(500, limit) - 1)])) as string[] | null
    return (r ?? []).map(s => parse<LaunchInfo>(s)).filter((x): x is LaunchInfo => x !== null)
  }
  async getActive(limit: number) {
    return ((await this.redis.send('ZREVRANGE', [`${P}active`, '0', String(limit - 1)])) as string[] | null) ?? []
  }
  async getPools() {
    const out: PoolInfo[] = []
    let cursor = '0'
    do {
      const [next, keys] = (await this.redis.send('SCAN', [cursor, 'MATCH', `${P}pool:*`, 'COUNT', '1000'])) as [string, string[]]
      cursor = next
      if (keys.length) {
        const vals = (await this.redis.send('MGET', keys)) as (string | null)[]
        for (const v of vals) { const p = parse<PoolInfo>(v); if (p) out.push(p) }
      }
    } while (cursor !== '0')
    return out
  }

  // Sent at once (not batched): gateways relay it straight to browsers.
  publish(message: string) {
    this.redis.send('PUBLISH', [`${P}events`, message]).catch(() => metrics.inc('redis_publish_errors'))
  }

  async onEvent(cb: (message: string) => void) {
    // A subscribed connection can't run other commands — use its own.
    const sub = this.makeSubscriber?.()
    if (!sub?.subscribe) throw new Error('pub/sub not available')
    await sub.subscribe(`${P}events`, m => cb(m))
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    const cmds = [...this.lists, ...this.staged.values()]
    // Prune the active set to the last 24h now and then.
    if (Math.random() < 0.01) cmds.push(['ZREMRANGEBYSCORE', `${P}active`, '-inf', String(Date.now() - DAY * 1000)])
    this.lists = []
    this.staged.clear()
    if (!cmds.length) return Promise.resolve()
    const t0 = Date.now()
    // Bun's client pipelines commands issued together.
    this.flushing = Promise.all(cmds.map(([c, ...a]) => this.redis.send(c, a)))
      .then(() => { metrics.latency('redis_flush', Date.now() - t0); metrics.inc('redis_commands', cmds.length) })
      .catch(e => { metrics.inc('redis_errors'); log.warn('redis flush failed', { error: errMsg(e), commands: cmds.length }) })
      .finally(() => { this.flushing = null })
    return this.flushing
  }

  async ping() {
    const t0 = Date.now()
    await this.redis.send('PING', [])
    const ms = Date.now() - t0
    metrics.set('redis_latency_ms', ms)
    return ms
  }

  close() { clearInterval(this.timer); this.redis.close() }
}

/** In-process hot store: automated tests, and single-process dev runs
 * without Redis (state is lost on restart — the engine then replays). */
export class MemoryHotStore implements HotStore {
  readonly kind = 'memory' as const
  cursor: number | null = null
  states = new Map<string, StoredState>()
  trades = new Map<string, WireTrade[]>()
  candles = new Map<string, Candle[]>()
  metas = new Map<string, LaunchInfo>()
  launches: LaunchInfo[] = []
  pools = new Map<string, PoolInfo>()
  active = new Map<string, number>()
  stats: unknown = null
  subs: Record<string, number> = {}
  private listeners: ((m: string) => void)[] = []

  putState(token: string, v: StoredState) { this.states.set(token, v) }
  pushTrade(token: string, t: WireTrade) {
    const l = this.trades.get(token) ?? []
    l.unshift(t)
    if (l.length > TRADES_KEPT) l.length = TRADES_KEPT
    this.trades.set(token, l)
    this.active.set(token, t.ts)
  }
  putCandles(token: string, interval: Interval, candles: Candle[]) { this.candles.set(`${token}:${interval}`, candles.map(c => ({ ...c }))) }
  putMeta(token: string, meta: LaunchInfo) { this.metas.set(token, meta) }
  pushLaunch(l: LaunchInfo) { this.launches.unshift(l); if (this.launches.length > 500) this.launches.length = 500 }
  putPool(p: PoolInfo) { this.pools.set(p.pool, p) }
  putMarketStats(s: unknown) { this.stats = s }
  putSubscriptions(s: Record<string, number>) { this.subs = s }
  async setCursor(block: number) { this.cursor = block }
  async getCursor() { return this.cursor }
  async getState(token: string) { return this.states.get(token) ?? null }
  async getTrades(token: string, limit: number) { return (this.trades.get(token) ?? []).slice(0, limit) }
  async getCandles(token: string, interval: Interval) { return this.candles.get(`${token}:${interval}`) ?? [] }
  async getMeta(token: string) { return this.metas.get(token) ?? null }
  async getLaunches(limit: number) { return this.launches.slice(0, limit) }
  async getActive(limit: number) { return [...this.active].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t) }
  async getPools() { return [...this.pools.values()] }
  publish(message: string) { this.listeners.forEach(l => l(message)) }
  async onEvent(cb: (m: string) => void) { this.listeners.push(cb) }
  async flush() {}
  async ping() { return 0 }
  close() {}
}
