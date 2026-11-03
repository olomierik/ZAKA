// Live BTC Up/Down autotrading with real money, from the user's own wallet (2026-11-03, owner: "make it trade small
// capital like 50 and 100 and be smart not to burn the account and enable LIVE AUTOTRADE with real money").
//
// The engine decides (engine/src/updown, its signals on the `updown` channel); this browser trades them on Polymarket
// with the unlocked trading wallet, which signs on Polygon by itself (lib/polyLive.ts). Polymarket checks the IP that
// sends an order, so orders leave from the user's own connection, never from the engine (US, blocked).
//
// What keeps a $50 or $100 account alive (LIVE_RULES, the same numbers the engine's live-speed paper book uses):
// - an order is a quarter of Kelly, at most 6% of the capital ($3 on $50, $6 on $100), nothing under $1;
// - at most 12% of the capital in one window and two positions open;
// - no new order for the rest of the UTC day once the day lost 15%;
// - a one-hour pause after four losses in a row;
// - stopped for good (until the user starts again) once the account is 30% under where it started;
// - a signal over 2 seconds old when it arrives isn't traded; a buy never pays above the engine's price, a sale never
//   takes under its floor (fill-and-kill: what can't fill at that price is cancelled, never left resting).
// This module is the rules and the record, kept in this browser; it has no wallet code, so the app's shell can read it.

import { useSyncExternalStore } from 'react'
import { LIVE_RULES, liveOrderUsd, type UpdownSignal } from '../../../api/_updownProtocol'

export type LiveCapital = (typeof LIVE_RULES.capitals)[number]

export interface LiveSettings {
  on: boolean
  capital: LiveCapital
  /** The user read and accepted the risks. */
  accepted: boolean
  /** When live trading was last started, and the account's value then (pUSD), for the drawdown stop. */
  startedAt: number
  startEquity: number | null
  /** Why it stopped by itself, until the user starts it again. */
  halted: string | null
  pauseUntil: number
}

export interface LivePosition {
  id: string
  slug: string
  side: 'up' | 'down'
  asset: string
  conditionId: string
  /** Window end, unix seconds. */
  end: number
  at: number
  shares: number
  /** pUSD paid, fees included. */
  cost: number
  sold: number
  proceeds: number
  status: 'open' | 'closed'
  /** The window's result, once known: did this side win. */
  won?: boolean
  redeemed?: boolean
  pnl: number | null
}

export interface LiveEvent {
  at: number
  kind: 'buy' | 'sell' | 'skip' | 'error' | 'settle' | 'stop'
  /** An English key for t() with its numbers apart. */
  k: string
  v?: Record<string, string>
}

const SETTINGS_KEY = 'arcdex:updown-live:v1'
const bookKey = (me: string) => `arcdex:updown-live-book:v1:${me.toLowerCase()}`
const EVENT = 'arcdex:updown-live'
const DEFAULTS: LiveSettings = { on: false, capital: 50, accepted: false, startedAt: 0, startEquity: null, halted: null, pauseUntil: 0 }

function read<V>(key: string, d: V): V {
  try { const raw = localStorage.getItem(key); return raw ? { ...d, ...(JSON.parse(raw) as V) } : d } catch { return d }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage blocked: kept for this page only */ }
  window.dispatchEvent(new Event(EVENT))
}

let settingsCache: LiveSettings | null = null
export function getLiveSettings(): LiveSettings {
  settingsCache ??= read(SETTINGS_KEY, DEFAULTS)
  if (!LIVE_RULES.capitals.includes(settingsCache.capital)) settingsCache = { ...settingsCache, capital: 50 }
  return settingsCache
}
export function setLiveSettings(patch: Partial<LiveSettings>) {
  settingsCache = { ...getLiveSettings(), ...patch }
  write(SETTINGS_KEY, settingsCache)
}
function subscribe(cb: () => void) {
  const on = (e: Event) => { if (e.type === 'storage') settingsCache = null; cb() }
  window.addEventListener(EVENT, on)
  window.addEventListener('storage', on)
  return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on) }
}
export function useLiveSettings(): LiveSettings { return useSyncExternalStore(subscribe, getLiveSettings, getLiveSettings) }

export interface LiveBook { positions: LivePosition[]; events: LiveEvent[] }
const bookCache = new Map<string, LiveBook>()
export function getLiveBook(me: string): LiveBook {
  const k = me.toLowerCase()
  let b = bookCache.get(k)
  if (!b) { b = read<LiveBook>(bookKey(k), { positions: [], events: [] }); bookCache.set(k, b) }
  return b
}
export function saveLiveBook(me: string, b: LiveBook) {
  if (b.positions.length > 500) b.positions.splice(0, b.positions.length - 500)
  if (b.events.length > 300) b.events.splice(0, b.events.length - 300)
  bookCache.set(me.toLowerCase(), { ...b })
  write(bookKey(me), b)
}
export function logLive(me: string, e: Omit<LiveEvent, 'at'>, now = Date.now()) {
  const b = getLiveBook(me)
  saveLiveBook(me, { ...b, events: [...b.events, { at: now, ...e }] })
}
export function useLiveBook(me: string | null): LiveBook {
  const get = () => (me ? getLiveBook(me) : EMPTY)
  return useSyncExternalStore(cb => { const off = subscribe(() => { if (me) bookCache.delete(me.toLowerCase()); cb() }); return off }, get, get)
}
const EMPTY: LiveBook = { positions: [], events: [] }

