// Alerts that reach this device with ARCDEX closed (the build pack's Phase 5): the market engine watches them and sends
// a web push (engine/src/alerts), which public/sw.js shows as a notification.
//
// Turning them on asks the browser's permission, subscribes this browser to the engine's public key, and hands the
// engine the alerts set here: every waiting Hyperliquid price alert (hl/alerts.ts, mirrored on each change) and the
// Arc coin alerts set on coin pages (price levels, and single trades of at least an amount). The engine gives this
// browser an id and a secret token, kept here; nothing else about the visitor is sent. The words are written here, in the
// visitor's language; the engine only fills in a trade's dollars and side.
//
// Behind the `pushAlerts` flag (on; /admin can turn it off). Without the engine, or on a browser without push (iOS
// Safari outside a home-screen app, some private windows), the page says so and the in-page alerts work as before.

import { useSyncExternalStore } from 'react'
import { engineApiUrl } from '../api/marketStream'
import { flag } from './flags'

export interface CoinAlert {
  id: string
  kind: 'price' | 'activity'
  venue: 'arc'
  /** The coin's address (lower case). */
  market: string
  symbol: string
  dir?: 'above' | 'below'
  px?: number
  minUsd?: number
  side?: 'any' | 'buy' | 'sell'
  title: string
  body: string
  url: string
  buyWord?: string
  sellWord?: string
  created: number
  firedAt?: number | null
  lastAt?: number | null
}

/** What the engine takes for one alert (engine/src/alerts/service.ts cleanAlert). */
export type ServerAlertIn = Omit<CoinAlert, 'symbol' | 'created' | 'firedAt' | 'lastAt' | 'venue'> & { venue: 'arc' | 'hl' }

interface Sub { id: string; token: string; endpoint: string }
interface State { sub: Sub | null; coin: CoinAlert[]; error: string | null; busy: boolean }

const SUB = 'arcdex:push:v1'
const COIN = 'arcdex:push-alerts:v1'
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
const write = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage blocked: this visit only */ } }

let state: State = { sub: read<Sub | null>(SUB, null), coin: read<CoinAlert[]>(COIN, []), error: null, busy: false }
const listeners = new Set<() => void>()
const set = (p: Partial<State>) => {
  state = { ...state, ...p }
  if ('sub' in p) write(SUB, state.sub)
  if ('coin' in p) write(COIN, state.coin)
  for (const f of listeners) f()
}
export const usePush = () => useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f) } }, () => state, () => state)
export const pushState = () => state

/** Whether this browser can get alerts by push here; why not otherwise. */
export function pushSupport(): 'ok' | 'no-engine' | 'off' | 'unsupported' | 'blocked' {
  if (!engineApiUrl) return 'no-engine'
  if (!flag('pushAlerts')) return 'off'
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  return 'ok'
}

