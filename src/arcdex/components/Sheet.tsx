// A bottom sheet, the way native apps show a trade box or a menu: slides up
// over the page, closes on a tap outside, the Back gesture or Esc, and keeps
// clear of the phone's home-indicator area. Rendered into <body> so no page
// layout (overflow, transforms) can clip it.

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sheetHistory } from '../lib/sheetHistory'
import { t as T } from '../lib/i18n'

/** Runs `fn` once a sheet that is closing has stepped back over its history
 * entry — navigating before that would be undone by the pending Back. */
export function afterSheetClose(fn: () => void) {
  let done = false
  const run = () => { if (done) return; done = true; window.removeEventListener('popstate', run); fn() }
  window.addEventListener('popstate', run)
  setTimeout(run, 350)
}

/** Phones, coin pages: the sticky Buy / Sell bar (fomo-style) that opens the
 * trade sheet. Hidden on wider screens, where the swap box sits beside the chart. */
export function TradeBar({ symbol, onTrade }: { symbol: string; onTrade: (mode: 'buy' | 'sell') => void }) {
  return (
    <div className="trade-bar">
      <button className="trade-bar-buy" onClick={() => onTrade('buy')}>{T('Buy {symbol}', { symbol })}</button>
      <button className="trade-bar-sell" onClick={() => onTrade('sell')}>{T('Sell {symbol}', { symbol })}</button>
    </div>
  )
}

interface Props {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
}

export default function Sheet({ open, onClose, title, children }: Props) {
  // Pages re-render on every live trade and pass a fresh onClose each time:
  // the history entry must follow `open` only, not each new callback.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    // Android/iOS Back closes the sheet instead of leaving the page.
    window.history.pushState({ arcdexSheet: true }, '')
    sheetHistory.open++
    const onPop = () => closeRef.current()
    window.addEventListener('keydown', onKey)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onPop)
      sheetHistory.open--
      if ((window.history.state as { arcdexSheet?: boolean } | null)?.arcdexSheet) {
        sheetHistory.ignoreNextPop = true
        window.history.back()
      }
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
