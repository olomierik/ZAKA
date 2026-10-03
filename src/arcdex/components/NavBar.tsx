import { useState, useEffect } from 'react'
import AccountMenu from './AccountMenu'
import SearchBox from './SearchBox'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

interface Props { page: Page; navigate: (p: Page) => void; onMenuClick: () => void; onBack?: () => void }

export default function NavBar({ page, navigate, onMenuClick, onBack }: Props) {
  const [searchOpen, setSearchOpen] = useState(false)

  // Secondary links drop out on narrower desktops (they're also in the
  // left panel and the account menu); trading links always show.
  const navLinks: { label: string; page: Page; secondary?: boolean; accent?: boolean }[] = [
    { label: T('Spot'),        page: { name: 'terminal' } },
    { label: T('Futures'),     page: { name: 'futures' }, accent: true },
    { label: T('Swap'),        page: { name: 'swap' } },
    { label: T('Bridge'),      page: { name: 'bridge' } },
    { label: T('Portfolio'),   page: { name: 'portfolio' } },
    { label: T('Feed'),        page: { name: 'feed' }, secondary: true },
    { label: T('Leaderboard'), page: { name: 'leaderboard' }, secondary: true },
    { label: T('Clans'),       page: { name: 'clans' }, secondary: true },
    { label: T('Rewards'),     page: { name: 'rewards' }, secondary: true },
  ]

  return (
    <header className="top-navbar">
      <button className="navbar-hamburger" onClick={onMenuClick} aria-label={T("Menu")}>
        <span /><span /><span />
      </button>
      {/* phones: coin pages are pushed screens with a back arrow */}
      {onBack && <button className="navbar-back" onClick={onBack} aria-label={T("Back")}>‹</button>}

      {/* Logo */}
      <button className="navbar-logo" onClick={() => navigate({ name: 'terminal' })} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src="/arcsense-mark.png" alt="" width={26} height={26} style={{ flexShrink: 0 }} /><span className="brand-word">Arc<span>sense</span></span></button>
      <span className="navbar-badge">{T("MAINNET")}</span>

      {/* Nav links */}
      <nav className="navbar-links">
        {navLinks.map(({ label, page: p, secondary, accent }) => (
          <button
            key={label}
            className={`navbar-link${page.name === p.name ? ' active' : ''}${secondary ? ' nav-secondary' : ''}${accent ? ' navbar-autotrade' : ''}`}
            onClick={() => navigate(p)}
          >
            {label}{accent && <span className="navbar-soon">{T('Soon')}</span>}
          </button>
        ))}
      </nav>

      {/* Search — tokens, traders, clans ("/" to focus) */}
      <SearchBox navigate={navigate} mobileOpen={searchOpen} />
      <button className="navbar-search-toggle" onClick={() => setSearchOpen(o => !o)} aria-label={T("Search")}>
        🔍
      </button>

      <div className="navbar-right">
        {/* live dot */}
        <div className="navbar-live">
          <div className="pulse-dot" />
          <span style={{ fontSize: '0.67rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{T("Arc Mainnet")}</span>
        </div>
        <AccountMenu navigate={navigate} />
      </div>
    </header>
  )
}
