import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import {
  ARCD, ARCD_APP_PATH, ARCD_POOL, ARCD_SUPPLY, ARC_EXPLORER, BURN_ADDRESS, FEE_WALLET,
  compact, loadArcd, price, short, type ArcdStats,
} from '../lib/arcd'
import './landing.css'

// arcdex.online/ — the landing page: what ARCDEX is, $ARCD (the official
// coin) and how platform fees buy it back and burn it, with live on-chain
// numbers. A separate small bundle (no wallet libraries); "Launch app"
// goes to /app.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCDEX — The social trading app for Arc · $ARCD'
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

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 3600 ? t('{n} min ago', { n: Math.max(1, Math.floor(s / 60)) }) : s < 86400 ? t('{n} hours ago', { n: Math.floor(s / 3600) }) : t('{n} days ago', { n: Math.floor(s / 86400) })
}

export default function Landing() {
  const lang = useLang()
  const [d, setD] = useState<ArcdStats | null>(null)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    const load = () => void loadArcd(true).then(setD).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => clearInterval(id)
  }, [])

  const m = d?.market
  const burnedPct = d?.burnedPct ?? 0
  const stats: [string, string][] = [
    [t('$ARCD burned'), d ? compact(d.burned) + ' ARCD' : '…'],
    [t('Of supply burned'), d ? (burnedPct < 0.01 ? '0%' : burnedPct.toFixed(2) + '%') : '…'],
    ...(d?.fees
      ? [[t('Platform fees generated'), '$' + compact(d.fees.feesUsdc)], [t('Traders on ARCDEX'), compact(d.fees.traders).replace(/\.00$/, '')]] as [string, string][]
      : [[t('$ARCD liquidity'), m ? '$' + compact(m.liquidityUsd) : '…'], [t('$ARCD market cap'), m ? '$' + compact(m.fdvUsd) : '…']] as [string, string][]),
  ]

  const FEATURES: [string, string, string][] = [
    ['⚡', t('One-tap trading'), t('A trading wallet in your browser: buy and sell in one tap, no pop-ups. Protect it with a passkey.')],
    ['👀', t("See who's buying"), t('Every trade on the chart is a trader’s avatar. Follow the best traders and get an alert the moment they move.')],
    ['⚑', t('Clans, leaderboards & points'), t('Team up in clans, climb the leaderboard and earn ARCDEX Points every season.')],
    ['🛡', t('Safety checks on every coin'), t('Dev sells, top-holder share, creator taxes and honeypot flags — before you trade.')],
    ['💳', t('Deposit your way'), t('Send USDC on Arc, bridge it from Ethereum or Base with Circle CCTP, or pay with a card, Apple Pay or Google Pay.')],
    ['🚀', t('Launch a coin'), t('Launch on a fair bonding curve and earn 60% of your creator tax in USDC on every trade.')],
    ['🤝', t('Invite & earn'), t('Earn 15% of the trading fees of everyone you invite — paid on-chain, on every trade, forever.')],
    ['🌍', t('Your language'), 'English · Français · Español · Português · Kiswahili · Deutsch · 中文'],
  ]

  const FLOW: [string, string, string][] = [
    ['1', t('You trade'), t('Every swap, launchpad trade and bridge on ARCDEX pays a small fee in USDC.')],
    ['2', t('Fees reach one public wallet'), t('All platform fees land in the ARCDEX fee wallet — anyone can watch it on-chain.')],
    ['3', t('Buyback'), t('The fee wallet uses that USDC to buy $ARCD on the open market, from the ARCD/USDC pool.')],
    ['4', t('Burn'), t('The $ARCD bought back is sent to the burn address. Nobody can ever move it again — the supply only goes down.')],
  ]

  const FEES: [string, string, string][] = [
    [t('Swaps on ARCDEX'), t('2% of each trade, in USDC'), t('85% — the other 15% rewards the trader’s referrer')],
    [t('Launchpad trades'), t('1% platform fee + the coin’s creator tax (0–3%)'), t('The 1% plus 40% of the creator tax — 60% goes to the coin’s creator')],
    [t('Bridge (Circle CCTP)'), t('0.5% of the transfer (min $0.05, max $50)'), t('90% — Circle keeps 10%')],
  ]

  const FAQ: [string, string][] = [
    [t('What is ARCDEX?'), t('ARCDEX is the social trading app for Arc: a terminal for every new coin, one-tap trading, live trader activity, clans, leaderboards and a launchpad. Everything settles on-chain in USDC, and you always keep your own keys.')],
    [t('What is $ARCD?'), t('$ARCD is the one official ARCDEX coin, launched on Argus on Arc mainnet. Its supply is fixed at 1,000,000,000 — the contract has no mint function — and ARCDEX’s fees are used to buy it back and burn it.')],
    [t('Which fees buy back and burn $ARCD?'), t('All of ARCDEX’s own fee revenue: its share of swap fees, launchpad fees and bridge fees. Referral rewards and creators’ shares are paid to them first; everything the platform keeps goes to buyback and burn.')],
    [t('How often do buybacks and burns happen?'), t('As fees build up in the fee wallet, they are used to buy back $ARCD, which is then burned. Every burn is a public transaction — you can see them on this page and on the Arc explorer.')],
    [t('Is $ARCD an investment?'), t('No. $ARCD is a community coin with no promise of profit. Burning reduces the supply but does not guarantee any price. Crypto is risky — only use money you can afford to lose.')],
    [t('Do I need $ARCD to use ARCDEX?'), t('No. You trade with USDC, and gas on Arc is paid in USDC too. Holding $ARCD is optional.')],
    [t('How do I get started?'), t('Open the app, connect a wallet or create a one-tap trading wallet, deposit USDC and start trading. It takes about a minute.')],
  ]

  const up = (m?.change24h ?? 0) >= 0

  return (
    <div className="ld" lang={lang}>
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />

      {/* ── nav ─────────────────────────────────────────── */}
      <header className="ld-nav">
        <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={30} height={30} />ARCDEX</a>
        <nav className={`ld-links${menu ? ' open' : ''}`} onClick={() => setMenu(false)}>
          <a href="#features">{t('Features')}</a>
          <a href="#arcd">$ARCD</a>
          <a href="#burn">{t('Buyback & burn')}</a>
          <a href="#faq">{t('FAQ')}</a>
          {/* phones: the language picker lives in this menu */}
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

      {/* ── hero ────────────────────────────────────────── */}
      <section className="ld-hero">
        <div className="ld-hero-text">
          <span className="ld-pill"><span className="ld-dot" />{t('Live on Arc mainnet')}</span>
          <h1>{t('The social trading app for Arc.')}</h1>
          <p className="ld-lead">{t('Trade every new coin on Arc in one tap, see who’s buying in real time and follow the best traders. Every fee the platform earns buys back and burns $ARCD.')}</p>
          <div className="ld-cta">
            <a className="ld-btn ld-btn-primary" href="/app">{t('Launch app')} →</a>
            <a className="ld-btn ld-btn-ghost" href={ARCD_APP_PATH}>🔥 {t('Buy $ARCD')}</a>
          </div>
          <div className="ld-trust">{t('USDC-native · gas paid in USDC · self-custody')}</div>
        </div>

        <div className="ld-card ld-coin">
          <div className="ld-coin-head">
            <img src={m?.image || '/arcdex-logo.svg'} alt="" width={48} height={48} />
            <div>
              <div className="ld-coin-name">$ARCD <span className="ld-tag">{t('Official coin')}</span></div>
              <div className="ld-muted">ARCDEX · Arc mainnet</div>
            </div>
          </div>
          <div className="ld-coin-price">
            <span>{price(m?.priceUsd)}</span>
            {m && <span className={up ? 'ld-up' : 'ld-down'}>{up ? '▲' : '▼'} {Math.abs(m.change24h).toFixed(2)}%</span>}
          </div>
          <div className="ld-coin-grid">
            <div><span>{t('Market cap')}</span><b>{m ? '$' + compact(m.fdvUsd) : '…'}</b></div>
            <div><span>{t('Liquidity')}</span><b>{m ? '$' + compact(m.liquidityUsd) : '…'}</b></div>
            <div><span>{t('Burned')}</span><b className="ld-fire">{d ? compact(d.burned) : '…'}</b></div>
            <div><span>{t('Supply')}</span><b>1B</b></div>
          </div>
          <div className="ld-ca">
            <span className="ld-muted">CA</span>
            <code title={ARCD}>{short(ARCD)}</code>
            <Copy text={ARCD} />
          </div>
          <a className="ld-btn ld-btn-primary ld-btn-block" href={ARCD_APP_PATH}>{t('Buy $ARCD on ARCDEX')}</a>
        </div>
      </section>

      {/* ── live stats ──────────────────────────────────── */}
      <section className="ld-stats">
        {stats.map(([k, v]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}
      </section>

      {/* ── features ────────────────────────────────────── */}
      <section className="ld-section" id="features">
        <h2>{t('Everything you need to trade Arc')}</h2>
        <p className="ld-sub">{t('Built for the coins launching on Arc every day — fast, social and safe.')}</p>
        <div className="ld-features">
          {FEATURES.map(([icon, title, body]) => (
            <div key={title} className="ld-card ld-feature"><div className="ld-icon">{icon}</div><h3>{title}</h3><p>{body}</p></div>
          ))}
        </div>
      </section>

      {/* ── $ARCD ───────────────────────────────────────── */}
      <section className="ld-section" id="arcd">
        <div className="ld-split">
          <div>
            <span className="ld-pill ld-pill-fire">🔥 $ARCD</span>
            <h2>{t('$ARCD — the official ARCDEX coin')}</h2>
            <p className="ld-sub ld-left">{t('$ARCD is the one official coin of ARCDEX. Its supply is fixed at 1,000,000,000 and can only go down: the contract has no mint function, and every fee the platform earns is used to buy $ARCD back and burn it.')}</p>
            <div className="ld-card ld-ca-big">
              <span className="ld-muted">{t('Contract address (Arc mainnet)')}</span>
              <code>{ARCD}</code>
              <Copy text={ARCD} label={t('Copy address')} />
            </div>
            <div className="ld-warn">⚠ {t('Only this contract is the official $ARCD. Anyone can launch a copycat with the same name — always check the address.')}</div>
            <div className="ld-cta">
              <a className="ld-btn ld-btn-primary" href={ARCD_APP_PATH}>{t('Buy $ARCD')}</a>
              <a className="ld-btn ld-btn-ghost" href={ARCD_APP_PATH}>{t('View chart')}</a>
              <a className="ld-btn ld-btn-ghost" href={`${ARC_EXPLORER}/token/${ARCD}`} target="_blank" rel="noopener noreferrer">{t('Arc explorer')} ↗</a>
              <a className="ld-btn ld-btn-ghost" href={`https://www.geckoterminal.com/arc/pools/${ARCD_POOL}`} target="_blank" rel="noopener noreferrer">GeckoTerminal ↗</a>
            </div>
          </div>
          <div className="ld-card ld-facts">
            {([
              [t('Name'), 'ARCDEX'], [t('Symbol'), 'ARCD'], [t('Network'), 'Arc mainnet'],
              [t('Total supply'), ARCD_SUPPLY.toLocaleString('en-US')], [t('Mint function'), t('None — supply can never increase')],
              [t('Launched on'), 'Argus (Portal 8)'], [t('Pool'), 'ARCD / USDC · Uniswap v4'],
              [t('Burn address'), short(BURN_ADDRESS)],
            ] as [string, string][]).map(([k, v]) => <div key={k} className="ld-fact"><span>{k}</span><b>{v}</b></div>)}
          </div>
        </div>
      </section>

      {/* ── buyback & burn ──────────────────────────────── */}
      <section className="ld-section" id="burn">
        <span className="ld-pill ld-pill-fire">🔥 {t('Buyback & burn')}</span>
        <h2>{t('Every fee buys back and burns $ARCD')}</h2>
        <p className="ld-sub">{t('ARCDEX earns money only from fees — and doesn’t keep them. 100% of the platform’s fee revenue goes back into $ARCD: bought on the open market and sent to the burn address, where no one can ever move it again.')}</p>

        <div className="ld-flow">
          {FLOW.map(([n, title, body]) => (
            <div key={n} className="ld-card ld-step"><div className="ld-step-n">{n}</div><h3>{title}</h3><p>{body}</p></div>
          ))}
        </div>

        <div className="ld-card ld-table-card">
          <h3>{t('Where the fees come from')}</h3>
          <div className="ld-table">
            <div className="ld-tr ld-th"><span>{t('Source')}</span><span>{t('Fee')}</span><span>{t('Goes to buyback & burn')}</span></div>
            {FEES.map(([a, b, c]) => <div key={a} className="ld-tr"><span>{a}</span><span>{b}</span><span className="ld-fire">{c}</span></div>)}
          </div>
        </div>

        <div className="ld-tracker">
          <div className="ld-card ld-track-main">
            <span className="ld-muted">{t('Burned so far')}</span>
            <div className="ld-big ld-fire">{d ? compact(d.burned) : '…'} <small>ARCD</small></div>
            <div className="ld-bar"><div style={{ width: `${(d?.burned ?? 0) >= 1 ? Math.min(100, Math.max(burnedPct, 0.5)) : 0}%` }} /></div>
            <span className="ld-muted">{d ? t('{pct}% of the 1,000,000,000 supply', { pct: burnedPct < 0.01 ? '0' : burnedPct.toFixed(2) }) : '…'}</span>
            <div className="ld-track-grid">
              <div><span>{t('USDC in the fee wallet')}</span><b>{d?.feeWallet.usdc != null ? '$' + compact(d.feeWallet.usdc) : '…'}</b></div>
              <div><span>{t('$ARCD in the fee wallet')}</span><b>{d?.feeWallet.arcd != null ? compact(d.feeWallet.arcd) : '…'}</b></div>
              {d?.fees && <div><span>{t('Swap fees generated')}</span><b>${compact(d.fees.feesUsdc)}</b></div>}
              {d?.fees && <div><span>{t('Fees in the last 24h')}</span><b>${compact(d.fees.fees24h)}</b></div>}
            </div>
          </div>
          <div className="ld-card ld-track-list">
            <h3>{t('Recent burns')}</h3>
            {!d ? <div className="ld-muted">{t('Loading…')}</div> : d.burns.length === 0 ? (
              <div className="ld-muted">{t('No burns in the last 48 hours. Burns appear here the moment they land on-chain.')}</div>
            ) : d.burns.slice(0, 8).map(b => (
              <a key={b.tx + b.block} className="ld-burn" href={`${ARC_EXPLORER}/tx/${b.tx}`} target="_blank" rel="noopener noreferrer">
                <span>🔥 <b>{compact(b.amount)} ARCD</b></span><span className="ld-muted">{b.time ? ago(b.time) : '#' + b.block} ↗</span>
              </a>
            ))}
            <a className="ld-link" href="/burn">{t('Open the burn dashboard')} →</a>
          </div>
        </div>

        <div className="ld-verify">
          <b>{t('Don’t trust — verify.')}</b> {t('Every buyback and burn is a public transaction from the fee wallet to the burn address.')}{' '}
          <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noopener noreferrer">{t('Fee wallet')} {short(FEE_WALLET)} ↗</a>{' · '}
          <a href={`${ARC_EXPLORER}/address/${BURN_ADDRESS}`} target="_blank" rel="noopener noreferrer">{t('Burn address')} {short(BURN_ADDRESS)} ↗</a>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────── */}
      <section className="ld-section" id="faq">
        <h2>{t('Questions')}</h2>
        <div className="ld-faq">
          {FAQ.map(([q, a]) => <details key={q} className="ld-card"><summary>{q}</summary><p>{a}</p></details>)}
        </div>
      </section>

      {/* ── final CTA ───────────────────────────────────── */}
      <section className="ld-final ld-card">
        <h2>{t('Ready to trade Arc?')}</h2>
        <p>{t('Open ARCDEX, deposit USDC and make your first trade in about a minute.')}</p>
        <div className="ld-cta ld-center">
          <a className="ld-btn ld-btn-primary" href="/app">{t('Launch app')} →</a>
          <a className="ld-btn ld-btn-ghost" href={ARCD_APP_PATH}>🔥 {t('Buy $ARCD')}</a>
        </div>
      </section>

      <footer className="ld-footer">
        <div className="ld-foot-top">
          <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={24} height={24} />ARCDEX</a>
          <nav>
            <a href="/app">{t('App')}</a>
            <a href="/leaderboard">{t('Leaderboard')}</a>
            <a href="/rewards">{t('Rewards')}</a>
            <a href="/launchpad">{t('Launchpad')}</a>
            <a href="/burn">{t('Burn dashboard')}</a>
          </nav>
        </div>
        <p className="ld-disclaimer">{t('ARCDEX is non-custodial software on Arc: you control your wallet and your funds. Nothing on this site is financial advice. Crypto prices are volatile and you can lose money. $ARCD has no promise of value or profit.')}</p>
        <p className="ld-muted">© 2026 ARCDEX</p>
      </footer>
    </div>
  )
}
