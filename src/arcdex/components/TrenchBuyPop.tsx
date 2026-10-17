// A row's Buy (2026-10-12, owner: "remove the 5 dollar buy, just put BUY for users to put the amount"): a small box by
// the button where the amount is typed, then the coin's own trade form opens with it, where its checks run (simulation,
// exact approvals, the price guard) and the trade is confirmed. Nothing is bought from here.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t as T } from '../lib/i18n'

interface Props {
  anchor: HTMLElement
  symbol: string
  /** What the amount is counted in (USDC, SOL, BNB). */
  unit: string
  onBuy: (amount: number) => void
  onClose: () => void
}

export default function TrenchBuyPop({ anchor, symbol, unit, onBuy, onClose }: Props) {
  const [v, setV] = useState('')
  const box = useRef<HTMLFormElement>(null)
  // Placed on the first render (a hidden input can't take focus): under the button, or above it near the bottom.
  const [pos] = useState(() => {
    const r = anchor.getBoundingClientRect()
    const w = 252, h = 118
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))
    const below = r.bottom + 6
    return { left, top: below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below }
  })
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', key)
    window.addEventListener('mousedown', away)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', away) }
  }, [anchor, onClose])

  const n = Number(v)
  const ok = v.trim() !== '' && Number.isFinite(n) && n > 0
  return createPortal(
    <form ref={box} className="tr-bpop" style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}
      onSubmit={e => { e.preventDefault(); if (ok) onBuy(n) }}>
      <label>
        <span>{T('Buy {sym}', { sym: symbol })}</span>
        <span className="tr-bpop-in">
          <input ref={input} inputMode="decimal" placeholder={T('Amount')} value={v} onChange={e => setV(e.target.value.replace(',', '.'))} aria-label={T('Amount in {unit}', { unit })} />
          <small>{unit}</small>
        </span>
      </label>
      <button type="submit" className="tr-buy" disabled={!ok}>{T('Buy')}</button>
      <small className="tr-bpop-note">{T('Opens its trade form with this amount: you confirm there.')}</small>
    </form>,
    document.body,
  )
}
