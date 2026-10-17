// Light or dark (2026-10-12, owner: "a trading terminal like motion.gift"): light by default, as motion opens, with
// a moon button to switch. The choice is kept in this browser and set on <html data-adx> before the page paints
// (index.html), so the page never flashes the other theme.

import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'arcdex:theme'
const EVENT = 'arcdex:theme'

function read(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

/** The theme now. */
export function getTheme(): Theme {
  const set = document.documentElement.getAttribute('data-adx')
  return set === 'dark' || set === 'light' ? set : read()
}

/** Switch theme, for this page and every later visit from this browser. */
export function setTheme(t: Theme) {
  document.documentElement.setAttribute('data-adx', t)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0a0f0c' : '#f3f4f0')
  try { localStorage.setItem(KEY, t) } catch { /* storage blocked: this page only */ }
  window.dispatchEvent(new Event(EVENT))
}

export const toggleTheme = () => setTheme(getTheme() === 'dark' ? 'light' : 'dark')

function subscribe(f: () => void) {
  window.addEventListener(EVENT, f)
  // Another tab switched it.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { document.documentElement.setAttribute('data-adx', read()); f() } }
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(EVENT, f); window.removeEventListener('storage', onStorage) }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'light')
}
