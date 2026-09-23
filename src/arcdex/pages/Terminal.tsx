import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getTrendingPairs, getNewPools, getGraduatedPools,
  getPairsBatch, getLaunchpad,
  type DexPair,
} from '../api/dexscreener'
import { subscribeAll, estimateUsd, ARC_EXPLORER } from '../api/arcRpc'
import type { Page } from '../App'

interface Props { navigate: (p: Page) => void }

// ── helpers ───────────────────────────────────────────────────────────
function fmt(n: number | null | undefined, prefix = ''): string {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e9)  return `${prefix}${(n/1e9).toFixed(2)}B`
  if (n >= 1e6)  return `${prefix}${(n/1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${prefix}${(n/1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(2)}`
}
function age(createdAt: number): string {
  const s = (Date.now() - createdAt) / 1000
  if (s < 60)   return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s/60)}m`
  if (s < 86400)return `${Math.floor(s/3600)}h`
  return `${Math.floor(s/86400)}d`
}
function pct(n: number) {
  const c = n > 0 ? '#22c55e' : n < 0 ? '#ef4444' : '#64748b'
  return <span style={{ color: c, fontWeight: 700 }}>{n > 0 ? '+' : ''}{n.toFixed(1)}%</span>
}

// ── live trade popup ──────────────────────────────────────────────────
interface Popup { id: number; pairAddress: string; kind: 'buy'|'sell'; usd: number }
let popupId = 0

// ── token image with fallback ─────────────────────────────────────────
function TokenImage({ src, symbol }: { src?: string; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) {
    return (
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        background: 'linear-gradient(135deg,#1e3a5f,#0f1e30)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent)',
        flexShrink: 0,
      }}>
        {symbol.slice(0, 3).toUpperCase()}
      </div>
    )
  }
  return (
    <img
      src={src} alt={symbol}
      style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      onError={() => setErr(true)}
    />
  )
}

// ── token card ────────────────────────────────────────────────────────
interface CardProps { pair: DexPair; popups: Popup[]; onClick: () => void }

function TokenCard({ pair, popups, onClick }: CardProps) {
  const lp    = getLaunchpad(pair)
  const ch24  = pair.priceChange?.h24 ?? 0
  const chColor = ch24 >= 0 ? '#22c55e' : '#ef4444'
  const myPopups = popups.filter(p => p.pairAddress === pair.pairAddress.toLowerCase())

  return (
    <div className="token-card" onClick={onClick} style={{ cursor: 'pointer', position: 'relative', overflow: 'visible' }}>
      {/* live popups */}
      {myPopups.map(p => (
        <div key={p.id} className={`trade-popup ${p.kind}`}>
          {p.kind === 'buy' ? '▲' : '▼'} ${p.usd < 1 ? p.usd.toFixed(2) : fmt(p.usd, '')} {p.kind.toUpperCase()}
        </div>
      ))}

      {/* price change badge */}
      <div style={{
        position: 'absolute', top: 10, right: 10,
        background: ch24 >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
        color: chColor, fontSize: '0.7rem', fontWeight: 700,
        padding: '2px 7px', borderRadius: 99,
        border: `1px solid ${chColor}40`,
      }}>
        {ch24 >= 0 ? '+' : ''}{ch24.toFixed(1)}% 24h
      </div>

      {/* launchpad badge */}
      <div style={{
        position: 'absolute', top: 10, left: 10,
        background: lp.color + '22', color: lp.color,
        fontSize: '0.62rem', fontWeight: 700,
        padding: '2px 6px', borderRadius: 99,
        border: `1px solid ${lp.color}44`,
        maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {lp.name}
      </div>

      {/* image */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 36, marginBottom: 10 }}>
        <TokenImage src={pair.info?.imageUrl} symbol={pair.baseToken.symbol} />
      </div>

      {/* name + price */}
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text)' }}>
          ${pair.baseToken.symbol}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
          {pair.baseToken.name}
        </div>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent)', marginTop: 4 }}>
          {pair.priceUsd ? `$${parseFloat(pair.priceUsd).toPrecision(4)}` : '—'}
        </div>
      </div>

      {/* stats row */}
      <div className="card-stats">
        <div><span className="stat-label">MCap</span><span className="stat-val">{fmt(pair.marketCap ?? pair.fdv, '$')}</span></div>
        <div><span className="stat-label">Vol 24h</span><span className="stat-val">{fmt(pair.volume?.h24, '$')}</span></div>
        <div><span className="stat-label">Liq</span><span className="stat-val">{fmt(pair.liquidity?.usd, '$')}</span></div>
      </div>
      <div className="card-stats" style={{ marginTop: 4 }}>
        <div><span className="stat-label">Buys</span><span className="stat-val" style={{ color: '#22c55e' }}>{pair.txns?.h24?.buys ?? '—'}</span></div>
        <div><span className="stat-label">Sells</span><span className="stat-val" style={{ color: '#ef4444' }}>{pair.txns?.h24?.sells ?? '—'}</span></div>
        <div><span className="stat-label">Age</span><span className="stat-val">{age(pair.pairCreatedAt)}</span></div>
      </div>

      {/* explorer link */}
      <a
        href={`${ARC_EXPLORER}/address/${pair.pairAddress}`}
        target="_blank" rel="noopener noreferrer"
        style={{ display: 'block', textAlign: 'center', marginTop: 8, fontSize: '0.65rem', color: 'var(--text-muted)', textDecoration: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        {pair.pairAddress.slice(0, 8)}…{pair.pairAddress.slice(-6)}
      </a>
    </div>
  )
}

// ── sort / filter types ───────────────────────────────────────────────
type Tab = 'trending' | 'new' | 'graduated'
type SortKey = 'volume' | 'mcap' | 'liquidity' | 'age' | 'txns'

const SORT_OPTIONS: { label: string; key: SortKey }[] = [
  { label: 'Volume',    key: 'volume' },
  { label: 'Mkt Cap',   key: 'mcap' },
  { label: 'Liquidity', key: 'liquidity' },
  { label: 'Newest',    key: 'age' },
  { label: 'Txns',      key: 'txns' },
]

const LAUNCHPADS = ['All', 'Argus', 'Minara', 'RadarDex', 'Tolly', 'Warp', 'Archemist', 'o1', 'Uniswap V3', 'Uniswap V4']

// ── main Terminal component ───────────────────────────────────────────
export default function Terminal({ navigate }: Props) {
  const [tab,       setTab]       = useState<Tab>('trending')
  const [pairs,     setPairs]     = useState<DexPair[]>([])
  const [loading,   setLoading]   = useState(true)
  const [sortKey,   setSortKey]   = useState<SortKey>('volume')
  const [lpFilter,  setLpFilter]  = useState('All')
  const [search,    setSearch]    = useState('')
  const [popups,    setPopups]    = useState<Popup[]>([])
  const [lastUpdate, setLastUpdate] = useState(Date.now())
  const pairsRef = useRef<DexPair[]>([])
  pairsRef.current = pairs

  // ── load pairs ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    let data: DexPair[] = []
    if      (tab === 'trending')  data = await getTrendingPairs()
    else if (tab === 'new')       data = await getNewPools()
    else                          data = await getGraduatedPools()
    setPairs(data)
    setLastUpdate(Date.now())
    setLoading(false)

    // batch-refresh with DexScreener for images + up-to-date prices
    const addrs = data.map(p => p.pairAddress)
    if (addrs.length) {
      const fresh = await getPairsBatch(addrs.slice(0, 60))
      if (fresh.length) {
        const map = new Map(fresh.map(p => [p.pairAddress.toLowerCase(), p]))
        setPairs(prev => prev.map(p => {
          const f = map.get(p.pairAddress.toLowerCase())
          if (!f) return p
          // merge: prefer DexScreener image, keep GT lifecycle fields
          return { ...p, ...f, info: f.info?.imageUrl ? f.info : p.info }
        }))
      }
    }
  }, [tab])

  useEffect(() => { void load() }, [load])

  // refresh every 8 seconds
  useEffect(() => {
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load])

  // ── real-time WebSocket trade popups ────────────────────────────────
  useEffect(() => {
    const unsub = subscribeAll(trade => {
      const pairAddr = trade.pairAddress.toLowerCase()
      const matchedPair = pairsRef.current.find(p => p.pairAddress.toLowerCase() === pairAddr)
      const usd = matchedPair
        ? estimateUsd(trade.amount1)
        : estimateUsd(trade.amount1)

      if (usd < 0.01) return  // ignore dust

      const popup: Popup = { id: ++popupId, pairAddress: pairAddr, kind: trade.kind, usd }
      setPopups(prev => [...prev.slice(-50), popup])  // keep last 50
      setTimeout(() => {
        setPopups(prev => prev.filter(p => p.id !== popup.id))
      }, 3500)
    })
    return unsub
  }, [])

  // ── filter + sort ───────────────────────────────────────────────────
  const displayed = pairs
    .filter(p => {
      if (search) {
        const q = search.toLowerCase()
        return p.baseToken.symbol.toLowerCase().includes(q) ||
               p.baseToken.name.toLowerCase().includes(q)
      }
      return true
    })
    .filter(p => {
      if (lpFilter === 'All') return true
      return getLaunchpad(p).name.toLowerCase().startsWith(lpFilter.toLowerCase())
    })
    .sort((a, b) => {
      if (sortKey === 'volume')    return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0)
      if (sortKey === 'mcap')      return (b.marketCap ?? b.fdv ?? 0) - (a.marketCap ?? a.fdv ?? 0)
      if (sortKey === 'liquidity') return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      if (sortKey === 'age')       return (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0)
      if (sortKey === 'txns')      return ((b.txns?.h24?.buys ?? 0) + (b.txns?.h24?.sells ?? 0)) - ((a.txns?.h24?.buys ?? 0) + (a.txns?.h24?.sells ?? 0))
      return 0
    })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>

      {/* ── top bar ── */}
      <div style={{ padding: '12px 16px 0', borderBottom: '1px solid var(--card-border)' }}>
        {/* tabs */}
        <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
          {(['trending','new','graduated'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
              fontWeight: tab === t ? 800 : 500,
              fontSize: '0.95rem',
              color: tab === t ? 'var(--text)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              textTransform: 'capitalize',
            }}>
              {t === 'trending' ? '🔥 Trending' : t === 'new' ? '✨ New' : '🎓 Graduated'}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
            Live • {new Date(lastUpdate).toLocaleTimeString()}
          </div>
        </div>

        {/* launchpad filter pills */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {LAUNCHPADS.map(lp => (
            <button key={lp} onClick={() => setLpFilter(lp)} style={{
              padding: '3px 12px', borderRadius: 99, fontSize: '0.72rem', fontWeight: 600,
              cursor: 'pointer', border: '1px solid',
              borderColor: lpFilter === lp ? 'var(--accent)' : 'var(--card-border)',
              background:  lpFilter === lp ? 'rgba(59,130,246,0.15)' : 'transparent',
              color:       lpFilter === lp ? 'var(--accent)' : 'var(--text-muted)',
            }}>
              {lp}
            </button>
          ))}
        </div>

        {/* sort + search row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            placeholder="Search tokens…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{
              background: 'var(--card-bg)', border: '1px solid var(--card-border)',
              borderRadius: 8, padding: '5px 12px', color: 'var(--text)', fontSize: '0.8rem',
              width: 180, outline: 'none',
            }}
          />
          {SORT_OPTIONS.map(s => (
            <button key={s.key} onClick={() => setSortKey(s.key)} style={{
              padding: '3px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600,
              cursor: 'pointer', border: '1px solid',
              borderColor: sortKey === s.key ? 'var(--accent)' : 'var(--card-border)',
              background:  sortKey === s.key ? 'rgba(59,130,246,0.15)' : 'transparent',
              color:       sortKey === s.key ? 'var(--accent)' : 'var(--text-muted)',
            }}>
              {s.label}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {displayed.length} pairs
          </span>
        </div>
      </div>

      {/* ── card grid ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {loading && pairs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            Loading Arc pairs…
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            No pairs found
          </div>
        ) : (
          <div className="token-grid">
            {displayed.map(pair => (
              <TokenCard
                key={pair.pairAddress}
                pair={pair}
                popups={popups}
                onClick={() => navigate({ name: 'token', address: pair.pairAddress })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
