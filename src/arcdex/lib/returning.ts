// Who sees the landing page at arcsense.site/: everyone, every time (owner, 2026-10-18: "always, everywhere", phones
// too). From 2026-10-17 to 2026-10-18 a trader who had signed in here went straight to the Trenches instead.
// The key below still records that a wallet was used here (set by the app, cleared on Sign out); nothing routes on it
// now. index.html's inline script draws the landing page's dark shell for / and /about the same way.
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
  void returning
  return p === '/' || p === '/about' ? 'landing' : 'app'
}
