import { useState, useEffect } from 'react'
import AccountMenu from './AccountMenu'
import SearchBox from './SearchBox'
import { compact, loadArcd, type ArcdStats } from '../lib/arcd'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

interface Props { page: Page; navigate: (p: Page) => void; onMenuClick: () => void; onBack?: () => void }

// 🔥 $ARCD burned — links to the buyback-and-burn dashboard.
function BurnTicker({ navigate }: { navigate: (p: Page) => void }) {
  const [stats, setStats] = useState<ArcdStats | null>(null)
  useEffect(() => {
    const load = () => void loadArcd().then(setStats).catch(() => {})
    load()
    const iv = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => clearInterval(iv)
  }, [])
  const pct = stats?.burnedPct ?? 0
  return (
    <button className="navbar-burn-ticker" onClick={() => navigate({ name: 'burn' })} title={T('$ARCD buyback & burn')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
      <span>🔥</span>
      <span style={{ color: 'var(--amber)', fontWeight: 700 }}>$ARCD {stats ? compact(stats.burned) : '…'}{' '}{T("burned")}</span>
      {pct >= 0.01 && <span style={{ color: 'var(--text-muted)' }}>({pct.toFixed(2)}%)</span>}
    </button>
  )
}

export default function NavBar({ page, navigate, onMenuClick, onBack }: Props) {
  const [searchOpen, setSearchOpen] = useState(false)

  // Secondary links drop out on narrower desktops (they're also in the
  // left panel and the account menu); trading links always show.
  const navLinks: { label: string; page: Page; secondary?: boolean }[] = [
    { label: T('Terminal'),    page: { name: 'terminal' } },
    { label: T('Swap'),        page: { name: 'swap' } },
    { label: T('Bridge'),      page: { name: 'bridge' } },
    { label: T('Launchpad'),   page: { name: 'launchpad' } },
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
        <img src="/arcdex-logo.svg" alt="" width={24} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />{T("ARCDEX")}</button>
      <span className="navbar-badge">{T("MAINNET")}</span>
      <BurnTicker navigate={navigate} />

      {/* Nav links */}
      <nav className="navbar-links">
        {navLinks.map(({ label, page: p, secondary }) => (
          <button
            key={label}
            className={`navbar-link${page.name === p.name ? ' active' : ''}${secondary ? ' nav-secondary' : ''}`}
            onClick={() => navigate(p)}
          >
            {label}
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
