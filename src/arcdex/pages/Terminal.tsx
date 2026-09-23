import { useState, useEffect, useCallback, useRef } from 'react'
import { getTokens, getPlatformStats, getLaunchpadColor, type ArcToken } from '../api/radardex'
import type { Page } from '../App'

type Tab       = 'trending' | 'new' | 'graduated'
type ViewMode  = 'grid' | 'list'
type SortKey   = 'marketCap' | 'volume24h' | 'priceChange24h' | 'liquidity' | 'holderCount' | 'ageMs' | 'buys24h' | 'lastTrade'
type QuoteFilter = 'all' | 'USDC' | 'EURC' | 'ARGUS' | 'XAUM' | 'cirBTC' | 'ARCASH' | 'WETH'

const QUOTE_FILTERS: QuoteFilter[] = ['all', 'USDC', 'EURC', 'ARGUS', 'XAUM', 'cirBTC', 'ARCASH', 'WETH']
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'lastTrade',    label: 'Last trade' },
  { key: 'marketCap',    label: 'Market cap' },
  { key: 'volume24h',    label: 'Volume 24h' },
  { key: 'priceChange24h', label: '24h change' },
  { key: 'liquidity',    label: 'Liquidity' },
  { key: 'holderCount',  label: 'Holders' },
  { key: 'ageMs',        label: 'Newest' },
  { key: 'buys24h',      label: 'Buy pressure' },
]

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function age(ms: number): string {
  const s = ms / 1000
  if (s < 60)    return `${Math.floor(s)}s`
  if (s < 3600)  return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function fmtPrice(p: number): string {
  if (p === 0) return '$0'
  if (p >= 1)  return `$${p.toFixed(4)}`
  if (p >= 0.001) return `$${p.toFixed(6)}`
  return `$${p.toExponential(2)}`
}

// Tiny sparkline SVG
function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data.length) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const w = 80, h = 28
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x},${y}`
  }).join(' ')
  const color = positive ? '#22c55e' : '#ef4444'
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

// Milestone / bonding progress bar
function MilestoneBar({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
      background: 'rgba(0,0,0,0.4)' }}>
      <div style={{
        height: '100%', width: `${clamped}%`,
        background: clamped >= 100 ? '#22c55e' : 'linear-gradient(90deg,#7c3aed,#3b82f6)',
        transition: 'width 0.3s ease',
      }} />
    </div>
  )
}

interface CardProps {
  token:    ArcToken
  rank:     number
  navigate: (p: Page) => void
}

function TokenCard({ token, rank, navigate }: CardProps) {
  const chg  = token.priceChange24h
  const pos  = chg >= 0
  const lpColor = getLaunchpadColor(token.launchpad)
  const bp   = token.bondingProgress ?? 0

  return (
    <div
      className="token-card glow-hover"
      onClick={() => navigate({ name: 'token', address: token.address })}
    >
      {/* Cover image / logo */}
      <div className="token-card-cover">
        {token.logoUrl ? (
          <img src={token.logoUrl} alt={token.symbol}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        ) : (
          <div className="token-card-cover-fallback" style={{
            background: `hsl(${parseInt(token.address.slice(2, 4), 16) * 1.4}deg 50% 25%)`,
          }}>
            <span>{token.symbol.slice(0, 3)}</span>
          </div>
        )}

        {/* 24h badge */}
        <div className={`chg-badge ${pos ? 'chg-pos' : 'chg-neg'}`}>
          {pos ? '+' : ''}{chg.toFixed(1)}% 24h
        </div>

        {/* Rank */}
        <div className="rank-badge">#{rank}</div>

        {/* Milestone label */}
        {!token.graduated && (
          <div className="milestone-label">{bp.toFixed(1)}% of milestone</div>
        )}
        {token.graduated && (
          <div className="milestone-label graduated">Graduated ✓</div>
        )}

        <MilestoneBar pct={bp} />
      </div>

      {/* Card body */}
      <div className="token-card-body">
        <div className="token-card-row">
          <div>
            <div className="token-card-name">{token.name.length > 18 ? token.name.slice(0, 16) + '…' : token.name}</div>
            <div className="token-card-symbol">${token.symbol}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>
              Market cap
            </div>
            <div className="token-card-mcap">{fmt(token.marketCap)}</div>
          </div>
        </div>

        {/* Creator / age */}
        <div className="token-card-meta">
          {token.deployer && (
            <span className="token-deployer" title={token.deployer}>
              <span className="lp-dot" style={{ background: lpColor }} />
              {token.deployer.slice(0, 7)}…
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: '0.6875rem' }}>
            · {age(token.ageMs)} ago
          </span>
          <a
            href={`https://explorer.mainnet.arc.io/address/${token.address}`}
            target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '0.625rem', lineHeight: 1 }}
          >
            ↗
          </a>
        </div>

        {/* Stats row */}
        <div className="token-card-stats">
          <span>Tax {token.txCount24h ? '–' : '–'}</span>
          <span>
            <svg width={10} height={10} viewBox="0 0 10 10" style={{ marginRight: 2 }}>
              <circle cx={5} cy={5} r={4} fill="none" stroke="currentColor" strokeWidth={1.5} />
              <path d="M5 2v3l2 1" stroke="currentColor" strokeWidth={1.2} fill="none" />
            </svg>
            {token.holderCount.toLocaleString()}
          </span>
          <span>Vol {fmt(token.volume24h)}</span>
        </div>

        {/* Sparkline */}
        {token.spark.length > 1 && (
          <div style={{ marginTop: 6 }}>
            <Sparkline data={token.spark} positive={pos} />
          </div>
        )}
      </div>
    </div>
  )
}

