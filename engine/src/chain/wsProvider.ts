// Live Arc data over WebSocket JSON-RPC (eth_subscribe).
//
// - One socket at a time; subscriptions are durable: after a reconnect every
//   one is re-sent and re-mapped to its new server id.
// - Reconnect with exponential backoff + jitter (0.5s → 30s), rotating
//   through ARC_WS_URLS so a dead provider fails over to the next.
// - Health: Arc makes a block every ~0.5s, so newHeads is the heartbeat. No
//   head for STALE_HEAD_MS = a stale stream (a socket can stay "open" while
//   delivering nothing) → drop it and move to the next provider.
// - Gaps are not this layer's job: ChainStream notices the cursor falling
//   behind and backfills from getLogs.

import type { RawLog } from '../../../api/_arcLogs'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import { safeHost } from './http'

export interface LogFilterWs { address?: string | string[]; topics?: (string | string[] | null)[] }
export interface Head { number: number; timestamp: number; hash: string }
export type WsStatus = 'connecting' | 'live' | 'stale' | 'down'

interface Sub {
  kind: 'logs' | 'newHeads'
  filter?: LogFilterWs
  onLog?: (l: RawLog) => void
  onHead?: (h: Head) => void
  serverId?: string
}

type WsLike = {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type WsFactory = (url: string) => WsLike

export class WsProvider {
  private ws: WsLike | null = null
  private idx = 0
  private backoff = 500
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private subs = new Set<Sub>()
  private byServerId = new Map<string, Sub>()
  private stopped = true
  private everConnected = false
  private watchdog: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  lastHeadAt = 0
  lastHead: Head | null = null
  status: WsStatus = 'down'
  /** Called after a reconnect has restored the subscriptions (not on the first connect). */
  onReconnect: (() => void) | null = null

  constructor(private urls: string[], private opts: { staleHeadMs: number; factory?: WsFactory }) {
    if (!urls.length) throw new Error('WsProvider needs at least one endpoint')
  }

  get provider() { return safeHost(this.urls[this.idx % this.urls.length]) }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
    this.watchdog = setInterval(() => this.checkStale(), 1_000)
  }

  stop() {
    this.stopped = true
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close()
    this.ws = null
    this.setStatus('down')
  }

  subscribeLogs(filter: LogFilterWs, onLog: (l: RawLog) => void): () => void {
    return this.add({ kind: 'logs', filter, onLog })
  }

  subscribeHeads(onHead: (h: Head) => void): () => void {
    return this.add({ kind: 'newHeads', onHead })
  }

  private add(sub: Sub): () => void {
    this.subs.add(sub)
    if (this.ws?.readyState === 1) void this.sendSubscribe(sub)
    return () => {
      this.subs.delete(sub)
      if (sub.serverId) {
        this.byServerId.delete(sub.serverId)
        if (this.ws?.readyState === 1) void this.request('eth_unsubscribe', [sub.serverId]).catch(() => {})
      }
    }
  }

  private setStatus(s: WsStatus) {
    if (this.status === s) return
    this.status = s
    metrics.set('chain_ws_status', s)
    log.info('chain websocket status', { status: s, provider: this.provider })
  }

  private connect() {
    if (this.stopped) return
    const url = this.urls[this.idx % this.urls.length]
    this.setStatus('connecting')
    let ws: WsLike
    try {
      ws = this.opts.factory ? this.opts.factory(url) : (new WebSocket(url) as unknown as WsLike)
    } catch (e) {
      log.warn('chain websocket failed to open', { provider: safeHost(url), error: errMsg(e) })
      this.scheduleReconnect(true)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.byServerId.clear()
      this.lastHeadAt = Date.now() // grace period until the first head
      void Promise.all([...this.subs].map(s => this.sendSubscribe(s))).then(() => {
        if (this.ws !== ws) return
        const wasReconnect = this.everConnected
        this.everConnected = true
        if (wasReconnect) { metrics.inc('chain_reconnects'); this.onReconnect?.() }
      })
    }
    ws.onmessage = ev => { if (this.ws === ws) this.handle(ev.data) }
    ws.onerror = () => { metrics.inc('chain_ws_errors') }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')) }
      this.pending.clear()
      if (!this.stopped) { this.setStatus('down'); this.scheduleReconnect(true) }
    }
  }

  private scheduleReconnect(rotate: boolean) {
    if (this.stopped || this.retry) return
    if (rotate) this.idx++
    const delay = Math.min(30_000, this.backoff) * (0.8 + Math.random() * 0.4)
    this.backoff = Math.min(30_000, this.backoff * 2)
    this.retry = setTimeout(() => { this.retry = null; this.connect() }, delay)
  }

  private checkStale() {
    if (this.stopped || !this.ws || this.ws.readyState !== 1) return
    if (Date.now() - this.lastHeadAt > this.opts.staleHeadMs) {
      metrics.inc('chain_stale')
      log.warn('chain websocket stale — failing over', { provider: this.provider, sinceHeadMs: Date.now() - this.lastHeadAt })
      this.setStatus('stale')
      const ws = this.ws
      this.ws = null
      ws.close()
      this.scheduleReconnect(true)
    }
  }

  private async sendSubscribe(sub: Sub) {
    const params = sub.kind === 'newHeads' ? ['newHeads'] : ['logs', sub.filter ?? {}]
    const ws = this.ws
    // Arc's public endpoint intermittently answers eth_subscribe with
    // "internal error" (the same filter succeeds on the next try): retry a
    // few times before giving up on the connection.
    for (let attempt = 1; ; attempt++) {
      try {
        const id = (await this.request('eth_subscribe', params)) as string
        if (!this.subs.has(sub)) { void this.request('eth_unsubscribe', [id]).catch(() => {}); return }
        sub.serverId = id
        this.byServerId.set(id, sub)
        return
      } catch (e) {
        metrics.inc('chain_subscribe_errors')
        if (this.ws !== ws) return // socket replaced meanwhile
        if (attempt < 4) { await new Promise(r => setTimeout(r, 250 * attempt)); continue }
        log.warn('eth_subscribe failed — dropping provider', { provider: this.provider, kind: sub.kind, error: errMsg(e) })
        // A provider that won't subscribe is as good as down.
        this.ws?.close()
        return
      }
    }
  }

  private request(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private handle(data: unknown) {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { subscription?: string; result?: unknown } }
    try { msg = JSON.parse(String(data)) } catch { metrics.inc('chain_bad_messages'); return }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'))
      else p.resolve(msg.result)
      return
    }
    if (msg.method !== 'eth_subscription' || !msg.params?.subscription) return
    const sub = this.byServerId.get(msg.params.subscription)
    if (!sub) return
    const r = msg.params.result as Record<string, unknown> | undefined
    if (!r) return
    if (sub.kind === 'newHeads') {
      const number = parseInt(String(r.number), 16)
      if (!Number.isFinite(number)) return
      const head = { number, timestamp: parseInt(String(r.timestamp), 16) * 1000, hash: String(r.hash) }
      if (!this.lastHead || head.number > this.lastHead.number) this.lastHead = head
      this.lastHeadAt = Date.now()
      this.backoff = 500 // healthy again
      if (this.status !== 'live') this.setStatus('live')
      metrics.set('chain_last_head', head.number)
      sub.onHead?.(head)
    } else {
      sub.onLog?.(r as unknown as RawLog)
    }
  }
}
