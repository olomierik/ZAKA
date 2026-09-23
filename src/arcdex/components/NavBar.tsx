import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import type { Page } from '../App'

interface Props { page: Page; navigate: (p: Page) => void }

export default function NavBar({ navigate }: Props) {
  const [search, setSearch] = useState('')

  return (
    <header className="top-navbar">
      {/* Logo */}
      <button className="navbar-logo" onClick={() => navigate({ name: 'terminal' })}>
        ARCDEX
      </button>
      <span className="navbar-badge">MAINNET</span>

      {/* Nav links */}
      <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        {(['Terminal','Swap','Scanner','Traders','Portfolio'] as const).map(label => (
          <button
            key={label}
            onClick={() => {
              if (label === 'Terminal') navigate({ name: 'terminal' })
              if (label === 'Portfolio') navigate({ name: 'portfolio' })
            }}
            style={{
              padding: '4px 10px', borderRadius: 5, fontSize: '0.72rem', fontWeight: 600,
              border: 'none', cursor: 'pointer', background: 'none',
              color: 'var(--text-muted)', transition: 'color 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search tokens, address…"
        style={{
          flex: 1, maxWidth: 280,
          background: 'var(--bg-3)', border: '1px solid var(--border)',
          color: 'var(--text)', borderRadius: 6, padding: '5px 10px',
          fontSize: '0.72rem', outline: 'none', fontFamily: 'var(--sans)',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
      />

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* live dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: '0.67rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Arc Mainnet</span>
        </div>
        <ConnectKitButton />
      </div>
    </header>
  )
}