// List row (compact view)
function TokenRow({ token, rank, navigate }: CardProps) {
  const chg = token.priceChange24h
  const pos = chg >= 0
  return (
    <tr
      onClick={() => navigate({ name: 'token', address: token.address })}
      className="token-list-row"
    >
      <td className="td-rank">{rank}</td>
      <td className="td-token">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {token.logoUrl ? (
            <img src={token.logoUrl} width={28} height={28}
              style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} alt="" />
          ) : (
            <div style={{
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontWeight: 700,
              fontSize: '0.625rem', color: '#fff',
              background: `hsl(${parseInt(token.address.slice(2,4),16)*1.4}deg 60% 40%)`,
            }}>{token.symbol.slice(0,2)}</div>
          )}
          <div>
            <div style={{ fontWeight: 600 }}>${token.symbol}</div>
            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{token.name}</div>
          </div>
        </div>
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        {fmtPrice(token.price)}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)',
        color: pos ? 'var(--green)' : 'var(--red)', fontSize: '0.8125rem' }}>
        {pos ? '+' : ''}{chg.toFixed(2)}%
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        {fmt(token.marketCap)}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        {fmt(token.volume24h)}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        {fmt(token.liquidity)}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        {token.holderCount.toLocaleString()}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem',
        color: 'var(--text-muted)' }}>
        {age(token.ageMs)}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
        <span style={{ color: 'var(--green)', marginRight: 4 }}>{token.buys24h}B</span>
        <span style={{ color: 'var(--red)' }}>{token.sells24h}S</span>
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
        {token.spark.length > 1 && <Sparkline data={token.spark} positive={pos} />}
      </td>
    </tr>
  )
}

interface Props { navigate: (p: Page) => void }

