// The trade forms' Details drawer (the build pack's Phase 3: "single-field Buy/Sell, collapsed Details drawer"; the
// owner chose it for coin pages, keeping the Trenches and futures as they are, on 2026-10-16).
//
// A form shows the amount, what it gets and the button. The route, fees, slippage and notes sit in here, collapsed
// until opened. What needs the trader's attention stays outside it: a high price impact, a snipe tax, the ticks that
// confirm them, the coin's safety rating and every error. Open or closed is remembered in this browser, for every form.

import { useSyncExternalStore, type ReactNode } from 'react'
import { t as T } from '../lib/i18n'

/** From these a quote's price impact or total cost (in %) is shown outside Details, in amber, or red at the confirm
 * limit: the forms' own warning levels. */
export const HOT = { impactPct: 5, costPct: 6 }

const KEY = 'arcdex:trade-details'
const listeners = new Set<() => void>()
let open = (() => { try { return localStorage.getItem(KEY) === 'open' } catch { return false } })()

/** Opens or closes every form's Details (and remembers it). */
export function setDetailsOpen(next: boolean) {
  open = next
  try { localStorage.setItem(KEY, next ? 'open' : 'closed') } catch { /* storage blocked: for this visit */ }
  for (const l of listeners) l()
}
export function useDetailsOpen(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => open, () => open)
}

/** "Details ▾": the form's route, fees, slippage and notes. `hint` is a short line shown while it's closed. */
export default function TradeDetails({ hint, children }: { hint?: string; children: ReactNode }) {
  const isOpen = useDetailsOpen()
  return (
    <div className={`trade-details${isOpen ? ' open' : ''}`}>
      <button type="button" className="trade-details-toggle" aria-expanded={isOpen} onClick={() => setDetailsOpen(!isOpen)}>
        <span className="trade-details-label">{T('Details')}</span>
        {!isOpen && hint && <span className="trade-details-hint">{hint}</span>}
        <span className="trade-details-chev" aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
      </button>
      {isOpen && <div className="trade-details-body">{children}</div>}
    </div>
  )
}
