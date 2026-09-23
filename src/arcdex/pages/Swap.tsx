import { useState, useEffect, useMemo } from 'react'
import { getTokens, type ArcToken } from '../api/radardex'
import SwapWidget from '../components/SwapWidget'
import type { Page } from '../App'

interface Props { navigate: (p: Page) => void }

export default function Swap({ navigate }: Props) {
  const [tokens, setTokens] = useState<ArcToken[]>([])
  const [query, setQuery]   = useState('')
  const [picked, setPicked] = useState<ArcToken | null>(null)

  useEffect(() => { void getTokens().then(setTokens) }, [])

  const matches = useMemo(() => {
    if (!query || picked) return []
    const q = query.toLowerCase()
    return tokens
      .filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase() === q)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 8)
  }, [tokens, query, picked])

  return (
    <div style={{ maxWidth: 440, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: 4 }}>Swap</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 20 }}>
        Trade any Arc mainnet token against USDC — 1% platform fee, same router as every token page.
      </p>

      {!picked ? (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 20 }}>
          <input
            autoFocus
            placeholder="Search by symbol, name, or address…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{
              padding: '11px 13px', borderRadius: 8, fontSize: '0.9rem',
              background: 'var(--bg-2)', border: '1px solid var(--card-border)', color: 'var(--text)',
              outline: 'none', width: '100%', marginBottom: matches.length ? 10 : 0,
            }}
          />
          {matches.map(t => (
            <div key={t.address} onClick={() => setPicked(t)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px', borderRadius: 8, cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0 }}>
                {t.symbol.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{t.symbol}</div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>${t.price < 0.01 ? t.price.toExponential(2) : t.price.toFixed(4)}</div>
            </div>
          ))}
          {query && matches.length === 0 && (
            <div style={{ padding: '16px 8px', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>No tokens match "{query}"</div>
          )}
        </div>
      ) : (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px 0' }}>
            <button onClick={() => { setPicked(null); setQuery('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.78rem' }}>
              ← Choose a different token
            </button>
            <button onClick={() => navigate({ name: 'token', address: picked.address, symbol: picked.symbol })} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.72rem' }}>
              View chart →
            </button>
          </div>
          <SwapWidget token={picked} />
        </div>
      )}
    </div>
  )
}
