// Notices for followed wallets' trades (the wallet tracker, lib/walletTracker.ts): while ARCDEX is open on any page, each
// trade by a wallet with alerts on shows a notice (top right, as price alerts do; a click opens the coin), and a system
// notification when the tab is in the background and notifications are allowed.

import { useEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import { CHAIN_LABEL, coinPageOf, onWalletTrades, ownerOf, useTracked } from '../lib/walletTracker'
import type { WalletTradeWire } from '../../../api/_trenchProtocol'
import { t as T } from '../lib/i18n'

const SHOW_MS = 8_000
const short = (a: string) => (a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : `${a.slice(0, 4)}…${a.slice(-4)}`)
const usd = (n: number) => (n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

interface Shown { id: string; t: WalletTradeWire; who: string; until: number }

export default function WalletAlertWatcher({ navigate }: { navigate: (p: Page) => void }) {
  const tracked = useTracked()
  // Labels and switches read at each trade, so renaming a wallet doesn't resubscribe.
  const trackedRef = useRef(tracked)
  trackedRef.current = tracked
  const watched = tracked.filter(w => w.alerts).map(w => w.address)
  const key = watched.join(',')
  const [shown, setShown] = useState<Shown[]>([])

  useEffect(() => {
    if (!watched.length) return
    return onWalletTrades(watched, t => {
      const o = ownerOf(t, trackedRef.current)
      if (!o?.alerts) return
      const who = o.label || short(o.address)
      const line = T('{who} {side} {usd} of {coin} on {chain}', { who, side: t.side === 'B' ? T('bought') : T('sold'), usd: usd(t.u), coin: t.s || short(t.t), chain: CHAIN_LABEL[t.c] })
      setShown(list => [{ id: `${t.c}:${t.w}:${t.ts}:${t.t}:${t.side}`, t, who, until: Date.now() + SHOW_MS }, ...list].slice(0, 4))
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(T('Wallet tracker'), { body: line, tag: `wt:${t.w}:${t.ts}` }) } catch { /* not allowed here */ }
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!shown.length) return
    const id = setInterval(() => setShown(list => list.filter(x => x.until > Date.now())), 1_000)
    return () => clearInterval(id)
  }, [shown.length])

  if (!shown.length) return null
  return (
    <div className="pa-toasts wt-toasts" role="status" aria-live="polite">
      {shown.map(s => (
        <div key={s.id} className={`pa-toast wt-toast ${s.t.side === 'B' ? 'buy' : 'sell'}`}>
          <button className="pa-toast-main" onClick={() => { setShown(list => list.filter(x => x.id !== s.id)); navigate(coinPageOf(s.t.c, s.t.t)) }}>
            <b>{s.t.side === 'B' ? '🟢' : '🔴'} {T('{who} {side} {coin}', { who: s.who, side: s.t.side === 'B' ? T('bought') : T('sold'), coin: s.t.s || short(s.t.t) })}</b>
            <small>{usd(s.t.u)} · {CHAIN_LABEL[s.t.c]}{s.t.m > 0 ? ` · MC ${usd(s.t.m)}` : ''}</small>
          </button>
          <button className="pa-toast-x" aria-label={T('Close')} onClick={() => setShown(list => list.filter(x => x.id !== s.id))}>✕</button>
        </div>
      ))}
    </div>
  )
}
