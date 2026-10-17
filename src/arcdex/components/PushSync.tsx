// Keeps the engine's copy of this browser's alerts in step (lib/push.ts), loaded only once alerts by push are on:
// every waiting Hyperliquid price alert (hl/alerts.ts) and every followed wallet with alerts on (lib/walletTracker.ts)
// go along with the coin alerts, in the visitor's language;
// what fired while away is read back on load; and a notification the service worker shows while a tab is open marks
// that alert reached here too.

import { useEffect } from 'react'
import { activeAlerts, useAlerts } from '../hl/alerts'
import { alertCondition } from './HlAlerts'
import { hlServerAlert, markPushed, refreshPush, setHlAlertSource, setWalletAlertSource, syncPush, usePush, walletServerAlert, type ServerAlertIn } from '../lib/push'
import { useTracked } from '../lib/walletTracker'
import { t as T, getLang } from '../lib/i18n'

export default function PushSync() {
  const hl = useAlerts()
  const push = usePush()
  const lang = getLang()
  const tracked = useTracked()

  useEffect(() => {
    setHlAlertSource((): ServerAlertIn[] => activeAlerts(hl).map(a => hlServerAlert(a, alertCondition(a), T('Price alert on ARCDEX'))))
    setWalletAlertSource((): ServerAlertIn[] => tracked.filter(w => w.alerts).map(w => walletServerAlert(w, T('Wallet tracker'),
      T('{who} {side} {usd} of {coin} on {chain}', { who: w.label || (w.address.startsWith('0x') ? `${w.address.slice(0, 6)}…${w.address.slice(-4)}` : `${w.address.slice(0, 4)}…${w.address.slice(-4)}`) }),
      T('bought'), T('sold'))))
    syncPush()
  }, [hl, lang, tracked])

  useEffect(() => { void refreshPush() }, [push.sub?.id])

  useEffect(() => {
    const on = (e: MessageEvent) => { const d = e.data as { type?: string; tag?: string; at?: number }; if (d?.type === 'arcdex-push' && d.tag) markPushed(d.tag, d.at ?? Date.now()) }
    navigator.serviceWorker?.addEventListener('message', on)
    return () => navigator.serviceWorker?.removeEventListener('message', on)
  }, [])

  return null
}
