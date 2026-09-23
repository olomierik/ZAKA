import { useState, useEffect, useCallback } from 'react'
import { getTokens, getPlatformStats, type ArcToken } from '../api/radardex'
import TokenTable from '../components/TokenTable'
import type { Page } from '../App'

const LAUNCHPADS = ['', 'Argus', 'RadarDex', 'Tolly', 'Warp', 'Archemist', 'Minara', 'PEGD']

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="arc-card" style={{ padding: '16px 20px', minWidth: 160 }}>
      <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginBottom: 4,
        textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: '1.125rem', fontWeight: 700, fontFamily: 'var(--mono)' }}>{value}</div>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

interface Props {
  navigate: (p: Page) => void
}

export default function Terminal({ navigate }: Props) {
  const [tokens,    setTokens]    = useState<ArcToken[]>([])
  const [loading,   setLoading]   = useState(true)
  const [filter,    setFilter]    = useState('')
  const [launchpad, setLaunchpad] = useState('')
  const [stats, setStats]         = useState({ tokenCount: 0, volume24h: 0, marketCap: 0, liquidity: 0 })
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const loadTokens = useCallback(async (force = false) => {
    try {
      const [ts, st] = await Promise.all([getTokens(force), getPlatformStats()])
      setTokens(ts)
      setStats(st)
      setLastRefresh(new Date())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadTokens() }, [loadTokens])

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(() => loadTokens(true), 15_000)
    return () => clearInterval(id)
  }, [loadTokens])

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: 4,
          background: 'linear-gradient(135deg,#e2e8f0,#94a3b8)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Arc Mainnet Terminal
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Every token launched on Arc — live prices, charts, and instant swaps.
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <StatCard label="Tokens Listed"   value={stats.tokenCount.toString()} />
        <StatCard label="24h Volume"      value={fmt(stats.volume24h)} />
        <StatCard label="Total Mcap"      value={fmt(stats.marketCap)} />
        <StatCard label="Total Liquidity" value={fmt(stats.liquidity)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : 'Loading…'}
          </span>
          <button
            onClick={() => { setLoading(true); loadTokens(true) }}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: '0.75rem',
              border: '1px solid var(--card-border)', background: 'transparent',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search token, symbol, address…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            padding: '8px 14px', borderRadius: 8, fontSize: '0.875rem',
            background: 'var(--bg-2)', border: '1px solid var(--card-border)',
            color: 'var(--text)', outline: 'none', width: 280, fontFamily: 'var(--sans)',
          }}
        />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {LAUNCHPADS.map(lp => (
            <button
              key={lp || 'all'}
              onClick={() => setLaunchpad(lp)}
              style={{
                padding: '6px 14px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
                border: '1px solid',
                borderColor: launchpad === lp ? 'var(--accent)' : 'var(--card-border)',
                background:  launchpad === lp ? 'rgba(59,130,246,0.15)' : 'transparent',
                color:       launchpad === lp ? 'var(--accent)' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {lp || 'All Sources'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="arc-card" style={{ overflow: 'hidden' }}>
        <TokenTable tokens={tokens} loading={loading} navigate={navigate} filter={filter} launchpad={launchpad} />
      </div>

      <p style={{ marginTop: 16, fontSize: '0.6875rem', color: 'var(--text-muted)', textAlign: 'center' }}>
        Live data from RadarDex API. Tokens from Argus, RadarDex, Tolly, Warp, Archemist, Minara, PEGD and all Arc launchpads.
        Refreshes every 15s. Not financial advice.
      </p>
    </div>
  )
}
