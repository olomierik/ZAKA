import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import { COIN, COIN_IMAGE, COIN_PATH } from '../lib/coin'
import './landing.css'

// arcsense.site/ — ARCDEX's home page: one screen, no scrolling (owner, 2026-10-18: "only a page like the one I
// uploaded, no scrolling down; remove other texts and explanations, make it simple"). The wordmark, one line, Start
// trading / Explore markets, the wallet-app link and $ARCDEX's contract, over a night sky; ARCDEX's X account in the
// top bar; "Protected by Privy" at the foot. Everyone lands here first, phones too (lib/returning.ts). The page names
// no chain in words (owner, 2026-10-04). A separate small bundle (no wallet libraries); every link goes into the app.

export function mountLanding(root: HTMLElement) {
  document.title = 'ARCDEX · where memecoins meet futures'
  createRoot(root).render(<StrictMode><Landing /></StrictMode>)
}

const LOGIN = '/trenches?login=1'
/** ARCDEX on X (owner, 2026-10-18). */
export const X_URL = 'https://x.com/arcdex2026'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="lp-copy" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? t('Copied') : t('Copy')}
    </button>
  )
}

const XIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)

function Landing() {
  const lang = useLang()
  return (
    <div className="lp">
      <div className="lp-sky" aria-hidden><span className="lp-planet" /></div>

      <header className="lp-nav">
        <a className="lp-brand" href="/" aria-label="ARCDEX"><img src="/arcdex-mark-48.png" alt="" width={26} height={26} /><span>arcdex</span></a>
        <div className="lp-nav-right">
          <a className="lp-x" href={X_URL} target="_blank" rel="noopener noreferrer" aria-label={t('ARCDEX on X')} title={t('ARCDEX on X')}><XIcon /><span>@arcdex2026</span></a>
          <select className="lp-lang" value={lang} onChange={e => void setLang(e.target.value as Lang)} aria-label={t('Language')}>
            {LANGS.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
          </select>
          <a className="lp-btn lp-btn-light lp-btn-sm" href={LOGIN} data-testid="landing-login">{t('Log in')}</a>
        </div>
      </header>

      <main className="lp-hero">
        <h1 className="lp-word">arcdex</h1>
        <p className="lp-tag">{t('where memecoins meet futures.')}</p>
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
      </main>

      <footer className="lp-foot">
        <span className="lp-privy">🔒 {t('Protected by Privy')}</span>
      </footer>
    </div>
  )
}
