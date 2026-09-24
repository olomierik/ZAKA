import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import {
  getArgusTokenPools, getArgusTokenInfo, getArgusTrades, getArgusOnchain, buildSwapRoute, copycatOf,
  USDC_ADDRESS, type ArgusPool, type ArgusTokenInfo, type ArgusTrade, type ArgusOnchain, type SwapRoute,
} from '../api/argusMarket'
import { subscribePoolSwaps, type LiveSwap } from '../api/argusLive'
import { ARC_EXPLORER } from '../api/arcRpc'
import PriceChart from '../components/PriceChart'
import ArgusSwapWidget from '../components/ArgusSwapWidget'
import type { Page } from '../App'

// Full page for one Argus launch. Live market data (price, volume,
// liquidity, candles, trade history, holders, socials) comes from
// GeckoTerminal — the same source argus.world uses. Arc RPC supplies what
// GeckoTerminal doesn't carry (creator wallet, Portal, hook, taxes) and a
// WebSocket push of each swap the moment its block lands, ahead of
// GeckoTerminal's indexing.

interface Props { address: string; pool: string; navigate: (p: Page) => void }

interface Row {
  txHash: string
  maker: string | null
  kind: 'buy' | 'sell'
  usd: number
  tokenAmount: number
  timestamp: number
  live: boolean // pushed from the chain, not yet indexed by GeckoTerminal
}

const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16 }
const cardHead: React.CSSProperties = { padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: '0.85rem' }

function short(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}` }
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
function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function TokenImage({ src, symbol }: { src: string | null; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) return (
    <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg,#1e3a5f,#0f1e30)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>
      {symbol.slice(0, 3)}
    </div>
  )
  return <img src={src} alt={symbol} style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} onError={() => setErr(true)} />
}

function Addr({ a, kind = 'address' }: { a: string; kind?: 'address' | 'tx' }) {
  const [copied, setCopied] = useState(false)
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontFamily: 'var(--mono)' }}>
      <a href={`${ARC_EXPLORER}/${kind}/${a}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', textDecoration: 'none' }}>{short(a)}</a>
      <button title="Copy" onClick={() => { void navigator.clipboard?.writeText(a); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: '0.75rem' }}>
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  )
}

