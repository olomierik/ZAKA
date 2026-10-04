import { isLaunchpadCoin } from '../../../api/_launchpads'
import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import {
  getLaunchpadColor,
  type ArcToken,
} from '../api/radardex'
import { getAllLaunchpadTokensAsArcTokens, LAUNCHPAD_ADDRESS } from '../api/launchpad'
import { subscribeMarketPulse } from '../api/marketPulse'
import { getArgusTokens } from '../api/argus'
import { cachedArgusMarket, getArgusMarket, argusPoolToArcToken } from '../api/argusMarket'
import { curveRowToArcToken, getCurveMarket } from '../api/curveMarket'
import { engineApiUrl, engineEnabled, getNewTokens, marketStream, useEngineStatus } from '../api/marketStream'
import type { ActiveToken, LaunchInfo } from '../../../api/_marketProtocol'
import { curateTokens, type CuratedGroup } from '../lib/curate'
import { getHolderScans } from '../api/social'
import { headBlock } from '../../../api/_arcLogs'
import type { Page } from '../App'
import { toggleWatch, usePrefs } from '../lib/prefs'
import { t as T, N_ } from '../lib/i18n'
import { useIsMobile } from '../lib/useMobile'
import MobileHome from '../components/MobileHome'
import FoundOnArc from '../components/FoundOnArc'
import SafetyBadge from '../components/SafetyBadge'
import CoinBoard, { type BoardCoin } from '../components/CoinBoard'
import { tokenRisk, type Risk } from '../lib/risk'
import { arcStage, arcStageInput } from '../lib/coinStage'
import { arcSafety, LISTING, meetsStandard, safetyRank, SAFETY_COLOR, SAFETY_ICON, SAFETY_LABEL, type SafetyView } from '../lib/safety'
import { useCoinSafety } from '../api/coinSafety'
import { COIN_IMAGE, COIN_LC, COIN_POOL, fmtPct as fmtPctCoin, fmtSmallUsd, useCoin } from '../lib/coin'
import { ChainSwitch } from '../components/Robinhood'

interface Props {
  navigate: (p: Page) => void
  registerFeedTokens: (t: { address: string; symbol: string }[]) => void
}

const ARC_EXPLORER = 'https://explorer.arc.io'

// Every launchpad's coin with a pool (Argus, Minara, Tolly, …) opens the
// full coin page; ARCDEX's own curve coins keep theirs.
function openPage(t: ArcToken): Page {
  return t.launchpad !== 'ARCDEX' && t.poolAddress
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
const QUOTE_SYMBOL: Record<string, string> = {
  '0x3600000000000000000000000000000000000000': 'USDC', '0x0000000000000000000000000000000000000000': 'USDC',
  '0xece5ca8bf9220718e5727754026757512212cb3c': 'ARGUS', '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC', '0x93ffd195481e8c08eb25a158689e4d9e61313111': 'WETH',
}
const NATIVE_USDC = '0x0000000000000000000000000000000000000000'
const QUOTE_BY_SYMBOL: Record<string, string> = {
  USDC: '0x3600000000000000000000000000000000000000', ARGUS: '0xece5ca8bf9220718e5727754026757512212cb3c',
}
/** A live trade's flash on its coin's row: which side, and a counter whose
 * parity alternates the CSS animation so back-to-back trades each restart it. */
interface Flash { side: 'buy' | 'sell'; n: number }
const flashClass = (f?: Flash) => (f ? ` flash-${f.side}-${f.n % 2}` : '')

/** A launch the market engine just detected, as a Terminal row — before its first trade. */
function launchToArcToken(l: LaunchInfo): ArcToken {
  return {
    address: l.token, symbol: l.symbol, name: l.name, decimals: l.decimals, logoUrl: l.image ?? '',
    price: l.priceUsd ?? 0, priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, volume24h: 0, marketCap: l.marketCapUsd ?? 0, liquidity: 0,
    ageMs: Math.max(0, Date.now() - l.timestamp), launchpad: l.launchpad === 'ARGUS' ? 'Argus' : l.launchpad,
    poolAddress: l.pool ?? '', txCount24h: 0, holderCount: 0, buys24h: 0, sells24h: 0, verified: false, graduated: false,
    bondingProgress: null, spark: [], deployer: l.creator ?? undefined, quoteSymbol: (l.quote && QUOTE_SYMBOL[l.quote]) || '',
    quoteAddress: l.quote ?? undefined,
  }
}

/** A coin trading now (GET /v1/tokens/active) that the list doesn't carry yet, as a row: its launch, with its live stats. */
function activeToArcToken(a: ActiveToken): ArcToken | null {
  if (!a.meta) return null
  const s = a.stats
  return {
    ...launchToArcToken(a.meta),
    price: s.priceUsd ?? 0, priceChange5m: s.chg.m5 ?? 0, priceChange1h: s.chg.h1 ?? 0, priceChange24h: s.chg.h24 ?? 0,
    volume24h: s.vol24, marketCap: s.marketCapUsd ?? 0, liquidity: s.liquidityUsd ?? 0,
    txCount24h: s.trades24, buys24h: s.buys24, sells24h: s.sells24,
  }
}

/** Trades in the last 15 minutes from which a coin wears the 🔥 (most active right now). */
const HOT_TRADES = 5

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
// Since 2026-10-04 the stages of a coin's life (lib/coinStage.ts) are tabs too: New, Near bond, Graduated, Established.
const VIEW_TABS = [N_('All'), N_('New'), N_('Near bond'), N_('Graduated'), N_('Established'), N_('Trending'), N_('Top volume')]
const STAGE_TAB: Record<string, string> = { New: 'new', 'Near bond': 'near', Graduated: 'graduated', Established: 'established' }

/** A per-browser choice (the list or the board; risky coins shown or not). */
const readPref = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage blocked */ } }

