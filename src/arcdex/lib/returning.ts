// Who sees the landing page at arcsense.site/ (owner, 2026-10-17: "from clicking our URL he has to be taken to a landing
// page; when he clicks Log in, Privy; then the wallet is created, then he trades"):
//   • a visitor who has never signed in here sees the landing page;
//   • a trader who has (any wallet: Privy, a wallet app, the trading wallet) goes straight to the Trenches.
// One key, set by the app whenever a wallet is in use and cleared on Sign out, read by main.tsx and, for the page shell,
// by index.html's inline script (keep the key's name in step there).
//
// This file is imported by main.tsx before anything else loads: no imports.

export const RETURNING_KEY = 'arcdex:returning'

export function isReturning(): boolean {
  try { return localStorage.getItem(RETURNING_KEY) === '1' } catch { return false }
}

export function markReturning(on: boolean): void {
  try { if (on) localStorage.setItem(RETURNING_KEY, '1'); else localStorage.removeItem(RETURNING_KEY) } catch { /* storage blocked */ }
}

/** Which first screen a path gets: the landing page, or the app. */
export function firstScreen(path: string, returning: boolean): 'landing' | 'app' {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/about') return 'landing'
  if (p === '/') return returning ? 'app' : 'landing'
  return 'app'
}
