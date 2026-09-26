// A launchpad coin as a card. Its art fills the whole card, and the card is
// never still: the art drifts (a slow zoom and pan, different for every
// card), a sheen sweeps across it now and then, it tilts toward the mouse
// with a glare, and every live buy or sell flashes it green or red with the
// amount floating up. Coins close to graduating glow; new ones pulse. All
// motion pauses while a card is off screen, and stops for people whose
// system asks for less motion (arcdex.css, .coin-card).

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchpadToken } from '../api/launchpad'
import RiskBadge from './RiskBadge'
import Ago from './Ago'
import { riskOf } from '../lib/risk'
import { useNow } from '../lib/ago'
import { t as T } from '../lib/i18n'

/** A live trade to flash on the card; `n` counts them (each flash restarts). */
export interface CardFlash { side: 'buy' | 'sell'; usd: number; n: number }

interface Props {
  token: LaunchpadToken
  flash?: CardFlash
  starred: boolean
  featured?: boolean
  onStar: () => void
  onOpen: () => void
  /** Quick buy ($5); rejects with a message to show. */
  onBuy: () => Promise<void>
}

const GRADUATING = 70

/** A stable number per coin, for its colors and its motion. */
function hashOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Art for a coin without an image: its own two-color glow. */
function artOf(h: number): string {
  const a = h % 360, b = (a + 70 + ((h >>> 9) % 140)) % 360
  return `radial-gradient(circle at 28% 22%, hsl(${a} 90% 62% / .95), transparent 58%), radial-gradient(circle at 78% 74%, hsl(${b} 85% 55% / .9), transparent 62%), linear-gradient(140deg, hsl(${a} 55% 16%), hsl(${b} 60% 10%))`
}

