import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import {
  getArgusTokenPools, getArgusTokenInfo, getArgusTrades, getArgusOnchain, buildSwapRoute, copycatOf,
  ARGUS_TOKEN, USDC_ADDRESS, type ArgusPool, type ArgusTokenInfo, type ArgusTrade, type ArgusOnchain, type SwapRoute,
} from '../api/argusMarket'
import { byRecency, knownMaker, loadPoolSwaps, poolMeta, quoteUsd, resolveMakers, subscribePoolSwaps, type PoolSwap } from '../api/poolSwaps'
import { useChainHolders } from '../api/holders'
import type { Tick } from '../lib/candles'
import PriceChart, { type ChartTrade } from '../components/PriceChart'
import ArgusSwapWidget from '../components/ArgusSwapWidget'
import TokenSocialTabs, { type TradeRow } from '../components/TokenSocialTabs'
import SafetyPanel from '../components/SafetyPanel'
import PositionCard from '../components/PositionCard'
import AboutPanel from '../components/AboutPanel'
import { getFollowing, getProfiles, type Profile, type Thesis } from '../api/social'
import { pushRecent, toggleWatch, usePrefs } from '../lib/prefs'
import { useTrader } from '../lib/identity'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Full page for one Argus launch. What moves is read straight from the
// chain: every swap in the pool (history from the logs, then each new one
// over Arc's WebSocket the moment its block lands) drives the price, the
// candles and the trades list, and holders come from ARCDEX's own index of
// the token's transfers. GeckoTerminal supplies the rest (24h stats,
// liquidity, older candles, socials) and stands in if the chain can't be
// read. Arc RPC also gives what GeckoTerminal doesn't carry (creator
// wallet, Portal, hook, taxes).

interface Props { address: string; pool: string; navigate: (p: Page) => void }

// live = pushed over the WebSocket during this visit
type Row = TradeRow

const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16 }

function fmt(n: number | null | undefined, prefix = '') {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(2)}`
}
function fmtPrice(p: number) {
  if (!p) return '$0'
  if (p >= 1) return `$${p.toFixed(4)}`
  // Small prices: keep 4 significant digits so micro-caps stay readable.
  return `$${p.toPrecision(4)}`
}
function pct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` }

function TokenImage({ src, symbol }: { src: string | null; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) return (
    <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg,#1e3a5f,#0f1e30)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>
      {symbol.slice(0, 3)}
    </div>
  )
  return <img src={src} alt={symbol} style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} onError={() => setErr(true)} />
}

