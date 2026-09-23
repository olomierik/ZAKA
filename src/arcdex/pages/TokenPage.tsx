import { useEffect, useState, useRef } from 'react'
import { getPoolTrades, type GeckoPool, type GeckoTrade, LAUNCHPAD_COLORS } from '../api/gecko'
import PriceChart from '../components/PriceChart'
import type { Page } from '../App'

interface Props { address: string; navigate: (p: Page) => void }

const EXPLORER = 'https://explorer.arc.io'

function fmt(n: number | null | undefined, prefix = '') {
  if (n == null || n === 0) return '—'
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`
  return `${prefix}${n.toFixed(4)}`
}
function timeAgo(iso: string) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function shortAddr(addr: string) {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export default function TokenPage({ address, navigate }: Props) {
  const network = 'arc'
  const [pool, setPool] = useState<GeckoPool | null>(null)
  const [trades, setTrades] = useState<GeckoTrade[]>([])
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // fetch pool info from gecko pools endpoint
  useEffect(() => {
    setLoading(true)
    const fetchPool = async () => {
      try {
        const res = await fetch(`/api/gecko?path=/networks/${network}/pools/${address}&include=dex`)
        const d = await res.json() as { data: { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }; included: { id: string; type: string; attributes: { name: string } }[] }
        const a = d.data.attributes
        const dexRel = (d.data.relationships as Record<string, { data: { id: string } }>)?.dex?.data
        const dexId = dexRel?.id ?? ''
        const dexInfo = d.included?.find((i: { id: string }) => i.id === dexId)
        const dexName = dexInfo?.attributes?.name ?? dexId
        const pc = a.price_change_percentage as Record<string, string> ?? {}
        const txnsH1 = (a.transactions as Record<string, { buys: number; sells: number; buyers: number; sellers: number }>)?.h1 ?? { buys: 0, sells: 0, buyers: 0, sellers: 0 }
        setPool({
          id: d.data.id,
          address: a.address as string,
          name: a.name as string,
          dexId,
          dexName,
          baseSymbol: (a.name as string).split('/')[0].trim().replace(/[^A-Z0-9$]/gi, ''),
          baseName: (a.name as string).split('/')[0].trim(),
          baseAddress: '',
          logoUrl: null,
          priceUsd: parseFloat(a.base_token_price_usd as string ?? '0') || 0,
          priceChange: { m5: parseFloat(pc.m5 ?? '0') || 0, h1: parseFloat(pc.h1 ?? '0') || 0, h6: parseFloat(pc.h6 ?? '0') || 0, h24: parseFloat(pc.h24 ?? '0') || 0 },
          volumeH24: parseFloat((a.volume_usd as Record<string, string>)?.h24 ?? '0') || 0,
          liquidityUsd: parseFloat((a.reserve_in_usd as string) ?? '0') || 0,
          marketCapUsd: a.market_cap_usd ? parseFloat(a.market_cap_usd as string) : null,
          fdvUsd: a.fdv_usd ? parseFloat(a.fdv_usd as string) : null,
          txns: txnsH1,
          poolCreatedAt: a.pool_created_at as string ?? '',
          reserveUsd: parseFloat((a.reserve_in_usd as string) ?? '0') || 0,
        })
      } catch { /* use cached pool from router state */ }
      setLoading(false)
    }
    void fetchPool()
  }, [network, address])

  // load + poll trades every 10s
  useEffect(() => {
    const loadTrades = async () => {
      try {
        const t = await getPoolTrades(address)
        setTrades(t)
      } catch {}
    }
    void loadTrades()
    pollRef.current = setInterval(() => { void loadTrades() }, 10_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [address])

  const lpColor = pool ? (LAUNCHPAD_COLORS[pool.dexName] ?? '#64748b') : '#64748b'

  if (loading) return (
    <div className="token-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
    </div>
  )

  return (
    <div className="token-page">
      {/* header */}
      <div className="token-page-header">
        <button className="back-btn" onClick={() => navigate({ name: 'terminal' })}>← Back</button>
        {pool && (
          <>
            <div className="card-logo-placeholder" style={{ width: 44, height: 44, fontSize: '0.85rem' }}>
              {pool.baseSymbol.slice(0, 2)}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '1.2rem' }}>{pool.baseName} <span style={{ color: 'var(--accent)' }}>${pool.baseSymbol}</span></div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <span style={{ background: lpColor, color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: '0.65rem', fontWeight: 700 }}>{pool.dexName}</span>
                &nbsp; Pool: <a href={`${EXPLORER}/address/${pool.address}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{shortAddr(pool.address)}</a>
              </div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '1.3rem', fontWeight: 700 }}>
                ${pool.priceUsd < 0.0001 ? pool.priceUsd.toExponential(3) : pool.priceUsd.toFixed(6)}
              </div>
              <div style={{ fontSize: '0.75rem', color: pool.priceChange.h24 >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                {pool.priceChange.h24 >= 0 ? '+' : ''}{pool.priceChange.h24.toFixed(2)}% 24h
              </div>
            </div>
          </>
        )}
      </div>

      {/* stats */}
      {pool && (
        <div className="token-stats-grid">
          <div className="stat-card"><div className="stat-label">Market Cap</div><div className="stat-val">{fmt(pool.marketCapUsd ?? pool.fdvUsd, '$')}</div></div>
          <div className="stat-card"><div className="stat-label">24h Volume</div><div className="stat-val">{fmt(pool.volumeH24, '$')}</div></div>
          <div className="stat-card"><div className="stat-label">Liquidity</div><div className="stat-val">{fmt(pool.liquidityUsd, '$')}</div></div>
          <div className="stat-card"><div className="stat-label">FDV</div><div className="stat-val">{fmt(pool.fdvUsd, '$')}</div></div>
          <div className="stat-card"><div className="stat-label">Buys (1h)</div><div className="stat-val" style={{ color: 'var(--green)' }}>{pool.txns.buys}</div></div>
          <div className="stat-card"><div className="stat-label">Sells (1h)</div><div className="stat-val" style={{ color: 'var(--red)' }}>{pool.txns.sells}</div></div>
          <div className="stat-card"><div className="stat-label">Buyers (1h)</div><div className="stat-val">{pool.txns.buyers}</div></div>
          <div className="stat-card"><div className="stat-label">Pool Age</div><div className="stat-val">{timeAgo(pool.poolCreatedAt)}</div></div>
        </div>
      )}

      {/* price chart */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Price Chart</div>
        <PriceChart tokenAddress={address} candles={[]} />
      </div>

      {/* live trades */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ fontWeight: 700 }}>Live Trades</div>
          <div className="live-dot" />
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>auto-refresh 10s · {trades.length} txns</div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="trades-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount USD</th>
                <th>From</th>
                <th>To</th>
                <th>Wallet</th>
                <th>Tx Hash</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr><td colSpan={7} style={{ color: 'var(--text-muted)', padding: '20px', textAlign: 'center' }}>No recent trades</td></tr>
              )}
              {trades.map((t, i) => (
                <tr key={i} className={t.kind}>
                  <td className={t.kind === 'buy' ? 'trade-buy' : 'trade-sell'}>
                    {t.kind === 'buy' ? '▲ BUY' : '▼ SELL'}
                  </td>
                  <td className="trade-mono">${t.volumeUsd < 0.01 ? t.volumeUsd.toFixed(4) : fmt(t.volumeUsd)}</td>
                  <td className="trade-mono" style={{ color: 'var(--text-muted)' }}>{parseFloat(t.fromAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="trade-mono" style={{ color: 'var(--text-muted)' }}>{parseFloat(t.toAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="trade-wallet">
                    <a href={`${EXPLORER}/address/${t.txFrom}`} target="_blank" rel="noreferrer">{shortAddr(t.txFrom)}</a>
                  </td>
                  <td className="trade-wallet">
                    <a href={`${EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noreferrer">{shortAddr(t.txHash)}</a>
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{timeAgo(t.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
