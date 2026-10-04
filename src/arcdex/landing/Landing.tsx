import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import TrafficCard from './TrafficCard'
import CoinProgram from './CoinProgram'
import { BurnChart, BurnList, BurnMeter, CoinFeed, CoinLiveCard, big, useCoinProgram } from './CoinLive'
import { PHASES, phaseStatus } from './roadmap'
import { ENGINE_API, COIN, COIN_RH, COIN_IMAGE, COIN_PATH, fmtPct, fmtSmallUsd, useCoin, useCoinBurned } from '../lib/coin'
import { isLaunchpadCoin } from '../../../api/_launchpads'
import './landing.css'

// arcsense.site/ — ARCDEX's home page (owner, 2026-10-04: ARCDEX, the multichain decentralized exchange
// for spot and futures, with $ARCDEX as its coin; "make it appealing so it attracts users and holders").
// The hero is the name and its coin: $ARCDEX's live card (price, market cap, the burn meter and every buy,
// sell and burn as it happens). Then live markets, the burn tracker, futures, where the fees go, the app,
// the roadmap and questions. The page names no chain (owner, same day: "we're going multichain; just the
// word ARCDEX"). A separate small bundle (no wallet libraries); every "trade" link goes into the app.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCDEX · Multichain DEX for spot & futures · $ARCDEX'
  createRoot(root).render(<StrictMode><Landing /></StrictMode>)
}

const ENGINE = ENGINE_API
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

interface Row { key: string; href: string; symbol: string; name: string; image: string | null; price: number | null; change: number | null; tag?: string }

/** Live rows for the markets card: launchpad coins trading now, the newest launches, and the futures pairs. */
function useMarkets() {
  const [popular, setPopular] = useState<Row[] | null>(null)
  const [fresh, setFresh] = useState<Row[] | null>(null)
  const [perps, setPerps] = useState<Row[] | null>(null)
  useEffect(() => {
    if (!ENGINE) return
    const get = (path: string) => fetch(`${ENGINE}${path}`, { signal: AbortSignal.timeout(8_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    type Meta = { token: string; name: string; symbol: string; image?: string | null; pool?: string | null; priceUsd?: number | null; marketCapUsd?: number | null; launchpad?: string | null }
    // Listed coins only: $15K or more of market cap (lib/safety.ts LISTING; owner, 2026-10-04).
    const MIN_MC = 15_000
    const load = () => {
      void get('/v1/tokens/active?limit=60').then((j: { tokens?: { token: string; stats: { priceUsd: number | null; marketCapUsd: number | null; chg: { h24: number | null } }; meta: Meta | null }[] } | null) => {
        if (!j?.tokens) return
        // Launchpad coins only (owner, 2026-10-04).
        setPopular(j.tokens.filter(a => a.meta && isLaunchpadCoin(a.meta.launchpad) && a.token !== COIN.toLowerCase() && a.stats.priceUsd && (a.stats.marketCapUsd ?? 0) >= MIN_MC).slice(0, 5).map(a => ({
          key: a.token, href: `/token/${a.token}${a.meta?.pool ? `?pool=${a.meta.pool}` : ''}`, symbol: a.meta!.symbol, name: a.meta!.name,
          image: a.meta!.image ?? null, price: a.stats.priceUsd, change: a.stats.chg.h24,
        })))
      })
      void get('/v1/tokens/new?limit=300').then((j: { launches?: Meta[] } | null) => {
        if (!j?.launches) return
        setFresh(j.launches.filter(l => isLaunchpadCoin(l.launchpad) && (l.marketCapUsd ?? 0) >= MIN_MC).slice(0, 6).map(l => ({
          key: l.token, href: `/token/${l.token}${l.pool ? `?pool=${l.pool}` : ''}`, symbol: l.symbol, name: l.name, image: l.image ?? null, price: l.priceUsd ?? null, change: null, tag: l.launchpad ?? t('New'),
        })))
      })
      void get('/v1/perps/prices').then((j: { feeds?: Record<string, { price: number; change24h: number | null }> } | null) => {
        if (!j?.feeds) return
        setPerps(['BTC', 'ETH', 'SOL'].filter(s => j.feeds![s]).map(s => ({
          key: s, href: '/futures', symbol: `${s}USDC`, name: t('Perpetual'), image: null, price: j.feeds![s].price, change: j.feeds![s].change24h, tag: t('Up to 10×'),
        })))
      })
    }
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 20_000)
    return () => clearInterval(id)
  }, [])
  return { popular, fresh, perps }
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="ld-copy" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? t('Copied ✓') : t('Copy')}
    </button>
  )
}

