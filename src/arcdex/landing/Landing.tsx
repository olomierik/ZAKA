import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import {
  ARCD, ARCD_APP_PATH, ARCD_POOL, ARC_EXPLORER,
  compact, loadArcd, price, short, type ArcdStats,
} from '../lib/arcd'
import { ARCD_TIERS, arcdAmount, TIERS_ENFORCED, TIERS_START } from '../lib/tiers'
import LiveBots from './LiveBots'
import { PHASES, phaseStatus } from './roadmap'
import './landing.css'

// arcdex.online/ — the landing page (redesigned 2026-10-01, owner's request:
// "more professional, less detail, a new slogan, smaller type"). Autotrade is
// the main feature now: the hero is the slogan and the bots' P&L, live
// (./LiveBots.tsx); then how it works, access tiers by $ARCD (../lib/tiers.ts),
// $ARCD itself, the rest of the app, the roadmap in one line, a few
// questions. A separate small bundle (no wallet libraries); "Launch app"
// goes to /app. The long explanations live in the whitepaper and the FAQ.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCDEX · Self-improving trading bots for Arc'
  createRoot(root).render(<StrictMode><Landing /></StrictMode>)
}

function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="ld-copy" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? t('Copied ✓') : label ?? t('Copy')}
    </button>
  )
}

/** The market engine's REST base (the bots, the scanner, $ARCD's live price), when the site has one. */
const ENGINE = ((import.meta.env.VITE_ARCDEX_API_URL as string | undefined) || ((import.meta.env.VITE_ARCDEX_WS_URL as string | undefined) ?? '').replace(/^ws/, 'http').replace(/\/ws\/?$/, '')).replace(/\/$/, '')
interface ScanNumbers { watching: number; evalsPerMin: number; signals24h: number; rejected24h: number }
type Market = NonNullable<ArcdStats['market']>

/** $ARCD's numbers from the market engine: when /api/arcd has no market (GeckoTerminal unavailable). */
async function engineMarket(): Promise<Market | null> {
  if (!ENGINE) return null
  const r = await fetch(`${ENGINE}/v1/tokens/${ARCD}`, { signal: AbortSignal.timeout(6_000) })
  if (!r.ok) return null
  const j = await r.json() as { stats?: { priceUsd: number | null; marketCapUsd: number | null; liquidityUsd: number | null; vol24: number; chg: { h24: number | null } } | null }
  const s = j.stats
  return s?.priceUsd ? { priceUsd: s.priceUsd, fdvUsd: s.marketCapUsd ?? s.priceUsd * 1e9, liquidityUsd: s.liquidityUsd ?? 0, volume24h: s.vol24, change24h: s.chg.h24 ?? 0, image: null } : null
}

