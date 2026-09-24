import { useState, useEffect } from 'react'
import AccountMenu from './AccountMenu'
import SearchBox from './SearchBox'
import { getPlatformTokenStats, type PlatformTokenStats } from '../api/launchpad'
import type { Page } from '../App'

interface Props { page: Page; navigate: (p: Page) => void; onMenuClick: () => void }

function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(2)
}

function BurnTicker() {
  const [stats, setStats] = useState<PlatformTokenStats | null>(null)
  useEffect(() => {
    const load = () => void getPlatformTokenStats().then(setStats)
    load()
    const iv = setInterval(load, 15_000)
    return () => clearInterval(iv)
  }, [])
  if (!stats) return null
  return (
    <div className="navbar-burn-ticker">
      <span>🔥</span>
      <span style={{ color: 'var(--amber)', fontWeight: 700 }}>{fmtCompact(stats.burned)} {stats.symbol} burned</span>
      <span style={{ color: 'var(--text-muted)' }}>({stats.burnedPct.toFixed(2)}%)</span>
    </div>
  )
}

export default function NavBar({ page, navigate, onMenuClick }: Props) {
  const [searchOpen, setSearchOpen] = useState(false)

  const navLinks: { label: string; page: Page }[] = [
    { label: 'Terminal',    page: { name: 'terminal' } },
    { label: 'Feed',        page: { name: 'feed' } },
    { label: 'Leaderboard', page: { name: 'leaderboard' } },
    { label: 'Clans',       page: { name: 'clans' } },
    { label: 'Rewards',     page: { name: 'rewards' } },
    { label: 'Launchpad',   page: { name: 'launchpad' } },
    { label: 'Portfolio',   page: { name: 'portfolio' } },
  ]

  return (
    <header className="top-navbar">
      <button className="navbar-hamburger" onClick={onMenuClick} aria-label="Menu">
        <span /><span /><span />
      </button>

      {/* Logo */}
      <button className="navbar-logo" onClick={() => navigate({ name: 'terminal' })} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src="/arcdex-logo.svg" alt="" width={24} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />
        ARCDEX
      </button>
      <span className="navbar-badge">MAINNET</span>
      <BurnTicker />

      {/* Nav links */}
      <nav className="navbar-links">
        {navLinks.map(({ label, page: p }) => (
          <button
            key={label}
            className={`navbar-link${page.name === p.name ? ' active' : ''}`}
            onClick={() => navigate(p)}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Search — tokens, traders, clans ("/" to focus) */}
      <SearchBox navigate={navigate} mobileOpen={searchOpen} />
      <button className="navbar-search-toggle" onClick={() => setSearchOpen(o => !o)} aria-label="Search">
        🔍
      </button>

      <div className="navbar-right">
        {/* live dot */}
        <div className="navbar-live">
          <div className="pulse-dot" />
          <span style={{ fontSize: '0.67rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Arc Mainnet</span>
        </div>
        <AccountMenu navigate={navigate} />
      </div>
    </header>
  )
}
