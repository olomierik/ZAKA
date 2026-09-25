// Client for the ARCDEX market engine (engine/): one shared WebSocket for
// the whole app, plus the engine's REST history endpoints.
//
// Enabled when VITE_ARCDEX_WS_URL is set at build time (e.g.
// wss://api.arcdex.online/ws). Without it — or while the engine is
// unreachable — pages use their direct-from-chain path (api/poolSwaps.ts)
// instead, so nothing depends on the engine being up.
//
// Subscriptions are reference-counted: many components can listen to the
// same channel over one subscription. After a reconnect every active
// subscription is re-sent, and the engine answers each with a fresh snapshot.

import { useSyncExternalStore } from 'react'
import type { Interval, LaunchInfo, ServerMessage, TokenStats, WireCandle, WireTrade } from '../../../api/_marketProtocol'

const WS_URL = (import.meta.env.VITE_ARCDEX_WS_URL as string | undefined) || undefined
const API_URL = ((import.meta.env.VITE_ARCDEX_API_URL as string | undefined) || (WS_URL ? WS_URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') : '')).replace(/\/$/, '')

export const engineEnabled = Boolean(WS_URL)

type Sub = { channel: 'token' | 'candles' | 'new_tokens' | 'market'; token?: string; interval?: Interval }
export type EngineStatus = 'off' | 'connecting' | 'open' | 'closed'

const keyOf = (s: Sub) => s.channel === 'candles' ? `candles:${s.token}:${s.interval}` : s.token ? `${s.channel}:${s.token}` : s.channel

class MarketStream {
  status: EngineStatus = engineEnabled ? 'closed' : 'off'
  private ws: WebSocket | null = null
  private subs = new Map<string, { sub: Sub; handlers: Set<(m: ServerMessage) => void> }>()
  private statusSubs = new Set<() => void>()
  private backoff = 500
  private retry: ReturnType<typeof setTimeout> | null = null
  private idle: ReturnType<typeof setTimeout> | null = null

  subscribe(sub: Sub, handler: (m: ServerMessage) => void): () => void {
    if (!engineEnabled) return () => {}
    const s: Sub = { ...sub, token: sub.token?.toLowerCase() }
    const k = keyOf(s)
    let e = this.subs.get(k)
    if (!e) {
      e = { sub: s, handlers: new Set() }
      this.subs.set(k, e)
      this.send({ action: 'subscribe', ...s })
    }
    e.handlers.add(handler)
    this.ensure()
    return () => {
      const cur = this.subs.get(k)
      if (!cur) return
      cur.handlers.delete(handler)
      if (cur.handlers.size === 0) {
        this.subs.delete(k)
        this.send({ action: 'unsubscribe', ...s })
        // Close the socket a little after the last listener leaves.
        if (!this.subs.size) { if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.subs.size) this.ws?.close() }, 30_000) }
      }
    }
  }

  onStatus(cb: () => void) { this.statusSubs.add(cb); return () => { this.statusSubs.delete(cb) } }

  private setStatus(s: EngineStatus) { if (this.status !== s) { this.status = s; this.statusSubs.forEach(f => f()) } }

  private send(msg: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)) }

  private ensure() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    if (this.ws || this.retry || !WS_URL) return
    this.setStatus('connecting')
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 500
      this.setStatus('open')
      for (const { sub } of this.subs.values()) this.send({ action: 'subscribe', ...sub })
    }
    ws.onmessage = ev => {
      let m: ServerMessage
      try { m = JSON.parse(String(ev.data)) as ServerMessage } catch { return }
      const k = 'k' in m ? m.k : undefined
      const target =
        m.t === 'CANDLE_UPDATE' ? `candles:${m.k}:${m.i}`
        : m.t === 'NEW_TOKEN' ? 'new_tokens'
        : m.t === 'TICKS' ? 'market'
        : k ? `token:${k}` : null
      if (target) this.subs.get(target)?.handlers.forEach(h => h(m))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.setStatus('closed')
      if (!this.subs.size) return
      const delay = this.backoff * (0.8 + Math.random() * 0.4)
      this.backoff = Math.min(15_000, this.backoff * 2)
      this.retry = setTimeout(() => { this.retry = null; this.ensure() }, delay)
    }
    ws.onerror = () => ws.close()
  }
}

export const marketStream = new MarketStream()

/** The engine connection's status, for components that switch data sources. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(cb => marketStream.onStatus(cb), () => marketStream.status)
}

// ── REST ─────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(6_000) })
  if (!res.ok) throw new Error(`engine ${path.split('?')[0]} → ${res.status}`)
  return res.json() as Promise<T>
}

export const getEngineTrades = (token: string, limit = 200) =>
  get<{ trades: WireTrade[] }>(`/v1/tokens/${token.toLowerCase()}/trades?limit=${limit}`).then(r => r.trades)
export const getEngineCandles = (token: string, interval: Interval, limit = 500) =>
  get<{ candles: WireCandle[] }>(`/v1/tokens/${token.toLowerCase()}/candles?interval=${interval}&limit=${limit}`).then(r => r.candles)
export const getEngineToken = (token: string) =>
  get<{ token: string; meta: LaunchInfo | null; stats: TokenStats | null }>(`/v1/tokens/${token.toLowerCase()}`)
export const getNewTokens = (limit = 100) =>
  get<{ launches: LaunchInfo[] }>(`/v1/tokens/new?limit=${limit}`).then(r => r.launches)

// ── recent launches (shared: Terminal, search) ───────────────────────────
let launches: LaunchInfo[] = []
const launchListeners = new Set<() => void>()
let launchesStarted = false
function startLaunches() {
  if (launchesStarted || !engineEnabled) return
  launchesStarted = true
  const merge = (ls: LaunchInfo[]) => {
    const seen = new Set(launches.map(l => l.token))
    launches = [...ls.filter(l => !seen.has(l.token)), ...launches].sort((a, b) => b.timestamp - a.timestamp).slice(0, 500)
    launchListeners.forEach(f => f())
  }
  void getNewTokens(200).then(merge).catch(() => {})
  marketStream.subscribe({ channel: 'new_tokens' }, m => { if (m.t === 'NEW_TOKEN') merge([m.d]) })
}

/** Launches the engine has detected, newest first (empty without the engine). */
export function useRecentLaunches(): LaunchInfo[] {
  return useSyncExternalStore(cb => { startLaunches(); launchListeners.add(cb); return () => { launchListeners.delete(cb) } }, () => launches)
}
