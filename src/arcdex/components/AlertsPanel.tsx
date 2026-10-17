// The bell's panel (top bar and status line): every price alert, waiting or fired, with Hyperliquid's live prices.
// Alerts are set from a futures market's 🔔; each opens its market.

import { useEffect, useMemo, useRef } from 'react'
import type { Page } from '../App'
import { AlertsList } from './HlAlerts'
import { useHlMarkets, useHlMids } from '../hl/live'
import { t as T } from '../lib/i18n'

export default function AlertsPanel({ navigate, onClose }: { navigate: (p: Page) => void; onClose: () => void }) {
  const { markets } = useHlMarkets()
  const mids = useHlMids()
  const byCoin = useMemo(() => new Map((markets ?? []).map(m => [m.coin, m])), [markets])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // The bell buttons toggle it themselves.
      if (!ref.current?.contains(t) && !t.closest('.tm-bell, .tm-st-link')) onClose()
    }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', f)
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', f); window.removeEventListener('keydown', k) }
  }, [onClose])
  return (
    <div className="tm-alerts" ref={ref} role="dialog" aria-label={T('Price alerts')}>
      <div className="tm-alerts-h"><b>{T('Price alerts')}</b><button className="tr-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
      <div className="tm-alerts-body">
        <AlertsList coin={null} byCoin={byCoin} mids={mids} onSelect={coin => { onClose(); navigate({ name: 'perps', coin }) }} />
      </div>
      <button className="tm-alerts-go" onClick={() => { onClose(); navigate({ name: 'perps' }) }}>{T('Set an alert on a futures market')} ›</button>
    </div>
  )
}
