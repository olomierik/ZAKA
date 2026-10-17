// Price alerts on Hyperliquid's markets (2026-10-12; the build pack's Strategy Lab starts with "alerts and paper
// trading"). An alert fires once, when a market's price reaches the level set: up to it from below, or down to it from
// above (whichever side the price was on when it was set).
//
// They're watched wherever ARCDEX is open in this browser (components/PriceAlertWatcher.tsx), and nothing is missed
// while it's closed: on return, the candles in between are read, and a level a candle reached fires with that time,
// marked as such. They live in this browser; nothing is sent anywhere.
//
// This file is the store and the checks only (no network), so the app can tell whether to load the watcher.

import { useSyncExternalStore } from 'react'
import { N_ } from '../lib/i18n'
import type { Bar } from './history'

export interface PriceAlert {
  id: string
  /** Hyperliquid's name for the market: "BTC", "xyz:NVDA". */
  coin: string
  /** As the page shows it: "BTC", "NVDA". */
  label: string
  dir: 'above' | 'below'
  px: number
  created: number
  /** The price when it was set. */
  from: number
  status: 'active' | 'fired'
  firedAt: number | null
  firedPx: number | null
  /** Fired from the candles, for a time the page was closed. */
  away: boolean
}
export interface AlertState { v: 1; alerts: PriceAlert[]; checked: number; sound: boolean; notify: boolean }

export const ALERTS = { maxActive: 50, keep: 100, gapMs: 15_000 }

export class AlertError extends Error {}

export const freshAlerts = (now: number): AlertState => ({ v: 1, alerts: [], checked: now, sound: true, notify: false })
export const activeAlerts = (s: AlertState) => s.alerts.filter(a => a.status === 'active')

/** A new alert at `px` on a market now at `from`: it fires when the price gets to `px` from where it is. */
export function addAlert(s: AlertState, a: { id: string; coin: string; label: string; px: number; from: number; now: number }): AlertState {
  if (!(a.px > 0)) throw new AlertError(N_('Enter a price.'))
  if (!(a.from > 0)) throw new AlertError(N_('There’s no price for this market right now.'))
  if (a.px === a.from) throw new AlertError(N_('That’s the price now: choose a level above or below it.'))
  if (activeAlerts(s).length >= ALERTS.maxActive) throw new AlertError(N_('You have 50 alerts waiting: delete one first.'))
  const alert: PriceAlert = { id: a.id, coin: a.coin, label: a.label, dir: a.px > a.from ? 'above' : 'below', px: a.px, created: a.now, from: a.from, status: 'active', firedAt: null, firedPx: null, away: false }
  // Fired ones beyond the newest hundred go; the waiting ones always stay.
  const fired = s.alerts.filter(x => x.status === 'fired').slice(0, ALERTS.keep)
  return { ...s, alerts: [alert, ...activeAlerts(s), ...fired] }
}

export const removeAlert = (s: AlertState, id: string): AlertState => ({ ...s, alerts: s.alerts.filter(a => a.id !== id) })
export const clearFired = (s: AlertState): AlertState => ({ ...s, alerts: activeAlerts(s) })

const fire = (a: PriceAlert, at: number, px: number, away: boolean): PriceAlert => ({ ...a, status: 'fired', firedAt: at, firedPx: px, away })
const reached = (a: PriceAlert, hi: number, lo: number) => (a.dir === 'above' ? hi >= a.px : lo <= a.px)

/** Live: fires each waiting alert whose market is at or past its level now. */
export function checkAlerts(s: AlertState, mids: Readonly<Record<string, number>>, now: number): { state: AlertState; fired: PriceAlert[] } {
  const fired: PriceAlert[] = []
  const alerts = s.alerts.map(a => {
    const p = mids[a.coin]
    if (a.status !== 'active' || !(p > 0) || !reached(a, p, p)) return a
    const f = fire(a, now, p, false)
    fired.push(f)
    return f
  })
  return { state: fired.length ? { ...s, alerts } : s, fired }
}

/** After a gap: fires each waiting alert at the first candle that reached its level. Only candles that opened after the
 * alert was set count; the time is the candle's, the price the level. */
export function replayAlerts(s: AlertState, bars: Bar[], until: number): { state: AlertState; fired: PriceAlert[] } {
  const sorted = [...bars].sort((a, b) => a.t - b.t)
  const fired: PriceAlert[] = []
  const alerts = s.alerts.map(a => {
    if (a.status !== 'active') return a
    const b = sorted.find(x => x.coin === a.coin && x.t >= a.created && x.t <= until && reached(a, x.h, x.l))
    if (!b) return a
    const f = fire(a, b.t, a.px, true)
    fired.push(f)
    return f
  })
  return { state: { ...s, alerts, checked: Math.max(s.checked, until) }, fired }
}

// ── the alerts in this browser ──────────────────────────────────────────

const KEY = 'arcdex:hl-alerts:v1'
const EVENT = 'arcdex:hl-alerts'
// Browsers that block storage keep the alerts for this tab only.
let memory: AlertState | null = null
let snapshot: AlertState | null = null

export function loadAlerts(): AlertState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<AlertState>
      if (s?.v === 1 && Array.isArray(s.alerts) && Number.isFinite(s.checked)) return { sound: true, notify: false, ...s } as AlertState
    }
  } catch { /* storage blocked or unreadable */ }
  return memory ?? (memory = freshAlerts(Date.now()))
}

export function saveAlerts(s: AlertState) {
  memory = s
  snapshot = null
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage blocked: this tab only */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* no window */ }
}

/** Applies a change to the stored alerts (read fresh, so another tab's change isn't lost). */
export function updateAlerts(f: (s: AlertState) => AlertState): AlertState {
  const before = loadAlerts()
  const next = f(before)
  // Alerts that were watching nothing start watching from now.
  if (!activeAlerts(before).length && activeAlerts(next).length) next.checked = Date.now()
  saveAlerts(next)
  return next
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { snapshot = null; cb() } }
  window.addEventListener('storage', onStorage)
  window.addEventListener(EVENT, cb)
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(EVENT, cb) }
}

/** The alerts, re-rendering the caller when they change here or in another tab. */
export function useAlerts(): AlertState {
  return useSyncExternalStore(subscribe, () => snapshot ?? (snapshot = loadAlerts()), () => snapshot ?? (snapshot = loadAlerts()))
}