// ── sort columns ─────────────────────────────────────────────────────
type SortCol = 'active' | 'mcap' | 'volume' | 'txns' | 'score' | 'age' | 'liq' | 'holders' | 'change' | 'risk'

const PAGE_SIZE = 50

/** A sortable column header. (Declared out here: a component created inside
 * render is a new component on every render, remounting the header each time.) */
function SortTh({ col, label, sortCol, sortAsc, onSort }: { col: SortCol; label: string; sortCol: SortCol; sortAsc: boolean; onSort: (c: SortCol) => void }) {
  const active = sortCol === col
  return (
    <th className="th-sort" style={{ textAlign: 'right', cursor: 'pointer' }} onClick={() => onSort(col)}>
      <span style={{ color: active ? 'var(--adx-accent)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {label} {active ? (sortAsc ? '↑' : '↓') : ''}
      </span>
    </th>
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
  risk: Risk
  safety: SafetyView
  flash?: Flash
  /** Trades in the last 15 minutes, when it's one of the most active coins right now. */
  hot?: number
}
function HotBadge({ n }: { n: number }) {
  return <span className="hot-badge" title={T('{n} trades in the last 15 minutes', { n })}>🔥 {n}</span>
}
function fmtPrice(p: number): string {
  if (!p || !Number.isFinite(p)) return '—'
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (p >= 1) return `$${p.toFixed(4)}`
  return `$${p.toPrecision(4)}`
}
function TokenRow({ token, rank, onClick, dupCount = 0, expanded = false, onToggleExpand, isDuplicateRow = false, safety, flash, hot, pinned }: RowProps & { pinned?: boolean }) {
  const lp      = token.launchpad
  const lpColor = getLaunchpadColor(lp)
  const ch24    = token.priceChange24h
  const starred = usePrefs().watchlist.includes(token.address.toLowerCase())

  return (
    <tr className={`token-row${isDuplicateRow ? ' duplicate-row' : ''}${pinned ? ' pinned-row' : ''}${flashClass(flash)}`} onClick={onClick}>
      <td className="td-rank">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {!isDuplicateRow && <button className={`row-star${starred ? ' on' : ''}`} title={starred ? T("Remove from watchlist") : T("Add to watchlist")} onClick={e => { e.stopPropagation(); toggleWatch(token.address) }}>{starred ? '★' : '☆'}</button>}
          <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{pinned ? '' : isDuplicateRow ? '↳' : rank}</span>
        </span>
      </td>
      <td className="td-token">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: isDuplicateRow ? 20 : 0 }}>
          <TokenLogo src={token.logoUrl} symbol={token.symbol} size={isDuplicateRow ? 22 : 28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span className="mk-sym" style={{ color: isDuplicateRow ? 'var(--text-muted)' : undefined }}>{token.symbol}</span>
              <span className="mk-quote">/{token.quoteSymbol || 'USDC'}</span>
              {pinned && <span className="mk-official">{T('Official')}</span>}
              {hot ? <HotBadge n={hot} /> : null}
              {token.verified && <span className="mk-tag" style={{ color: '#6ea2ff', borderColor: '#2a6df455' }}>{T("✓ VERIFIED")}</span>}
              <span className="mk-tag" style={{ color: lpColor, borderColor: lpColor + '55' }}>{lp}</span>
              {isDuplicateRow && (
                <span title={T("Another contract also uses this ticker — sorted below the highest-liquidity one.")} className="mk-tag" style={{ color: 'var(--amber)', borderColor: '#f0b90b55' }}>{T("⚠ SAME TICKER")}</span>
              )}
              {!isDuplicateRow && dupCount > 0 && (
                <button onClick={e => { e.stopPropagation(); onToggleExpand?.() }} className="mk-tag mk-dup">
                  {expanded ? '▾' : '▸'} +{dupCount}{' '}{T("same ticker")}</button>
              )}
            </div>
            <div className="mk-sub">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{token.name}</span>
              <span style={{ flexShrink: 0 }}>· {fmtAge(token.ageMs)}</span>
              {token.ageMs < 5 * 60_000 && <span className="new-badge">{T("NEW")}</span>}
              {!token.graduated && token.bondingProgress !== null && token.bondingProgress < 100 && <span className="mk-tag" title={T('{pct}% of the way to graduating', { pct: token.bondingProgress.toFixed(0) })} style={{ color: '#6ea2ff', borderColor: '#2a6df455' }}>🚀 {token.bondingProgress.toFixed(0)}%</span>}
              <a href={`${ARC_EXPLORER}/address/${token.address}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="mk-addr">
                {token.address.slice(0,6)}…{token.address.slice(-4)} ↗
              </a>
            </div>
          </div>
        </div>
      </td>
      <td className="td-num mk-price">{fmtPrice(token.price)}</td>
      <td className="td-num"><span className="mk-chg" style={{ color: pctColor(ch24) }}>{ch24 > 0 ? '+' : ''}{ch24.toFixed(2)}%</span></td>
      <td className="td-num">{fmt(token.marketCap, '$')}</td>
      <td className="td-num">{fmt(token.liquidity, '$')}</td>
      <td className="td-num">{fmt(token.volume24h, '$')}</td>
      <td className="td-num">
        <div>{token.txCount24h.toLocaleString()}</div>
        <div style={{ fontSize: '0.66rem' }}><span style={{ color: 'var(--green)' }}>{token.buys24h}</span>{' / '}<span style={{ color: 'var(--red)' }}>{token.sells24h}</span></div>
      </td>
      <td className="td-num">{token.holderCount > 0 ? token.holderCount.toLocaleString() : '—'}</td>
      <td className="td-num"><SafetyBadge view={safety} /></td>
      <td className="td-num td-trade"><button className="mk-trade" onClick={e => { e.stopPropagation(); onClick() }}>{T('Trade')}</button></td>
    </tr>
  )
}

interface CardProps { token: ArcToken; dupCount?: number; onClick: () => void; safety: SafetyView; flash?: Flash; hot?: number; pinned?: boolean }
function TokenCard({ token, dupCount = 0, onClick, safety, flash, hot, pinned }: CardProps) {
  const ch24 = token.priceChange24h
  return (
    <div className={`token-card mk-row${pinned ? ' pinned' : ''}${flashClass(flash)}`} onClick={onClick}>
      <TokenLogo src={token.logoUrl} symbol={token.symbol} size={30} />
      <div className="mk-row-name">
        <div className="mk-row-sym">
          <b>{token.symbol}</b><span>/{token.quoteSymbol || 'USDC'}</span>
          {pinned && <span className="mk-official">{T('Official')}</span>}
          {hot ? <HotBadge n={hot} /> : null}
        </div>
        <div className="mk-row-meta"><span style={{ color: SAFETY_COLOR[safety.level] }}>{SAFETY_ICON[safety.level]}</span> {T("Vol")} {fmt(token.volume24h, '$')} · {T("MCap")} {fmt(token.marketCap, '$')}{dupCount > 0 ? ` · +${dupCount}` : ''}</div>
      </div>
      <div className="mk-row-price">{fmtPrice(token.price)}<small>{fmtAge(token.ageMs)} · {T(SAFETY_LABEL[safety.level])}</small></div>
      <span className={`mk-row-chg ${ch24 > 0 ? 'up' : ch24 < 0 ? 'down' : 'flat'}`}>{ch24 > 0 ? '+' : ''}{ch24.toFixed(2)}%</span>
    </div>
  )
}

export default function Terminal({ navigate, registerFeedTokens }: Props) {
  const mobile = useIsMobile()
  const [tokens,   setTokens]   = useState<ArcToken[]>([])
  const [loading,  setLoading]  = useState(true)
  const [source,   setSource]   = useState('All sources')
  const [viewTab,  setViewTab]  = useState('Trending')
  // Most active first (2026-10-03, owner: rank coins by their activity, so the busiest are on top and flashing).
  const [sortCol,  setSortCol]  = useState<SortCol>('active')
  const [sortAsc,  setSortAsc]  = useState(false)
  const [search,   setSearch]   = useState('')
  const [page,     setPage]     = useState(1)
  // Phones: filters fold away behind a button, and the list grows with
  // "Show more" (an app feed) instead of numbered pages.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [shown, setShown] = useState(PAGE_SIZE)
  // The list or the coin board (CoinBoard), and whether coins under the listing standard show (lib/safety.ts).
  const [view, setView] = useState<'list' | 'board'>(() => (readPref('arcdex:mk-view') === 'board' ? 'board' : 'list'))
  const [showRisky, setShowRisky] = useState(() => readPref('arcdex:show-risky') === '1')
  useEffect(() => { writePref('arcdex:mk-view', view) }, [view])
  useEffect(() => { writePref('arcdex:show-risky', showRisky ? '1' : '0') }, [showRisky])
  const [minMcap,  setMinMcap]  = useState('')
  const [maxMcap,  setMaxMcap]  = useState('')
  const [minVol,   setMinVol]   = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const coinQ = useCoin()

  // ARCDEX's own launches, Argus (every Portal) and every other Arc
  // launchpad GeckoTerminal lists (api/_launchpads.ts), each with its badge.
  const argusSeen = useRef(new Map<string, { t: ArcToken; seen: number }>())
  const oursRef = useRef<ArcToken[]>([])
  // Mercuri's and SolonPad's coins: on their bonding curves GeckoTerminal
  // has no pool for them (api/curveMarket.ts).
  const curvesRef = useRef<ArcToken[]>([])
  // From the market engine (when connected): launches it detected, and its
  // once-a-second price/volume ticks, laid over the rows above.
  const launchesRef = useRef(new Map<string, LaunchInfo>())
  // What's trading now (GET /v1/tokens/active, every 15s): each coin's activity score and its trades in 15 minutes.
  const activeRef = useRef(new Map<string, ActiveToken>())
  // Trades seen live since the last poll: each one lifts its coin, so the ranking follows the market between polls.
  const liveTradesRef = useRef(new Map<string, number>())
  // The ranking is re-taken every 5 seconds (and after each poll), not on every trade: rows jumping on each flash
  // couldn't be read.
  const rankRef = useRef(new Map<string, number>())
  const [, setRankTick] = useState(0)
  const takeRank = useCallback(() => {
    const m = new Map<string, number>()
    for (const [k, a] of activeRef.current) m.set(k, a.score)
    for (const [k, n] of liveTradesRef.current) m.set(k, (m.get(k) ?? 0) + 2 * n)
    rankRef.current = m
    setRankTick(x => x + 1)
  }, [])
  useEffect(() => { const id = setInterval(() => { if (!document.hidden) takeRank() }, 5_000); return () => clearInterval(id) }, [takeRank])
  const ticksRef = useRef(new Map<string, [number | null, number | null, number, number | null, number]>())
  const engineStatus = useEngineStatus()
  const withTick = (t: ArcToken): ArcToken => {
    const k = ticksRef.current.get(t.address.toLowerCase())
    if (!k) return t
    const [price, chg24, vol, mc, trades] = k
    return {
      ...t,
      price: price ?? t.price,
      priceChange24h: chg24 ?? t.priceChange24h,
      volume24h: Math.max(vol, t.volume24h),
      marketCap: mc ?? (price && t.price && t.marketCap ? t.marketCap * (price / t.price) : t.marketCap),
      txCount24h: Math.max(trades, t.txCount24h),
    }
  }

  // Merge, don't replace: when GeckoTerminal throttles one refresh, the
  // list comes back short — coins keep their last-known row until they've
  // been missing for 10 minutes, instead of flickering out of the table.
  const publish = useCallback((fresh: ArcToken[]) => {
    const now = Date.now()
    const seen = argusSeen.current
    for (const t of fresh) seen.set(t.address.toLowerCase(), { t, seen: now })
    for (const [k, v] of seen) if (now - v.seen > 10 * 60_000) seen.delete(k)
    const listed = new Set([...oursRef.current.map(t => t.address.toLowerCase()), ...seen.keys()])
    const curves = curvesRef.current.filter(t => !listed.has(t.address))
    for (const t of curves) listed.add(t.address)
    const launched = [...launchesRef.current.values()].filter(l => !listed.has(l.token)).map(launchToArcToken)
    for (const t of launched) listed.add(t.address.toLowerCase())
    const busy = [...activeRef.current.values()].filter(a => !listed.has(a.token)).map(activeToArcToken).filter((t): t is ArcToken => t !== null)
    // Launchpad coins only (owner, 2026-10-04): a coin from a contract no launchpad made isn't listed.
    const data = [...oursRef.current, ...[...seen.values()].map(v => v.t), ...curves, ...launched, ...busy].filter(t => isLaunchpadCoin(t.launchpad)).map(withTick)
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
    const curves = getCurveMarket()
      .then(rows => { const now = Date.now(); curvesRef.current = rows.map(r => curveRowToArcToken(r, now)); publish([]) })
      .catch(() => {})
    await Promise.all([argus, ours, curves])
    setLoading(false) // all done — even if everything came back empty
  }, [publish])

  // The last list this browser saw, at once; the fresh one replaces it.
  useEffect(() => { const c = cachedArgusMarket(); if (c) publish(c.map(argusPoolToArcToken)) }, [publish])
  useEffect(() => { void load() }, [load])
  // With the engine streaming prices, the list only needs a slow metadata
  // refresh (names, liquidity, 5m/1h change); otherwise poll every 15s.
  const engineLive = engineEnabled && engineStatus === 'open'
  useEffect(() => {
    const iv = setInterval(() => void load(), engineLive ? 60_000 : 15_000)
    return () => clearInterval(iv)
  }, [load, engineLive])

  // ── live pulse: every buy and sell on-chain flashes its coin's row ──
  // (green for a buy, red for a sell) as its block lands, straight from
  // Arc's WebSocket (api/marketPulse.ts). The "live" badge counts them.
  const [flash, setFlash] = useState<Map<string, Flash>>(new Map())
  const [perMin, setPerMin] = useState(0)
  const pulseBuf = useRef<{ token: string; side: 'buy' | 'sell' }[]>([])
  const pulseTimes = useRef<number[]>([])
  const lastPulse = useRef(new Map<string, number>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countPerMin = useCallback(() => {
    const cutoff = Date.now() - 60_000
    pulseTimes.current = pulseTimes.current.filter(t => t > cutoff)
    setPerMin(pulseTimes.current.length)
  }, [])
  const pulse = useCallback((p: { token: string; side: 'buy' | 'sell' }) => {
    const now = Date.now()
    lastPulse.current.set(p.token, now)
    liveTradesRef.current.set(p.token, (liveTradesRef.current.get(p.token) ?? 0) + 1)
    pulseTimes.current.push(now)
    pulseBuf.current.push(p)
    if (flushTimer.current) return
    // Batched: a burst of swaps is one re-render, not one per swap.
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      const batch = pulseBuf.current
      pulseBuf.current = []
      countPerMin()
      if (document.hidden) return
      setFlash(prev => {
        const next = new Map(prev)
        for (const x of batch) next.set(x.token, { side: x.side, n: (next.get(x.token)?.n ?? 0) + 1 })
        return next
      })
    }, 150)
  }, [countPerMin])
  useEffect(() => {
    const id = setInterval(countPerMin, 5_000)
    return () => { clearInterval(id); if (flushTimer.current) clearTimeout(flushTimer.current) }
  }, [countPerMin])
  // Which pool (and quote) belongs to which listed coin, for decoding swaps.
  const poolsRef = useRef(new Map<string, { token: string; quote: string }>())
  const curveRef = useRef(new Set<string>())
  useEffect(() => {
    const pools = new Map<string, { token: string; quote: string }>()
    const curve = new Set<string>()
    for (const t of tokens) {
      if (t.launchpad === 'ARCDEX') curve.add(t.address.toLowerCase())
      const quote = t.quoteAddress || QUOTE_BY_SYMBOL[t.quoteSymbol]
      if (t.poolAddress && quote) pools.set(t.poolAddress.toLowerCase(), { token: t.address.toLowerCase(), quote: quote.toLowerCase() })
    }
    poolsRef.current = pools
    curveRef.current = curve
  }, [tokens])
  // The listed v3 pools (a v3 pool is a contract address; v4 pools are ids).
  // Rows quoted in native USDC trade on a launchpad's curve or a v4 pool, never v3.
  const v3Pools = useMemo(() => [...new Set(tokens.filter(t => /^0x[0-9a-fA-F]{40}$/.test(t.poolAddress) && t.quoteAddress?.toLowerCase() !== NATIVE_USDC).map(t => t.poolAddress.toLowerCase()))].sort().join(','), [tokens])
  useEffect(() => subscribeMarketPulse(LAUNCHPAD_ADDRESS, {
    pool: id => poolsRef.current.get(id),
    curve: token => curveRef.current.has(token),
  }, pulse, v3Pools ? v3Pools.split(',') : []), [pulse, v3Pools])

  // Market engine: new launches appear the moment they're detected (before
  // their first trade), and prices/volumes move with every tick.
  useEffect(() => {
    if (!engineEnabled) return
    void getNewTokens(100).then(ls => { for (const l of ls) launchesRef.current.set(l.token, l); publish([]) }).catch(() => {})
    const offNew = marketStream.subscribe({ channel: 'new_tokens' }, m => {
      if (m.t !== 'NEW_TOKEN') return
      launchesRef.current.set(m.d.token, m.d)
      if (launchesRef.current.size > 500) launchesRef.current.delete(launchesRef.current.keys().next().value as string)
      publish([])
    })
    const offTicks = marketStream.subscribe({ channel: 'market' }, m => {
      if (m.t !== 'TICKS') return
      for (const [token, price, chg, vol, mc, trades] of m.d) {
        const prev = ticksRef.current.get(token)
        ticksRef.current.set(token, [price, chg, vol, mc, trades])
        // A trade the chain feed didn't show (its socket reconnecting, or a
        // pool this list doesn't carry): flash it from the engine's count.
        if (prev && trades > prev[4] && Date.now() - (lastPulse.current.get(token) ?? 0) > 3_000)
          pulse({ token, side: price !== null && prev[0] !== null && price < prev[0] ? 'sell' : 'buy' })
      }
      publish([])
    })
    return () => { offNew(); offTicks() }
  }, [publish, pulse])

  useEffect(() => {
    if (!engineEnabled || !engineApiUrl) return
    let alive = true
    const load = () => void fetch(`${engineApiUrl}/v1/tokens/active?limit=150`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { tokens?: ActiveToken[] } | null) => {
        if (!alive || !j?.tokens) return
        activeRef.current = new Map(j.tokens.map(a => [a.token.toLowerCase(), a]))
        liveTradesRef.current = new Map()
        takeRank()
        publish([])
      }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [publish, takeRank])

  // reset page on filter change
  useEffect(() => { setPage(1); setShown(PAGE_SIZE) }, [source, viewTab, search, sortCol, sortAsc, minMcap, maxMcap, minVol])

  // Holder counts from ARCDEX's own on-chain index, for the coins it has
  // counted within the last day (every coin page keeps its coin's count
  // current) — the market list itself carries none.
  const tokensRef = useRef(tokens)
  useEffect(() => { tokensRef.current = tokens }, [tokens])
  const [indexedHolders, setIndexedHolders] = useState<Map<string, number>>(new Map())
  const haveTokens = tokens.length > 0
  useEffect(() => {
    if (!haveTokens) return
    let alive = true
    const load = async () => {
      try {
        const [scans, head] = await Promise.all([getHolderScans(tokensRef.current.map(t => t.address)), headBlock()])
        const fresh = new Map(scans.filter(r => r.holders > 0 && r.scanned_to >= head - 172_800).map(r => [r.token, r.holders]))
        if (alive) setIndexedHolders(fresh)
      } catch { /* no index: the column stays as it was */ }
    }
    void load()
    // Again once the engine's most active coins have joined the list (its first poll lands within seconds), then every
    // 30s: the engine keeps those coins' counts current every minute (2026-10-03).
    const soon = setTimeout(() => void load(), 10_000)
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { alive = false; clearTimeout(soon); clearInterval(id) }
  }, [haveTokens])
  const withHolders = useMemo(() => indexedHolders.size
    ? tokens.map(t => { const h = indexedHolders.get(t.address.toLowerCase()); return h ? { ...t, holderCount: h } : t })
    : tokens, [tokens, indexedHolders])

  // ── curate: fold ticker-squatting duplicates behind an expand toggle,
  // drop fully-dead placeholder entries — see lib/curate.ts ────────────
  const curation = useMemo(() => curateTokens(withHolders), [withHolders])
  // Every coin's risk score, from its market data (lib/risk.ts). A smaller
  // coin reusing a bigger one's ticker scores higher.
  const riskBy = useMemo(() => {
    const m = new Map<string, Risk>()
    for (const g of curation.groups) {
      m.set(g.primary.address, tokenRisk(g.primary))
      for (const d of g.duplicates) m.set(d.address, tokenRisk(d, { sameTicker: true }))
    }
    return m
  }, [curation])
  const riskOfRow = (t: ArcToken) => riskBy.get(t.address) ?? tokenRisk(t)

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
    // The board has its own columns: the tabs only filter the list.
    const stageTab = view === 'list' ? STAGE_TAB[viewTab] : undefined
    if (stageTab && arcStage(t) !== stageTab) return false
    if (view === 'list' && viewTab === 'Top volume') {
      if (t.volume24h < 1000) return false
    }
    if (minMcap && t.marketCap < parseFloat(minMcap)) return false
    if (maxMcap && t.marketCap > parseFloat(maxMcap)) return false
    if (minVol  && t.volume24h < parseFloat(minVol))  return false
    return true
  }, [search, source, viewTab, minMcap, maxMcap, minVol, view])

  // ── safety (lib/safety.ts): the engine's scan of the coins worth asking about (the young and on-curve ones, the
  // busiest, the youngest graduates and $ARCDEX), with each coin's market data. Others are rated from market data. ──
  const askTokens = useMemo(() => {
    const prim = curation.groups.map(g => g.primary)
    const young = prim.filter(t => { const st = arcStage(t); return st === 'new' || st === 'near' || st === 'bonding' }).sort((a, b) => a.ageMs - b.ageMs).slice(0, 120)
    const busy = [...prim].sort((a, b) => b.volume24h - a.volume24h).slice(0, 150)
    const grads = prim.filter(t => arcStage(t) === 'graduated').sort((a, b) => a.ageMs - b.ageMs).slice(0, 40)
    return [...new Set([COIN_LC, ...young, ...busy, ...grads].map(t => (typeof t === 'string' ? t : t.address.toLowerCase())))]
  }, [curation])
  const asked = useMemo(() => new Set(askTokens), [askTokens])
  const chainSafety = useCoinSafety(askTokens)
  const safetyOf = (t: ArcToken): SafetyView => {
    const k = t.address.toLowerCase()
    return arcSafety(t, riskOfRow(t), asked.has(k) ? chainSafety.get(k) : null, arcStageInput(t).onCurve)
  }
  const passes = (t: ArcToken, v: SafetyView) => meetsStandard({ level: v.level, stage: arcStage(t), onCurve: arcStageInput(t).onCurve, liquidityUsd: t.liquidity, holders: t.holderCount > 0 ? t.holderCount : null })

  const matched = curation.groups.map(g => g.primary).filter(matchesFilters)
  const rated = new Map(matched.map(t => [t.address, safetyOf(t)]))
  const ratedOf = (t: ArcToken) => rated.get(t.address) ?? safetyOf(t)
  // The listing standard (lib/safety.ts): danger, and pool coins under $2K of liquidity or 20 holders, stay out of the
  // default lists; a search, or "Show risky coins", shows everything with its badge.
  const standardOn = !showRisky && !search.trim()
  const filtered = standardOn ? matched.filter(t => passes(t, ratedOf(t))) : matched
  const hiddenCount = matched.length - filtered.length
  const shownAddresses = useMemo(() => new Set(filtered.map(t => t.address.toLowerCase())), [filtered])

  // ── sort ──────────────────────────────────────────────────────────
  // A coin's activity: the engine's score (2 × trades in 15 minutes + trades in the hour + $100 of the hour's volume
  // a point) plus 2 for every trade seen live since its last poll, as of the last re-take (every 5 seconds).
  const activityOf = (t: ArcToken) => rankRef.current.get(t.address.toLowerCase()) ?? 0
  const hotOf = (t: ArcToken) => {
    const k = t.address.toLowerCase()
    const n = (activeRef.current.get(k)?.trades15m ?? 0) + (liveTradesRef.current.get(k) ?? 0)
    return n >= HOT_TRADES ? n : undefined
  }
  const sorted = [...filtered].sort((a, b) => {
    let diff = 0
    if (sortCol === 'active')   diff = activityOf(b) - activityOf(a) || (b.volume24h ?? 0) - (a.volume24h ?? 0)
    if (sortCol === 'mcap')     diff = (b.marketCap ?? 0)    - (a.marketCap ?? 0)
    if (sortCol === 'volume')   diff = (b.volume24h ?? 0)    - (a.volume24h ?? 0)
    if (sortCol === 'liq')      diff = (b.liquidity ?? 0)    - (a.liquidity ?? 0)
    if (sortCol === 'txns')     diff = (b.txCount24h ?? 0)   - (a.txCount24h ?? 0)
    if (sortCol === 'holders')  diff = (b.holderCount ?? 0)  - (a.holderCount ?? 0)
    if (sortCol === 'change')   diff = (b.priceChange24h??0) - (a.priceChange24h??0)
    if (sortCol === 'age')      diff = a.ageMs - b.ageMs
    // Safest first; tap again for the riskiest.
    if (sortCol === 'risk')     diff = safetyRank(ratedOf(a).level) - safetyRank(ratedOf(b).level) || riskOfRow(a).score - riskOfRow(b).score
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
  const sortTh = (col: SortCol, label: string) => <SortTh col={col} label={label} sortCol={sortCol} sortAsc={sortAsc} onSort={toggleSort} />

  // $ARCDEX, pinned above the list (the first page, unless a search leaves it out): its row from the list, else
  // one built from the engine's numbers for it.
  const listedCoin = tokens.find(t => t.address.toLowerCase() === COIN_LC)
  const coinMatches = !search || 'arcdex arcd'.includes(search.toLowerCase()) || COIN_LC.includes(search.toLowerCase())
  const coinRow: ArcToken | null = page !== 1 || !coinMatches ? null : listedCoin ? { ...listedCoin, logoUrl: COIN_IMAGE } : (coinQ ? {
    address: COIN_LC, symbol: 'ARCDEX', name: 'ARCDEX', decimals: 18, logoUrl: coinQ.image,
    price: coinQ.priceUsd ?? 0, priceChange5m: 0, priceChange1h: 0, priceChange24h: coinQ.change24h ?? 0,
    volume24h: coinQ.volume24h ?? 0, marketCap: coinQ.marketCapUsd ?? 0, liquidity: coinQ.liquidityUsd ?? 0,
    ageMs: Date.now() - Date.parse('2026-09-24T13:11:17Z'), launchpad: 'Argus', poolAddress: COIN_POOL,
    txCount24h: coinQ.buys24h + coinQ.sells24h, holderCount: 0, buys24h: coinQ.buys24h, sells24h: coinQ.sells24h,
    verified: false, graduated: false, bondingProgress: null, spark: [], quoteSymbol: 'USDC',
  } : null)

  // Binance's market overview: the most active coins, the biggest gainers and the most traded, beside $ARCDEX.
  // The overview cards only pick coins that meet the listing standard.
  const primaries = curation.groups.map(g => g.primary).filter(t => t.address.toLowerCase() !== COIN_LC && t.price > 0 && passes(t, ratedOf(t)))
  const overview = {
    hot: [...primaries].sort((a, b) => activityOf(b) - activityOf(a) || b.volume24h - a.volume24h).slice(0, 3),
    gainers: primaries.filter(t => t.volume24h >= 500 && t.liquidity >= 1_000).sort((a, b) => b.priceChange24h - a.priceChange24h).slice(0, 3),
    volume: [...primaries].sort((a, b) => b.volume24h - a.volume24h).slice(0, 3),
  }

  return (
    <div className={`terminal-shell${filtersOpen ? ' filters-open' : ''}`}>
      {/* Phones: one slim line with your cash and Deposit, then the coins. */}
      {mobile && <MobileHome navigate={navigate} />}

      {/* ── Binance's Markets header: a title line and four compact cards (not on phones) ── */}
      <div className="mk-head">
        <div className="mk-title">
          <h1>{T('Markets')}</h1>
          <span>{T('Every coin on Arc, live: price, volume and safety checks.')}</span>
        </div>
        <div className="mk-overview">
          <div className="mk-card mk-card-arcdex" onClick={() => navigate({ name: 'argus', address: COIN_LC, pool: COIN_POOL })}>
            <div className="mk-card-h">
              <span>◆ $ARCDEX <span className="mk-official">{T('Official')}</span></span>
              <button className="mk-trade mk-trade-solid mk-trade-sm" onClick={e => { e.stopPropagation(); navigate({ name: 'argus', address: COIN_LC, pool: COIN_POOL }) }}>{T('Buy $ARCDEX')}</button>
            </div>
            <div className="mk-arcdex-price">{fmtSmallUsd(coinQ?.priceUsd)} <span style={{ color: pctColor(coinQ?.change24h ?? 0) }}>{fmtPctCoin(coinQ?.change24h)}</span></div>
            <div className="mk-arcdex-meta">{T('MCap')} {fmt(coinQ?.marketCapUsd ?? 0, '$')} · {T('Liq')} {fmt(coinQ?.liquidityUsd ?? 0, '$')}</div>
            <div className="mk-arcdex-note">{T('30% of ARCDEX’s fees buy back $ARCDEX and burn it.')}</div>
          </div>
          {([[`🔥 ${T('Hot coins')}`, overview.hot], [T('Top gainers'), overview.gainers], [T('Top volume'), overview.volume]] as [string, ArcToken[]][]).map(([title, list]) => (
            <div key={title} className="mk-card">
              <div className="mk-card-h"><span>{title}</span></div>
              {list.length === 0 && <div className="mk-card-empty">{T('Loading…')}</div>}
              {list.map(t => (
                <button key={t.address} className="mk-card-row" onClick={() => navigate(openPage(t))}>
                  <TokenLogo src={t.logoUrl} symbol={t.symbol} size={18} />
                  <b>{t.symbol}</b>
                  <span className="mk-card-price">{fmtPrice(t.price)}</span>
                  <span style={{ color: pctColor(t.priceChange24h) }}>{t.priceChange24h > 0 ? '+' : ''}{t.priceChange24h.toFixed(2)}%</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── one toolbar, as on Binance: the tabs, then search, sort and Filters ── */}
      <div className="mk-toolbar">
        {/* Arc or Robinhood Chain (phones: a tab at the end of the row) */}
        {!mobile && <ChainSwitch chain="arc" navigate={navigate} />}
        <div className="view-tabs">
          {VIEW_TABS.map(t => (
            <button key={t} className={`view-tab${viewTab === t ? ' active' : ''}`} onClick={() => setViewTab(t)}>
              {t === 'Trending' ? '⚡ ' + T('Trending') : T(t)}
            </button>
          ))}
          {/* Phones have no header line: Robinhood Chain's markets are a tab away. */}
          {mobile && <button className="view-tab rh-tab" onClick={() => navigate({ name: 'robinhood' })}>🏹 {T('Robinhood Chain')}</button>}
        </div>
        <span className="live-badge" title={T("Every buy and sell on Arc, as its block lands")}>{T("● live")}{perMin > 0 && <> · {T('{n} trades/min', { n: perMin })}</>}</span>
        <div className="mk-tools">
          <div className="mk-view-switch" role="group" aria-label={T('View')}>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>☰ {T('List')}</button>
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>▦ {T('Board')}</button>
          </div>
          <label className="mk-safe-toggle" title={T('Off: coins rated Danger, and pool coins under ${usd} of liquidity or {holders} holders, are left out.', { usd: LISTING.minLiquidityUsd.toLocaleString(), holders: LISTING.minHolders })}>
            <input type="checkbox" checked={showRisky} onChange={e => setShowRisky(e.target.checked)} /><span>{T('Show risky coins')}</span>
          </label>
          <input className="filter-input mk-search" placeholder={T("🔍 Search…")} value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sort-select" value={sortCol} onChange={e => setSortCol(e.target.value as SortCol)}>
            <option value="active">{T("Sort: most active")}</option>
            <option value="volume">{T("Sort: volume")}</option>
            <option value="mcap">{T("Sort: market cap")}</option>
            <option value="txns">{T("Sort: transactions")}</option>
            <option value="holders">{T("Sort: holders")}</option>
            <option value="age">{T("Sort: newest")}</option>
            <option value="liq">{T("Sort: liquidity")}</option>
            <option value="score">{T("Sort: score")}</option>
            <option value="risk">{T("Sort: risk")}</option>
          </select>
          <button className={`filters-btn${filtersOpen ? ' on' : ''}`} onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen}>⚙ {T("Filters")}{source !== 'All sources' || minMcap || maxMcap || minVol ? ' •' : ''}</button>
        </div>
      </div>

      {/* ── filters, folded away until asked for: launchpads and ranges ── */}
      {filtersOpen && (
        <div className="filter-bar">
          <div className="source-pills">
            {sources.map(s => (
              <button key={s} className={`source-pill${source === s ? ' active' : ''}`} onClick={() => setSource(s)}>
                {s === 'All sources' ? '◉ ' + T('All sources') : s}
              </button>
            ))}
          </div>
          <div className="filter-controls">
            <input className="filter-input" placeholder={T("min MC $")} value={minMcap} onChange={e => setMinMcap(e.target.value)} style={{ width: 90 }} />
            <input className="filter-input" placeholder={T("max MC $")} value={maxMcap} onChange={e => setMaxMcap(e.target.value)} style={{ width: 90 }} />
            <input className="filter-input" placeholder={T("min vol $")} value={minVol}  onChange={e => setMinVol(e.target.value)}  style={{ width: 90 }} />
          </div>
        </div>
      )}

      {standardOn && hiddenCount > 0 && (
        <div className="mk-hidden-note">
          {T('Hidden by the safety standard: {n} (rated Danger, or under ${usd} of liquidity or {holders} holders).', { n: hiddenCount, usd: LISTING.minLiquidityUsd.toLocaleString(), holders: LISTING.minHolders })}
          <button onClick={() => setShowRisky(true)}>{T('Show them')}</button>
        </div>
      )}

      {/* ── the coin board: New, Near bond, Graduated ── */}
      {view === 'board' && (
        <CoinBoard mobile={mobile} onOpen={c => { const t = filtered.find(x => x.address === c.key); if (t) navigate(openPage(t)) }}
          coins={filtered.map((t): BoardCoin => {
            const inp = arcStageInput(t)
            return {
              key: t.address, symbol: t.symbol, name: t.name, logo: t.logoUrl || null, launchpad: t.launchpad, launchpadColor: getLaunchpadColor(t.launchpad),
              ageMs: t.ageMs, marketCap: t.marketCap, liquidity: t.liquidity, volume24h: t.volume24h, change24h: t.priceChange24h,
              holders: t.holderCount > 0 ? t.holderCount : null, progress: inp.onCurve ? inp.progress : null, stage: arcStage(t), safety: ratedOf(t), hot: hotOf(t),
            }
          })} />
      )}

      {/* ── table ── */}
      {view === 'list' && <div className="table-scroll">
        {loading && tokens.length === 0 ? (
          <div className="loading-state">{T("Loading Arc tokens…")}</div>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th className="th-rank">#</th>
                <th className="th-token" style={{ textAlign: 'left' }}>{T("Name")}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}><span>{T("Price")}</span></th>
                {sortTh('change', T("24h change"))}
                {sortTh('mcap', T("Market cap"))}
                {sortTh('liq', T("Liquidity"))}
                {sortTh('volume', T("24h volume"))}
                {sortTh('txns', T("24h trades"))}
                {sortTh('holders', T("Holders"))}
                {sortTh('risk', T("Safety"))}
                <th className="th-sort" />
              </tr>
            </thead>
            <tbody>
              {coinRow && <TokenRow token={coinRow} rank={0} pinned risk={riskOfRow(coinRow)} safety={safetyOf(coinRow)} flash={flash.get(COIN_LC)} hot={hotOf(coinRow)} onClick={() => navigate({ name: 'argus', address: COIN_LC, pool: coinRow.poolAddress || COIN_POOL })} />}
              {pageItems.filter(t => !coinRow || t.address.toLowerCase() !== COIN_LC).map((token, i) => {
                const group = groupByPrimaryAddress.get(token.address)
                const dupCount = group?.duplicates.length ?? 0
                const isExpanded = expanded.has(token.address)
                const goTo = (t: ArcToken) => navigate(openPage(t))
                return (
                  <Fragment key={token.address}>
                    <TokenRow
                      token={token}
                      rank={(page - 1) * PAGE_SIZE + i + 1}
                      risk={riskOfRow(token)}
                      safety={ratedOf(token)}
                      flash={flash.get(token.address.toLowerCase())}
                      hot={hotOf(token)}
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
                        risk={riskOfRow(dup)}
                        safety={safetyOf(dup)}
                        flash={flash.get(dup.address.toLowerCase())}
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

        {!loading && totalPages > 1 && (
          <div className="pagination-bar">
            <button className="pg-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => i + 1).map(n => (
              <button key={n} className={`pg-btn${page === n ? ' active' : ''}`} onClick={() => setPage(n)}>{n}</button>
            ))}
            {totalPages > 5 && <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', padding: '0 4px' }}>…</span>}
            <button className="pg-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <span className="pg-info">
              {sorted.length.toLocaleString()}{' '}{T("tokens · page")}{' '}{page}/{totalPages}
              {(curation.hiddenDuplicateCount > 0 || curation.deadFilteredCount > 0) && (
                <span title={T("Contracts reusing another token's ticker are folded into that token's row (expand with the ticker badge); listings with zero liquidity, volume, and holders are hidden entirely.")}>
                  {' · '}{curation.hiddenDuplicateCount > 0 && T('{n} same-ticker duplicates folded', { n: curation.hiddenDuplicateCount })}
                  {curation.hiddenDuplicateCount > 0 && curation.deadFilteredCount > 0 && ', '}
                  {curation.deadFilteredCount > 0 && T('{n} dead listings hidden', { n: curation.deadFilteredCount })}
                </span>
              )}
            </span>
          </div>
        )}

        {/* mobile card list — same data, CSS toggles which one is visible */}
        {!loading && (
          <div className="token-cards">
            {coinRow && <TokenCard token={coinRow} pinned safety={safetyOf(coinRow)} flash={flash.get(COIN_LC)} hot={hotOf(coinRow)} onClick={() => navigate({ name: 'argus', address: COIN_LC, pool: coinRow.poolAddress || COIN_POOL })} />}
            {sorted.filter(t => !coinRow || t.address.toLowerCase() !== COIN_LC).slice(0, shown).map(token => {
              const group = groupByPrimaryAddress.get(token.address)
              return (
                <TokenCard
                  key={token.address}
                  token={token}
                  safety={ratedOf(token)}
                  flash={flash.get(token.address.toLowerCase())}
                  hot={hotOf(token)}
                  dupCount={group?.duplicates.length ?? 0}
                  onClick={() => navigate(openPage(token))}
                />
              )
            })}
            {shown < sorted.length && (
              <button className="show-more" onClick={() => setShown(n => n + PAGE_SIZE)}>{T("Show more")} · {(sorted.length - shown).toLocaleString()}</button>
            )}
          </div>
        )}
      </div>}
      {/* A name or pasted address the list doesn't have: found anyway, from all of Arc. */}
      {search.trim().length >= 2 && <FoundOnArc query={search} shown={shownAddresses} navigate={navigate} />}
    </div>
  )
}
