import { ConnectKitButton } from 'connectkit'
import type { Page } from '../App'

interface Props {
  page:     Page
  navigate: (p: Page) => void
}

export default function NavBar({ page, navigate }: Props) {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 50,
      background: 'rgba(6,13,24,0.85)',
      backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--card-border)',
      padding: '0 24px',
      height: '56px',
      display: 'flex', alignItems: 'center', gap: '24px',
    }}>
      {/* Logo */}
      <button
        onClick={() => navigate({ name: 'terminal' })}
        style={{
          fontFamily: 'var(--sans)', fontWeight: 700, fontSize: '1.125rem',
          letterSpacing: '-0.02em', color: 'var(--text)',
          background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}
      >
        <span style={{
          background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          fontWeight: 800,
        }}>ARCDEX</span>
        <span style={{ fontSize: '0.625rem', color: 'var(--green)', border: '1px solid var(--green)',
          borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--mono)', fontWeight: 600 }}>
          MAINNET
        </span>
      </button>

      {/* Nav links */}
      <nav style={{ display: 'flex', gap: '4px', flex: 1 }}>
        {([
          { name: 'terminal',  label: 'Terminal' },
          { name: 'portfolio', label: 'Portfolio' },
        ] as const).map(item => (
          <button
            key={item.name}
            onClick={() => navigate({ name: item.name })}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: '0.875rem', fontWeight: 500,
              border: 'none', cursor: 'pointer', transition: 'all 0.15s',
              background: page.name === item.name ? 'var(--bg-3)' : 'transparent',
              color: page.name === item.name ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Live indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <div className="pulse-dot" />
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
          Arc Mainnet
        </span>
      </div>

      <ConnectKitButton />
    </header>
  )
}
