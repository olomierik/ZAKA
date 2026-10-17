// Copy trading's settings, copied coins and log, kept in this browser (lib/copyTrade.ts copies; this module is small so
// the app's shell can tell whether copying is on without loading the swap code).

import { useSyncExternalStore } from 'react'

// ── rules ──────────────────────────────────────────────────────────────────

export interface CopyRule {
  /** The leader: an EVM address, lower case. */
  leader: string
  on: boolean
  /** 'fixed': always maxUsd; 'match': the leader's own dollars, up to maxUsd. */
  sizing: 'fixed' | 'match'
  maxUsd: number
  /** Worse than the leader's price by more than this, a copy is skipped; also the swap's slippage. */
  slippagePct: number
  safety: 'skip-danger' | 'safe-only'
  /** Copy the leader's sales of coins copied from it. */
  sells: boolean
}

export interface CopySettings {
  on: boolean
  /** The most all buys together may spend in a UTC day. */
  dailyCapUsd: number
  /** The follower read and accepted the risks. */
  accepted: boolean
  rules: CopyRule[]
}

export const COPY = {
  minUsd: 1, maxUsd: 500, maxDailyUsd: 5_000, minSlip: 0.5, maxSlip: 15, maxLeaders: 20,
  /** USDC left in the wallet for gas (Arc pays gas in USDC). */
  gasReserveUsd: 0.3,
  /** A leader's trade older than this when it reaches the browser isn't copied. */
  staleMs: 60_000,
  /** The leader's holding left under this share of what it had: it sold out, and the copied coins all go. */
  soldOutShare: 0.01,
} as const

export const DEFAULT_RULE = (leader: string): CopyRule => ({ leader: leader.toLowerCase(), on: true, sizing: 'fixed', maxUsd: 5, slippagePct: 3, safety: 'skip-danger', sells: true })
const DEFAULTS: CopySettings = { on: false, dailyCapUsd: 50, accepted: false, rules: [] }

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)
/** A rule as kept: every number within bounds. */
export function cleanRule(r: Partial<CopyRule> & { leader: string }): CopyRule {
  const d = DEFAULT_RULE(r.leader)
  return {
    leader: r.leader.toLowerCase(), on: r.on ?? d.on, sizing: r.sizing === 'match' ? 'match' : 'fixed',
    maxUsd: clamp(Number(r.maxUsd ?? d.maxUsd), COPY.minUsd, COPY.maxUsd), slippagePct: clamp(Number(r.slippagePct ?? d.slippagePct), COPY.minSlip, COPY.maxSlip),
    safety: r.safety === 'safe-only' ? 'safe-only' : 'skip-danger', sells: r.sells ?? d.sells,
  }
}

// ── storage (this browser, per trading wallet) ─────────────────────────────

const SETTINGS_KEY = 'arcdex:copy:v1'
const lotsKey = (me: string) => `arcdex:copy-lots:v1:${me.toLowerCase()}`
const logKey = (me: string) => `arcdex:copy-log:v1:${me.toLowerCase()}`
const EVENT = 'arcdex:copy'

export interface CopyLot { leader: string; token: string; symbol: string; raw: string; decimals: number; spentUsd: number; at: number }
export interface CopyEvent {
  id: string
  at: number
  leader: string
  token: string
  symbol: string
  side: 'B' | 'S'
  status: 'filled' | 'skipped' | 'failed'
  /** Why it was skipped or failed: an English key for t() (lib/i18n.ts), with its numbers in `whyVars`; a failure's raw
   * error text otherwise. */
  why?: string
  whyVars?: Record<string, string | number>
  /** Dollars spent (a buy) or received (a sale). */
  usd?: number
  tx?: string
  /** From the leader's trade to the copy's receipt. */
  lagMs?: number
}