export default function ArgusTokenPage({ address, pool, navigate }: Props) {
  const [pools, setPools] = useState<ArgusPool[] | null>(null)
  const [info, setInfo] = useState<ArgusTokenInfo | null>(null)
  const [chain, setChain] = useState<ArgusOnchain | null>(null)
  const [route, setRoute] = useState<SwapRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(true)
  const [trades, setTrades] = useState<ArgusTrade[]>([])
  const [live, setLive] = useState<LiveSwap[]>([])
  const [tradesLoaded, setTradesLoaded] = useState(false)
  const [, tick] = useState(0)

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
    buildSwapRoute(address, activePool)
      .then(r => { if (!cancelled) setRoute(r) })
      .catch(() => { if (!cancelled) setRoute(null) })
      .finally(() => { if (!cancelled) setRouteLoading(false) })
    return () => { cancelled = true }
  }, [address, activePool])

  // Trade history (makers + USD values) from GeckoTerminal…
  const loadTrades = useMemo(() => () => getArgusTrades(activePool, address).then(t => { setTrades(t); setTradesLoaded(true) }).catch(() => setTradesLoaded(true)), [activePool, address])
  useEffect(() => {
    setTrades([]); setLive([]); setTradesLoaded(false)
    void loadTrades()
    const id = setInterval(() => { if (!document.hidden) void loadTrades() }, 10_000)
    return () => clearInterval(id)
  }, [loadTrades])

  // …plus every swap pushed straight from the chain as it happens.
  const quoteAddr = active?.quote.address
  useEffect(() => {
    if (!quoteAddr) return
    const tokenIsCurrency0 = address.toLowerCase() < quoteAddr
    const quoteDecimals = quoteAddr === USDC_ADDRESS.toLowerCase() ? 6 : 18
    return subscribePoolSwaps(activePool, tokenIsCurrency0, quoteDecimals, s => setLive(prev => [s, ...prev].slice(0, 100)))
  }, [activePool, quoteAddr, address])

  // Re-render every 5s so "ago" timestamps stay honest.
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(id) }, [])

  const rows: Row[] = useMemo(() => {
    const known = new Set(trades.map(t => t.txHash.toLowerCase()))
    const quoteIsUsdc = active?.quote.address === USDC_ADDRESS.toLowerCase()
    const pushed: Row[] = live
      .filter(s => !known.has(s.txHash.toLowerCase()))
      .map(s => ({
        txHash: s.txHash, maker: null, kind: s.kind, tokenAmount: s.tokenAmount, timestamp: s.receivedAt, live: true,
        usd: quoteIsUsdc ? s.quoteAmount : s.tokenAmount * (active?.priceUsd ?? 0),
      }))
    const indexed: Row[] = trades.map(t => ({ ...t, live: false }))
    return [...pushed, ...indexed].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100)
  }, [trades, live, active])

  const symbol = active?.token.symbol || info?.symbol || '…'
  const name = active?.token.name || info?.name || ''
  const image = info?.image ?? active?.token.image ?? null
  const priceUsd = active?.priceUsd ?? 0
  const copy = symbol === '…' ? null : copycatOf(symbol, address)

  return (
    <div className="token-page">
      {info?.banner && /^https:\/\//i.test(info.banner) && (
        <img src={info.banner} alt="" style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 12, marginBottom: 12, display: 'block' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
      )}

      <div className="token-page-header">
        <button className="back-btn" onClick={() => navigate({ name: 'terminal' })}>← Back</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <TokenImage src={image} symbol={symbol} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: '1.2rem', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              ${symbol}
              <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text)', fontFamily: 'var(--mono)' }}>{active ? fmtPrice(priceUsd) : '…'}</span>
              {active && <span style={{ fontWeight: 700, fontSize: '0.8rem', color: active.change.h24 >= 0 ? 'var(--green)' : 'var(--red)' }}>{pct(active.change.h24)}</span>}
              <span style={{ background: 'rgba(168,85,247,0.15)', color: '#c084fc', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, border: '1px solid rgba(168,85,247,0.35)' }}>
                ARGUS{chain?.portal ? ` · Portal ${chain.portal}` : ''}
              </span>
              {active && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/ {active.quote.symbol}</span>}
              {info?.isHoneypot && <span style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99 }}>HONEYPOT RISK</span>}
            </div>
          </div>
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
            ['Market Cap', fmt(active.marketCapUsd ?? active.fdvUsd, '$'), 'var(--text)'],
            ['FDV', fmt(active.fdvUsd, '$'), 'var(--text)'],
            ['Liquidity', fmt(active.liquidityUsd, '$'), 'var(--text)'],
            ['Volume 24h', fmt(active.volume24h, '$'), 'var(--text)'],
            ['Buys 24h', active.txns24h.buys.toLocaleString(), 'var(--green)'],
            ['Sells 24h', active.txns24h.sells.toLocaleString(), 'var(--red)'],
            ['Holders', info?.holders != null ? info.holders.toLocaleString() : '—', 'var(--text)'],
            ['Top 10 hold', info?.top10Pct != null ? `${info.top10Pct.toFixed(1)}%` : '—', 'var(--text)'],
          ] as const).map(([label, val, color]) => (
            <div key={label}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 2 }}>{label}</div>
              <div style={{ fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{val}</div>
            </div>
          ))}
        </div>
      )}
      {copy && (
        <div style={{ ...card, padding: '12px 16px', fontSize: '0.82rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', color: '#fcd34d' }}>
          ⚠ This is <b>not</b> the real {copy}. It's a separate Argus launch that reuses the {copy} ticker — check the contract address before trading.
        </div>
      )}
      {pools !== null && pools.length === 0 && (
        <div style={{ ...card, padding: 16, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          GeckoTerminal has no USDC- or ARGUS-quoted pool for this token yet.
        </div>
      )}

      <div className="token-detail-grid">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...card, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: '0.85rem', color: 'var(--text-muted)' }}>PRICE CHART · USD</div>
            <PriceChart poolAddress={activePool} />
          </div>

          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={cardHead}>
              <span>Live Trades</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginRight: 5, animation: 'pulse 1.5s infinite' }} />
                Arc RPC push + GeckoTerminal
              </span>
            </div>
            {rows.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {tradesLoaded ? 'No recent trades on this pool — new ones appear here instantly.' : 'Loading trades…'}
              </div>
            ) : (
              <div style={{ overflow: 'auto', maxHeight: 460 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 520 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
                      {['Age', 'Type', 'USD', symbol, 'Maker', 'Tx'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(t => {
                      const c = t.kind === 'buy' ? 'var(--green)' : 'var(--red)'
                      return (
                        <tr key={t.txHash + t.kind + t.tokenAmount} style={{ borderBottom: '1px solid var(--adx-card-border)', background: t.live ? 'rgba(59,130,246,0.06)' : 'transparent' }}>
                          <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{ago(t.timestamp)}</td>
                          <td style={{ padding: '8px 12px', color: c, fontWeight: 700 }}>{t.kind.toUpperCase()}</td>
                          <td style={{ padding: '8px 12px', color: c, fontFamily: 'var(--mono)' }}>{t.usd < 0.01 ? '<$0.01' : `$${fmt(t.usd)}`}</td>
                          <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)' }}>{fmt(t.tokenAmount)}</td>
                          <td style={{ padding: '8px 12px' }}>{t.maker ? <Addr a={t.maker} /> : <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>just now…</span>}</td>
                          <td style={{ padding: '8px 12px' }}><Addr a={t.txHash} kind="tx" /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="token-detail-swap">
          <div style={{ ...card, overflow: 'hidden' }}>
            <ArgusSwapWidget token={address as Address} symbol={symbol} priceUsd={priceUsd} route={route} routeLoading={routeLoading} onTraded={() => void loadTrades()} />
          </div>

          <div style={card}>
            <div style={cardHead}>Token details</div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.78rem' }}>
              <Detail label="Contract"><Addr a={address} /></Detail>
              <Detail label={chain?.creatorLabel ?? 'Creator'}>{chain?.creator ? <Addr a={chain.creator} /> : chain ? '—' : '…'}</Detail>
              <Detail label="Pool"><span title={activePool} style={{ fontFamily: 'var(--mono)' }}>{short(activePool)}</span></Detail>
              <Detail label="Launched on">{chain?.portal ? `Argus Portal ${chain.portal}` : chain ? 'Argus' : '…'}</Detail>
              {chain?.hook && <Detail label="Hook"><Addr a={chain.hook} /></Detail>}
              <Detail label="Creator tax">
                {chain?.buyTaxBps != null ? `${chain.buyTaxBps / 100}% buy · ${(chain.sellTaxBps ?? 0) / 100}% sell` : chain ? '—' : '…'}
              </Detail>
              <Detail label="Bonded">{chain?.bonded == null ? '—' : chain.bonded ? 'Yes' : 'Not yet'}</Detail>
              <Detail label="Age">{active?.createdAt ? ago(Date.parse(active.createdAt)) : '—'}</Detail>
              {info?.gtScore != null && <Detail label="GT score">{info.gtScore.toFixed(0)} / 100</Detail>}
              {pools && pools.length > 1 && (
                <Detail label="Other pools">{pools.length - 1} more (showing deepest routable)</Detail>
              )}
            </div>
            {info?.description && (
              <div style={{ padding: '0 16px 16px', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{info.description}</div>
            )}
            {(info?.websites.length || info?.twitter || info?.telegram || info?.discord) ? (
              <div style={{ padding: '0 16px 16px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {info.websites.map(w => <Social key={w} href={w} label={hostOf(w)} />)}
                {info.twitter && <Social href={`https://x.com/${info.twitter}`} label="X" />}
                {info.telegram && <Social href={`https://t.me/${info.telegram}`} label="Telegram" />}
                {info.discord && <Social href={info.discord} label="Discord" />}
              </div>
            ) : null}
            <div style={{ padding: '0 16px 16px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Social href={`https://argus.world/token/${address}`} label="argus.world" />
              <Social href={`https://www.geckoterminal.com/arc/pools/${activePool}`} label="GeckoTerminal" />
              <Social href={`${ARC_EXPLORER}/token/${address}`} label="Explorer" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )
}

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Website' }
}

function Social({ href, label }: { href: string; label: string }) {
  // Only http(s) — socials come from third-party metadata.
  if (!/^https?:\/\//i.test(href)) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 99, fontSize: '0.72rem', border: '1px solid var(--adx-card-border)', color: 'var(--text)', textDecoration: 'none', background: 'var(--bg-2)' }}>{label}</a>
  )
}
