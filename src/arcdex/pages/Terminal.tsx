import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getTrendingPools, getNewPools, getAllPools, getPoolTrades,
  type GeckoPool, type GeckoTrade, LAUNCHPAD_COLORS,
} from '../api/gecko'
import type { Page } from '../App'

interface Props { navigate: (p: Page) => void }

// ── helpers ─────────────────────────────────────────────────────────
function fmt(n: number | null | undefined, prefix = '') {
  if (n == null || n === 0) return '—'
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`
  return `${prefix}${n.toFixed(2)}`
}
function fmtPrice(n: number) {
  if (n === 0) return '$0'
  if (n >= 1) return `$${n.toFixed(4)}`
  const s = n.toExponential(2)
  return `$${s}`
}
function timeAgo(iso: string) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
function launchpadColor(name: string) {
  return LAUNCHPAD_COLORS[name] ?? '#64748b'
}

// ── pop-up badge per card ────────────────────────────────────────────
interface PopBadge { id: string; kind: 'buy' | 'sell'; amount: number }

// live trade poller — one shared interval across all visible cards
const tradeCache = new Map<string, GeckoTrade[]>()
const tradeCallbacks = new Map<string, Set<(t: GeckoTrade) => void>>()

function subscribePool(address: string, cb: (t: GeckoTrade) => void) {
  if (!tradeCallbacks.has(address)) tradeCallbacks.set(address, new Set())
  tradeCallbacks.get(address)!.add(cb)
}
function unsubscribePool(address: string, cb: (t: GeckoTrade) => void) {
  tradeCallbacks.get(address)?.delete(cb)
}
async function pollPool(address: string) {
  try {
    const trades = await getPoolTrades(address)
    const prev = tradeCache.get(address) ?? []
    const prevIds = new Set(prev.map(t => t.txHash))
    const newTrades = trades.filter(t => !prevIds.has(t.txHash))
    tradeCache.set(address, trades)
    const cbs = tradeCallbacks.get(address)
    if (cbs) newTrades.forEach(t => cbs.forEach(cb => cb(t)))
  } catch {}
}

// ── TokenCard ────────────────────────────────────────────────────────
function TokenCard({ pool, onClick }: { pool: GeckoPool; onClick: () => void }) {
  const [badges, setBadges] = useState<PopBadge[]>([])
  const [recentTrades, setRecentTrades] = useState<GeckoTrade[]>([])
  const [hovered, setHovered] = useState(false)

  const handleTrade = useCallback((t: GeckoTrade) => {
    const badge: PopBadge = { id: t.txHash, kind: t.kind, amount: t.volumeUsd }
    setBadges(prev => [...prev.slice(-4), badge])
    setRecentTrades(prev => [t, ...prev].slice(0, 5))
    setTimeout(() => setBadges(prev => prev.filter(b => b.id !== badge.id)), 3200)
  }, [])

  useEffect(() => {
    if (!pool.address) return
    subscribePool(pool.address, handleTrade)
    return () => unsubscribePool(pool.address, handleTrade)
  }, [pool.address, handleTrade])

  const pc = pool.priceChange.h24
  const pcColor = pc >= 0 ? '#22c55e' : '#ef4444'
  const lpColor = launchpadColor(pool.dexName)

  return (
    <div
      className="token-card"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', cursor: 'pointer' }}
    >
      {/* price change badge top-right */}
      <div className="card-change-badge" style={{ color: pcColor, borderColor: pcColor }}>
        {pc >= 0 ? '+' : ''}{pc.toFixed(1)}% 24h
      </div>

      {/* live pop-up buy/sell badges */}
      <div className="card-popups">
        {badges.map(b => (
          <div key={b.id} className={`card-popup ${b.kind}`}>
            {b.kind === 'buy' ? '▲' : '▼'} ${b.amount < 1 ? b.amount.toFixed(2) : fmt(b.amount, '')} {b.kind.toUpperCase()}
          </div>
        ))}
      </div>

      {/* token logo */}
      <div className="card-logo-wrap">
        {pool.logoUrl ? (
          <img src={pool.logoUrl} alt={pool.baseSymbol} className="card-logo" />
        ) : (
          <div className="card-logo-placeholder">
            {(pool.baseSymbol || '?').slice(0, 2).toUpperCase()}
          </div>
        )}
        {/* launchpad badge */}
        <div className="card-launchpad" style={{ background: lpColor }}>
          {pool.dexName}
        </div>
      </div>

      {/* name + market cap row */}
      <div className="card-row" style={{ marginTop: 10 }}>
        <div>
          <div className="card-name">{pool.baseName}</div>
          <div className="card-symbol">${pool.baseSymbol}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="card-label">Market cap</div>
          <div className="card-value">{fmt(pool.marketCapUsd ?? pool.fdvUsd, '$')}</div>
        </div>
      </div>

      {/* price */}
      <div className="card-price">{fmtPrice(pool.priceUsd)}</div>

      {/* stats row */}
      <div className="card-stats">
        <span title="Liquidity">💧 {fmt(pool.liquidityUsd, '$')}</span>
        <span title="24h Volume">📊 {fmt(pool.volumeH24, '$')}</span>
        <span title="Created">{timeAgo(pool.poolCreatedAt)} ago</span>
      </div>

      {/* txn counts */}
      <div className="card-txns">
        <span className="buy-count">▲ {pool.txns.buys}B</span>
        <span className="sell-count">▼ {pool.txns.sells}S</span>
        <span className="buyers-count">{pool.txns.buyers} buyers</span>
      </div>

      {/* recent trade feed on hover */}
      {hovered && recentTrades.length > 0 && (
        <div className="card-trade-feed">
          {recentTrades.map((t, i) => (
            <div key={i} className={`feed-item ${t.kind}`}>
              <span className="feed-kind">{t.kind === 'buy' ? '▲ BUY' : '▼ SELL'}</span>
              <span className="feed-amount">${t.volumeUsd < 1 ? t.volumeUsd.toFixed(3) : fmt(t.volumeUsd)}</span>
              <span className="feed-wallet">{t.txFrom.slice(0, 6)}…{t.txFrom.slice(-4)}</span>
              <span className="feed-time">{timeAgo(t.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Terminal ────────────────────────────────────────────────────
type Tab = 'trending' | 'new' | 'all'
type SortKey = 'volume' | 'marketcap' | 'liquidity' | 'age' | 'txns'
type LaunchpadFilter = 'all' | string

const LAUNCHPADS = ['Argus', 'Minara.fun', 'RadarDex', 'Tolly', 'Warp', 'Archemist', 'o1 Launchpad', 'Uniswap V3', 'Uniswap V4']

export default function Terminal({ navigate }: Props) {
  const [tab, setTab] = useState<Tab>('trending')
  const [pools, setPools] = useState<GeckoPool[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('volume')
  const [lpFilter, setLpFilter] = useState<LaunchpadFilter>('all')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(Date.now())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const loaderRef = useRef<HTMLDivElement>(null)

  // fetch pools for current tab
  const fetchPools = useCallback(async (tab: Tab, pageNum: number, replace: boolean) => {
    try {
      let data: GeckoPool[] = []
      if (tab === 'trending') data = await getTrendingPools(pageNum)
      else if (tab === 'new')  data = await getNewPools(pageNum)
      else                     data = await getAllPools(pageNum)
      setPools(prev => replace ? data : [...prev, ...data])
      setHasMore(data.length === 20)
      setLastUpdate(Date.now())
    } finally {
      setLoading(false)
    }
  }, [])

  // initial load + tab change
  useEffect(() => {
    setLoading(true)
    setPools([])
    setPage(1)
    setHasMore(true)
    void fetchPools(tab, 1, true)
  }, [tab, fetchPools])

  // auto-refresh every 15s
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      void fetchPools(tab, 1, true)
      // also poll top 10 visible pools for live trades
      setPools(prev => {
        prev.slice(0, 10).forEach(p => { void pollPool(p.address) })
        return prev
      })
    }, 15_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [tab, fetchPools])

  // poll trades for visible pools every 10s
  useEffect(() => {
    const interval = setInterval(() => {
      pools.slice(0, 12).forEach(p => { void pollPool(p.address) })
    }, 10_000)
    return () => clearInterval(interval)
  }, [pools])

  // infinite scroll
  useEffect(() => {
    const el = loaderRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        const next = page + 1
        setPage(next)
        void fetchPools(tab, next, false)
      }
    }, { threshold: 0.1 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [page, hasMore, loading, tab, fetchPools])

  // filter + sort
  const filtered = pools
    .filter(p => {
      if (lpFilter !== 'all' && p.dexName !== lpFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return p.baseSymbol.toLowerCase().includes(q) || p.baseName.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      if (sortKey === 'volume')    return (b.volumeH24 ?? 0) - (a.volumeH24 ?? 0)
      if (sortKey === 'marketcap') return ((b.marketCapUsd ?? b.fdvUsd ?? 0)) - ((a.marketCapUsd ?? a.fdvUsd ?? 0))
      if (sortKey === 'liquidity') return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
      if (sortKey === 'age')       return new Date(b.poolCreatedAt).getTime() - new Date(a.poolCreatedAt).getTime()
      if (sortKey === 'txns')      return (b.txns.buys + b.txns.sells) - (a.txns.buys + a.txns.sells)
      return 0
    })

  const secs = Math.floor((Date.now() - lastUpdate) / 1000)

  return (
    <div className="terminal-root">
      {/* header */}
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="terminal-logo">⬡</span> ARC<span style={{ color: '#3b82f6' }}>DEX</span>
          <span className="live-dot" />
          <span className="live-label">LIVE · {secs}s ago</span>
        </div>
        <input
          className="terminal-search"
          placeholder="Search token…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* tabs */}
      <div className="terminal-tabs">
        {(['trending', 'new', 'all'] as Tab[]).map(t => (
          <button key={t} className={`tab-btn${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'trending' ? '🔥 Trending' : t === 'new' ? '✨ New' : '🌐 All Pairs'}
          </button>
        ))}
      </div>

      {/* launchpad filter pills */}
      <div className="lp-filter-row">
        <button className={`lp-pill${lpFilter === 'all' ? ' active' : ''}`} onClick={() => setLpFilter('all')}>
          All
        </button>
        {LAUNCHPADS.map(lp => (
          <button
            key={lp}
            className={`lp-pill${lpFilter === lp ? ' active' : ''}`}
            style={lpFilter === lp ? { background: launchpadColor(lp), borderColor: launchpadColor(lp), color: '#fff' } : { borderColor: launchpadColor(lp), color: launchpadColor(lp) }}
            onClick={() => setLpFilter(lp === lpFilter ? 'all' : lp)}
          >
            {lp}
          </button>
        ))}
      </div>

      {/* sort bar */}
      <div className="sort-bar">
        <span className="sort-label">Sort:</span>
        {([
          ['volume',    'Volume 24h'],
          ['marketcap', 'Market Cap'],
          ['liquidity', 'Liquidity'],
          ['age',       'Newest'],
          ['txns',      'Transactions'],
        ] as [SortKey, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`sort-btn${sortKey === key ? ' active' : ''}`}
            onClick={() => setSortKey(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* token grid */}
      <div className="token-grid" style={{ minHeight: '80vh' }}>
        {loading && pools.length === 0
          ? Array.from({ length: 12 }).map((_, i) => <div key={i} className="token-card skeleton" />)
          : filtered.map(pool => (
              <TokenCard
                key={pool.id}
                pool={pool}
                onClick={() => navigate({ name: 'token', address: pool.address })}
              />
            ))
        }
      </div>

      {/* infinite scroll sentinel */}
      <div ref={loaderRef} style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {loading && pools.length > 0 && <span className="loading-more">Loading more…</span>}
        {!hasMore && pools.length > 0 && <span className="no-more">All pools loaded</span>}
      </div>
    </div>
  )
}
