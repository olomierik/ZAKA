import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import {
  getLaunchpadColor,
  type ArcToken,
} from '../api/radardex'
import { getAllLaunchpadTokensAsArcTokens } from '../api/launchpad'
import { getArgusTokens } from '../api/argus'
import { getArgusMarket, argusPoolToArcToken } from '../api/argusMarket'
import { curateTokens, type CuratedGroup } from '../lib/curate'
import type { Page } from '../App'

interface Props {
  navigate: (p: Page) => void
  registerFeedTokens: (t: { address: string; symbol: string }[]) => void
}

const ARC_EXPLORER = 'https://explorer.arc.io'

function openPage(t: ArcToken): Page {
  return t.launchpad === 'Argus' && t.poolAddress
    ? { name: 'argus', address: t.address, pool: t.poolAddress }
    : { name: 'token', address: t.address, symbol: t.symbol }
}

// ── helpers ────────────────────────────────────────────────────────────
function fmt(n: number, prefix = ''): string {
  if (!n || isNaN(n)) return '—'
  if (n >= 1e9)  return `${prefix}${(n/1e9).toFixed(2)}B`
  if (n >= 1e6)  return `${prefix}${(n/1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${prefix}${(n/1e3).toFixed(1)}K`
  if (n >= 1)    return `${prefix}${n.toFixed(2)}`
  return `${prefix}${n.toPrecision(3)}`
}
function fmtAge(ms: number): string {
  const s = ms / 1000
  if (s < 60)    return `${Math.floor(s)}s`
  if (s < 3600)  return `${Math.floor(s/60)}m`
  if (s < 86400) return `${Math.floor(s/3600)}h`
  return `${Math.floor(s/86400)}d`
}
function pctColor(n: number) {
  return n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-muted)'
}
function fmtPct(n: number) {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ── view tabs ─────────────────────────────────────────────────────────
// Only tabs with real, distinct filtering behind them — 'Alpha', 'Insider
// picks', 'Watchlist' and 'Holdings' implied personalization features
// (saved watchlists, wallet-linked holdings, curated calls) this app
// doesn't have, so they did nothing when clicked.
const VIEW_TABS = ['All', 'New pair', 'New <15m', 'Trending', 'Top volume']

// ── sort columns ─────────────────────────────────────────────────────
type SortCol = 'mcap' | 'volume' | 'txns' | 'score' | 'age' | 'liq' | 'holders' | 'change'

const PAGE_SIZE = 50

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score))
  const color = pct >= 80 ? 'var(--green)' : pct >= 60 ? '#f59e0b' : 'var(--red)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: 36, height: 14, background: 'var(--bg-2)', borderRadius: 3,
        overflow: 'hidden', border: '1px solid var(--adx-border)',
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: '0.65rem', color, fontWeight: 700, fontFamily: 'var(--mono)' }}>{Math.round(pct)}</span>
    </div>
  )
}