// ── the rules ──────────────────────────────────────────────────────────────

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Realized P&L today, and what today's open positions put at risk (their cost less what they sold for). */
export function todayRisk(b: LiveBook, now: number) {
  const d = day(now)
  let realized = 0, atRisk = 0
  for (const p of b.positions) {
    if (day(p.at) !== d) continue
    if (p.status === 'closed') realized += p.pnl ?? 0
    else atRisk += p.cost - p.proceeds
  }
  return { realized, atRisk }
}

/** Closed losses in a row, newest first. */
export function lossStreak(b: LiveBook) {
  const closed = b.positions.filter(p => p.status === 'closed').sort((a, x) => x.at - a.at)
  let n = 0
  for (const p of closed) { if ((p.pnl ?? 0) < 0) n++; else break }
  return n
}

/** Whether to buy on a signal, and for how much; or why not. `cash` is the pUSD free in the wallet, `equity` cash plus
 *  open positions at cost. */
export function liveBuy(s: LiveSettings, b: LiveBook, sig: UpdownSignal, cash: number, equity: number, now: number, feeRate = 0.07): { usd: number } | { why: string; v?: Record<string, string> } {
  if (!s.on) return { why: 'live trading is off' }
  if (s.halted) return { why: 'stopped: {r}', v: { r: s.halted } }
  if (now < s.pauseUntil) return { why: 'paused after a losing streak' }
  if (sig.kind !== 'buy' || sig.p === undefined || sig.ask === undefined) return { why: 'not a buy' }
  if (now - sig.at > LIVE_RULES.maxSignalAgeMs) return { why: 'the signal arrived {s}s late', v: { s: ((now - sig.at) / 1000).toFixed(1) } }
  if (sig.end * 1000 - now < 5_000) return { why: 'the window is closing' }
  const open = b.positions.filter(p => p.status === 'open')
  if (open.length >= LIVE_RULES.maxOpen) return { why: '{n} positions already open', v: { n: String(open.length) } }
  const inWindow = b.positions.filter(p => p.slug === sig.slug).reduce((a, p) => a + p.cost, 0)
  const windowCap = s.capital * LIVE_RULES.windowShare
  if (inWindow >= windowCap - 0.5) return { why: 'this window’s cap of ${c}', v: { c: windowCap.toFixed(2) } }
  const r = todayRisk(b, now)
  if (r.realized - r.atRisk <= -s.capital * LIVE_RULES.dailyLossShare) return { why: 'the day’s loss stop of ${c}', v: { c: (s.capital * LIVE_RULES.dailyLossShare).toFixed(2) } }
  let usd = Math.min(liveOrderUsd(s.capital, sig.p, sig.ask, feeRate), windowCap - inWindow, cash - 0.05)
  usd = Math.floor(usd * 100) / 100
  if (usd < Math.max(LIVE_RULES.minOrderUsd, sig.minSize * sig.price)) return cash < LIVE_RULES.minOrderUsd + 0.05 ? { why: 'not enough pUSD' } : { why: 'under Polymarket’s minimum order' }
  void equity
  return { usd }
}

/** After every close and on each start: the drawdown stop and the losing-streak pause. Returns the settings' patch. */
export function liveCheck(s: LiveSettings, b: LiveBook, equity: number | null, now: number): Partial<LiveSettings> | null {
  if (!s.on || s.halted) return null
  if (equity !== null && s.startEquity !== null && equity < s.startEquity * (1 - LIVE_RULES.drawdownStop)) {
    return { on: false, halted: 'down 30% from where it started' }
  }
  const streak = lossStreak(b)
  const lastClose = b.positions.filter(p => p.status === 'closed').reduce((a, p) => Math.max(a, p.at), 0)
  if (streak > 0 && streak % LIVE_RULES.lossStreak === 0 && s.pauseUntil < lastClose) return { pauseUntil: now + LIVE_RULES.pauseMs }
  return null
}

/** The live record: closed trades, won, P&L. */
export function liveStats(b: LiveBook) {
  const closed = b.positions.filter(p => p.status === 'closed')
  return {
    trades: b.positions.length, open: b.positions.length - closed.length, closed: closed.length,
    won: closed.filter(p => (p.pnl ?? 0) > 0).length, pnl: closed.reduce((a, p) => a + (p.pnl ?? 0), 0),
    staked: b.positions.reduce((a, p) => a + p.cost, 0),
  }
}
