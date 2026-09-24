// Per-browser trading preferences (fomo parity): quick-trade presets,
// blur balances, watchlist, recently viewed coins, alert sound and size.
// Stored in localStorage; every read/write is guarded so a blocked or
// private-mode storage just falls back to defaults.

import { useSyncExternalStore } from 'react'

export interface RecentToken { address: string; symbol: string; image: string | null; pool: string | null }

export interface Prefs {
  buyPresets: number[]   // USDC amounts
  sellPresets: number[]  // % of holding
  blur: boolean
  watchlist: string[]    // token addresses, lowercase
  recents: RecentToken[] // newest first
  alertSound: boolean
  alertMinUsd: number
  discoveryCollapsed: boolean
  discoverySplit: boolean
}

export const DEFAULT_PREFS: Prefs = {
  buyPresets: [10, 25, 50, 100],
  sellPresets: [10, 25, 50, 100],
  blur: false,
  watchlist: [],
  recents: [],
  alertSound: false,
  alertMinUsd: 10,
  discoveryCollapsed: false,
  discoverySplit: false,
}

const KEY = 'arcdex:prefs:v1'
let state: Prefs = load()
const listeners = new Set<() => void>()

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

export function getPrefs(): Prefs { return state }

export function setPrefs(patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage blocked */ }
  if ('blur' in next) document.documentElement.classList.toggle('blur-balances', state.blur)
  listeners.forEach(l => l())
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => state, () => state)
}

// Apply blur on load.
try { document.documentElement.classList.toggle('blur-balances', state.blur) } catch { /* SSR */ }

export function toggleWatch(address: string) {
  const a = address.toLowerCase()
  setPrefs(p => ({ watchlist: p.watchlist.includes(a) ? p.watchlist.filter(x => x !== a) : [a, ...p.watchlist].slice(0, 200) }))
}

export function pushRecent(t: RecentToken) {
  const a = t.address.toLowerCase()
  setPrefs(p => ({ recents: [{ ...t, address: a }, ...p.recents.filter(r => r.address !== a)].slice(0, 12) }))
}