function Logo({ src, symbol }: { src: string | null; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) return <span className="ld-mk-logo">{symbol.slice(0, 1)}</span>
  return <img className="ld-mk-logo" src={src} alt="" onError={() => setErr(true)} />
}

/** A laurel branch (Binance's award badges): leaves along an arc; `flip` for the right-hand one. */
function Laurel({ flip }: { flip?: boolean }) {
  const leaves = [0, 1, 2, 3, 4, 5]
  return (
    <svg className="ld-laurel-svg" viewBox="0 0 24 48" width="20" height="40" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M18 46 C 6 38, 4 20, 12 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {leaves.map(i => {
        const y = 42 - i * 7.2
        const x = 14 - Math.sin((i / 5) * Math.PI) * 6.5 - i * 0.2
        return <ellipse key={i} cx={x - 3.2} cy={y - 1} rx="4.2" ry="1.9" fill="currentColor" transform={`rotate(${-40 + i * 6} ${x - 3.2} ${y - 1})`} />
      })}
    </svg>
  )
}

const price = (p: number | null) => (p == null ? '—' : p >= 1000 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : fmtSmallUsd(p))

export default function Landing() {
  const lang = useLang()
  const [menu, setMenu] = useState(false)
  const [tab, setTab] = useState<'popular' | 'new' | 'futures'>('popular')
  const navRef = useRef<HTMLElement>(null)
  const coinQ = useCoin()
  const markets = useMarkets()
  const program = useCoinProgram(ENGINE)

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

  const coinRow: Row = { key: 'coin', href: COIN_PATH, symbol: 'ARCDEX', name: 'ARCDEX', image: COIN_IMAGE, price: coinQ?.priceUsd ?? null, change: coinQ?.change24h ?? null, tag: t('Official') }
  const rows = tab === 'popular' ? (markets.popular ? [coinRow, ...markets.popular] : null) : tab === 'new' ? markets.fresh : markets.perps
  const dead = useCoinBurned()
  const burnedPct = dead?.pct ?? program?.burned.pct ?? null

  const PLATFORM: [string, string, string, string][] = [
    ['📈', t('Markets'), t('Every listed coin, live, with a safety rating.'), '/app'],
    ['◆', t('Spot'), t('Buy and sell in one tap, no pop-ups.'), '/spot'],
    ['📊', t('Futures'), t('BTC, ETH and SOL perpetuals, up to 10×.'), '/futures'],
    ['⇄', t('Swap'), t('Any listed coin for USDC, in one step.'), '/swap'],
    ['🌉', t('Bridge'), t('Move USDC in and out in about a minute.'), '/bridge'],
    ['▤', t('Portfolio'), t('Every coin you hold, valued live.'), '/portfolio'],
  ]

  const FAQ: [string, string][] = [
    [t('What is ARCDEX?'), t('A multichain decentralized exchange: spot trading, one-tap swaps, a USDC bridge, and BTC, ETH and SOL perpetual futures, now on testnet.')],
    [t('What is $ARCDEX?'), t('ARCDEX’s platform coin. 30% of ARCDEX’s fees buy back $ARCDEX and burn it, and 70% go to liquidity pools. Every buyback and burn is on-chain and shown live on this page.')],
    [t('How do I buy $ARCDEX?'), t('Open the app, create a trading wallet or connect your own, add USDC, then buy $ARCDEX on its trading page. Always check the contract address: {ca}.', { ca: short(COIN) })],
    [t('Which coins can I trade?'), t('Coins launched on a launchpad with $15K or more of market cap, and stock tokens. Coins from unknown contracts and coins that have rugged aren’t listed.')],
    [t('When do futures launch?'), t('They’re on testnet now: try them with free test USDC, without risk. Mainnet follows an independent security audit; the date will be announced.')],
    [t('Is my money at risk?'), t('Yes. Meme coins are very volatile, and futures with leverage can lose money quickly. Trade only what you can afford to lose. Nothing here is financial advice.')],
  ]

  const phaseNow = PHASES.find(p => phaseStatus(p.n) === 'now') ?? PHASES.find(p => phaseStatus(p.n) === 'next') ?? PHASES[PHASES.length - 1]

  return (
    <div className="ld ld-x" lang={lang}>
      {/* ── nav ─────────────────────────────────────────── */}
      <header className="ld-nav" ref={navRef}>
        <a href="/" className="ld-brand"><img src="/arcdex-mark.png" alt="" width={30} height={30} /><span className="ld-word">arc<span>dex</span></span></a>
        <nav className={`ld-links${menu ? ' open' : ''}`} onClick={() => setMenu(false)}>
          <a href="/app">{t('Markets')}</a>
          <a href="/futures">{t('Futures')} <small className="ld-tag">{t('Testnet')}</small></a>
          <a href="/swap">{t('Swap')}</a>
          <a href="/bridge">{t('Bridge')}</a>
          <a href="#burn" className="ld-link-arcdex">🔥 $ARCDEX</a>
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
          <a className="ld-btn ld-btn-ghost ld-btn-sm ld-hide-sm" href="/app">{t('Launch app')}</a>
          <a className="ld-btn ld-btn-primary ld-btn-sm" href={COIN_PATH}>{t('Buy $ARCDEX')}</a>
          <button className="ld-burger" onClick={() => setMenu(o => !o)} aria-label={t('Menu')}>☰</button>
        </div>
      </header>

      {/* ── hero: the exchange and its coin, live ───────── */}
      <section className="ld-hero">
        <div className="ld-hero-text">
          <div className="ld-pill"><span className="ld-live-dot" />{t('Multichain DEX · spot & futures')}</div>
          <h1 className="ld-h1-name"><span className="ld-hero-blue">ARCDEX</span></h1>
          <p className="ld-lead">{t('The multichain decentralized exchange for spot and futures. 30% of every fee buys back $ARCDEX and burns it.')}</p>
          <div className="ld-laurels">
            <div className="ld-laurel"><Laurel /><div><b>{burnedPct == null ? '…' : `${burnedPct.toFixed(2)}%`}</b><span>{t('Of the supply burned')}</span></div><Laurel flip /></div>
            <div className="ld-laurel"><Laurel /><div><b>30%</b><span>{t('Of fees burn $ARCDEX')}</span></div><Laurel flip /></div>
            <div className="ld-laurel ld-hide-xs"><Laurel /><div><b>10×</b><span>{t('Futures on BTC, ETH and SOL')}</span></div><Laurel flip /></div>
          </div>
          <div className="ld-buybox">
            {/* $ARCDEX's contract on each chain (owner, 2026-10-04: the Robinhood CA below the Arc one). */}
            <div className="ld-cas">
              {([[t('Arc CA'), COIN], [t('Robinhood CA'), COIN_RH]] as const).map(([label, ca]) => (
                <div key={ca} className="ld-ca">
                  <img src={COIN_IMAGE} alt="" width={22} height={22} />
                  <span className="ld-ca-tag">{label}</span>
                  <code title={ca}><span className="ld-ca-full">{ca}</span><span className="ld-ca-short">{short(ca)}</span></code>
                  <Copy text={ca} />
                </div>
              ))}
            </div>
            <a className="ld-btn ld-btn-primary ld-buy" href={COIN_PATH}>{t('Buy $ARCDEX')}</a>
          </div>
          <div className="ld-hero-links">
            <a className="ld-btn ld-btn-ghost ld-btn-sm" href="/app">{t('Explore markets')}</a>
            <a className="ld-btn ld-btn-ghost ld-btn-sm" href="/futures">{t('Try futures free')}</a>
          </div>
          <TrafficCard engine={ENGINE} />
        </div>

        <div className="ld-hero-side">
          <CoinLiveCard engine={ENGINE} program={program} />
        </div>
      </section>

      {/* ── live markets ────────────────────────────────── */}
      <section className="ld-section" id="markets">
        <div className="ld-split-head">
          <div><h2>{t('Live markets')}</h2></div>
          <a className="ld-btn ld-btn-ghost" href="/app">{t('Explore markets')} →</a>
        </div>
        <div className="ld-mkts-solo">
          <div className="ld-card ld-mkts">
            <div className="ld-mkts-tabs">
              {([['popular', t('Popular')], ['new', t('New listing')], ['futures', t('Futures')]] as const).map(([k, l]) => (
                <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
              <a className="ld-mkts-all" href={tab === 'futures' ? '/futures' : '/app'}>{t('View all')} ›</a>
            </div>
            {!rows && <div className="ld-mkts-empty">{t('Loading markets…')}</div>}
            {rows?.length === 0 && <div className="ld-mkts-empty">{t('No new coin has reached $15K of market cap yet.')}</div>}
            {rows?.map(r => (
              <a key={r.key} className={`ld-mkts-row${r.key === 'coin' ? ' arcdex' : ''}`} href={r.href}>
                <Logo src={r.image} symbol={r.symbol} />
                <span className="ld-mkts-name"><b>{r.symbol}</b><small>{r.name}</small>{r.tag && <em>{r.tag}</em>}</span>
                <span className="ld-mkts-price">{price(r.price)}</span>
                <span className={`ld-mkts-chg ${r.change == null ? '' : r.change >= 0 ? 'ld-up' : 'ld-down'}`}>{r.change == null ? '—' : fmtPct(r.change)}</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── the $ARCDEX burn, live ──────────────────────── */}
      <section className="ld-section" id="burn">
        <div className="ld-split-head">
          <div>
            <h2>{t('The $ARCDEX burn, live')}</h2>
          </div>
          <a className="ld-btn ld-btn-primary" href={COIN_PATH}>{t('Buy $ARCDEX')} →</a>
        </div>
        <div className="ld-burngrid">
          <div className="ld-card ld-burncard">
            <BurnMeter program={program} />
            <div className="ld-burncard-h">{t('Burned per day')}</div>
            <BurnChart program={program} />
            <div className="ld-burnstats">
              <div><span>{t('Burns')}</span><b>{program ? program.burned.count.toLocaleString() : '…'}</b></div>
              <div><span>{t('Bought back from fees')}</span><b>{program ? `$${program.totals.buybackUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '…'}</b></div>
              <div><span>{t('Burned by the fee wallet')}</span><b>{program ? big(program.totals.coinBurned) : '…'}</b></div>
            </div>
          </div>
          <div className="ld-card ld-burncard">
            <CoinFeed engine={ENGINE} program={program} limit={10} />
            {program && program.burns.length > 0 && <div className="ld-burncard-h">{t('Latest burns')}</div>}
            <BurnList program={program} limit={5} />
          </div>
        </div>
      </section>

      {/* ── futures ─────────────────────────────────────── */}
      <section className="ld-section" id="futures">
        <div className="ld-split-head">
          <div>
            <h2>{t('Perpetual futures')}</h2>
            <p className="ld-sub">{t('Long or short BTC, ETH and SOL with up to 10× leverage, settled in USDC at RedStone’s signed oracle prices. On testnet now; mainnet after an independent audit.')}</p>
          </div>
          <a className="ld-btn ld-btn-primary" href="/futures">{t('Trade futures')} →</a>
        </div>
        <div className="ld-perps">
          {(markets.perps ?? ['BTC', 'ETH', 'SOL'].map(s => ({ key: s, symbol: `${s}USDC`, price: null, change: null } as Row))).map(p => (
            <a key={p.key} className="ld-card ld-perp" href="/futures">
              <span className="ld-perp-sym">{p.symbol} <small>{t('Perp')}</small></span>
              <b>{price(p.price)}</b>
              <span className="ld-muted">{t('Long or short')} · {t('Up to 10× leverage')}</span>
            </a>
          ))}
        </div>
      </section>

      {/* ── where the fees go: 30% $ARCDEX buyback & burn, 70% liquidity ── */}
      <CoinProgram engine={ENGINE} />

      {/* ── the app ─────────────────────────────────────── */}
      <section className="ld-section" id="platform">
        <h2>{t('Everything to trade, in one place')}</h2>
        <div className="ld-platform">
          {PLATFORM.map(([icon, title, body, href]) => (
            <a key={title} href={href} className="ld-card ld-tile"><span className="ld-icon">{icon}</span><div><h3>{title}</h3><p>{body}</p></div></a>
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

      <section className="ld-final">
        <img src="/arcdex-mark.png" alt="" width={56} height={56} />
        <h2>{t('Trade every chain. Hold $ARCDEX.')}</h2>
        <p>{t('Create a trading wallet in seconds. No sign-up.')}</p>
        <div className="ld-cta ld-center">
          <a className="ld-btn ld-btn-primary" href={COIN_PATH}>{t('Buy $ARCDEX')}</a>
          <a className="ld-btn ld-btn-ghost" href="/app">{t('Launch app')} →</a>
        </div>
      </section>

      <footer className="ld-footer">
        <div className="ld-foot-top">
          <a href="/" className="ld-brand"><img src="/arcdex-mark.png" alt="" width={24} height={24} /><span className="ld-word">arc<span>dex</span></span></a>
          <nav>
            <a href="/app">{t('Markets')}</a>
            <a href="/spot">{t('Spot')}</a>
            <a href="/futures">{t('Futures')}</a>
            <a href="/swap">{t('Swap')}</a>
            <a href="/bridge">{t('Bridge')}</a>
            <a href="/burn">{t('$ARCDEX burn')}</a>
          </nav>
        </div>
        <p className="ld-disclaimer">{t('Trading crypto is risky, and leveraged futures more so. Nothing here is financial advice.')}</p>
        <p className="ld-muted">© 2026 ARCDEX · {t('Multichain Decentralized Exchange')}</p>
      </footer>
    </div>
  )
}
