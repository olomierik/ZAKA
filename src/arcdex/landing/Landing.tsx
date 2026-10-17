import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import TrafficCard from './TrafficCard'
import { ENGINE_API, COIN, COIN_IMAGE, COIN_PATH, fmtPct } from '../lib/coin'
import type { TrendRow, TrendingAnswer } from '../../../api/trending'
import { onTraffic, startTraffic, type TrafficCounts } from '../lib/traffic'
import { useLogo } from '../lib/logo'
import './landing.css'

// arcsense.site/ — ARCDEX's home page, rebuilt as simply as fomo's (2026-10-17, owner: "redesign the landing page to
// be simple; remake it by changing everything, like the fomo landing page"). fomo's page is a giant wordmark and one
// line over a dark sky with two buttons, a product shot, six short feature cards and a closing call. This one is the
// same shape: the wordmark, one line and Start trading; a live terminal (the coins people are buying now, from the
// engine's /api/trending) where fomo shows a screenshot; six cards; a closing call; a small footer. The page still
// names no chain in words (owner, 2026-10-04: "just the word ARCDEX"): chains show as logos. $ARCDEX's contract stays
// in the hero. A separate small bundle (no wallet libraries); every "trade" link goes into the app.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCDEX · where memecoins meet futures'
  createRoot(root).render(<StrictMode><Landing /></StrictMode>)
}

