import { useState, useEffect, useRef } from 'react'
import AccountMenu from './AccountMenu'
import SearchBox from './SearchBox'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { SENSE_IMAGE, SENSE_LC, SENSE_POOL, fmtPct, fmtSmallUsd, useSense } from '../lib/sense'

interface Props { page: Page; navigate: (p: Page) => void; onMenuClick: () => void; onBack?: () => void }

/** $SENSE's trading page (the spot screen opens on it). */
export const SENSE_PAGE: Page = { name: 'argus', address: SENSE_LC, pool: SENSE_POOL }

// Binance's top bar, in ARCSENSE blue: the trading links, a "More" menu for the
// social pages, then search, $SENSE's live price and a Buy $SENSE button, and
// the account. Links that don't fit drop into "More" as the screen narrows.
export default function NavBar({ page, navigate, onMenuClick, onBack }: Props) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [more, setMore] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const sense = useSense()

  useEffect(() => {
    if (!more) return
    const close = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMore(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [more])

  const onSpot = page.name === 'argus' || page.name === 'token'
  const navLinks: { label: string; page: Page; active: boolean; cls?: string; badge?: string }[] = [
    { label: T('Markets'),   page: { name: 'terminal' }, active: page.name === 'terminal' || page.name === 'launchpad' },
    { label: T('Spot'),      page: SENSE_PAGE, active: onSpot },
    { label: T('Futures'),   page: { name: 'futures' }, active: page.name === 'futures', badge: T('Testnet') },
    { label: T('Swap'),      page: { name: 'swap' }, active: page.name === 'swap', cls: 'nav-l1' },
    { label: T('Portfolio'), page: { name: 'portfolio' }, active: page.name === 'portfolio', cls: 'nav-l2' },
    { label: T('Bridge'),    page: { name: 'bridge' }, active: page.name === 'bridge', cls: 'nav-l3' },
    { label: '$SENSE',       page: { name: 'sense' }, active: page.name === 'sense', cls: 'nav-l3 nav-sense-link' },
  ]
  const moreLinks: { label: string; icon: string; page: Page; cls?: string }[] = [
    { label: T('Swap'),        icon: '⇄', page: { name: 'swap' }, cls: 'more-l1' },
    { label: T('Portfolio'),   icon: '▤', page: { name: 'portfolio' }, cls: 'more-l2' },
    { label: T('Bridge'),      icon: '◎', page: { name: 'bridge' }, cls: 'more-l3' },
    { label: T('$SENSE burn'), icon: '🔥', page: { name: 'sense' }, cls: 'more-l3' },
    { label: T('Feed'),        icon: '◉', page: { name: 'feed' } },
    { label: T('Leaderboard'), icon: '♛', page: { name: 'leaderboard' } },
    { label: T('Clans'),       icon: '⚑', page: { name: 'clans' } },
    { label: T('Rewards'),     icon: '✦', page: { name: 'rewards' } },
    { label: T('Alerts'),      icon: '🔔', page: { name: 'alerts' } },
    { label: T('Transfers'),   icon: '⇅', page: { name: 'transfers' } },
    { label: T('Autotrade'),   icon: '⚡', page: { name: 'signals' } },
  ]
  const chg = sense?.change24h ?? null

  return (
    <header className="top-navbar">
      <button className="navbar-hamburger" onClick={onMenuClick} aria-label={T("Menu")}>
        <span /><span /><span />
      </button>
      {/* phones: coin pages are pushed screens with a back arrow */}
      {onBack && <button className="navbar-back" onClick={onBack} aria-label={T("Back")}>‹</button>}

      <button className="navbar-logo" onClick={() => navigate({ name: 'terminal' })}>
        <img src="/arcsense-mark.png" alt="" width={26} height={26} style={{ flexShrink: 0 }} /><span className="brand-word">Arc<span>sense</span></span>
      </button>

      <nav className="navbar-links">
        {navLinks.map(({ label, page: p, active, cls, badge }) => (
          <button key={label} className={`navbar-link${active ? ' active' : ''}${cls ? ` ${cls}` : ''}`} onClick={() => navigate(p)}>
            {label}{badge && <span className="navbar-soon">{badge}</span>}
          </button>
        ))}
      </nav>
      <div className="navbar-more" ref={moreRef}>
        <button className={`navbar-link${more ? ' active' : ''}`} onClick={() => setMore(o => !o)} aria-expanded={more}>{T('More')} <span className="navbar-caret">▾</span></button>
        {more && (
          <div className="menu-pop navbar-more-pop">
            {moreLinks.map(l => (
              <button key={l.label} className={`menu-item${l.cls ? ` ${l.cls}` : ''}`} onClick={() => { setMore(false); navigate(l.page) }}>
                <span style={{ width: 18 }}>{l.icon}</span>{l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search — tokens, traders, clans ("/" to focus) */}
      <SearchBox navigate={navigate} mobileOpen={searchOpen} />
      <button className="navbar-search-toggle" onClick={() => setSearchOpen(o => !o)} aria-label={T("Search")}>
        🔍
      </button>

      <div className="navbar-right">
        {/* $SENSE, live: its price and 24h change, and the way to buy it */}
        <button className="nav-sense" onClick={() => navigate(SENSE_PAGE)} title={T('$SENSE, the ARCSENSE coin')}>
          <img src={SENSE_IMAGE} alt="" width={18} height={18} />
          <b>SENSE</b>
          <span className="nav-sense-price">{fmtSmallUsd(sense?.priceUsd)}</span>
          {chg != null && <span className={`nav-sense-chg ${chg >= 0 ? 'up' : 'down'}`}>{fmtPct(chg)}</span>}
        </button>
        <button className="nav-buy" onClick={() => navigate(SENSE_PAGE)}>{T('Buy $SENSE')}</button>
        <AccountMenu navigate={navigate} />
      </div>
    </header>
  )
}
