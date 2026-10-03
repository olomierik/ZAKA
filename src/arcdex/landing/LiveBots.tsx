import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MarketBot } from '../../../api/_marketProtocol'
import { t } from '../lib/i18n'

// The landing page's live bot board (owner's request, 2026-10-01: "put the
// real movement of the bots' P&L on the landing page, with true numbers in
// real time"). The marketplace's own numbers (GET /v1/bots, the same list as
// arcsense.site/bots), polled every 5 seconds while the page is visible:
// each P&L counts to its new value, a row flashes green or red when it
// changes, and a bot that moves up or down slides to its new rank.

const POLL_MS = 5_000
const STRATEGY: Record<MarketBot['strategies'][number], [string, string]> = {
  snipe: ['Snipe', '#3b82f6'], scalp: ['Fast scalp', '#f59e0b'], 'second-leg': ['Dip rebound', '#a855f7'], precision: ['Precision', '#facc15'],
}
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (n: number | null) => n === null ? '' : `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}%`

/** A number that counts to its new value instead of jumping. */
function Tween({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value)
  const cur = useRef(value)
  useEffect(() => {
    const from = cur.current, to = value
    if (from === to) return
    if (reduced()) { cur.current = to; setShown(to); return }
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 800)
      cur.current = from + (to - from) * (1 - Math.pow(1 - k, 3))
      setShown(cur.current)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{format(shown)}</>
}

interface Move { dir: 'up' | 'down'; n: number; rank?: 'up' | 'down' }

export default function LiveBots({ engine, rows: shownRows = 7 }: { engine: string; rows?: number }) {
  const [bots, setBots] = useState<MarketBot[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [moves, setMoves] = useState<Record<string, Move>>({})
  const last = useRef(new Map<string, { pnl: number; rank: number }>())
  const rows = useRef(new Map<string, HTMLAnchorElement>())
  const tops = useRef(new Map<string, number>())
  const beat = useRef(0)

  useEffect(() => {
    if (!engine) return
    let alive = true
    const load = () => fetch(`${engine}/v1/bots?sort=pnl&limit=100`, { signal: AbortSignal.timeout(6_000) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { bots: MarketBot[] }) => {
        if (!alive) return
        // Bots that have traded, or hold something now: the rest have no P&L to show.
        const list = j.bots.filter(b => b.closed > 0 || b.positions.length > 0)
        const next: Record<string, Move> = {}
        beat.current++
        list.forEach((b, i) => {
          const was = last.current.get(b.slug)
          if (was && Math.abs(b.pnlUsd - was.pnl) >= 0.005) next[b.slug] = { dir: b.pnlUsd > was.pnl ? 'up' : 'down', n: beat.current }
          if (was && i < shownRows && was.rank !== i) next[b.slug] = { ...(next[b.slug] ?? { dir: i < was.rank ? 'up' : 'down', n: beat.current }), rank: i < was.rank ? 'up' : 'down' }
        })
        last.current = new Map(list.map((b, i) => [b.slug, { pnl: b.pnlUsd, rank: i }]))
        setMoves(next)
        setBots(list)
        setFailed(false)
      })
      .catch(() => { if (alive) setFailed(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [engine, shownRows])

  // A bot that changed rank slides from where it was.
  useLayoutEffect(() => {
    const now = new Map<string, number>()
    for (const [slug, el] of rows.current) now.set(slug, el.offsetTop)
    if (!reduced()) {
      for (const [slug, top] of now) {
        const was = tops.current.get(slug)
        const el = rows.current.get(slug)
        if (was === undefined || was === top || !el) continue
        el.style.transition = 'none'
        el.style.transform = `translateY(${was - top}px)`
        requestAnimationFrame(() => { el.style.transition = 'transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)'; el.style.transform = '' })
      }
    }
    tops.current = now
  }, [bots])

  if (!engine || (failed && !bots)) return null
  const shown = bots?.slice(0, shownRows) ?? []
  const combined = bots?.reduce((s, b) => s + b.pnlUsd, 0) ?? 0
  const trades = bots?.reduce((s, b) => s + b.closed, 0) ?? 0

  return (
    <div className="ld-card ld-bots">
      <div className="ld-bots-head">
        <span className="ld-bots-live"><span className="ld-dot" />{t('LIVE')}</span>
        <span className="ld-muted">{bots ? t('{n} bots · {t} trades', { n: bots.length, t: trades.toLocaleString() }) : t('Loading bots…')}</span>
        {bots && (
          <span className="ld-bots-sum">{t('Combined P&L')} <b className={combined >= 0 ? 'ld-up' : 'ld-down'}><Tween value={combined} format={money} /></b></span>
        )}
      </div>
      {!bots ? (
        <div className="ld-bots-list">{Array.from({ length: 4 }, (_, i) => <div key={i} className="ld-bot ld-bot-skel" />)}</div>
      ) : (
        <div className="ld-bots-list">
          {shown.map((b, i) => {
            const mv = moves[b.slug]
            const open = b.positions.filter(p => p.pnlUsd !== null)
            return (
              <a key={b.slug} href={`/bots/${encodeURIComponent(b.slug)}`} ref={el => { if (el) rows.current.set(b.slug, el); else rows.current.delete(b.slug) }}
                className={`ld-bot${mv ? ` ld-flash-${mv.dir}-${mv.n % 2 ? 'a' : 'b'}` : ''}`}>
                <span className="ld-bot-rank">{i + 1}{mv?.rank && <i className={mv.rank === 'up' ? 'ld-up' : 'ld-down'}>{mv.rank === 'up' ? '▲' : '▼'}</i>}</span>
                <span className="ld-bot-main">
                  <span className="ld-bot-name">
                    🤖 <b>{b.name}</b>
                    <span className={`ld-bot-mode${b.mode === 'live' ? ' live' : ''}`}>{b.mode === 'live' ? t('LIVE') : t('PAPER')}</span>
                    {b.running && <span className="ld-bot-run">● {t('Running')}</span>}
                    {b.strategies.map(s => <span key={s} className="ld-bot-strat" style={{ color: STRATEGY[s][1], borderColor: `${STRATEGY[s][1]}66` }}>{t(STRATEGY[s][0])}</span>)}
                  </span>
                  <span className="ld-bot-meta">
                    {t('{n} trades', { n: b.closed })}{b.winRate !== null ? ` · ${t('{p}% won', { p: Math.round(b.winRate * 100) })}` : ''}
                    {open.length > 0 && <> · {t('holding')} {open.slice(0, 2).map(p => <span key={p.token} className={(p.pnlUsd ?? 0) >= 0 ? 'ld-up' : 'ld-down'}> ${p.symbol} {money(p.pnlUsd ?? 0)}</span>)}</>}
                    {b.learned > 0 && ` · ${t('learned {n}×', { n: b.learned })}`}
                  </span>
                </span>
                <span className="ld-bot-pnl">
                  <b className={b.pnlUsd >= 0 ? 'ld-up' : 'ld-down'}><Tween value={b.pnlUsd} format={money} /></b>
                  {b.pnlPct !== null && <small className={b.pnlPct >= 0 ? 'ld-up' : 'ld-down'}>{pct(b.pnlPct)}</small>}
                </span>
              </a>
            )
          })}
        </div>
      )}
      {bots && <a className="ld-bots-all" href="/bots">{t('See all bots')} →</a>}
    </div>
  )
}
