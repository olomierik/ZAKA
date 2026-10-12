// Price alerts on /futures (hl/alerts.ts): the bell in the pair bar, the dialog that sets one, and the list of them in
// the account tabs. They're watched app-wide by components/PriceAlertWatcher.tsx.

import { useMemo, useState } from 'react'
import { t as T } from '../lib/i18n'
import type { HlMarket } from '../hl/markets'
import { roundPrice } from '../hl/wire'
import { fmtPx, sanitize } from '../hl/format'
import { activeAlerts, addAlert, AlertError, ALERTS, clearFired, removeAlert, updateAlerts, useAlerts, type PriceAlert } from '../hl/alerts'

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const movePct = (px: number, from: number) => (from > 0 ? ((px / from - 1) * 100) : 0)

export function alertCondition(a: Pick<PriceAlert, 'dir' | 'px' | 'label'>): string {
  return a.dir === 'above' ? T('{sym} rises to {px}', { sym: a.label, px: fmtPx(a.px) }) : T('{sym} falls to {px}', { sym: a.label, px: fmtPx(a.px) })
}

/** System notifications for alerts: asks the browser, and remembers the answer with the alerts. */
export async function setAlertNotify(on: boolean): Promise<boolean> {
  let ok = false
  if (on && typeof Notification !== 'undefined') {
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    ok = p === 'granted'
  }
  updateAlerts(s => ({ ...s, notify: ok }))
  return ok
}

export function AlertBell({ coin, onOpen }: { coin: string; onOpen: () => void }) {
  const s = useAlerts()
  const n = activeAlerts(s).filter(a => a.coin === coin).length
  return (
    <button className={`pa-bell${n ? ' on' : ''}`} onClick={onOpen} title={T('Price alerts')} aria-label={T('Price alerts')}>
      🔔{n ? <b>{n}</b> : null}
    </button>
  )
}

export function AlertModal({ market, px, onClose }: { market: HlMarket; px: number; onClose: () => void }) {
  const s = useAlerts()
  const [level, setLevel] = useState(() => (px > 0 ? String(roundPrice(px * 1.02, market.szDecimals, true)) : ''))
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const mine = useMemo(() => s.alerts.filter(a => a.coin === market.coin), [s.alerts, market.coin])
  const n = +level
  const pct = n > 0 && px > 0 ? movePct(n, px) : null
  const notifyBlocked = typeof Notification !== 'undefined' && Notification.permission === 'denied'

  function create() {
    setErr(null); setDone(null)
    try {
      const at = roundPrice(n, market.szDecimals, true)
      const next = updateAlerts(st => addAlert(st, { id: newId(), coin: market.coin, label: market.symbol, px: at, from: px, now: Date.now() }))
      setDone(alertCondition(next.alerts[0]))
    } catch (e) { setErr(e instanceof AlertError ? T(e.message) : String(e)) }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card hl-modal pa-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>🔔 {T('Price alert')} · {market.symbol}-USD</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <div className="fx-summary"><div><span>{T('Price now')}</span><b>{fmtPx(px)}</b></div></div>
        <div className="fxb-input">
          <span>{T('Alert me at')}</span>
          <input inputMode="decimal" value={level} onChange={e => { setLevel(sanitize(e.target.value)); setDone(null) }} autoFocus />
          <em>USD</em>
        </div>
        <div className="pa-chips">
          {[-10, -5, -2, -1, 1, 2, 5, 10].map(p => (
            <button key={p} className={p < 0 ? 'down' : 'up'} disabled={!(px > 0)} onClick={() => { setLevel(String(roundPrice(px * (1 + p / 100), market.szDecimals, true))); setDone(null) }}>{p > 0 ? '+' : '−'}{Math.abs(p)}%</button>
          ))}
        </div>
        {pct != null && pct !== 0 && (
          <div className="fx-fine">{T('Fires once, when {cond} ({pct} from now).', { cond: alertCondition({ dir: pct > 0 ? 'above' : 'below', px: n, label: market.symbol }), pct: `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%` })}</div>
        )}
        <label className="fxb-check"><input type="checkbox" checked={s.sound} onChange={e => updateAlerts(st => ({ ...st, sound: e.target.checked }))} /> {T('Play a sound')}</label>
        <label className="fxb-check">
          <input type="checkbox" checked={s.notify} disabled={notifyBlocked} onChange={e => void setAlertNotify(e.target.checked)} /> {T('Also a system notification (with ARCDEX in the background)')}
        </label>
        {notifyBlocked && <div className="fx-fine">{T('Notifications are blocked for this site in your browser’s settings.')}</div>}
        {err && <div className="fx-hint-bad">⚠ {err}</div>}
        {done && <div className="fx-note ok">✓ {T('Alert set: {cond}.', { cond: done })}</div>}
        <button className="btn-primary" disabled={!(n > 0) || !(px > 0)} onClick={create}>{T('Set alert')}</button>
        {mine.length > 0 && (
          <div className="pa-mine">
            {mine.map(a => (
              <div key={a.id} className={`pa-row ${a.status}`}>
                <span>{alertCondition(a)}</span>
                <small>{a.status === 'active' ? T('waiting') : T('reached {time}', { time: when(a.firedAt ?? a.created) })}</small>
                <button className="link-btn" onClick={() => updateAlerts(st => removeAlert(st, a.id))}>{T('Delete')}</button>
              </div>
            ))}
          </div>
        )}
        <p className="fx-fine">{T('Alerts are watched while ARCDEX is open in this browser, on any page. If a level is reached while it’s closed, you’re told when you come back, from Hyperliquid’s candles. Up to {n} at a time.', { n: ALERTS.maxActive })}</p>
      </div>
    </div>
  )
}