export default function Landing() {
  const lang = useLang()
  const [d, setD] = useState<ArcdStats | null>(null)
  const [fallback, setFallback] = useState<Market | null>(null)
  const [scan, setScan] = useState<ScanNumbers | null>(null)
  const [menu, setMenu] = useState(false)
  const navRef = useRef<HTMLElement>(null)

  // The links fold into the ☰ menu wherever they don't fit on one line.
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const fit = () => {
      nav.classList.remove('ld-nav-fold')
      nav.classList.toggle('ld-nav-fold', nav.scrollWidth > nav.clientWidth + 1)
    }
    fit()
    void document.fonts.ready.then(fit)
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [lang])

  useEffect(() => {
    const load = () => void loadArcd(true).then(x => {
      setD(x)
      if (!x.market) void engineMarket().then(setFallback).catch(() => {})
    }).catch(() => void engineMarket().then(setFallback).catch(() => {}))
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!ENGINE) return
    const load = () => void fetch(`${ENGINE}/v1/bot/scan?limit=1`, { signal: AbortSignal.timeout(6_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { stats?: ScanNumbers } | null) => { if (j?.stats) setScan(j.stats) }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 15_000)
    return () => clearInterval(id)
  }, [])

  const m = d?.market ?? fallback
  const up = (m?.change24h ?? 0) >= 0
  const metrics: [string, string][] = [
    [t('Coins scanned'), scan ? scan.watching.toLocaleString() : '…'],
    [t('Signals in 24h'), scan ? scan.signals24h.toLocaleString() : '…'],
    [t('$ARCD market cap'), m ? '$' + compact(m.fdvUsd) : '…'],
    [t('$ARCD burned'), d?.burned != null ? compact(d.burned) : '…'],
  ]

  const STEPS: [string, string, string][] = [
    ['1', t('Create'), t('Name your bot and pick its strategies.')],
    ['2', t('Trade'), t('It scans every new coin, skips the unsafe ones and sizes each trade.')],
    ['3', t('Learn'), t('It reads its losing trades and adjusts itself.')],
  ]

  const PLATFORM: [string, string, string][] = [
    ['📈', t('Terminal'), t('Every coin on Arc, live.')],
    ['⚡', t('One-tap trading'), t('Buy and sell with no pop-ups.')],
    ['🛡', t('Safety checks'), t('Honeypots and rugs flagged first.')],
    ['🚀', t('Launchpad'), t('Launch a coin on a fair curve.')],
    ['🌉', t('Bridge'), t('USDC from Ethereum and Base.')],
    ['👥', t('Social'), t('Follow traders, join clans.')],
  ]

  const FAQ: [string, string][] = [
    [t('What is Autotrade?'), t('Your own trading bot on ARCDEX. It scans every new coin on Arc, skips the unsafe ones and trades the rest with the strategies you pick, around the clock.')],
    [t('How does a bot improve itself?'), t('After trades close, it reads its losing ones and adjusts its take-profit and entry filters. Every change is logged with its reason, and a change that makes it win less is rolled back.')],
    [t('Is my money at risk?'), t('Every bot starts on paper with virtual USDC. It can go live once its record earns it. Live trading uses real money and can lose it. Nothing here is financial advice.')],
    [t('What are the $ARCD tiers?'), t('Holding $ARCD will unlock more of Autotrade: live trading, more bots and a lower profit fee. The tiers are announced; holdings are checked once accounts can link a wallet.')],
    [t('What is $ARCD?'), t('The official ARCDEX coin: a fixed supply of 1,000,000,000 with no mint function. Platform fees buy it back and burn it.')],
  ]

  const phaseNow = PHASES.find(p => phaseStatus(p.n) === 'now') ?? PHASES.find(p => phaseStatus(p.n) === 'next') ?? PHASES[PHASES.length - 1]

  return (
    <div className="ld" lang={lang}>
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />

      {/* ── nav ─────────────────────────────────────────── */}
      <header className="ld-nav" ref={navRef}>
        <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={26} height={26} />ARCDEX</a>
        <nav className={`ld-links${menu ? ' open' : ''}`} onClick={() => setMenu(false)}>
          <a href="#how">{t('How it works')}</a>
          <a href="#tiers">{t('Tiers')}</a>
          <a href="#arcd">$ARCD</a>
          <a href="/bots">{t('Bots')}</a>
          <a href="/whitepaper">{t('Whitepaper')}</a>
          <div className="ld-menu-lang" onClick={e => e.stopPropagation()}>
            <select className="ld-lang" value={lang} onChange={e => void setLang(e.target.value as Lang)} aria-label={t('Language')}>
              {LANGS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        </nav>
        <div className="ld-nav-right">
          <select className="ld-lang ld-lang-top" value={lang} onChange={e => void setLang(e.target.value as Lang)} aria-label={t('Language')}>
            {LANGS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
          <a className="ld-btn ld-btn-primary ld-btn-sm" href="/app">{t('Launch app')}</a>
          <button className="ld-burger" onClick={() => setMenu(o => !o)} aria-label={t('Menu')}>☰</button>
        </div>
      </header>

      {/* ── hero: the slogan and the bots, live ─────────── */}
      <section className="ld-hero">
        <div className="ld-hero-text">
          <span className="ld-pill"><span className="ld-dot" />{t('Live on Arc mainnet')}</span>
          <h1>{t('Self-improving trading bots for Arc.')}</h1>
          <p className="ld-lead">{t('Name a bot, pick a strategy, press Start. It trades new coins around the clock and learns from every trade.')}</p>
          <div className="ld-cta">
            <a className="ld-btn ld-btn-primary" href="/autotrade">{t('Create your bot')} →</a>
            <a className="ld-btn ld-btn-ghost" href="/app">{t('Launch app')}</a>
          </div>
          <div className="ld-trust">{t('Paper first')} · {t('Rug guard')} · {t('Auto trade size')} · {t('Shareable P&L')}</div>
        </div>
        <LiveBots engine={ENGINE} rows={5} />
      </section>

      <section className="ld-metrics">
        {metrics.map(([k, v]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}
      </section>

      {/* ── how it works ────────────────────────────────── */}
      <section className="ld-section" id="how">
        <h2>{t('How it works')}</h2>
        <div className="ld-steps">
          {STEPS.map(([n, title, body]) => (
            <div key={n} className="ld-card ld-step"><span className="ld-step-n">{n}</span><h3>{title}</h3><p>{body}</p></div>
          ))}
        </div>
      </section>

      {/* ── access tiers ────────────────────────────────── */}
      <section className="ld-section" id="tiers">
        <h2>{t('Autotrade access with $ARCD')}</h2>
        <p className="ld-sub">{t('Tiered by signal quality: the higher the tier, the cleaner the signals. Prime signals, the cleanest, go to Tier 3 with the Precision strategy.')}</p>
        <div className="ld-tiers">
          {ARCD_TIERS.map(tier => (
            <div key={tier.id} className={`ld-card ld-tier${tier.id === 't3' ? ' top' : ''}`}>
              <span className="ld-tier-name">{t(tier.name)}</span>
              <b className="ld-tier-min">{tier.minArcd ? `${arcdAmount(tier.minArcd)} $ARCD` : t('No $ARCD needed')}</b>
              <span className="ld-tier-usd">{tier.minArcd && m ? t('≈ ${v} today', { v: compact(tier.minArcd * m.priceUsd) }) : ' '}</span>
              <ul>{tier.perks.map(x => <li key={x}>{t(x)}</li>)}</ul>
            </div>
          ))}
        </div>
        {!TIERS_ENFORCED && Date.now() < TIERS_START && <p className="ld-note ld-promo">{t('🎉 Free live trading: every account trades live without $ARCD until {d}. Then tiers start.', { d: new Date(TIERS_START).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
        {!TIERS_ENFORCED && <p className="ld-note">{t('Free for now: every tier\'s signals and strategies are open to everyone, so you can see what each one does. Link a wallet in Autotrade to see your tier.')}</p>}
        <div className="ld-cta ld-center"><a className="ld-btn ld-btn-ghost" href={ARCD_APP_PATH}>{t('Buy $ARCD')}</a></div>
      </section>

      {/* ── $ARCD ───────────────────────────────────────── */}
      <section className="ld-section" id="arcd">
        <div className="ld-split">
          <div className="ld-left">
            <h2>$ARCD</h2>
            <p className="ld-sub ld-left">{t('The official ARCDEX coin. A fixed supply of 1B with no mint function. Platform fees buy it back and burn it.')}</p>
            <div className="ld-links-row">
              <a href="/burn">{t('Burn dashboard')} →</a>
              <a href={`${ARC_EXPLORER}/token/${ARCD}`} target="_blank" rel="noopener noreferrer">{t('Explorer')} ↗</a>
              <a href={`https://www.geckoterminal.com/arc/pools/${ARCD_POOL}`} target="_blank" rel="noopener noreferrer">GeckoTerminal ↗</a>
            </div>
          </div>
          <div className="ld-card ld-coin">
            <div className="ld-coin-head">
              <img src={m?.image || '/arcdex-logo.svg'} alt="" width={40} height={40} />
              <div>
                <div className="ld-coin-name">$ARCD</div>
                <div className="ld-muted">ARCDEX · Arc</div>
              </div>
              <div className="ld-coin-price">
                <span>{price(m?.priceUsd)}</span>
                {m ? <span className={up ? 'ld-up' : 'ld-down'}>{up ? '▲' : '▼'} {Math.abs(m.change24h).toFixed(2)}%</span> : <span className="ld-muted">…</span>}
              </div>
            </div>
            <div className="ld-coin-grid">
              <div><span>{t('Market cap')}</span><b>{m ? '$' + compact(m.fdvUsd) : '…'}</b></div>
              <div><span>{t('24h change')}</span><b className={m ? (up ? 'ld-up' : 'ld-down') : ''}>{m ? `${up ? '+' : '−'}${Math.abs(m.change24h).toFixed(2)}%` : '…'}</b></div>
              <div><span>{t('Liquidity')}</span><b>{m ? '$' + compact(m.liquidityUsd) : '…'}</b></div>
              <div><span>{t('Burned')}</span><b className="ld-fire">{d?.burned != null ? compact(d.burned) : '…'}</b></div>
            </div>
            <div className="ld-ca">
              <span className="ld-muted">CA</span>
              <code title={ARCD}>{short(ARCD)}</code>
              <Copy text={ARCD} />
            </div>
            <a className="ld-btn ld-btn-primary ld-btn-block" href={ARCD_APP_PATH}>{t('Buy $ARCD')}</a>
          </div>
        </div>
      </section>

      {/* ── the rest of the app ─────────────────────────── */}
      <section className="ld-section" id="platform">
        <h2>{t('A full trading app for Arc')}</h2>
        <div className="ld-platform">
          {PLATFORM.map(([icon, title, body]) => (
            <div key={title} className="ld-card ld-tile"><span className="ld-icon">{icon}</span><div><h3>{title}</h3><p>{body}</p></div></div>
          ))}
        </div>
      </section>

      {/* ── roadmap, in one line ────────────────────────── */}
      <section className="ld-section" id="roadmap">
        <div className="ld-card ld-road">
          <span className="ld-muted">{t('Roadmap')}</span>
          <div className="ld-road-steps">
            {PHASES.map(p => {
              const st = phaseStatus(p.n)
              return <span key={p.n} className={`ld-road-step ${st}`} title={t(p.title)}>{st === 'done' ? '✓' : p.n}</span>
            })}
          </div>
          <span className="ld-road-now">{t('Now')}: <b>{t(phaseNow.title)}</b></span>
          <a className="ld-link" href="/whitepaper">{t('Whitepaper')} →</a>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────── */}
      <section className="ld-section" id="faq">
        <h2>{t('Questions')}</h2>
        <div className="ld-faq">
          {FAQ.map(([q, a]) => <details key={q} className="ld-card"><summary>{q}</summary><p>{a}</p></details>)}
        </div>
      </section>

      <section className="ld-final ld-card">
        <h2>{t('Start your bot today.')}</h2>
        <p>{t('Free on paper. No wallet needed to try.')}</p>
        <div className="ld-cta ld-center">
          <a className="ld-btn ld-btn-primary" href="/autotrade">{t('Create your bot')} →</a>
          <a className="ld-btn ld-btn-ghost" href="/bots">{t('See all bots')}</a>
        </div>
      </section>

      <footer className="ld-footer">
        <div className="ld-foot-top">
          <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={22} height={22} />ARCDEX</a>
          <nav>
            <a href="/app">{t('App')}</a>
            <a href="/autotrade">{t('Autotrade')}</a>
            <a href="/bots">{t('Bots')}</a>
            <a href="/launchpad">{t('Launchpad')}</a>
            <a href="/burn">{t('Burn dashboard')}</a>
            <a href="/whitepaper">{t('Whitepaper')}</a>
          </nav>
        </div>
        <p className="ld-disclaimer">{t('Paper bots trade virtual USDC; live bots trade real USDC and can lose it. Results shown are real, not promises. Nothing here is financial advice. $ARCD has no promise of value.')}</p>
        <p className="ld-muted">© 2026 ARCDEX</p>
      </footer>
    </div>
  )
}