export default function Terminal({ navigate }: Props) {
  const [tokens,      setTokens]      = useState<ArcToken[]>([])
  const [loading,     setLoading]     = useState(true)
  const [tab,         setTab]         = useState<Tab>('trending')
  const [view,        setView]        = useState<ViewMode>('grid')
  const [quoteFilter, setQuoteFilter] = useState<QuoteFilter>('all')
  const [sortKey,     setSortKey]     = useState<SortKey>('lastTrade')
  const [search,      setSearch]      = useState('')
  const [stats, setStats]             = useState({ tokenCount: 0, volume24h: 0, marketCap: 0, liquidity: 0 })
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (force = false) => {
    try {
      const [ts, st] = await Promise.all([getTokens(force), getPlatformStats()])
      setTokens(ts)
      setStats(st)
      setLastRefresh(new Date())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    timerRef.current = setInterval(() => { void load(true) }, 15_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [load])

  // Filter + sort
  const visible = (() => {
    let list = tokens

    // Tab filter
    if (tab === 'new')       list = list.filter(t => t.ageMs < 7 * 86400 * 1000)
    if (tab === 'graduated') list = list.filter(t => t.graduated)
    if (tab === 'trending')  list = list.filter(t => t.volume24h > 0 || t.txCount24h > 0)

    // Quote filter
    if (quoteFilter !== 'all')
      list = list.filter(t => t.quoteSymbol.toUpperCase() === quoteFilter)

    // Search
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(t =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q),
      )
    }

    // Sort
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'lastTrade':    return b.txCount24h - a.txCount24h
        case 'marketCap':    return b.marketCap  - a.marketCap
        case 'volume24h':    return b.volume24h   - a.volume24h
        case 'priceChange24h': return b.priceChange24h - a.priceChange24h
        case 'liquidity':    return b.liquidity   - a.liquidity
        case 'holderCount':  return b.holderCount - a.holderCount
        case 'ageMs':        return a.ageMs - b.ageMs  // newest first
        case 'buys24h':      return (b.buys24h - b.sells24h) - (a.buys24h - a.sells24h)
        default:             return 0
      }
    })

    return list
  })()

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto', padding: '0 16px 32px' }}>

      {/* Stats bar */}
      <div className="stats-bar">
        <StatPill label="Tokens" value={stats.tokenCount > 0 ? stats.tokenCount.toLocaleString() : tokens.length.toLocaleString()} />
        <StatPill label="24h Vol" value={fmt(stats.volume24h)} />
        <StatPill label="Mcap"    value={fmt(stats.marketCap)} />
        <StatPill label="Liq"     value={fmt(stats.liquidity)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
            {lastRefresh ? `${lastRefresh.toLocaleTimeString()}` : 'Loading…'}
          </span>
        </div>
      </div>

      {/* Tabs + view toggle */}
      <div className="tabs-row">
        <div className="tabs">
          {(['trending', 'new', 'graduated'] as Tab[]).map(t => (
            <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`}
              onClick={() => setTab(t)}>
              {t === 'trending' && '🔥 '}
              {t === 'new'      && '✨ '}
              {t === 'graduated' && '🎓 '}
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {/* Sort dropdown */}
          <select
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            className="sort-select"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          {/* View toggle */}
          <div className="view-toggle">
            <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}
              title="Grid view">
              <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor">
                <rect x="1" y="1" width="6" height="6" rx="1" />
                <rect x="9" y="1" width="6" height="6" rx="1" />
                <rect x="1" y="9" width="6" height="6" rx="1" />
                <rect x="9" y="9" width="6" height="6" rx="1" />
              </svg>
            </button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}
              title="List view">
              <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor">
                <rect x="1" y="2" width="14" height="2" rx="1" />
                <rect x="1" y="7" width="14" height="2" rx="1" />
                <rect x="1" y="12" width="14" height="2" rx="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Quote pair filters */}
      <div className="quote-filters">
        {QUOTE_FILTERS.map(q => (
          <button key={q}
            className={`quote-btn ${quoteFilter === q ? 'quote-active' : ''}`}
            onClick={() => setQuoteFilter(q)}>
            {q === 'all' ? 'All pairs' : q}
          </button>
        ))}
        {/* Search */}
        <input
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      {/* Content */}
      {loading && (
        <div className="loading-grid">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="token-card skeleton" />
          ))}
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-muted)' }}>
          No tokens found
        </div>
      )}

      {!loading && visible.length > 0 && view === 'grid' && (
        <div className="token-grid">
          {visible.map((t, i) => (
            <TokenCard key={t.address} token={t} rank={i + 1} navigate={navigate} />
          ))}
        </div>
      )}

      {!loading && visible.length > 0 && view === 'list' && (
        <div className="arc-card" style={{ overflow: 'hidden', marginTop: 8 }}>
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--card-border)' }}>
                  {['#','Token','Price','24h','MCap','Vol 24h','Liq','Holders','Age','B/S','Spark'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === '#' || h === 'Token' ? 'left' : 'right',
                      color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.6875rem',
                      whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((t, i) => (
                  <TokenRow key={t.address} token={t} rank={i + 1} navigate={navigate} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p style={{ marginTop: 20, fontSize: '0.6875rem', color: 'var(--text-muted)', textAlign: 'center' }}>
        Live data from RadarDex API · All Arc launchpads · Refreshes every 15s · Not financial advice
      </p>
    </div>
  )
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8125rem', fontWeight: 700 }}>{value}</span>
    </div>
  )
}
