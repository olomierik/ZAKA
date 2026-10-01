import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BotProfit } from '../../../api/_marketProtocol'
import { t } from '../lib/i18n'

// Small pop-ups on the landing page whenever a bot takes a profit (owner's
// request, 2026-10-01: "a small notification that won't disturb users and
// should fade away in seconds"). The engine's public feed of winning trades
// (GET /v1/bots/profits: the bot's name and page, never its owner), read every
// 8 seconds while the page is visible. One pop-up at a time, bottom left, gone
// after 4 seconds with a pause before the next; a click opens the bot's page.
// On arrival only the latest recent profit is shown, so the page isn't busy.

const POLL_MS = 8_000
const FIRST_MS = 3_000
/** How long a pop-up is on screen (the CSS animation runs as long), and the quiet time before the next. */
const SHOW_MS = 4_000
const GAP_MS = 6_000
/** At most this many wait their turn: the newest; older ones are dropped rather than shown late. */
const MAX_WAITING = 2

const money = (n: number) => `+$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** One per coin: when many bots take profit on the same signal, the biggest stands for them. */
function bestPerCoin(list: BotProfit[]): BotProfit[] {
  const best = new Map<string, BotProfit>()
  for (const p of list) {
    const k = `${p.token}:${p.mode}`
    const b = best.get(k)
    if (!b || p.pnlUsd > b.pnlUsd) best.set(k, p)
  }
  return [...best.values()].sort((x, y) => y.closedAt - x.closedAt)
}

export default function ProfitToasts({ engine }: { engine: string }) {
  const [current, setCurrent] = useState<BotProfit | null>(null)
  const [waiting, setWaiting] = useState(0)
  const queue = useRef<BotProfit[]>([])
  const seen = useRef(new Set<string>())
  const first = useRef(true)
  const lastShownAt = useRef(0)

  useEffect(() => {
    if (!engine) return
    let alive = true
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      try {
        const r = await fetch(`${engine}/v1/bots/profits`, { signal: AbortSignal.timeout(6_000) })
        if (!r.ok) return
        const j = (await r.json()) as { profits?: BotProfit[] }
        if (!alive || !Array.isArray(j.profits)) return
        const fresh = bestPerCoin(j.profits.filter(p => !seen.current.has(p.id) && p.pnlUsd > 0))
        for (const p of j.profits) seen.current.add(p.id)
        const take = first.current ? fresh.slice(0, 1) : fresh
        first.current = false
        if (!take.length) return
        queue.current = [...take.slice(0, MAX_WAITING), ...queue.current].slice(0, MAX_WAITING)
        setWaiting(queue.current.length)
      } catch { /* the engine is unreachable: no pop-ups, nothing else changes */ }
    }
    const firstId = setTimeout(() => void load(), FIRST_MS)
    const id = setInterval(() => void load(), POLL_MS)
    return () => { alive = false; clearTimeout(firstId); clearInterval(id) }
  }, [engine])

  // One at a time: on screen for SHOW_MS (new arrivals don't extend it), then a quiet GAP_MS before the next.
  useEffect(() => {
    if (!current) return
    const id = setTimeout(() => setCurrent(null), SHOW_MS)
    return () => clearTimeout(id)
  }, [current])
  useEffect(() => {
    if (current || !queue.current.length) return
    const wait = Math.max(0, lastShownAt.current + SHOW_MS + GAP_MS - Date.now())
    const id = setTimeout(() => {
      const next = queue.current.shift() ?? null
      setWaiting(queue.current.length)
      if (next) { lastShownAt.current = Date.now(); setCurrent(next) }
    }, wait)
    return () => clearTimeout(id)
  }, [current, waiting])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="ld-toasts" role="status" aria-live="polite">
      {current && (
        <a key={current.id} className="ld-toast" href={`/bots/${encodeURIComponent(current.slug)}`}>
          <span className="ld-toast-dot" aria-hidden />
          <span className="ld-toast-body">
            <span className="ld-toast-head">
              <b className="ld-toast-name">{current.bot}</b>
              <span className={`ld-toast-mode ${current.mode}`}>{current.mode === 'live' ? t('Live') : t('Paper')}</span>
            </span>
            <span className="ld-toast-text">
              <b className="ld-toast-pnl">{money(current.pnlUsd)}{current.pnlPct !== null ? ` · +${current.pnlPct.toFixed(1)}%` : ''}</b>{' '}
              {t('profit on {coin}', { coin: `$${current.symbol}` })}
            </span>
          </span>
        </a>
      )}
    </div>,
    document.body,
  )
}