export default function ArgusTokenPage({ address, pool, navigate }: Props) {
  const [pools, setPools] = useState<ArgusPool[] | null>(null)
  const [info, setInfo] = useState<ArgusTokenInfo | null>(null)
  const [chain, setChain] = useState<ArgusOnchain | null>(null)
  const [route, setRoute] = useState<SwapRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(true)
  // Every swap in the pool, newest first (null while loading).
  const [swaps, setSwaps] = useState<PoolSwap[] | null>(null)
  const [onchainFailed, setOnchainFailed] = useState(false)
  // GeckoTerminal's trade list — only if the chain can't be read.
  const [gtTrades, setGtTrades] = useState<ArgusTrade[]>([])
  const [gtLoaded, setGtLoaded] = useState(false)
  const [qUsd, setQUsd] = useState<number | null>(null)
  const [makersTick, setMakersTick] = useState(0)
  const [, tick] = useState(0)
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [positionUsd, setPositionUsd] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const requested = useRef(new Set<string>())
  const [theses, setTheses] = useState<Thesis[]>([])
  const [friends, setFriends] = useState<Set<string>>(new Set())
  const prefs = usePrefs()
  const starred = prefs.watchlist.includes(address.toLowerCase())
  const [copiedCa, setCopiedCa] = useState(false)

  // Who I follow — the chart's "Friends only" overlay.
  useEffect(() => {
    if (!me) { setFriends(new Set()); return }
    void getFollowing(me).then(f => setFriends(new Set(f))).catch(() => {})
  }, [me])

  // Usernames/avatars for everyone shown on the page, fetched once each.
  const needProfiles = useCallback((addresses: string[]) => {
    const fresh = [...new Set(addresses.map(a => a.toLowerCase()))].filter(a => !requested.current.has(a))
    if (fresh.length === 0) return
    fresh.forEach(a => requested.current.add(a))
    void getProfiles(fresh).then(found => {
      if (found.size) setProfiles(prev => { const n = new Map(prev); found.forEach((p, a) => n.set(a, p)); return n })
    }).catch(() => {})
  }, [])

  // The pool the Terminal row pointed at, if it's still one of this
  // token's tradable pools; otherwise its deepest.
  const active = useMemo(() => pools?.find(p => p.pool === pool.toLowerCase()) ?? pools?.[0] ?? null, [pools, pool])
  const activePool = active?.pool ?? pool.toLowerCase()

  // Market data — GeckoTerminal refreshes a pool roughly every 15–30s.
  useEffect(() => {
    let cancelled = false
    setPools(null)
    const load = () => getArgusTokenPools(address).then(p => { if (!cancelled) setPools(p) }).catch(() => { if (!cancelled) setPools(prev => prev ?? []) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [address])

  // Holders / socials change slowly; on-chain launch record never changes.
  useEffect(() => {
    let cancelled = false
    setInfo(null); setChain(null)
    const loadInfo = () => getArgusTokenInfo(address).then(i => { if (!cancelled) setInfo(i) }).catch(() => {})
    void loadInfo()
    void getArgusOnchain(address as Address).then(c => { if (!cancelled) setChain(c) }).catch(() => {})
    const id = setInterval(() => { if (!document.hidden) void loadInfo() }, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [address])

  useEffect(() => {
    let cancelled = false
    setRouteLoading(true); setRoute(null)
    // Opened from a bare /token/<address> URL: wait for the pool list.
    if (!activePool) { setRouteLoading(pools === null); return }
    buildSwapRoute(address, activePool)
      .then(r => { if (!cancelled) setRoute(r) })
      .catch(() => { if (!cancelled) setRoute(null) })
      .finally(() => { if (!cancelled) setRouteLoading(false) })
    return () => { cancelled = true }
  }, [address, activePool, pools === null])

  // The pool's quote side: from GeckoTerminal's pool data, or — while that's
  // still loading — from the on-chain route.
  const quoteAddr = active?.quote.address
    ?? (route ? (route.kind === 'v4' && route.via === 'ARGUS' ? ARGUS_TOKEN.toLowerCase() : USDC_ADDRESS.toLowerCase()) : undefined)

  // Every swap, from the chain: history first (newest drawn as soon as it
  // arrives), then each new one the moment its block lands.
  useEffect(() => {
    setSwaps(null); setOnchainFailed(false)
    if (!activePool || !quoteAddr) return
    const meta = poolMeta(activePool, address, quoteAddr)
    let alive = true
    const add = (fresh: PoolSwap[]) => {
      if (!alive) return
      setSwaps(prev => {
        const seen = new Set((prev ?? []).map(x => x.id))
        const next = fresh.filter(x => !seen.has(x.id))
        if (prev && next.length === 0) return prev
        return [...next, ...(prev ?? [])].sort(byRecency).slice(0, 6_000)
      })
    }
    // Subscribe first, so nothing lands between the history and the stream.
    const unsub = subscribePoolSwaps(meta, add)
    loadPoolSwaps(meta, { onProgress: add })
      .then(r => add(r.swaps))
      .catch(() => { if (alive) { setOnchainFailed(true); setSwaps(prev => prev ?? []) } })
    return () => { alive = false; unsub() }
  }, [activePool, quoteAddr, address])

  // USD per quote unit: USDC = 1; ARGUS from its own pool's live price.
  useEffect(() => {
    setQUsd(null)
    if (!quoteAddr) return
    let alive = true
    const load = () => void quoteUsd(quoteAddr).then(v => { if (alive && v) setQUsd(v) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [quoteAddr])
  const usdPerQuote = qUsd ?? (active?.priceUsd && swaps?.[0]?.price ? active.priceUsd / swaps[0].price : null)

  // Who made each recent trade (the transaction's sender), in batches.
  useEffect(() => {
    const need = (swaps ?? []).slice(0, 120).map(x => x.txHash).filter(h => !knownMaker(h))
    if (need.length === 0) return
    const id = setTimeout(() => void resolveMakers(need).then(() => setMakersTick(n => n + 1)).catch(() => {}), 200)
    return () => clearTimeout(id)
  }, [swaps])

  // GeckoTerminal's trades, only if the chain couldn't be read.
  const loadGtTrades = useMemo(() => () => !activePool ? Promise.resolve() : getArgusTrades(activePool, address).then(t => { setGtTrades(t); setGtLoaded(true) }).catch(() => setGtLoaded(true)), [activePool, address])
  useEffect(() => {
    if (!onchainFailed) return
    void loadGtTrades()
    const id = setInterval(() => { if (!document.hidden) void loadGtTrades() }, 10_000)
    return () => clearInterval(id)
  }, [onchainFailed, loadGtTrades])
  const tradesLoaded = onchainFailed ? gtLoaded : swaps !== null

  // Re-render every 5s so "ago" timestamps stay honest.
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(id) }, [])

  const rows: Row[] = useMemo(() => {
    if (onchainFailed && !swaps?.length) return gtTrades.map(t => ({ ...t, live: false })).slice(0, 100)
    return (swaps ?? []).slice(0, 100).map(x => ({
      txHash: x.txHash, maker: knownMaker(x.txHash), kind: x.kind, tokenAmount: x.tokenAmount,
      usd: usdPerQuote ? x.quoteAmount * usdPerQuote : 0, timestamp: x.time, live: !!x.live,
    }))
    // makersTick: re-read makers once a batch resolves
  }, [swaps, onchainFailed, gtTrades, usdPerQuote, makersTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // The chart's ticks: every swap's pool price and size, in USD.
  const ticks: Tick[] | null = useMemo(() => {
    if (swaps === null || !usdPerQuote) return null
    return swaps.map(x => ({ time: x.time, priceUsd: x.price * usdPerQuote, usd: x.quoteAmount * usdPerQuote }))
  }, [swaps, usdPerQuote])
  const streaming = !!swaps?.some(x => x.live)

  useEffect(() => { needProfiles(rows.flatMap(r => (r.maker ? [r.maker] : []))) }, [rows, needProfiles])
  useEffect(() => { if (chain?.creator) needProfiles([chain.creator]) }, [chain?.creator, needProfiles])

  // Every recent trade as its trader's avatar on the chart.
  const chartTrades: ChartTrade[] = useMemo(() => rows.flatMap(r => {
    const price = r.tokenAmount > 0 ? r.usd / r.tokenAmount : 0
    if (!price) return []
    const p = r.maker ? profiles.get(r.maker.toLowerCase()) : undefined
    const who = p?.username ? `@${p.username}` : r.maker ? `${r.maker.slice(0, 6)}…${r.maker.slice(-4)}` : T('Someone')
    return [{
      id: r.txHash + r.kind + r.tokenAmount, time: r.timestamp, priceUsd: price, usd: r.usd, kind: r.kind, maker: r.maker,
      avatarUrl: p?.avatar_url ?? null, mine: !!me && r.maker?.toLowerCase() === me,
      label: `${who} ${r.kind === 'buy' ? 'bought' : 'sold'} $${r.usd >= 1000 ? (r.usd / 1000).toFixed(1) + 'K' : r.usd.toFixed(2)}`,
    }]
  }), [rows, profiles, me])

  // Theses pinned on the chart at the price when they were posted.
  const thesisMarks: ChartTrade[] = useMemo(() => theses.map(t => {
    const at = Date.parse(t.created_at)
    const near = rows.reduce<Row | null>((best, r) => r.tokenAmount > 0 && (!best || Math.abs(r.timestamp - at) < Math.abs(best.timestamp - at)) ? r : best, null)
    const price = near ? near.usd / near.tokenAmount : active?.priceUsd ?? 0
    const p = profiles.get(t.author.toLowerCase())
    return {
      id: `thesis-${t.id}`, time: at, priceUsd: price, usd: t.position_usd ?? 0, kind: 'thesis' as const, maker: t.author,
      avatarUrl: p?.avatar_url ?? null, mine: !!me && t.author.toLowerCase() === me,
      label: `${p?.username ? '@' + p.username : t.author.slice(0, 6) + '…'}: “${t.body.slice(0, 80)}${t.body.length > 80 ? '…' : ''}”`,
    }
  }).filter(m => m.priceUsd > 0), [theses, rows, profiles, me, active])

  // Your own trade shows up over the WebSocket within a block; this just
  // refreshes the position card.
  const onTraded = useCallback(() => { setRefreshKey(k => k + 1) }, [])

  const symbol = active?.token.symbol || info?.symbol || '…'
  const name = active?.token.name || info?.name || ''
  const image = info?.image ?? active?.token.image ?? null
  // The pool's price only changes on a swap, so the latest swap's price IS
  // the live price (GeckoTerminal's is 10-60s behind).
  const livePrice = swaps?.[0] && usdPerQuote ? swaps[0].price * usdPerQuote : null
  const priceUsd = livePrice ?? active?.priceUsd ?? 0
  const copy = symbol === '…' ? null : copycatOf(symbol, address)
  const gtMcap = active?.marketCapUsd ?? active?.fdvUsd ?? null
  // Circulating supply, for MCap-at-trade and the chart's MCap mode.
  const supply = gtMcap && active?.priceUsd ? gtMcap / active.priceUsd : null
  const mcap = supply && priceUsd ? supply * priceUsd : gtMcap

  // Tick the header price green/red as it moves.
  const lastPrice = useRef(0)
  const [priceDir, setPriceDir] = useState<'up' | 'down' | null>(null)
  useEffect(() => {
    if (lastPrice.current && priceUsd && priceUsd !== lastPrice.current) setPriceDir(priceUsd > lastPrice.current ? 'up' : 'down')
    lastPrice.current = priceUsd
  }, [priceUsd])

  // True holders from ARCDEX's own index (GeckoTerminal's is hours old).
  const chainHolders = useChainHolders(address, active?.createdAt)
  const infoLive = useMemo(() => info && chainHolders?.complete
    ? { ...info, holders: chainHolders.holders, top10Pct: chainHolders.top10Pct ?? info.top10Pct }
    : info, [info, chainHolders])
  const holdersLabel = chainHolders?.complete ? chainHolders.holders.toLocaleString()
    : info?.holders != null ? info.holders.toLocaleString()
    : chainHolders ? chainHolders.holders.toLocaleString() + '…' : '—'

  // Recently viewed (search box) once we know what this coin is called.
  useEffect(() => {
    if (symbol !== '…') pushRecent({ address, symbol, image, pool: activePool || null })
  }, [address, symbol, image, activePool])

  // Tab title like fomo: "$1.2M | SYMBOL | ARCDEX".
  useEffect(() => {
    const prev = document.title
    if (symbol !== '…') document.title = `${mcap ? fmt(mcap, '$') + ' | ' : ''}${symbol} | ARCDEX`
    return () => { document.title = prev }
  }, [symbol, mcap])

  return (
    <div className="token-page">
      {info?.banner && /^https:\/\//i.test(info.banner) && (
        <img src={info.banner} alt="" style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 12, marginBottom: 12, display: 'block' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
      )}

      <div className="token-page-header">
        <button className="back-btn" onClick={() => navigate({ name: 'terminal' })}>{T("← Back")}</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <TokenImage src={image} symbol={symbol} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: '1.2rem', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              ${symbol}
              <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span key={priceUsd} className={priceDir ? `price-tick ${priceDir}` : undefined} style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text)', fontFamily: 'var(--mono)', borderRadius: 4, padding: '0 2px' }}>{priceUsd ? fmtPrice(priceUsd) : '…'}</span>
              {active && <span style={{ fontWeight: 700, fontSize: '0.8rem', color: active.change.h24 >= 0 ? 'var(--green)' : 'var(--red)' }}>{pct(active.change.h24)}</span>}
              <span style={{ background: 'rgba(168,85,247,0.15)', color: '#c084fc', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, border: '1px solid rgba(168,85,247,0.35)' }}>
                {chain?.portal ? `ARGUS · Portal ${chain.portal}` : active?.dex === 'argus' ? T("ARGUS") : active?.dex ? active.dex.replace(/-arc$/, '').replace(/-/g, ' ').toUpperCase() : '…'}
              </span>
              {active && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/ {active.quote.symbol}</span>}
              {info && !info.verified && <span title={T("GeckoTerminal hasn't verified this token's metadata")} style={{ background: 'rgba(245,158,11,0.12)', color: '#fcd34d', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99 }}>{T("Unverified")}</span>}
              {info?.isHoneypot && <span style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99 }}>{T("HONEYPOT RISK")}</span>}
            </div>
          </div>
        </div>
        <div className="token-head-actions">
          <button title={starred ? T("Remove from watchlist") : T("Add to watchlist")} onClick={() => toggleWatch(address)} className={`head-icon${starred ? ' on' : ''}`}>{starred ? '★' : '☆'}</button>
          <button title={T("Copy contract address")} className="head-icon" onClick={() => { void navigator.clipboard?.writeText(address); setCopiedCa(true); setTimeout(() => setCopiedCa(false), 1200) }}>{copiedCa ? '✓' : '⧉'}</button>
          {info?.websites[0] && /^https?:\/\//i.test(info.websites[0]) && <a title={T("Website")} className="head-icon" href={info.websites[0]} target="_blank" rel="noopener noreferrer">🌐</a>}
          {info?.twitter && <a title={T("X / Twitter")} className="head-icon" href={`https://x.com/${info.twitter}`} target="_blank" rel="noopener noreferrer">𝕏</a>}
          <a title={T("Search on X")} className="head-icon" href={`https://x.com/search?q=${encodeURIComponent(`${address} OR $${symbol}`)}&f=live`} target="_blank" rel="noopener noreferrer">🔍</a>
        </div>
      </div>

      {/* stats */}
      {active && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', fontSize: '0.8rem' }}>
          {([
            ['5m', pct(active.change.m5), active.change.m5 >= 0 ? 'var(--green)' : 'var(--red)'],
            ['1h', pct(active.change.h1), active.change.h1 >= 0 ? 'var(--green)' : 'var(--red)'],
            ['6h', pct(active.change.h6), active.change.h6 >= 0 ? 'var(--green)' : 'var(--red)'],
            ['24h', pct(active.change.h24), active.change.h24 >= 0 ? 'var(--green)' : 'var(--red)'],
            [T('Market Cap'), fmt(mcap, '$'), 'var(--text)'],
            ['FDV', fmt(active.fdvUsd, '$'), 'var(--text)'],
            [T('Liquidity'), fmt(active.liquidityUsd, '$'), 'var(--text)'],
            [T('Volume 24h'), fmt(active.volume24h, '$'), 'var(--text)'],
            [T('Buys 24h'), active.txns24h.buys.toLocaleString(), 'var(--green)'],
            [T('Sells 24h'), active.txns24h.sells.toLocaleString(), 'var(--red)'],
            [T('Holders'), holdersLabel, 'var(--text)'],
            [T('Top 10 hold'), infoLive?.top10Pct != null ? `${infoLive.top10Pct.toFixed(1)}%` : '—', 'var(--text)'],
          ] as [string, string, string][]).map(([label, val, color]) => (
            <div key={label}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 2 }}>{label}</div>
              <div style={{ fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{val}</div>
            </div>
          ))}
        </div>
      )}
      {copy && (
        <div style={{ ...card, padding: '12px 16px', fontSize: '0.82rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', color: '#fcd34d' }}>{T("⚠ This is")}{' '}<b>{T("not")}</b>{' '}{T("the real")}{' '}{copy}{T(". It's a separate Argus launch that reuses the")}{' '}{copy}{' '}{T("ticker — check the contract address before trading.")}</div>
      )}
      {pools !== null && pools.length === 0 && (
        <div style={{ ...card, padding: 16, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{T("GeckoTerminal has no USDC- or ARGUS-quoted pool for this token yet.")}</div>
      )}

      <div className="token-detail-grid">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...card, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: '0.85rem', color: 'var(--text-muted)' }}>{T("PRICE CHART · USD")}</div>
            <PriceChart poolAddress={activePool || null} ticks={onchainFailed ? undefined : ticks} live={streaming} trades={chartTrades} thesisMarks={thesisMarks} friends={friends} supply={supply} symbol={symbol}
              onTraderClick={a => navigate({ name: 'trader', address: a })} />
          </div>

          <TokenSocialTabs token={address} symbol={symbol} rows={rows} tradesLoaded={tradesLoaded} profiles={profiles} chainHolders={chainHolders}
            trader={trader} positionUsd={positionUsd} creator={chain?.creator ?? null} priceUsd={priceUsd} supply={supply}
            navigate={navigate} onProfilesNeeded={needProfiles} onThesesLoaded={setTheses} />
        </div>

        <div className="token-detail-swap">
          <div style={{ ...card, overflow: 'hidden' }}>
            <ArgusSwapWidget token={address as Address} symbol={symbol} tokenImage={image} priceUsd={priceUsd}
              marketCapUsd={mcap} route={route} routeLoading={routeLoading}
              buyTaxBps={chain?.buyTaxBps} sellTaxBps={chain?.sellTaxBps} onTraded={onTraded} unverified={info ? !info.verified : false} />
          </div>

          <PositionCard token={address} symbol={symbol} image={image} priceUsd={priceUsd} trader={trader} rows={rows}
            refreshKey={refreshKey} onPositionUsd={setPositionUsd} />

          <SafetyPanel token={address} info={infoLive} chain={chain} liquidityUsd={active?.liquidityUsd ?? null} rows={rows} />

          <AboutPanel address={address} symbol={symbol} info={infoLive} pool={active} chain={chain} rows={rows} supply={supply} profiles={profiles} navigate={navigate} />
        </div>
      </div>
    </div>
  )
}

