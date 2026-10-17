// Runs copy trading (lib/copyTrade.ts) while ARCDEX is open: the leaders' live trades from the wallet tracker's channel,
// copied one at a time from the unlocked trading wallet. One tab copies at a time (a lease renewed every 2s), so two
// open tabs never copy the same trade twice. A notice shows each filled or failed copy; skips are only in the log.

import { useEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import { copyTrade, getCopySettings, useCopySettings, type CopyEvent } from '../lib/copyTrade'
import { coinPageOf, onWalletTrades } from '../lib/walletTracker'
import { useTrader } from '../lib/identity'
import { flag } from '../lib/flags'
import type { WalletTradeWire } from '../../../api/_trenchProtocol'
import { t as T } from '../lib/i18n'

const LEASE = 'arcdex:copy:lease'
const SHOW_MS = 10_000
const usd = (n: number) => (n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`)

/** Whether this tab copies: no other tab renewed the lease in the last 6 seconds. */
function holdLease(me: string, now = Date.now()): boolean {
  try {
    const l = JSON.parse(localStorage.getItem(LEASE) ?? 'null') as { id?: string; until?: number } | null
    if (l && l.id !== me && (l.until ?? 0) > now) return false
    localStorage.setItem(LEASE, JSON.stringify({ id: me, until: now + 6_000 }))
  } catch { /* storage blocked: this tab alone */ }
  return true
}

export default function CopyRunner({ navigate }: { navigate: (p: Page) => void }) {
  const settings = useCopySettings()
  const trader = useTrader()
  const me = trader.kind === 'trading-wallet' ? trader.address : null
  const leaders = settings.on ? settings.rules.filter(r => r.on).map(r => r.leader) : []
  const key = me ? `${me}:${leaders.join(',')}` : ''
  const tab = useRef(Math.random().toString(36).slice(2))
  const [shown, setShown] = useState<(CopyEvent & { until: number })[]>([])

  useEffect(() => {
    if (!me || !leaders.length) return
    const seen = new Set<string>()
    const queue: WalletTradeWire[] = []
    let running = false
    let alive = true
    const lease = setInterval(() => holdLease(tab.current), 2_000)
    holdLease(tab.current)
    const stillOn = (leader: string) => {
      const s = getCopySettings()
      return alive && flag('walletCopy') && s.on && !!s.rules.find(r => r.leader === leader.toLowerCase() && r.on)
    }
    const run = async () => {
      if (running) return
      running = true
      while (queue.length && alive) {
        const t = queue.shift()!
        if (!holdLease(tab.current) || !stillOn(t.w)) continue
        const ev = await copyTrade(t, { me: me as `0x${string}`, stillOn })
        if (ev.status !== 'skipped') setShown(list => [{ ...ev, until: Date.now() + SHOW_MS }, ...list].slice(0, 4))
      }
      running = false
    }
    const off = onWalletTrades(leaders, t => {
      const id = `${t.w.toLowerCase()}:${t.t}:${t.ts}:${t.side}:${t.u}`
      if (seen.has(id) || t.c !== 'arc') return
      seen.add(id)
      queue.push(t)
      void run()
    })
    return () => {
      alive = false
      off()
      clearInterval(lease)
      try { const l = JSON.parse(localStorage.getItem(LEASE) ?? 'null') as { id?: string } | null; if (l?.id === tab.current) localStorage.removeItem(LEASE) } catch { /* nothing to release */ }
    }
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
      {shown.map(e => (
        <div key={e.id} className={`pa-toast wt-toast ${e.status === 'filled' ? (e.side === 'B' ? 'buy' : 'sell') : 'sell'}`}>
          <button className="pa-toast-main" onClick={() => { setShown(list => list.filter(x => x.id !== e.id)); navigate(coinPageOf('arc', e.token)) }}>
            <b>⧉ {e.status === 'filled'
              ? (e.side === 'B' ? T('Copied a buy of {coin}', { coin: e.symbol }) : T('Copied a sale of {coin}', { coin: e.symbol }))
              : T('Copy of {coin} failed', { coin: e.symbol })}</b>
            <small>{e.status === 'filled' ? `${usd(e.usd ?? 0)}${e.lagMs ? ` · ${T('{s}s after the leader', { s: (e.lagMs / 1000).toFixed(1) })}` : ''}` : e.why ? T(e.why, e.whyVars) : ''}</small>
          </button>
          <button className="pa-toast-x" aria-label={T('Close')} onClick={() => setShown(list => list.filter(x => x.id !== e.id))}>✕</button>
        </div>
      ))}
    </div>
  )
}
