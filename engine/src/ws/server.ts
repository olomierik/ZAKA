// ARCDEX market API: WebSocket (wss://api.arcdex.online/ws) + REST + health.
//
// WebSocket: clients subscribe to channels (see api/_marketProtocol.ts);
// every message is validated (shape, channel, 0x address, interval) and
// rate-limited per connection; connections are capped per IP; browser
// origins must be allowlisted. Delivery uses Bun's native pub/sub topics,
// and a message is only serialized when a topic has subscribers.
//
// REST (history + snapshots, CORS-limited to the allowed origins):
//   GET /v1/tokens/new?limit=50
//   GET /v1/tokens/:token
//   GET /v1/tokens/:token/trades?limit=100&before=<ms>
//   GET /v1/tokens/:token/candles?interval=1m&limit=500&before=<ms>
//   GET /v1/market?limit=100
//   GET /health           summary (200 ok/degraded, 503 down)
//   GET /metrics          full metrics (Bearer METRICS_TOKEN when set)

import type { Server, ServerWebSocket } from 'bun'
import {
  INTERVALS, isInterval, parseClientMessage, toWire, topicOf,
  type Interval, type LaunchInfo, type ServerMessage, type TokenStats, type WireCandle, type WireTrade,
} from '../../../api/_marketProtocol'
import type { Config } from '../config'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { MarketEngine, Publisher } from '../market/engine'
import type { HistoryStore } from '../store/history'
import type { HotStore } from '../store/hot'

interface Conn { id: number; ip: string; subs: Set<string>; allowance: number; last: number }

/** Reads for snapshots and REST: the in-process engine when this process
 * ingests, otherwise the hot store (gateway role); history for older data. */
export class DataApi {
  constructor(private engine: MarketEngine | null, private hot: HotStore, private history: HistoryStore) {}

  /** The engine starts after the server (so /health answers during warm-up). */
  attachEngine(e: MarketEngine) { this.engine = e }

  async tokenSnapshot(token: string, limit = 50): Promise<{ stats: TokenStats | null; trades: WireTrade[] }> {
    if (this.engine?.tokens.has(token)) return { stats: this.engine.statsOf(token), trades: this.engine.recentTrades(token, limit) }
    const [s, trades] = await Promise.all([this.hot.getState(token), this.hot.getTrades(token, limit)])
    return { stats: (s?.stats as TokenStats | undefined) ?? null, trades }
  }

  async currentCandle(token: string, interval: Interval): Promise<WireCandle | null> {
    if (this.engine) return this.engine.currentCandle(token, interval)
    const c = await this.hot.getCandles(token, interval)
    const last = c[c.length - 1]
    return last ? [last.t, last.o, last.h, last.l, last.c, last.v, last.n] : null
  }

  async meta(token: string): Promise<LaunchInfo | null> {
    return this.engine?.metas.get(token) ?? (await this.hot.getMeta(token)) ?? (await this.history.token(token).catch(() => null))
  }

  async trades(token: string, limit: number, before?: number): Promise<WireTrade[]> {
    if (!before) {
      const recent = this.engine?.recentTrades(token, limit) ?? await this.hot.getTrades(token, limit)
      if (recent.length >= limit) return recent
      // Top up from history, deduped by id.
      const older = await this.history.trades(token, limit, recent.length ? recent[recent.length - 1].ts : undefined).catch(() => [])
      const seen = new Set(recent.map(t => t.id))
      return [...recent, ...older.map(toWire).filter(t => !seen.has(t.id))].slice(0, limit)
    }
    return (await this.history.trades(token, limit, before).catch(() => [])).map(toWire)
  }

  async candles(token: string, interval: Interval, limit: number, before?: number): Promise<WireCandle[]> {
    const stored = await this.history.candles(token, interval, limit, before).catch(() => [] as WireCandle[])
    if (before) return stored
    // Recent candles (incl. the one being built) from memory win over stored ones.
    const live = this.engine ? this.engine.recentCandles(token, interval) : (await this.hot.getCandles(token, interval)).map(c => [c.t, c.o, c.h, c.l, c.c, c.v, c.n] as WireCandle)
    const byT = new Map<number, WireCandle>()
    for (const c of stored) byT.set(c[0], c)
    for (const c of live) byT.set(c[0], c)
    return [...byT.values()].sort((a, b) => a[0] - b[0]).slice(-limit)
  }

  async launches(limit: number): Promise<LaunchInfo[]> {
    const hot = await this.hot.getLaunches(limit)
    let list = hot
    if (hot.length < Math.min(limit, 20)) {
      const stored = await this.history.launches(limit).catch(() => [])
      const seen = new Set(hot.map(l => l.token))
      list = [...hot, ...stored.filter(l => !seen.has(l.token))].slice(0, limit)
    }
    // With their current price and market cap, when this process tracks them.
    return list.map(l => { const s = this.engine?.statsOf(l.token); return s ? { ...l, priceUsd: s.priceUsd, marketCapUsd: s.marketCapUsd } : l })
  }

