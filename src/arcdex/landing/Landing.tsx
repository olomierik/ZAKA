import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import TrafficCard from './TrafficCard'
import { PHASES, phaseStatus } from './roadmap'
import './landing.css'

// arcsense.site/ — the landing page. ARCSENSE (2026-10-03, owner): spot and
// futures trading on Arc. The hero is the slogan and the futures to come; then
// the app's features, the futures plan, the roadmap in one line and a few
// questions. A separate small bundle (no wallet libraries); "Launch app" goes
// to /app.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCSENSE · Spot and futures trading on Arc'
  createRoot(root).render(<StrictMode><Landing /></StrictMode>)
}

/** The market engine's REST base (the scanner's numbers), when the site has one. */
const ENGINE = ((import.meta.env.VITE_ARCDEX_API_URL as string | undefined) || ((import.meta.env.VITE_ARCDEX_WS_URL as string | undefined) ?? '').replace(/^ws/, 'http').replace(/\/ws\/?$/, '')).replace(/\/$/, '')
interface ScanNumbers { watching: number; evalsPerMin: number; signals24h: number; rejected24h: number }

/** The futures markets planned first (Chainlink Data Feeds on Arc). */
const PERPS = ['BTC', 'ETH', 'SOL']

export default function Landing() {
  const lang = useLang()
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
    if (!ENGINE) return
    const load = () => void fetch(`${ENGINE}/v1/bot/scan?limit=1`, { signal: AbortSignal.timeout(6_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { stats?: ScanNumbers } | null) => { if (j?.stats) setScan(j.stats) }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 15_000)
    return () => clearInterval(id)
  }, [])

  const metrics: [string, string][] = [
    [t('Coins tracked'), scan ? scan.watching.toLocaleString() : '…'],
    [t('Safety checks a minute'), scan ? scan.evalsPerMin.toLocaleString() : '…'],
  ]

  const PLATFORM: [string, string, string][] = [
    ['📈', t('Terminal'), t('Every coin on Arc, live.')],
    ['⚡', t('One-tap trading'), t('Buy and sell with no pop-ups.')],
    ['🛡', t('Safety checks'), t('Honeypots and rugs flagged first.')],
    ['🚀', t('Launchpad'), t('Launch a coin on a fair curve.')],
    ['🌉', t('Bridge'), t('USDC from Ethereum and Base.')],
    ['📊', t('Futures'), t('BTC, ETH and SOL perpetuals, coming soon.')],
  ]

  const FUTURES: [string, string][] = [
    [t('USDC in, USDC out'), t('Margin, profits and fees are all in USDC, the currency Arc runs on.')],
    [t('Chainlink prices'), t('Positions are priced by Chainlink feeds on Arc, not by thin pools anyone can push.')],
    [t('Fees fund the pool'), t('Fees from $SENSE trading are added as liquidity for futures trading.')],
  ]

  const FAQ: [string, string][] = [
    [t('What is ARCSENSE?'), t('A trading app for Arc: a live terminal for every coin, one-tap swaps, a launchpad, a USDC bridge and, soon, perpetual futures.')],
    [t('When do futures launch?'), t('On Arc testnet first, so traders can try them without risk. Mainnet follows an independent security audit; the date will be announced.')],
    [t('What is $SENSE?'), t('The ARCSENSE coin, launching on Argus. Fees from $SENSE trading are added as liquidity for futures trading.')],
    [t('Is my money at risk?'), t('Yes. Coins on Arc are very volatile, and futures with leverage can lose money quickly. Trade only what you can afford to lose. Nothing here is financial advice.')],
  ]

  const phaseNow = PHASES.find(p => phaseStatus(p.n) === 'now') ?? PHASES.find(p => phaseStatus(p.n) === 'next') ?? PHASES[PHASES.length - 1]

  return (
    <div className="ld" lang={lang}>
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />

      {/* ── nav ─────────────────────────────────────────── */}
      <header className="ld-nav" ref={navRef}>
        <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={26} height={26} />ARCSENSE</a>
        <nav className={`ld-links${menu ? ' open' : ''}`} onClick={() => setMenu(false)}>
          <a href="#platform">{t('Features')}</a>
          <a href="#futures">{t('Futures')}</a>
          <a href="#roadmap">{t('Roadmap')}</a>
          <a href="#faq">{t('Questions')}</a>
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

      {/* ── hero: the slogan, and the futures to come ───── */}
      <section className="ld-hero">
        <div className="ld-hero-text">
          <span className="ld-pill"><span className="ld-dot" />{t('Live on Arc mainnet')}</span>
          <h1>{t('Spot and futures trading on Arc.')}</h1>
          <p className="ld-lead">{t('Trade every coin on Arc in one tap, launch your own, and soon go long or short on BTC, ETH and SOL. All in USDC.')}</p>
          <div className="ld-cta">
            <a className="ld-btn ld-btn-primary" href="/app">{t('Launch app')} →</a>
            <a className="ld-btn ld-btn-ghost" href="/launchpad">{t('Launchpad')}</a>
          </div>
          <div className="ld-trust">{t('One-tap trading')} · {t('Safety checks')} · {t('USDC in and out')} · {t('7 languages')}</div>
          <TrafficCard engine={ENGINE} />
        </div>
        <div className="ld-card ld-perps">
          <div className="ld-perps-head"><b>{t('Perpetual futures')}</b><span className="ld-pill">{t('Coming soon')}</span></div>
          {PERPS.map(c => (
            <div key={c} className="ld-perps-row"><b>{c}-PERP</b><span className="ld-muted">{t('Long or short')} · {t('Up to 10× leverage')}</span></div>
          ))}
          <p className="ld-muted">{t('Testnet first, then mainnet after an independent audit.')}</p>
        </div>
      </section>

      <section className="ld-metrics">
        {metrics.map(([k, v]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}
      </section>

      {/* ── the app ─────────────────────────────────────── */}
      <section className="ld-section" id="platform">
        <h2>{t('A full trading app for Arc')}</h2>
        <div className="ld-platform">
          {PLATFORM.map(([icon, title, body]) => (
            <div key={title} className="ld-card ld-tile"><span className="ld-icon">{icon}</span><div><h3>{title}</h3><p>{body}</p></div></div>
          ))}
        </div>
      </section>

      {/* ── futures ─────────────────────────────────────── */}
      <section className="ld-section" id="futures">
        <h2>{t('Perpetual futures, coming to Arc')}</h2>
        <p className="ld-sub">{t('Long or short BTC, ETH and SOL with up to 10× leverage, settled in USDC and priced by Chainlink. Testnet first, then mainnet after an independent audit.')}</p>
        <div className="ld-steps">
          {FUTURES.map(([title, body], i) => (
            <div key={title} className="ld-card ld-step"><span className="ld-step-n">{i + 1}</span><h3>{title}</h3><p>{body}</p></div>
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
        <h2>{t('Start trading on Arc.')}</h2>
        <p>{t('Create a trading wallet in seconds. No sign-up.')}</p>
        <div className="ld-cta ld-center">
          <a className="ld-btn ld-btn-primary" href="/app">{t('Launch app')} →</a>
        </div>
      </section>

      <footer className="ld-footer">
        <div className="ld-foot-top">
          <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={22} height={22} />ARCSENSE</a>
          <nav>
            <a href="/app">{t('App')}</a>
            <a href="/swap">{t('Swap')}</a>
            <a href="/launchpad">{t('Launchpad')}</a>
            <a href="/bridge">{t('Bridge')}</a>
            <a href="/portfolio">{t('Portfolio')}</a>
          </nav>
        </div>
        <p className="ld-disclaimer">{t('Trading crypto is risky, and leveraged futures more so. Nothing here is financial advice.')}</p>
        <p className="ld-muted">© 2026 ARCSENSE</p>
      </footer>
    </div>
  )
}
