// Watches price alerts (hl/alerts.ts) wherever ARCDEX is open, and says when one fires: a notice in every open tab, and
// from the one tab that drives them, the sound and (when allowed) a system notification. Loaded by the app only once
// an alert exists.
//
// While alerts wait, Hyperliquid's mids are followed live (its WebSocket) and checked once a second. After a gap (the
// page closed, or a background tab the browser slowed down), the candles in between are read first, so a level
// reached meanwhile still fires, with the time it was reached.

import { useEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { beep } from '../lib/beep'
import { fmtPx } from '../hl/format'
import { useHlMids } from '../hl/live'
import { barsFor } from '../hl/history'
import { activeAlerts, ALERTS, checkAlerts, loadAlerts, replayAlerts, saveAlerts, useAlerts, type PriceAlert } from '../hl/alerts'

const LEASE = 'arcdex:hl-alerts:lease'
const SHOW_MS = 12_000

function holdLease(me: string, now: number): boolean {
  try {
    const raw = localStorage.getItem(LEASE)
    const l = raw ? (JSON.parse(raw) as { id?: string; until?: number }) : null
    if (l && l.id !== me && (l.until ?? 0) > now) return false
    localStorage.setItem(LEASE, JSON.stringify({ id: me, until: now + 4_000 }))
  } catch { /* storage blocked: this tab alone */ }
  return true
}

const headline = (a: PriceAlert) => (a.dir === 'above' ? T('{sym} rose to {px}', { sym: a.label, px: fmtPx(a.px) }) : T('{sym} fell to {px}', { sym: a.label, px: fmtPx(a.px) }))
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const detail = (a: PriceAlert) => (a.away ? T('While you were away, at {time} (from Hyperliquid’s candles)', { time: clock(a.firedAt ?? a.created) }) : T('Now {px}', { px: fmtPx(a.firedPx) }))

function systemNotice(a: PriceAlert, open: () => void) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const n = new Notification(`🔔 ${headline(a)}`, { body: detail(a), icon: '/icon-192.png', tag: `alert:${a.id}` })
    n.onclick = () => { window.focus(); open(); n.close() }
  } catch { /* unsupported */ }
}

/** Follows the mids and fires alerts; mounted only while some wait. */
function AlertDriver({ navigate }: { navigate: (p: Page) => void }) {
  const mids = useHlMids()
  const nav = useRef(navigate)
  nav.current = navigate
  useEffect(() => {
    const me = Math.random().toString(36).slice(2)
    let alive = true, busy = false, lastLive = 0, lastSave = 0, failures = 0

    function announce(fired: PriceAlert[], sound: boolean, notify: boolean) {
      if (!fired.length) return
      if (sound) beep()
      if (notify) for (const a of fired) systemNotice(a, () => nav.current({ name: 'perps', coin: a.coin }))
    }

    async function beat() {
      if (busy || !alive) return
      const now = Date.now()
      if (!holdLease(me, now)) { lastLive = 0; return }
      const s = loadAlerts()
      const waiting = activeAlerts(s)
      if (!waiting.length) return
      busy = true
      try {
        const from = Math.max(s.checked, lastLive)
        if (now - from > ALERTS.gapMs) {
          try {
            const coins = [...new Set(waiting.map(a => a.coin))]
            const bars = (await Promise.all(coins.map(c => barsFor(c, from, now)))).flat()
            if (!alive) return
            const r = replayAlerts(loadAlerts(), bars, now)
            const live = checkAlerts(r.state, mids, now)
            saveAlerts(live.state)
            announce([...r.fired, ...live.fired], r.state.sound, r.state.notify)
            failures = 0
          } catch {
            // Hyperliquid didn't answer: after three tries, carry on from now (the waiting alerts stay).
            if (++failures >= 3) { failures = 0; saveAlerts({ ...loadAlerts(), checked: now }) } else return
          }
          lastLive = lastSave = now
          return
        }
        const r = checkAlerts(s, mids, now)
        lastLive = now
        if (r.fired.length || now - lastSave > 5_000) { lastSave = now; saveAlerts({ ...r.state, checked: now }) }
        announce(r.fired, s.sound, s.notify)
      } finally { busy = false }
    }

    const id = setInterval(() => { void beat() }, 1_000)
    return () => {
      alive = false
      clearInterval(id)
      try { const l = JSON.parse(localStorage.getItem(LEASE) ?? 'null') as { id?: string } | null; if (l?.id === me) localStorage.removeItem(LEASE) } catch { /* nothing to release */ }
    }
  }, [mids])
  return null
}

export default function PriceAlertWatcher({ navigate }: { navigate: (p: Page) => void }) {
  const s = useAlerts()
  const waiting = activeAlerts(s).length > 0
  const [shown, setShown] = useState<(PriceAlert & { until: number })[]>([])
  const seen = useRef<Set<string> | null>(null)

  // A notice for every alert that fires while this tab is open, whichever tab drove it.
  useEffect(() => {
    const fired = s.alerts.filter(a => a.status === 'fired')
    if (!seen.current) { seen.current = new Set(fired.map(a => a.id)); return }
    const fresh = fired.filter(a => !seen.current!.has(a.id))
    if (!fresh.length) return
    for (const a of fresh) seen.current.add(a.id)
    const until = Date.now() + SHOW_MS
    setShown(list => [...fresh.map(a => ({ ...a, until })), ...list].slice(0, 4))
  }, [s.alerts])

  useEffect(() => {
    if (!shown.length) return
    const id = setInterval(() => setShown(list => list.filter(x => x.until > Date.now())), 1_000)
    return () => clearInterval(id)
  }, [shown.length])

  return (
    <>
      {waiting && <AlertDriver navigate={navigate} />}
      {shown.length > 0 && (
        <div className="pa-toasts" role="status" aria-live="polite">
          {shown.map(a => (
            <div key={a.id} className="pa-toast">
              <button className="pa-toast-main" onClick={() => { setShown(list => list.filter(x => x.id !== a.id)); navigate({ name: 'perps', coin: a.coin }) }}>
                <b>🔔 {headline(a)}</b>
                <small>{detail(a)}</small>
              </button>
              <button className="pa-toast-x" aria-label={T('Close')} onClick={() => setShown(list => list.filter(x => x.id !== a.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