const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(n >= 1 ? 0 : 2)}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const safeUrl = (u?: string) => (u && /^https:\/\//i.test(u) ? u : undefined)
const social = (kind: 'x' | 'tg', v?: string) => {
  if (!v) return undefined
  if (/^https:\/\//i.test(v)) return v
  const handle = v.replace(/^@/, '')
  return kind === 'x' ? `https://x.com/${handle}` : `https://t.me/${handle}`
}

/** "NEW" while a coin is under an hour old (off the shared 1s clock, so only
 * this badge re-renders). */
function NewBadge({ since }: { since: number }) {
  const now = useNow()
  return since > 0 && now - since < 3_600_000 ? <span className="coin-badge new">{T('NEW')}</span> : null
}

function CoinCard({ token: t, flash, starred, featured = false, onStar, onOpen, onBuy }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const h = useMemo(() => hashOf(t.address.toLowerCase()), [t.address])
  const [imgOk, setImgOk] = useState(true)
  const [buying, setBuying] = useState(false)
  const [msg, setMsg] = useState('')
  const img = t.metadata?.image && imgOk ? t.metadata.image : null
  const progress = Math.min(100, t.bondingProgress)
  const graduated = t.curve.graduated
  const launchedMs = t.curve.launchedAt * 1000
  const s = t.stats
  const mc = t.priceUsd * 1_000_000_000

  const risk = useMemo(() => riskOf({
    liquidityUsd: Number(t.curve.rUsdc) / 1e6, marketCapUsd: mc, launchedAt: launchedMs,
    holders: s?.traders || null, txns24h: s?.trades24 ?? null, buys24h: s?.buys24, sells24h: s?.sells24,
    curve: true, bonded: graduated,
  }), [t.curve.rUsdc, mc, launchedMs, s, graduated])

  // Motion only while the card is on screen.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { el?.setAttribute('data-live', ''); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) el.setAttribute('data-live', ''); else el.removeAttribute('data-live') }, { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Tilt toward the mouse, with a glare where it points (straight to the DOM:
  // no re-render per mouse move).
  const tilt = (e: React.PointerEvent) => {
    const el = ref.current
    if (!el || e.pointerType !== 'mouse') return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
    el.style.setProperty('--ry', `${(x - 0.5) * 12}deg`)
    el.style.setProperty('--rx', `${(0.5 - y) * 10}deg`)
    el.style.setProperty('--gx', `${x * 100}%`)
    el.style.setProperty('--gy', `${y * 100}%`)
  }
  const untilt = () => {
    const el = ref.current
    if (!el) return
    for (const k of ['--rx', '--ry']) el.style.setProperty(k, '0deg')
  }

  async function buy(e: React.MouseEvent) {
    e.stopPropagation()
    setBuying(true); setMsg('')
    try { await onBuy(); setMsg(T('Bought ✓')) }
    catch (err) { setMsg(err instanceof Error ? err.message : T('Buy failed')) }
    finally { setBuying(false); setTimeout(() => setMsg(''), 2500) }
  }

  const x = social('x', t.metadata?.twitter), tg = social('tg', t.metadata?.telegram), web = safeUrl(t.metadata?.website)
  const cls = [
    'coin-card',
    featured ? 'featured' : '',
    graduated ? 'graduated' : progress >= GRADUATING ? 'graduating' : '',
    flash ? `flash-${flash.side}-${flash.n % 2}` : '',
  ].filter(Boolean).join(' ')
  const vars = {
    '--kb-delay': `${-(h % 17000)}ms`,
    '--kb-x': `${(h % 2 ? 1 : -1) * (2 + (h >>> 4) % 4)}%`,
    '--kb-y': `${((h >>> 8) % 2 ? 1 : -1) * (2 + (h >>> 12) % 3)}%`,
    '--shine-delay': `${(h >>> 16) % 7000}ms`,
    '--art': img ? undefined : artOf(h),
  } as React.CSSProperties

  return (
    <div ref={ref} className={cls} style={vars} role="link" tabIndex={0} aria-label={`${t.name} ($${t.symbol})`}
      onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen() }} onPointerMove={tilt} onPointerLeave={untilt}>
      <div className="coin-card-inner">
        <div className="coin-art">
          {img
            ? <img src={img} alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} />
            : <span className="coin-art-ticker">{t.symbol.slice(0, 6)}</span>}
        </div>
        <div className="coin-shine" />
        <div className="coin-glare" />
        <div className="coin-scrim" />

        <div className="coin-top">
          <div className="coin-badges">
            {graduated ? <span className="coin-badge grad">{T('✓ Graduated')}</span>
              : progress >= GRADUATING ? <span className="coin-badge hot">🔥 {T('Graduating')}</span>
              : null}
            <NewBadge since={launchedMs} />
            {launchedMs > 0 && <span className="coin-badge age"><Ago ts={launchedMs} /></span>}
          </div>
          <button className={`coin-star${starred ? ' on' : ''}`} title={starred ? T('Remove from watchlist') : T('Add to watchlist')}
            onClick={e => { e.stopPropagation(); onStar() }}>{starred ? '★' : '☆'}</button>
        </div>

        <div className="coin-body">
          <div className="coin-title">
            <span className="coin-ticker">${t.symbol}</span>
            <span className="coin-mc">{usd(mc)}<small>{T('MC')}</small></span>
          </div>
          <div className="coin-name">{t.name}<span> · {T('by')} {short(t.curve.creator)}</span></div>
          {t.metadata?.description && <div className="coin-desc">{t.metadata.description}</div>}
          {!graduated && (
            <div className="coin-progress" title={T('{pct}% of the way to graduating', { pct: progress.toFixed(1) })}>
              <div className="coin-progress-bar"><i style={{ width: `${Math.max(2, progress)}%` }} /></div>
              <b>{progress.toFixed(progress >= 10 ? 0 : 1)}%</b>
            </div>
          )}
          <div className="coin-stats">
            <span title={T('24h volume')}>{T('Vol')} {usd(s?.vol24 ?? 0)}</span>
            <span title={T('Trades in 24h')}>{(s?.trades24 ?? 0).toLocaleString()} {T('trades')}</span>
            <span className="coin-risk"><RiskBadge risk={risk} quick compact /></span>
          </div>
          <div className="coin-foot">
            <div className="coin-links">
              {x && <a href={x} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="X">𝕏</a>}
              {tg && <a href={tg} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="Telegram">✈</a>}
              {web && <a href={web} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={T('Website')}>🌐</a>}
            </div>
            {!graduated && (
              <button className="coin-buy" onClick={e => void buy(e)} disabled={buying}>
                {buying ? T('Buying…') : msg || T('⚡ Buy $5')}
              </button>
            )}
          </div>
        </div>

        {/* The latest live trade: its amount floats up from the card. */}
        {flash && <span key={flash.n} className={`coin-float ${flash.side}`}>{flash.side === 'buy' ? '+' : '-'}{usd(flash.usd)}</span>}
      </div>
    </div>
  )
}

export default memo(CoinCard)