const ENGINE = ENGINE_API
const LOGIN = '/trenches?login=1'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const usdShort = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`)

/** Each chain's logo (DefiLlama's icon CDN, as the app's Swap and Bridge show them). */
const CHAIN_LOGO: Record<TrendRow['chain'], string> = {
  arc: 'https://icons.llamao.fi/icons/chains/rsz_arc.jpg', robinhood: 'https://icons.llamao.fi/icons/chains/rsz_robinhood.jpg',
  solana: 'https://icons.llamao.fi/icons/chains/rsz_solana.jpg', bsc: 'https://icons.llamao.fi/icons/chains/rsz_bsc.jpg',
}
const coinHref = (r: TrendRow) => {
  const pool = r.pool ? `?pool=${encodeURIComponent(r.pool)}` : ''
  return r.chain === 'arc' ? `/token/${r.address}${pool}` : r.chain === 'solana' ? `/solana/token/${r.address}${pool}`
    : r.chain === 'bsc' ? `/bnb/token/${r.address}${pool}` : `/robinhood/token/${r.address}${pool}`
}

/** The busiest listed coins on every chain (engine /api/trending, every 20s). */
function useTrending(): TrendRow[] | null {
  const [v, setV] = useState<TrendRow[] | null>(null)
  useEffect(() => {
    if (!ENGINE) return
    let alive = true
    const load = () => void fetch(`${ENGINE}/api/trending`, { signal: AbortSignal.timeout(8_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: TrendingAnswer | null) => { if (alive && j?.rows) setV(j.rows) }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return v
}

function useTraffic(): TrafficCounts | null {
  const [c, setC] = useState<TrafficCounts | null>(null)
  useEffect(() => { if (!ENGINE) return; startTraffic(ENGINE); return onTraffic(setC) }, [])
  return c
}

function Logo({ src, symbol, size = 34 }: { src: string | null; symbol: string; size?: number }) {
  const { url, onError } = useLogo(src, size)
  return url
    ? <img className="lp-logo" src={url} alt="" width={size} height={size} loading="lazy" onError={onError} />
    : <span className="lp-logo lp-logo-blank" style={{ width: size, height: size }}>{symbol.replace(/^\$/, '').slice(0, 2).toUpperCase()}</span>
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="lp-copy" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? t('Copied') : t('Copy')}
    </button>
  )
}

/** fomo shows a screenshot of its app here; this is the app's own feed: what people are buying right now. */
function LiveTerminal({ rows }: { rows: TrendRow[] | null }) {
  const list = rows?.slice(0, 7)
  return (
    <div className="lp-term" aria-label={t('Trending now')}>
      <div className="lp-term-bar">
        <span className="lp-term-dots"><i /><i /><i /></span>
        <b><span className="lp-dot" />{t('Trending now')}</b>
        <a href="/trenches">{t('Open the terminal')} →</a>
      </div>
      <div className="lp-term-cols"><span>{t('Coin')}</span><span>{t('Market cap')}</span><span>24h</span><span className="lp-hide-xs">{t('Volume')}</span></div>
      {!list && <div className="lp-term-empty">{t('Loading markets…')}</div>}
      {list?.map((r, i) => (
        <a key={`${r.chain}:${r.address}`} className="lp-term-row" href={coinHref(r)} style={{ animationDelay: `${i * 60}ms` }}>
          <span className="lp-term-coin">
            <span className="lp-term-pic"><Logo src={r.image} symbol={r.symbol} /><img className="lp-term-chain" src={CHAIN_LOGO[r.chain]} alt="" width={14} height={14} /></span>
            <span><b>{r.symbol}</b><small>{r.launchpad ?? r.name}</small></span>
          </span>
          <span>{usdShort(r.marketCapUsd)}</span>
          <span className={r.change24h >= 0 ? 'lp-up' : 'lp-down'}>{fmtPct(r.change24h)}</span>
          <span className="lp-hide-xs">{usdShort(r.volume24h)}</span>
        </a>
      ))}
    </div>
  )
}

function Landing() {
  const lang = useLang()
  const rows = useTrending()
  const traffic = useTraffic()
  const features: [string, string, string, string][] = [
    ['trenches', t('LIVE LAUNCHES'), t('every launch, as it happens'), t('New coins, almost bonded and migrated, streaming in seconds after they land.')],
    ['trending', t('TRENDING NOW'), t('see what people are buying'), t('The coins with the most buyers in the last hour, across every chain.')],
    ['safety', t('SAFETY FIRST'), t('spot the rug before it pulls'), t('Dev sold, bundlers, snipers and a safety rating on every coin, in plain words.')],
    ['futures', t('BEYOND MEMECOINS'), t('futures & predictions'), t('Long or short crypto, stocks and commodities, and trade on what happens next.')],
    ['login', t('EASY ONBOARDING'), t('log in with your email'), t('Your wallet is made for you in seconds: no app, no seed phrase.')],
    ['chains', t('ZERO COMPLEXITY'), t('every chain, one wallet'), t('Pay with USDC, SOL or ETH from wherever your money already is.')],
  ]

  return (
    <div className="lp">
      <div className="lp-sky" aria-hidden><span className="lp-planet" /></div>

      <header className="lp-nav">
        <a className="lp-brand" href="/" aria-label="ARCDEX"><img src="/arcdex-mark-48.png" alt="" width={26} height={26} /><span>arcdex</span></a>
        <nav className="lp-links">
          <a href="/trenches">{t('Trenches')}</a>
          <a href="/futures">{t('Futures')}</a>
          <a href="/predict">{t('Predict')}</a>
        </nav>
        <div className="lp-nav-right">
          <select className="lp-lang" value={lang} onChange={e => void setLang(e.target.value as Lang)} aria-label={t('Language')}>
            {LANGS.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
          </select>
          <a className="lp-btn lp-btn-light lp-btn-sm" href={LOGIN} data-testid="landing-login">{t('Log in')}</a>
        </div>
      </header>

      <section className="lp-hero">
        <h1 className="lp-word">arcdex</h1>
        <p className="lp-tag">{t('where memecoins meet futures.')}</p>
        <p className="lp-sub">{t('New launches, trending coins, futures and predictions. Trade any of them in seconds.')}</p>
        <div className="lp-ctas">
          <a className="lp-btn lp-btn-primary" href={LOGIN}>{t('Start trading')}</a>
          <a className="lp-btn lp-btn-dark" href="/trenches">{t('Explore markets')}</a>
        </div>
        <a className="lp-alt" href="/trenches?connect=wallet">{t('Use MetaMask, Phantom or another wallet app instead')}</a>
        <div className="lp-ca">
          <img src={COIN_IMAGE} alt="" width={20} height={20} />
          <span className="lp-ca-tag">$ARCDEX</span>
          <code title={COIN}><span className="lp-ca-full">{COIN}</span><span className="lp-ca-short">{short(COIN)}</span></code>
          <Copy text={COIN} />
          <a href={COIN_PATH}>{t('Buy')}</a>
        </div>
      </section>

      <section className="lp-section lp-center">
        <span className="lp-kicker">{t('LIVE NOW')}</span>
        <h2>{t('trade what’s moving.')}<br />{t('before everyone else.')}</h2>
        <p className="lp-lead">{t('Every coin as it launches, bonds and migrates, and what people are buying right now.')}</p>
        <LiveTerminal rows={rows} />
      </section>

      <section className="lp-section">
        <h2 className="lp-h-left">{t('never miss a move')}</h2>
        <p className="lp-lead lp-h-left">{t('everything a trader needs, in one place')}</p>
        <div className="lp-cards">
          {features.map(([k, kicker, title, body]) => (
            <div key={k} className={`lp-card lp-card-${k}`}>
              <span className="lp-kicker">{kicker}</span>
              <h3>{title}</h3>
              <p>{body}</p>
              <FeatureArt k={k} rows={rows} />
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-center lp-final">
        <h2>{t('a trading terminal')}<br />{t('for everyone')}</h2>
        {traffic && traffic.total > 0 && <p className="lp-lead">{t('{n} traders have visited ARCDEX', { n: traffic.total.toLocaleString('en-US') })}</p>}
        <div className="lp-ctas">
          <a className="lp-btn lp-btn-primary" href={LOGIN}>{t('Start trading')}</a>
          <a className="lp-btn lp-btn-dark" href="/trenches">{t('Explore markets')}</a>
        </div>
      </section>

      <footer className="lp-footer">
        <a className="lp-brand" href="/"><img src="/arcdex-mark-48.png" alt="" width={20} height={20} /><span>arcdex</span></a>
        <nav>
          <a href="/trenches">{t('Trenches')}</a>
          <a href="/futures">{t('Futures')}</a>
          <a href="/predict">{t('Predict')}</a>
          <a href="/burn">$ARCDEX</a>
          <a href="/routes">{t('Supported routes')}</a>
        </nav>
        <TrafficCard engine={ENGINE} />
        <small>{t('Trading is risky: coins can lose all their value. Nothing here is advice.')}</small>
      </footer>
    </div>
  )
}

/** Each card's small picture, drawn from the page's own data (no stock art). */
function FeatureArt({ k, rows }: { k: string; rows: TrendRow[] | null }) {
  if (k === 'chains') return <div className="lp-art lp-art-chains">{Object.values(CHAIN_LOGO).map(u => <img key={u} src={u} alt="" width={40} height={40} />)}</div>
  if (k === 'trending' || k === 'trenches') {
    const r = (rows ?? []).slice(k === 'trending' ? 0 : 3, k === 'trending' ? 3 : 6)
    return (
      <div className="lp-art lp-art-rows">
        {r.map(x => <span key={x.address}><Logo src={x.image} symbol={x.symbol} size={22} /><b>{x.symbol}</b><em className={x.change24h >= 0 ? 'lp-up' : 'lp-down'}>{fmtPct(x.change24h)}</em></span>)}
      </div>
    )
  }
  if (k === 'safety') return <div className="lp-art lp-art-chips"><span className="ok">{t('Safe')}</span><span>{t('DS 0%')}</span><span>{t('Bundlers 0')}</span><span className="warn">{t('Snipers 4')}</span></div>
  if (k === 'futures') return <div className="lp-art lp-art-chips"><span className="ok">{t('Long')} BTC</span><span className="bad">{t('Short')} ETH</span><span>{t('Yes')} 62¢</span></div>
  return <div className="lp-art lp-art-login"><span>✉ {t('Continue with email')}</span><span>G {t('Continue with Google')}</span></div>
}