/** Every alert, for the account tabs: waiting ones first, then those that fired, newest first. */
export function AlertsList({ coin, byCoin, mids, onSelect }: { coin: string | null; byCoin: Map<string, HlMarket>; mids: Readonly<Record<string, number>>; onSelect: (coin: string) => void }) {
  const s = useAlerts()
  const [err, setErr] = useState<string | null>(null)
  const list = s.alerts.filter(a => !coin || a.coin === coin)
  if (!list.length) return <div className="fx-empty">{T('No price alerts. Set one with the 🔔 next to the market’s price.')}</div>
  const fired = list.filter(a => a.status === 'fired')
  function again(a: PriceAlert) {
    const now = mids[a.coin] ?? byCoin.get(a.coin)?.markPx ?? 0
    setErr(null)
    try { updateAlerts(st => addAlert(removeAlert(st, a.id), { id: newId(), coin: a.coin, label: a.label, px: a.px, from: now, now: Date.now() })) }
    catch (e) { setErr(e instanceof AlertError ? T(e.message) : String(e)) }
  }
  return (
    <div className="fx-table-wrap">
      {err && <div className="fx-hint-bad">⚠ {err}</div>}
      <table className="fx-table hl-table">
        <thead><tr>
          <th>{T('Market')}</th><th>{T('Alert')}</th><th>{T('Price now')}</th><th>{T('Set')}</th><th>{T('Status')}</th>
          <th>{fired.length > 0 && <button className="link-btn" onClick={() => updateAlerts(clearFired)}>{T('Clear reached')}</button>}</th>
        </tr></thead>
        <tbody>
          {list.map(a => {
            const now = mids[a.coin] ?? byCoin.get(a.coin)?.markPx ?? 0
            const pct = now > 0 ? movePct(a.px, now) : null
            return (
              <tr key={a.id}>
                <td><button className="link-btn" onClick={() => onSelect(a.coin)}><b>{a.label}</b></button></td>
                <td>{alertCondition(a)}</td>
                <td>{fmtPx(now)}{a.status === 'active' && pct != null ? <small> · {pct > 0 ? '+' : '−'}{Math.abs(pct).toFixed(2)}%</small> : null}</td>
                <td><small>{when(a.created)} · {fmtPx(a.from)}</small></td>
                <td>{a.status === 'active' ? <span className="pa-wait">{T('Waiting')}</span> : <span className="fx-up">{T('Reached {time}', { time: when(a.firedAt ?? a.created) })}{a.away ? <small> · {T('while away')}</small> : null}</span>}</td>
                <td className="pa-actions">
                  {a.status === 'fired' && <button className="btn-ghost" onClick={() => again(a)}>{T('Set again')}</button>}
                  <button className="btn-ghost" onClick={() => updateAlerts(st => removeAlert(st, a.id))}>{T('Delete')}</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
