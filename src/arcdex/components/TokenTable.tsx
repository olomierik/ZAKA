import { useState } from 'react'
import type { ArcToken } from '../api/radardex'
import { getLaunchpadColor } from '../api/radardex'
import type { Page } from '../App'

type SortKey = 'marketCap' | 'price' | 'priceChange24h' | 'volume24h' | 'liquidity' | 'ageMs'

function fmt(n: number, compact = true): string {
  if (compact) {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
    if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
    return `$${n.toFixed(2)}`
  }
  return `$${n.toFixed(6)}`
}

function age(ms: number): string {
  const s = ms / 1000
  if (s < 3600)   return `${Math.floor(s / 60)}m`
  if (s < 86400)  return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

interface Props {
  tokens:   ArcToken[]
  loading:  boolean
  navigate: (p: Page) => void
  filter:   string
  launchpad: string
}

export default function TokenTable({ tokens, loading, navigate, filter, launchpad }: Props) {
  const [sort, setSort] = useState<SortKey>('marketCap')
  const [dir, setDir]   = useState<1 | -1>(-1)

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir(d => d === -1 ? 1 : -1)
    else { setSort(key); setDir(-1) }
  }

  const filtered = tokens
    .filter(t => {
      const q = filter.toLowerCase()
      const matchQuery = !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)
      const matchLp = !launchpad || t.launchpad === launchpad
      return matchQuery && matchLp
    })
    .sort((a, b) => (a[sort] - b[sort]) * dir)

  const headers: { key: SortKey; label: string; align?: string }[] = [
    { key: 'marketCap',      label: 'MCap' },
    { key: 'price',          label: 'Price',     align: 'right' },
    { key: 'priceChange24h', label: '24h %',     align: 'right' },
    { key: 'volume24h',      label: 'Volume 24h', align: 'right' },
    { key: 'liquidity',      label: 'Liquidity', align: 'right' },
    { key: 'ageMs',          label: 'Age',        align: 'right' },
  ]

  return (
    <div className="table-scroll">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
            <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)',
              fontWeight: 500, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>#</th>
            <th style={{ padding: '10px 8px', textAlign: 'left', color: 'var(--text-muted)',
              fontWeight: 500, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Token</th>
            <th style={{ padding: '10px 8px', textAlign: 'left', color: 'var(--text-muted)',
              fontWeight: 500, fontSize: '0.75rem' }}>Source</th>
            {headers.map(h => (
              <th
                key={h.key}
                onClick={() => toggleSort(h.key)}
                style={{
                  padding: '10px 16px', textAlign: (h.align ?? 'right') as 'right' | 'left',
                  color: sort === h.key ? 'var(--adx-accent)' : 'var(--text-muted)',
                  fontWeight: 500, fontSize: '0.75rem', cursor: 'pointer',
                  userSelect: 'none', whiteSpace: 'nowrap',
                }}
              >
                {h.label} {sort === h.key ? (dir === -1 ? '↓' : '↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={9} style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                Loading tokens from Arc mainnet…
              </td>
            </tr>
          )}
          {!loading && filtered.length === 0 && (
            <tr>
              <td colSpan={9} style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                No tokens found
              </td>
            </tr>
          )}
          {filtered.map((t, i) => {
            const lpColor = getLaunchpadColor(t.launchpad)
            const chg = t.priceChange24h
            return (
              <tr
                key={t.address}
                onClick={() => navigate({ name: 'token', address: t.address })}
                style={{
                  borderBottom: '1px solid rgba(30,48,80,0.5)',
                  cursor: 'pointer', transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-3)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '12px 16px', color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
                  {i + 1}
                </td>
                <td style={{ padding: '12px 8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {t.logoUrl ? (
                      <img src={t.logoUrl} alt="" width={28} height={28}
                        style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                        background: `hsl(${parseInt(t.address.slice(2, 4), 16) * 1.4}deg 60% 40%)`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.625rem', fontWeight: 700, color: '#fff',
                      }}>
                        {t.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{t.symbol}</div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', maxWidth: 120,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.name}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '12px 8px' }}>
                  <span className="lp-badge" style={{ color: lpColor, borderColor: `${lpColor}40`, background: `${lpColor}15` }}>
                    {t.launchpad}
                  </span>
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  {fmt(t.marketCap)}
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  {t.price < 0.001 ? `$${t.price.toExponential(2)}` : fmt(t.price, false)}
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)',
                  color: chg > 0 ? 'var(--green)' : chg < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                  {chg > 0 ? '+' : ''}{chg.toFixed(2)}%
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  {fmt(t.volume24h)}
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  {fmt(t.liquidity)}
                </td>
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
                  {t.ageMs > 0 ? age(t.ageMs) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