function TokenLogo({ src, symbol, size = 28 }: { src?: string; symbol: string; size?: number }) {
  const [err, setErr] = useState(false)
  const bg = `hsl(${(symbol.charCodeAt(0) * 17 + 180) % 360},60%,25%)`
  if (!src || err) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%', background: bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.35, fontWeight: 800, color: '#fff', flexShrink: 0,
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        {symbol.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return (
    <img src={src} alt={symbol} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      onError={() => setErr(true)} />
  )
}

interface RowProps {
  token: ArcToken; rank: number; onClick: () => void
  dupCount?: number; expanded?: boolean; onToggleExpand?: () => void
  isDuplicateRow?: boolean
}
function TokenRow({ token, rank, onClick, dupCount = 0, expanded = false, onToggleExpand, isDuplicateRow = false }: RowProps) {
  const lp      = token.launchpad
  const lpColor = getLaunchpadColor(lp)
  const ch24    = token.priceChange24h
  const score   = Math.min(100, Math.max(0,
    (token.holderCount > 0 ? Math.min(40, token.holderCount / 25) : 0) +
    (token.volume24h > 0   ? Math.min(40, Math.log10(token.volume24h + 1) * 8) : 0) +
    (token.txCount24h > 0  ? Math.min(20, token.txCount24h / 50) : 0)
  ))

  return (
    <tr className={`token-row${isDuplicateRow ? ' duplicate-row' : ''}`} onClick={onClick}>
      {/* rank */}
      <td className="td-rank">
        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{isDuplicateRow ? '↳' : rank}</span>
      </td>
      {/* token */}
      <td className="td-token">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: isDuplicateRow ? 20 : 0 }}>
          <TokenLogo src={token.logoUrl} symbol={token.symbol} size={isDuplicateRow ? 22 : 28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '0.82rem', color: isDuplicateRow ? 'var(--text-muted)' : 'var(--text)' }}>
                {token.symbol}
              </span>
              {token.verified && (
                <span style={{ fontSize: '0.55rem', background: '#1d4ed822', color: '#60a5fa', border: '1px solid #1d4ed844', borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>
                  ✓ VERIFIED
                </span>
              )}
              <span style={{ fontSize: '0.55rem', background: lpColor + '22', color: lpColor, border: `1px solid ${lpColor}44`, borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>
                {lp}
              </span>
              {isDuplicateRow && (
                <span title="Another contract also uses this ticker — sorted below the highest-liquidity one." style={{ fontSize: '0.55rem', background: '#f59e0b18', color: 'var(--amber)', border: '1px solid #f59e0b44', borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>
                  ⚠ SAME TICKER
                </span>
              )}
              {!isDuplicateRow && dupCount > 0 && (
                <button
                  onClick={e => { e.stopPropagation(); onToggleExpand?.() }}
                  style={{ fontSize: '0.6rem', background: 'var(--bg-3)', color: 'var(--text-muted)', border: '1px solid var(--border-hi)', borderRadius: 3, padding: '1px 5px', fontWeight: 700, cursor: 'pointer' }}
                >
                  {expanded ? '▾' : '▸'} +{dupCount} same ticker
                </button>
              )}
            </div>
            <div style={{ fontSize: '0.67rem', color: 'var(--text-muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{token.name}</span>
              <span style={{ fontFamily: 'var(--mono)', opacity: 0.6, flexShrink: 0 }}>
                {token.address.slice(0,6)}…{token.address.slice(-4)}
              </span>
              <a
                href={`${ARC_EXPLORER}/address/${token.address}`}
                target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ color: 'var(--text-muted)', opacity: 0.5, textDecoration: 'none', fontSize: '0.6rem', flexShrink: 0 }}
              >↗</a>
            </div>
          </div>
        </div>
      </td>
      {/* age */}
      <td className="td-num">
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {fmtAge(token.ageMs)}
        </span>
      </td>
      {/* mcap */}
      <td className="td-num">
        <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)' }}>{fmt(token.marketCap, '$')}</div>
        <div style={{ fontSize: '0.65rem', color: pctColor(ch24) }}>{fmtPct(ch24)}</div>
      </td>
      {/* liquidity */}
      <td className="td-num">
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>{fmt(token.liquidity, '$')}</span>
      </td>
      {/* volume 24h */}
      <td className="td-num">
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>{fmt(token.volume24h, '$')}</span>
      </td>
      {/* txns */}
      <td className="td-num">
        <div style={{ fontSize: '0.75rem', color: 'var(--text)' }}>{token.txCount24h.toLocaleString()}</div>
        <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--green)' }}>{token.buys24h}</span>
          {' / '}
          <span style={{ color: 'var(--red)' }}>{token.sells24h}</span>
        </div>
      </td>
      {/* holders */}
      <td className="td-num">
        <span style={{ fontSize: '0.78rem', fontFamily: 'var(--mono)', color: 'var(--text)' }}>
          {token.holderCount > 0 ? token.holderCount.toLocaleString() : '—'}
        </span>
      </td>
      {/* score */}
      <td className="td-num">
        <ScoreBar score={score} />
      </td>
      {/* quote */}
      <td className="td-num">
        <span style={{ fontSize: '0.65rem', color: 'var(--adx-accent)', background: 'var(--adx-accent)18', borderRadius: 3, padding: '2px 5px', fontWeight: 700 }}>
          {token.quoteSymbol}
        </span>
      </td>
    </tr>
  )
}

interface CardProps { token: ArcToken; dupCount?: number; onClick: () => void }
function TokenCard({ token, dupCount = 0, onClick }: CardProps) {
  const lp = token.launchpad
  const lpColor = getLaunchpadColor(lp)
  const ch24 = token.priceChange24h
  return (
    <div className="token-card" onClick={onClick}>
      <div className="token-card-top">
        <TokenLogo src={token.logoUrl} symbol={token.symbol} size={36} />
        <div className="token-card-name">
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {token.symbol}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {token.name} · {fmtAge(token.ageMs)}
          </div>
          <div className="token-card-badges">
            {token.verified && (
              <span style={{ fontSize: '0.58rem', background: '#1d4ed822', color: '#60a5fa', border: '1px solid #1d4ed844', borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>✓ VERIFIED</span>
            )}
            <span style={{ fontSize: '0.58rem', background: lpColor + '22', color: lpColor, border: `1px solid ${lpColor}44`, borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>{lp}</span>
            {dupCount > 0 && (
              <span style={{ fontSize: '0.58rem', background: '#f59e0b18', color: 'var(--amber)', border: '1px solid #f59e0b44', borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>+{dupCount} same ticker</span>
            )}
          </div>
        </div>
        <div className="token-card-price">
          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text)' }}>{fmt(token.marketCap, '$')}</div>
          <div style={{ fontSize: '0.72rem', color: pctColor(ch24), fontWeight: 700 }}>{fmtPct(ch24)}</div>
        </div>
      </div>
      <div className="token-card-stats">
        <div className="token-card-stat"><span className="token-card-stat-label">Liq</span><span className="token-card-stat-value">{fmt(token.liquidity, '$')}</span></div>
        <div className="token-card-stat"><span className="token-card-stat-label">Vol</span><span className="token-card-stat-value">{fmt(token.volume24h, '$')}</span></div>
        <div className="token-card-stat"><span className="token-card-stat-label">Txns</span><span className="token-card-stat-value">{token.txCount24h.toLocaleString()}</span></div>
        <div className="token-card-stat"><span className="token-card-stat-label">Holders</span><span className="token-card-stat-value">{token.holderCount > 0 ? token.holderCount.toLocaleString() : '—'}</span></div>
      </div>
    </div>
  )
}

export default function Terminal({ navigate, registerFeedTokens }: Props) {
  const [tokens,   setTokens]   = useState<ArcToken[]>([])
  const [loading,  setLoading]  = useState(true)
  const [source,   setSource]   = useState('All sources')
  const [viewTab,  setViewTab]  = useState('Trending')
  const [sortCol,  setSortCol]  = useState<SortCol>('volume')
  const [sortAsc,  setSortAsc]  = useState(false)
  const [search,   setSearch]   = useState('')
  const [page,     setPage]     = useState(1)
  const [minMcap,  setMinMcap]  = useState('')
  const [maxMcap,  setMaxMcap]  = useState('')
  const [minVol,   setMinVol]   = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const tickerRef = useRef<HTMLDivElement>(null)

  // Focused on ARCDEX's own launches plus Argus (every Portal) rather than
  // RadarDex's broad, unattributed multi-launchpad aggregate.
  const argusSeen = useRef(new Map<string, { t: ArcToken; seen: number }>())
  const oursRef = useRef<ArcToken[]>([])

  // Merge, don't replace: when GeckoTerminal throttles one refresh, the
  // list comes back short — coins keep their last-known row until they've
  // been missing for 10 minutes, instead of flickering out of the table.
  const publish = useCallback((fresh: ArcToken[]) => {
    const now = Date.now()
    const seen = argusSeen.current
    for (const t of fresh) seen.set(t.address.toLowerCase(), { t, seen: now })
    for (const [k, v] of seen) if (now - v.seen > 10 * 60_000) seen.delete(k)
    const data = [...oursRef.current, ...[...seen.values()].map(v => v.t)]
    setTokens(data)
    // Keep the loading state until there's something to show — the first
    // source to land may be an empty one.
    if (data.length > 0) setLoading(false)
    registerFeedTokens(
      [...data].sort((a,b) => b.volume24h - a.volume24h).slice(0, 10)
        .map(t => ({ address: t.address, symbol: t.symbol }))
    )
  }, [registerFeedTokens])

  const load = useCallback(async () => {
    // Each source is shown the moment it lands — the Argus list (usually a
    // ~1s CDN hit) doesn't wait on our own launchpad's on-chain reads, or
    // vice versa.
    //
    // Argus: GeckoTerminal (live, every Portal) via getArgusMarket, whose
    // callback delivers anything that completes later. The on-chain reader
    // is only a last resort: ~300 RPC calls against a rate-limited node.
    const argus = getArgusMarket(more => publish(more.map(argusPoolToArcToken)))
      .then(pools => pools.map(argusPoolToArcToken))
      .catch(() => getArgusTokens().catch(() => [] as ArcToken[]))
      .then(fresh => publish(fresh))
    // A failed read keeps the last known list rather than wiping it.
    const ours = getAllLaunchpadTokensAsArcTokens()
      .then(t => { oursRef.current = t; publish([]) })
      .catch(() => {})
    await Promise.all([argus, ours])
    setLoading(false) // both done — even if everything came back empty
  }, [publish])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const iv = setInterval(() => void load(), 15_000)
    return () => clearInterval(iv)
  }, [load])

  // reset page on filter change
  useEffect(() => setPage(1), [source, viewTab, search, sortCol, sortAsc, minMcap, maxMcap, minVol])

  // ── curate: fold ticker-squatting duplicates behind an expand toggle,
  // drop fully-dead placeholder entries — see lib/curate.ts ────────────
  const curation = useMemo(() => curateTokens(tokens), [tokens])
  const groupByPrimaryAddress = useMemo(() => {
    const m = new Map<string, CuratedGroup>()
    for (const g of curation.groups) m.set(g.primary.address, g)
    return m
  }, [curation])

  // Source pills are derived from what's actually in the data, not a
  // fixed list — RadarDex's launchpad attribution is null for ~99.8% of
  // tokens (verified directly against the live API), so a hardcoded list
  // of "known" launchpads mostly produced pills that matched zero real
  // tokens. Sorted by how many tokens are actually behind each one.
  const sources = useMemo(() => {
    const counts = new Map<string, number>()
    for (const g of curation.groups) counts.set(g.primary.launchpad, (counts.get(g.primary.launchpad) ?? 0) + 1)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
    return ['All sources', ...sorted]
  }, [curation])

  // ── filter (runs against each group's primary token) ────────────────
  const matchesFilters = useCallback((t: ArcToken) => {
    if (search) {
      const q = search.toLowerCase()
      if (!t.symbol.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q) && !t.address.toLowerCase().includes(q)) return false
    }
    if (source !== 'All sources') {
      const lp = t.launchpad.toLowerCase()
      const src = source.toLowerCase()
      if (src === 'uniswap v4') { if (!lp.includes('uniswap') && !lp.includes('v4')) return false }
      else if (!lp.includes(src.split(' ')[0])) return false
    }
    if (viewTab === 'New pair' || viewTab === 'New <15m') {
      const maxAge = viewTab === 'New <15m' ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000
      if (t.ageMs > maxAge) return false
    }
    if (viewTab === 'Top volume') {
      if (t.volume24h < 1000) return false
    }
    if (minMcap && t.marketCap < parseFloat(minMcap)) return false
    if (maxMcap && t.marketCap > parseFloat(maxMcap)) return false
    if (minVol  && t.volume24h < parseFloat(minVol))  return false
    return true
  }, [search, source, viewTab, minMcap, maxMcap, minVol])

  const filtered = curation.groups.map(g => g.primary).filter(matchesFilters)

  // ── sort ──────────────────────────────────────────────────────────
  const sorted = [...filtered].sort((a, b) => {
    let diff = 0
    if (sortCol === 'mcap')     diff = (b.marketCap ?? 0)    - (a.marketCap ?? 0)
    if (sortCol === 'volume')   diff = (b.volume24h ?? 0)    - (a.volume24h ?? 0)
    if (sortCol === 'liq')      diff = (b.liquidity ?? 0)    - (a.liquidity ?? 0)
    if (sortCol === 'txns')     diff = (b.txCount24h ?? 0)   - (a.txCount24h ?? 0)
    if (sortCol === 'holders')  diff = (b.holderCount ?? 0)  - (a.holderCount ?? 0)
    if (sortCol === 'change')   diff = (b.priceChange24h??0) - (a.priceChange24h??0)
    if (sortCol === 'age')      diff = a.ageMs - b.ageMs
    if (sortCol === 'score') {
      const scoreOf = (t: ArcToken) =>
        Math.min(40, t.holderCount/25) + Math.min(40, Math.log10(t.volume24h+1)*8) + Math.min(20, t.txCount24h/50)
      diff = scoreOf(b) - scoreOf(a)
    }
    return sortAsc ? -diff : diff
  })

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageItems  = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortAsc(p => !p)
    else { setSortCol(col); setSortAsc(false) }
  }
  function SortTh({ col, label, align = 'right' }: { col: SortCol; label: string; align?: string }) {
    const active = sortCol === col
    return (
      <th className="th-sort" style={{ textAlign: align as 'right' | 'left', cursor: 'pointer' }} onClick={() => toggleSort(col)}>
        <span style={{ color: active ? 'var(--adx-accent)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {label} {active ? (sortAsc ? '↑' : '↓') : ''}
        </span>
      </th>
    )
  }

  // ── top ticker tokens ─────────────────────────────────────────────
  const tickerTokens = tokens.slice(0, 20)

  return (
    <div className="terminal-shell">

      {/* ── scrolling ticker ── */}
      <div className="ticker-bar" ref={tickerRef}>
        <div className="ticker-track">
          {[...tickerTokens, ...tickerTokens].map((t, i) => (
            <span key={i} className="ticker-item" onClick={() => navigate(openPage(t))}>
              <TokenLogo src={t.logoUrl} symbol={t.symbol} size={16} />
              <span className="ticker-sym">{t.symbol}</span>
              <span className="ticker-price">${t.price < 0.001 ? t.price.toExponential(2) : t.price.toPrecision(4)}</span>
              <span className="ticker-chg" style={{ color: pctColor(t.priceChange24h) }}>
                {fmtPct(t.priceChange24h)}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* ── filter bar ── */}
      <div className="filter-bar">
        <div className="source-pills">
          {sources.map(s => (
            <button key={s} className={`source-pill${source === s ? ' active' : ''}`} onClick={() => setSource(s)}>
              {s === 'All sources' ? '◉ All sources' : s}
            </button>
          ))}
        </div>
        <div className="filter-controls">
          <input className="filter-input" placeholder="min MC $" value={minMcap} onChange={e => setMinMcap(e.target.value)} style={{ width: 90 }} />
          <input className="filter-input" placeholder="max MC $" value={maxMcap} onChange={e => setMaxMcap(e.target.value)} style={{ width: 90 }} />
          <input className="filter-input" placeholder="min vol $" value={minVol}  onChange={e => setMinVol(e.target.value)}  style={{ width: 90 }} />
        </div>
      </div>

      {/* ── sort dropdown + view tabs ── */}
      <div className="view-bar">
        <select className="sort-select" value={sortCol} onChange={e => setSortCol(e.target.value as SortCol)}>
          <option value="volume">Sort: volume</option>
          <option value="mcap">Sort: market cap</option>
          <option value="txns">Sort: transactions</option>
          <option value="holders">Sort: holders</option>
          <option value="age">Sort: newest</option>
          <option value="liq">Sort: liquidity</option>
          <option value="score">Sort: score</option>
        </select>
        <div className="view-tabs">
          {VIEW_TABS.map(t => (
            <button key={t} className={`view-tab${viewTab === t ? ' active' : ''}`} onClick={() => setViewTab(t)}>
              {t === 'Trending' ? '⚡ Trending' : t}
            </button>
          ))}
        </div>
        <div className="time-tabs">
          <span className="live-badge">● live</span>
        </div>
      </div>

      {/* ── pagination + search ── */}
      <div className="pagination-bar">
        <button className="pg-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← prev</button>
        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => i + 1).map(n => (
          <button key={n} className={`pg-btn${page === n ? ' active' : ''}`} onClick={() => setPage(n)}>{n}</button>
        ))}
        {totalPages > 5 && <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', padding: '0 4px' }}>…</span>}
        <button className="pg-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>next →</button>
        <span className="pg-info">
          {sorted.length.toLocaleString()} tokens · page {page}/{totalPages}
          {(curation.hiddenDuplicateCount > 0 || curation.deadFilteredCount > 0) && (
            <span title="Contracts reusing another token's ticker are folded into that token's row (expand with the ticker badge); listings with zero liquidity, volume, and holders are hidden entirely.">
              {' · '}{curation.hiddenDuplicateCount > 0 && `${curation.hiddenDuplicateCount} same-ticker duplicates folded`}
              {curation.hiddenDuplicateCount > 0 && curation.deadFilteredCount > 0 && ', '}
              {curation.deadFilteredCount > 0 && `${curation.deadFilteredCount} dead listings hidden`}
            </span>
          )}
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <input
            className="filter-input" placeholder="🔍 Search…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: 160 }}
          />
        </div>
      </div>

      {/* ── table ── */}
      <div className="table-scroll">
        {loading && tokens.length === 0 ? (
          <div className="loading-state">Loading Arc tokens…</div>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th className="th-rank">#</th>
                <th className="th-token" style={{ textAlign: 'left' }}>TOKEN / AGE ↕</th>
                <SortTh col="age"     label="AGE"     align="right" />
                <SortTh col="mcap"    label="MC $"    align="right" />
                <SortTh col="liq"     label="LIQ"     align="right" />
                <SortTh col="volume"  label="ALL VOL" align="right" />
                <SortTh col="txns"    label="ALL TXS" align="right" />
                <SortTh col="holders" label="HOLDERS" align="right" />
                <SortTh col="score"   label="SCORE"   align="right" />
                <th className="th-sort" style={{ textAlign: 'right' }}>QUOTE</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((token, i) => {
                const group = groupByPrimaryAddress.get(token.address)
                const dupCount = group?.duplicates.length ?? 0
                const isExpanded = expanded.has(token.address)
                const goTo = (t: ArcToken) => navigate(openPage(t))
                return (
                  <Fragment key={token.address}>
                    <TokenRow
                      token={token}
                      rank={(page - 1) * PAGE_SIZE + i + 1}
                      onClick={() => goTo(token)}
                      dupCount={dupCount}
                      expanded={isExpanded}
                      onToggleExpand={() => setExpanded(prev => {
                        const next = new Set(prev)
                        if (next.has(token.address)) next.delete(token.address); else next.add(token.address)
                        return next
                      })}
                    />
                    {isExpanded && group?.duplicates.map(dup => (
                      <TokenRow
                        key={dup.address}
                        token={dup}
                        rank={0}
                        isDuplicateRow
                        onClick={() => goTo(dup)}
                      />
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}

        {/* mobile card list — same data, CSS toggles which one is visible */}
        {!loading && (
          <div className="token-cards">
            {pageItems.map(token => {
              const group = groupByPrimaryAddress.get(token.address)
              return (
                <TokenCard
                  key={token.address}
                  token={token}
                  dupCount={group?.duplicates.length ?? 0}
                  onClick={() => navigate(openPage(token))}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
