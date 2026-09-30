import { useEffect, useRef, useState } from 'react'
import type { BotProfit } from '../../../api/_marketProtocol'
import type { Page } from '../App'
import { botProfits, botSession, engineEnabled, getMarketBot } from '../api/marketStream'
import { t as T } from '../lib/i18n'
import { BotShareModal, cardFromMarket } from './BotShare'
import type { BotCardData } from '../lib/shareCard'

// Profit notifications (owner's request, 2026-10-01: "notifications for each
// profit realized on each trade"). While ARCDEX is open, on any page and in
// any tab, a signed-in owner's bots are asked every 15 seconds (a minute in a
// background tab) for winning trades they closed. Each one shows a toast here
// with Share and View, and, once the owner allows it, a system notification
// (the one that shows with the tab in the background). With every ARCDEX tab
// closed there's no notification: that needs web push, a later step.

const SINCE_KEY = 'arcdex:profit-since'
const SEEN_KEY = 'arcdex:profit-seen'
const ON_KEY = 'arcdex:profit-notify'
const SHOW_MS = 10_000
const STRAT: Record<BotProfit['strategy'], string> = { scalp: 'Fast scalp', snipe: 'Snipe', 'second-leg': 'Dip rebound' }

const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage blocked */ } }
const money = (n: number) => `+$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Whether the owner turned on system notifications for profits (and the browser allows them). */
export function profitNotifyOn(): boolean {
  return read(ON_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'
}
/** Asks the browser, then remembers the choice. */
export async function setProfitNotify(on: boolean): Promise<boolean> {
  if (!on) { write(ON_KEY, '0'); return false }
  if (typeof Notification === 'undefined') return false
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  write(ON_KEY, p === 'granted' ? '1' : '0')
  return p === 'granted'
}

function system(p: BotProfit, onClick: () => void) {
  try {
    if (!profitNotifyOn()) return
    const n = new Notification(T('{bot} took a profit: {usd}', { bot: p.bot, usd: money(p.pnlUsd) }), {
      body: `$${p.symbol}${p.pnlPct !== null ? ` · +${p.pnlPct.toFixed(1)}%` : ''} · ${T(STRAT[p.strategy])}${p.mode === 'live' ? ` · ${T('LIVE')}` : ` · ${T('paper')}`}`,
      icon: '/arcdex-logo.png', tag: p.id,
    })
    n.onclick = () => { window.focus(); onClick(); n.close() }
  } catch { /* unsupported */ }
}

interface Shown extends BotProfit { until: number }

export default function ProfitAlerts({ navigate }: { navigate: (p: Page) => void }) {
  const [session, setSession] = useState(() => botSession())
  const [shown, setShown] = useState<Shown[]>([])
  const [share, setShare] = useState<BotCardData | null>(null)
  const hover = useRef(false)

  useEffect(() => {
    const on = () => setSession(botSession())
    window.addEventListener('arcdex:bot-session', on)
    return () => window.removeEventListener('arcdex:bot-session', on)
  }, [])

  useEffect(() => {
    if (!session || !engineEnabled) return
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null
    // First run on this device: from now (no flood of old trades).
    if (!read(SINCE_KEY)) write(SINCE_KEY, String(Date.now()))
    const seen = new Set<string>((read(SEEN_KEY) ?? '').split(',').filter(Boolean))
    const poll = async () => {
      try {
        const since = Number(read(SINCE_KEY)) || Date.now()
        const r = await botProfits(since)
        if (!alive) return
        const fresh = r.profits.filter(p => !seen.has(p.id)).reverse() // oldest first
        for (const p of fresh) {
          seen.add(p.id)
          system(p, () => navigate({ name: 'signals' }))
        }
        if (fresh.length) {
          const now = Date.now()
          setShown(list => [...fresh.map(p => ({ ...p, until: now + SHOW_MS })), ...list].slice(0, 3))
          write(SEEN_KEY, [...seen].slice(-200).join(','))
        }
        // A little overlap: a trade closing as the answer is built isn't missed (the seen list drops repeats).
        write(SINCE_KEY, String(r.now - 5_000))
      } catch { /* signed out, or the engine is away: next time */ }
      if (alive) timer = setTimeout(() => void poll(), document.hidden ? 60_000 : 15_000)
    }
    void poll()
    const wake = () => { if (!document.hidden && timer) { clearTimeout(timer); void poll() } }
    document.addEventListener('visibilitychange', wake)
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [session, navigate])

  // Toasts leave after 10 seconds (not while the pointer is on them).
  useEffect(() => {
    if (!shown.length) return
    const id = setInterval(() => { if (!hover.current) setShown(list => list.filter(x => x.until > Date.now())) }, 1_000)
    return () => clearInterval(id)
  }, [shown.length])

  const openShare = async (p: BotProfit) => {
    try { setShare(cardFromMarket(await getMarketBot(p.slug))) } catch { navigate({ name: 'signals', view: 'market', bot: p.slug }) }
  }

  return (
    <>
      {shown.length > 0 && (
        <div className="profit-toasts" onMouseEnter={() => { hover.current = true }} onMouseLeave={() => { hover.current = false; setShown(list => list.map(x => ({ ...x, until: Math.max(x.until, Date.now() + 3_000) }))) }}>
          {shown.map(p => (
            <div key={p.id} className="profit-toast" role="status">
              <div className="profit-toast-head">
                <span>💰 {T('{bot} took a profit', { bot: p.bot })}</span>
                <button className="profit-toast-x" aria-label={T('Close')} onClick={() => setShown(list => list.filter(x => x.id !== p.id))}>✕</button>
              </div>
              <div className="profit-toast-amt">{money(p.pnlUsd)} <span>{T('on')} ${p.symbol}{p.pnlPct !== null ? ` · +${p.pnlPct.toFixed(1)}%` : ''}</span></div>
              <div className="profit-toast-meta">{T(STRAT[p.strategy])} · {p.mode === 'live' ? <b style={{ color: '#ef4444' }}>{T('LIVE')}</b> : T('paper')}{p.feeUsd ? ` · ${T('after the 2% fee')}` : ''}</div>
              <div className="profit-toast-btns">
                <button onClick={() => void openShare(p)}>📤 {T('Share P&L card')}</button>
                <button onClick={() => { navigate({ name: 'signals' }); setShown(list => list.filter(x => x.id !== p.id)) }}>{T('View')}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {share && <BotShareModal data={share} mine onClose={() => setShare(null)} />}
    </>
  )
}