async function post<T>(path: string, body: unknown): Promise<T> {
  // text/plain: a simple request (no preflight), as the engine's routes expect from the site's pages.
  const r = await fetch(`${engineApiUrl}/v1/push/${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  const j = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw Object.assign(new Error(j?.error ?? `the engine answered ${r.status}`), { status: r.status })
  return j as T
}

const keyBytes = (b64u: string) => { const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)) }

/** Every alert the engine should watch: the coin alerts, and the Hyperliquid ones still waiting. */
let hlSource: () => ServerAlertIn[] = () => []
export function setHlAlertSource(f: () => ServerAlertIn[]) { hlSource = f }
const toServer = (a: CoinAlert): ServerAlertIn => {
  const { symbol: _s, created: _c, firedAt: _f, lastAt: _l, ...rest } = a
  return rest
}
/** What the engine is handed: the coin alerts not yet reached, then the waiting Hyperliquid ones; 50 at most. */
export const outgoing = (): ServerAlertIn[] => [...state.coin.filter(a => !(a.kind === 'price' && a.firedAt)).map(toServer), ...hlSource()].slice(0, 50)
const wanted = outgoing

/** A Hyperliquid price alert (hl/alerts.ts) as the engine takes it, with its words. */
export const hlServerAlert = (a: { id: string; coin: string; dir: 'above' | 'below'; px: number }, title: string, body: string): ServerAlertIn =>
  ({ id: a.id, kind: 'price', venue: 'hl', market: a.coin, dir: a.dir, px: a.px, title, body, url: `/futures/${a.coin}` })

/** Asks permission and subscribes this browser; then hands the engine the alerts. */
export async function enablePush(): Promise<boolean> {
  const why = pushSupport()
  if (why !== 'ok') { set({ error: why }); return false }
  set({ busy: true, error: null })
  try {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (perm !== 'granted') { set({ error: 'blocked' }); return false }
    const { publicKey } = await fetch(`${engineApiUrl}/v1/push/key`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json() as Promise<{ publicKey: string }>)
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    let ps = await reg.pushManager.getSubscription()
    // A subscription to another key (the engine's key changed) can't be used.
    const key = keyBytes(publicKey)
    const same = ps?.options.applicationServerKey && new Uint8Array(ps.options.applicationServerKey).every((b, i) => b === key[i])
    if (ps && !same) { await ps.unsubscribe(); ps = null }
    ps ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    const sub = ps.toJSON()
    const r = await post<{ id: string; token: string }>('subscribe', { subscription: { endpoint: sub.endpoint, keys: sub.keys }, alerts: wanted() })
    set({ sub: { id: r.id, token: r.token, endpoint: sub.endpoint! } })
    return true
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) })
    return false
  } finally { set({ busy: false }) }
}

export async function disablePush() {
  const s = state.sub
  set({ sub: null, busy: true })
  try {
    if (s) await post('unsubscribe', { id: s.id, token: s.token }).catch(() => {})
    const reg = await navigator.serviceWorker?.getRegistration('/')
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
  } catch { /* already gone */ } finally { set({ busy: false }) }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null
/** Hands the engine the current alerts (soon after a change; a burst of changes is one request). */
export function syncPush() {
  if (!state.sub) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    const s = state.sub
    if (!s) return
    post('alerts', { id: s.id, token: s.token, alerts: wanted() }).then(() => set({ error: null }), (e: Error & { status?: number }) => {
      // The engine no longer knows this browser (it dropped it, or a restart lost it): subscribe again.
      if (e.status === 401) { set({ sub: null }); void enablePush() } else set({ error: e.message })
    })
  }, 400)
}

/** What fired while away: the engine's word for each coin alert. */
export async function refreshPush() {
  const s = state.sub
  if (!s) return
  try {
    const r = await post<{ alerts: { id: string; firedAt?: number | null; lastAt?: number | null }[] }>('state', { id: s.id, token: s.token })
    const by = new Map(r.alerts.map(a => [a.id, a]))
    set({ coin: state.coin.map(a => { const g = by.get(a.id); return g ? { ...a, firedAt: g.firedAt ?? a.firedAt ?? null, lastAt: g.lastAt ?? a.lastAt ?? null } : a }) })
  } catch (e) {
    if ((e as { status?: number }).status === 401) { set({ sub: null }); void enablePush() }
  }
}

/** A test notification to this browser. */
export async function testPush(title: string, body: string) {
  const s = state.sub
  if (!s) throw new Error('alerts aren’t on')
  await post('test', { id: s.id, token: s.token, title, body })
}

export function addCoinAlert(a: Omit<CoinAlert, 'id' | 'created' | 'venue'>) {
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const alert: CoinAlert = { ...a, id, venue: 'arc', created: Date.now(), firedAt: null, lastAt: null }
  set({ coin: [alert, ...state.coin].slice(0, 40) })
  syncPush()
}
export function removeCoinAlert(id: string) { set({ coin: state.coin.filter(a => a.id !== id) }); syncPush() }

/** A notification the service worker showed while a tab was open: that coin alert is reached here too. */
export function markPushed(tag: string, at: number) {
  if (state.coin.some(a => a.id === tag)) set({ coin: state.coin.map(a => a.id !== tag ? a : a.kind === 'price' ? { ...a, firedAt: a.firedAt ?? at } : { ...a, lastAt: at }) })
}