  async market(limit: number) {
    if (this.engine) return this.engine.market(limit)
    const tokens = await this.hot.getActive(limit)
    const rows = await Promise.all(tokens.map(async token => {
      const [s, meta] = await Promise.all([this.hot.getState(token), this.hot.getMeta(token)])
      return { token, stats: (s?.stats as TokenStats | undefined) ?? null, meta }
    }))
    return rows.filter(r => r.stats?.priceUsd != null)
  }
}

class Buckets {
  private m = new Map<string, { n: number; at: number }>()
  constructor(private perSec: number, private burst = perSec * 2) {}
  take(key: string): boolean {
    const now = Date.now()
    const b = this.m.get(key) ?? { n: this.burst, at: now }
    b.n = Math.min(this.burst, b.n + ((now - b.at) / 1000) * this.perSec)
    b.at = now
    if (b.n < 1) { this.m.set(key, b); return false }
    b.n -= 1
    this.m.set(key, b)
    if (this.m.size > 50_000) this.m.clear()
    return true
  }
}

export interface ServerDeps {
  cfg: Config
  api: DataApi
  health: () => { status: 'ok' | 'degraded' | 'down'; [k: string]: unknown }
}

export function startServer({ cfg, api, health }: ServerDeps) {
  const counts = new Map<string, number>()
  const perIp = new Map<string, number>()
  const rest = new Buckets(cfg.restRatePerSec)
  let nextId = 1
  let clients = 0
  const trustProxy = process.env.TRUST_PROXY === '1'

  const cors = (req: Request): Record<string, string> => {
    const o = req.headers.get('origin')
    return o && cfg.allowedOrigins.includes(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin' } : {}
  }
  const json = (req: Request, status: number, body: unknown, cache = 'no-store') =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...cors(req) } })
  const ipOf = (req: Request, server: Server<Conn>) => {
    if (trustProxy) {
      const f = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      if (f) return f
    }
    return server.requestIP(req)?.address ?? 'unknown'
  }
  const send = (ws: ServerWebSocket<Conn>, m: ServerMessage) => ws.send(JSON.stringify(m))

  const server = Bun.serve<Conn>({
    port: cfg.port,
    async fetch(req, server) {
      const url = new URL(req.url)
      const ip = ipOf(req, server)
      if (url.pathname === '/ws') {
        const origin = req.headers.get('origin')
        // Browsers always send Origin; only allowlisted sites may connect.
        if (origin && !cfg.allowedOrigins.includes(origin)) { metrics.inc('ws_rejected_origin'); return new Response('origin not allowed', { status: 403 }) }
        if ((perIp.get(ip) ?? 0) >= cfg.maxConnsPerIp) { metrics.inc('ws_rejected_ip_limit'); return new Response('too many connections', { status: 429 }) }
        const ok = server.upgrade(req, { data: { id: nextId++, ip, subs: new Set(), allowance: cfg.maxMsgsPerSec, last: Date.now() } })
        return ok ? undefined : new Response('websocket upgrade expected', { status: 400 })
      }
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' } })
      if (req.method !== 'GET') return json(req, 405, { error: 'method not allowed' })
      if (url.pathname === '/health') { const h = health(); return json(req, h.status === 'down' ? 503 : 200, h) }
      if (url.pathname === '/metrics') {
        if (cfg.metricsToken && req.headers.get('authorization') !== `Bearer ${cfg.metricsToken}`) return json(req, 401, { error: 'unauthorized' })
        return json(req, 200, { ...metrics.snapshot(), ws: { clients, topics: counts.size } })
      }
      if (!rest.take(ip)) { metrics.inc('rest_rate_limited'); return json(req, 429, { error: 'rate limited' }) }
      const limit = (d: number, max: number) => Math.max(1, Math.min(max, Number(url.searchParams.get('limit')) || d))
      const before = Number(url.searchParams.get('before')) || undefined
      try {
        if (url.pathname === '/v1/tokens/new') return json(req, 200, { launches: await api.launches(limit(50, 500)) }, 'public, max-age=1')
        if (url.pathname === '/v1/market') return json(req, 200, { tokens: await api.market(limit(100, 1_000)) }, 'public, max-age=2')
        const m = /^\/v1\/tokens\/(0x[0-9a-fA-F]{40})(\/trades|\/candles)?$/.exec(url.pathname)
        if (m) {
          const token = m[1].toLowerCase()
          if (!m[2]) {
            const [snap, meta] = await Promise.all([api.tokenSnapshot(token, 0), api.meta(token)])
            return json(req, 200, { token, meta, stats: snap.stats }, 'public, max-age=1')
          }
          if (m[2] === '/trades') return json(req, 200, { trades: await api.trades(token, limit(100, 500), before) }, 'public, max-age=1')
          const iv = url.searchParams.get('interval') ?? '1m'
          if (!isInterval(iv)) return json(req, 400, { error: 'bad interval', intervals: Object.keys(INTERVALS) })
          return json(req, 200, { interval: iv, candles: await api.candles(token, iv, limit(500, 1_000), before) }, 'public, max-age=1')
        }
        return json(req, 404, { error: 'not found' })
      } catch (e) {
        metrics.inc('rest_errors')
        log.warn('rest error', { path: url.pathname, error: errMsg(e) })
        return json(req, 500, { error: 'internal error' })
      }
    },
    websocket: {
      maxPayloadLength: 2_048,
      idleTimeout: 120,
      sendPings: true,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        clients++
        perIp.set(ws.data.ip, (perIp.get(ws.data.ip) ?? 0) + 1)
        metrics.set('ws_clients', clients)
      },
      async message(ws, raw) {
        // Token bucket per connection.
        const now = Date.now()
        ws.data.allowance = Math.min(cfg.maxMsgsPerSec, ws.data.allowance + ((now - ws.data.last) / 1000) * cfg.maxMsgsPerSec)
        ws.data.last = now
        if (ws.data.allowance < 1) { metrics.inc('ws_rate_limited'); send(ws, { t: 'ERROR', d: { code: 'rate_limited' } }); return }
        ws.data.allowance -= 1
        const m = parseClientMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
        if ('error' in m) { metrics.inc('ws_bad_messages'); send(ws, { t: 'ERROR', d: { code: m.error } }); return }
        if (m.action === 'ping') { send(ws, { t: 'PONG', ts: now }); return }
        const topic = topicOf({ channel: m.channel!, token: m.token, interval: m.interval })
        if (m.action === 'unsubscribe') {
          if (ws.data.subs.delete(topic)) { ws.unsubscribe(topic); counts.set(topic, (counts.get(topic) ?? 1) - 1); if (!counts.get(topic)) counts.delete(topic) }
          send(ws, { t: 'UNSUBSCRIBED', c: topic })
          return
        }
        if (!ws.data.subs.has(topic)) {
          if (ws.data.subs.size >= cfg.maxSubsPerConn) { send(ws, { t: 'ERROR', d: { code: 'too_many_subscriptions' } }); return }
          ws.data.subs.add(topic)
          ws.subscribe(topic)
          counts.set(topic, (counts.get(topic) ?? 0) + 1)
          metrics.inc('ws_subscriptions')
        }
        send(ws, { t: 'SUBSCRIBED', c: topic })
        // A snapshot right away, so the client has no gap to wait out.
        try {
          if (m.channel === 'token') send(ws, { t: 'SNAPSHOT', k: m.token!, d: await api.tokenSnapshot(m.token!) })
          if (m.channel === 'candles') {
            const c = await api.currentCandle(m.token!, m.interval!)
            if (c) send(ws, { t: 'CANDLE_UPDATE', k: m.token!, i: m.interval!, d: c })
          }
        } catch (e) { log.debug('snapshot failed', { error: errMsg(e) }) }
      },
      close(ws) {
        clients--
        const n = (perIp.get(ws.data.ip) ?? 1) - 1
        if (n > 0) perIp.set(ws.data.ip, n); else perIp.delete(ws.data.ip)
        for (const topic of ws.data.subs) { counts.set(topic, (counts.get(topic) ?? 1) - 1); if (!counts.get(topic)) counts.delete(topic) }
        metrics.set('ws_clients', clients)
      },
    },
  })

  const publisher: Publisher = {
    wants: topic => (counts.get(topic) ?? 0) > 0,
    publish(topics, msg) {
      let s: string | null = null
      for (const t of topics) {
        if (!counts.get(t)) continue
        s ??= JSON.stringify(msg)
        server.publish(t, s)
        metrics.inc('ws_messages_out')
      }
    },
  }

  log.info('market api listening', { port: server.port })
  return {
    server,
    publisher,
    /** Relay a message published by another process (gateway role). */
    relay(raw: string) {
      try {
        const { topics, msg } = JSON.parse(raw) as { topics: string[]; msg: ServerMessage }
        if (Array.isArray(topics)) publisher.publish(topics.filter(t => typeof t === 'string'), msg)
      } catch { metrics.inc('relay_bad_messages') }
    },
    subscriptionCounts: () => Object.fromEntries(counts),
    clients: () => clients,
    stop: () => server.stop(true),
  }
}

