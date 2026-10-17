// Hyperliquid's public API, called straight from the browser (it allows any origin and rate-limits by the visitor's
// own IP, so no shared server quota can run out): POST /info for data, POST /exchange for signed actions, and one
// shared WebSocket for live books, trades, candles, prices and the user's fills and orders.
//
// Network: mainnet unless VITE_HL_NETWORK=testnet (the build's), for trying the flows with test funds.
//
// Trading is off unless VITE_HL_TRADING=on (the owner's switch, 2026-10-11: the build pack's "no live trading or
// mainnet execution by default until explicit enablement"). Off, the pages show every market, price, book, chart and
// account, but send nothing to /exchange and move no money: no orders, closes, cancels, approvals, deposits or
// withdrawals. hlExchange refuses as well, so no path can send one.

type Env = { VITE_HL_NETWORK?: string; VITE_HL_TRADING?: string }
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}

export const HL_NETWORK: 'mainnet' | 'testnet' = env.VITE_HL_NETWORK === 'testnet' ? 'testnet' : 'mainnet'
export const HL_TRADING = env.VITE_HL_TRADING === 'on'
export const HL_MAINNET = HL_NETWORK === 'mainnet'
export const HL_API = HL_MAINNET ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz'
export const HL_WS = HL_MAINNET ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws'
export const HL_CHAIN_NAME = HL_MAINNET ? 'Mainnet' : 'Testnet'
export const HL_EXPLORER = HL_MAINNET ? 'https://app.hyperliquid.xyz/explorer' : 'https://app.hyperliquid-testnet.xyz/explorer'

export class HlError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** POST /info. A throttled or failing answer is retried twice, with backoff and jitter. */
export async function hlInfo<T>(body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(400 * 2 ** attempt + Math.random() * 250)
    try {
      const r = await fetch(`${HL_API}/info`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      })
      if (r.status === 429 || r.status >= 500) { last = new HlError(`Hyperliquid answered ${r.status}`, r.status); continue }
      if (!r.ok) throw new HlError(`Hyperliquid answered ${r.status}`, r.status)
      return (await r.json()) as T
    } catch (e) {
      if (opts.signal?.aborted) throw e
      last = e
    }
  }
  throw last instanceof Error ? last : new HlError('Hyperliquid is not answering')
}

export interface ExchangeResponse<T = unknown> { status: 'ok' | 'err'; response: T }

/** POST /exchange: one signed action. Never retried (a resend could place an order twice); callers reconcile by the
 * order's client id instead. An "err" answer is thrown with the venue's own words. */
export async function hlExchange<T = unknown>(payload: { action: unknown; nonce: number; signature: unknown; vaultAddress?: string | null; expiresAfter?: number | null }): Promise<T> {
  if (!HL_TRADING) throw new HlError('Trading on Hyperliquid isn’t switched on yet.')
  const body: Record<string, unknown> = { action: payload.action, nonce: payload.nonce, signature: payload.signature }
  if (payload.vaultAddress) body.vaultAddress = payload.vaultAddress
  if (payload.expiresAfter) body.expiresAfter = payload.expiresAfter
  const r = await fetch(`${HL_API}/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const text = await r.text()
  let j: ExchangeResponse<T> | null = null
  try { j = JSON.parse(text) as ExchangeResponse<T> } catch { /* not JSON */ }
  if (!r.ok || !j) throw new HlError(j ? String(j.response) : text.slice(0, 200) || `Hyperliquid answered ${r.status}`, r.status)
  if (j.status !== 'ok') throw new HlError(String(j.response))
  return j.response
}

// ── the shared WebSocket ─────────────────────────────────────────────────

type Handler = (data: unknown) => void
interface Sub { key: string; sub: Record<string, unknown>; handlers: Set<Handler> }

const subs = new Map<string, Sub>()
let ws: WebSocket | null = null
let opening = false
let retry = 0
let pingTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(open: boolean) => void>()

const keyOf = (s: Record<string, unknown>) => JSON.stringify(Object.keys(s).sort().map(k => [k, s[k]]))

/** Which subscription a message belongs to: the channel plus what identifies it (coin, user, dex, interval). */
function routeKeys(channel: string, data: unknown): string[] {
  const d = (data ?? {}) as Record<string, unknown>
  const out: string[] = []
  for (const s of subs.values()) {
    if (s.sub.type !== channel && !(channel === 'user' && s.sub.type === 'userEvents')) continue
    if (channel === 'l2Book' || channel === 'trades' || channel === 'activeAssetCtx' || channel === 'bbo') {
      const coin = channel === 'trades' ? (Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined)?.coin : undefined) : d.coin
      if (coin !== undefined && coin !== s.sub.coin) continue
    }
    if (channel === 'candle' && (d.s !== s.sub.coin || d.i !== s.sub.interval)) continue
    if (channel === 'activeAssetData' && (d.coin !== s.sub.coin || String(d.user ?? '').toLowerCase() !== String(s.sub.user ?? '').toLowerCase())) continue
    // The core dex's mids come without a dex field; a builder dex's carry its name.
    if (channel === 'allMids' && String(d.dex ?? '') !== String(s.sub.dex ?? '')) continue
    if ((channel === 'orderUpdates' || channel === 'userFills' || channel === 'user') && 'user' in d && String(d.user).toLowerCase() !== String(s.sub.user).toLowerCase()) continue
    out.push(s.key)
  }
  return out
}

function send(msg: unknown) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }

function open() {
  if (ws || opening || typeof WebSocket === 'undefined' || subs.size === 0) return
  opening = true
  const sock = new WebSocket(HL_WS)
  sock.onopen = () => {
    opening = false
    ws = sock
    retry = 0
    for (const s of subs.values()) send({ method: 'subscribe', subscription: s.sub })
    pingTimer = setInterval(() => send({ method: 'ping' }), 45_000)
    for (const f of listeners) f(true)
  }
  sock.onmessage = ev => {
    let m: { channel?: string; data?: unknown }
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (!m.channel || m.channel === 'pong' || m.channel === 'subscriptionResponse') return
    for (const k of routeKeys(m.channel, m.data)) for (const h of subs.get(k)?.handlers ?? []) {
      try { h(m.data) } catch { /* one handler's error doesn't stop the others */ }
    }
  }
  sock.onclose = () => {
    opening = false
    if (ws === sock) ws = null
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    for (const f of listeners) f(false)
    if (subs.size === 0) return
    retry++
    setTimeout(open, Math.min(15_000, 500 * 2 ** retry) + Math.random() * 400)
  }
  sock.onerror = () => { try { sock.close() } catch { /* already closed */ } }
}

/** Subscribes to a Hyperliquid stream (shared: one socket, one subscription per distinct stream). Returns the
 * unsubscribe. Reconnects by itself and subscribes again. */
export function hlSubscribe(sub: Record<string, unknown>, handler: Handler): () => void {
  const key = keyOf(sub)
  let s = subs.get(key)
  if (!s) {
    s = { key, sub, handlers: new Set() }
    subs.set(key, s)
    send({ method: 'subscribe', subscription: sub })
  }
  s.handlers.add(handler)
  open()
  return () => {
    const cur = subs.get(key)
    if (!cur) return
    cur.handlers.delete(handler)
    if (cur.handlers.size === 0) {
      subs.delete(key)
      send({ method: 'unsubscribe', subscription: sub })
    }
  }
}

/** Socket up or down, for a live badge. */
export function onHlSocket(f: (open: boolean) => void): () => void {
  listeners.add(f)
  f(!!ws)
  return () => { listeners.delete(f) }
}