const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage blocked: this tab only */ } }
const ping = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT)) }
export const onCopyChange = (f: () => void) => { window.addEventListener(EVENT, f); window.addEventListener('storage', f); return () => { window.removeEventListener(EVENT, f); window.removeEventListener('storage', f) } }

export function getCopySettings(): CopySettings {
  const s = read<Partial<CopySettings>>(SETTINGS_KEY, {})
  return {
    on: s.on === true, accepted: s.accepted === true, dailyCapUsd: clamp(Number(s.dailyCapUsd ?? DEFAULTS.dailyCapUsd), COPY.minUsd, COPY.maxDailyUsd),
    rules: (Array.isArray(s.rules) ? s.rules : []).filter(r => r && /^0x[0-9a-f]{40}$/i.test(String(r.leader))).slice(0, COPY.maxLeaders).map(cleanRule),
  }
}
export function setCopySettings(patch: Partial<CopySettings> | ((s: CopySettings) => Partial<CopySettings>)) {
  const cur = getCopySettings()
  write(SETTINGS_KEY, { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) })
  ping()
}
export function upsertRule(rule: Partial<CopyRule> & { leader: string }) {
  setCopySettings(s => {
    const r = cleanRule({ ...(s.rules.find(x => x.leader === rule.leader.toLowerCase()) ?? {}), ...rule })
    const rest = s.rules.filter(x => x.leader !== r.leader)
    if (rest.length >= COPY.maxLeaders && rest.length === s.rules.length) throw new Error('limit')
    return { rules: [r, ...rest] }
  })
}
export const removeRule = (leader: string) => setCopySettings(s => ({ rules: s.rules.filter(r => r.leader !== leader.toLowerCase()) }))

export const getLots = (me: string): CopyLot[] => read<CopyLot[]>(lotsKey(me), [])
export function setLots(me: string, lots: CopyLot[]) { write(lotsKey(me), lots.filter(l => BigInt(l.raw) > 0n)); ping() }
export const getCopyLog = (me: string): CopyEvent[] => read<CopyEvent[]>(logKey(me), [])
export function logEvent(me: string, e: CopyEvent) { write(logKey(me), [e, ...getCopyLog(me)].slice(0, 200)); ping() }

/** Dollars this wallet's copies spent on buys since 00:00 UTC. */
export function spentToday(me: string, now = Date.now()): number {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0)
  return getCopyLog(me).filter(e => e.side === 'B' && e.status === 'filled' && e.at >= day.getTime()).reduce((s, e) => s + (e.usd ?? 0), 0)
}

// ── hooks ──────────────────────────────────────────────────────────────────


/** A store snapshot that stays the same object while its stored text does (React re-renders only on a change). */
function stable<T>(key: () => string, parse: () => T) {
  let raw: string | null = null, snap: T
  return () => {
    let r = ''
    try { r = localStorage.getItem(key()) ?? '' } catch { /* storage blocked */ }
    if (r !== raw) { raw = r; snap = parse() }
    return snap
  }
}
const settingsSnap = stable(() => SETTINGS_KEY, getCopySettings)
export function useCopySettings(): CopySettings {
  return useSyncExternalStore(onCopyChange, settingsSnap, settingsSnap)
}
const perWallet = new Map<string, { log: () => CopyEvent[]; lots: () => CopyLot[] }>()
function snapsFor(me: string) {
  const k = me.toLowerCase()
  if (!perWallet.has(k)) perWallet.set(k, { log: stable(() => logKey(k), () => getCopyLog(k)), lots: stable(() => lotsKey(k), () => getLots(k)) })
  return perWallet.get(k)!
}
const none: never[] = []
export function useCopyLog(me: string | null): CopyEvent[] {
  const f = me ? snapsFor(me).log : () => none
  return useSyncExternalStore(onCopyChange, f, f)
}
export function useCopyLots(me: string | null): CopyLot[] {
  const f = me ? snapsFor(me).lots : () => none
  return useSyncExternalStore(onCopyChange, f, f)
}
