import { useEffect, useState, useRef, useCallback } from 'react'
import { getToken, getTrades, getOhlcv, type ArcToken, type Trade, type OhlcvCandle, getLaunchpadColor } from '../api/radardex'
import PriceChart from '../components/PriceChart'
import SwapWidget from '../components/SwapWidget'
import type { Page } from '../App'

interface Props {
  address:  string
  navigate: (p: Page) => void
}

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(4)}`
}

function fmtPrice(p: number): string {
  if (p === 0) return '$0'
  if (p >= 1)  return `$${p.toFixed(4)}`
  if (p >= 0.001) return `$${p.toFixed(6)}`
  return `$${p.toExponential(3)}`
}

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function trunc(s: string, n = 6): string {
  if (!s) return '—'
  return `${s.slice(0, n)}…${s.slice(-4)}`
}

type ResKey = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RES: ResKey[] = ['1m', '5m', '15m', '1h', '4h', '1d']

export default function TokenPage({ address, navigate }: Props) {
  const [token,    setToken]    = useState<ArcToken | null>(null)
  const [trades,   setTrades]   = useState<Trade[]>([])
  const [candles,  setCandles]  = useState<OhlcvCandle[]>([])
  const [loading,  setLoading]  = useState(true)
  const [res,      setRes]      = useState<ResKey>('1h')
  const [newCount, setNewCount] = useState(0)
  const prevTradeRef = useRef<string>('')
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadToken = useCallback(async () => {
    const t = await getToken(address)
    setToken(t)
  }, [address])

  const loadTrades = useCallback(async () => {
    const tr = await getTrades(address, 50)
    if (tr.length && tr[0]?.txHash !== prevTradeRef.current) {
      if (prevTradeRef.current) {
        const newOnes = tr.filter(t => t.txHash !== prevTradeRef.current).length
        setNewCount(n => n + newOnes)
      }
      prevTradeRef.current = tr[0]?.txHash ?? ''
    }
    setTrades(tr)
  }, [address])

  const loadCandles = useCallback(async (r: ResKey) => {
    const c = await getOhlcv(address, r, 200)
    setCandles(c)
  }, [address])

  useEffect(() => {
    setLoading(true)
    setNewCount(0)
    Promise.all([loadToken(), loadTrades(), loadCandles(res)]).finally(() => setLoading(false))
  }, [address, loadToken, loadTrades, loadCandles, res])

  // Poll trades every 10s for live updates
  useEffect(() => {
    timerRef.current = setInterval(() => {
      void loadTrades()
      void loadToken()
    }, 10_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [loadTrades, loadToken])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: 300, color: 'var(--text-muted)' }}>Loading…</div>
  )

  if (!token) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: 300, gap: 16 }}>
      <div style={{ color: 'var(--text-muted)' }}>Token not found</div>
      <button onClick={() => navigate({ name: 'terminal' })}
        style={{ padding: '8px 20px', borderRadius: 8, background: 'var(--accent)',
          color: '#fff', border: 'none', cursor: 'pointer' }}>← Back</button>
    </div>
  )

  const lpColor = getLaunchpadColor(token.launchpad)
  const chg     = token.priceChange24h
  const pos     = chg >= 0

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '20px 16px 40px' }}>

      {/* Back */}
      <button onClick={() => navigate({ name: 'terminal' })}
        style={{ background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 4 }}>
        ← Terminal
      </button>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        {token.logoUrl ? (
          <img src={token.logoUrl} width={52} height={52}
            style={{ borderRadius: '50%', objectFit: 'cover' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} alt="" />
        ) : (
          <div style={{
            width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
            background: `hsl(${parseInt(token.address.slice(2,4),16)*1.4}deg 60% 35%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '1.125rem', color: '#fff',
          }}>{token.symbol.slice(0, 2)}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <h1 style={{ fontSize: '1.375rem', fontWeight: 800 }}>{token.symbol}</h1>
            <span style={{ color: 'var(--text-muted)' }}>{token.name}</span>
            <span className="lp-badge" style={{ color: lpColor, borderColor: `${lpColor}40`, background: `${lpColor}15` }}>
              {token.launchpad}
            </span>
            {token.graduated && (
              <span style={{ fontSize: '0.625rem', fontWeight: 600, padding: '2px 8px',
                borderRadius: 999, background: 'rgba(34,197,94,0.15)', color: 'var(--green)',
                border: '1px solid rgba(34,197,94,0.3)' }}>Graduated ✓</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', fontWeight: 700 }}>
              {fmtPrice(token.price)}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '1rem',
              color: pos ? 'var(--green)' : 'var(--red)' }}>
              {pos ? '+' : ''}{chg.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['MCap',      fmt(token.marketCap)],
            ['Vol 24h',   fmt(token.volume24h)],
            ['Liquidity', fmt(token.liquidity)],
            ['Holders',   token.holderCount.toLocaleString()],
          ].map(([l, v]) => (
            <div key={l} className="arc-card" style={{ padding: '10px 16px', textAlign: 'right', minWidth: 90 }}>
              <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase',
                letterSpacing: '0.06em', marginBottom: 2 }}>{l}</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.9375rem' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Contract + links */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CA:</span>
        <a href={`https://explorer.mainnet.arc.io/address/${token.address}`}
          target="_blank" rel="noreferrer"
          style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'none' }}>
          {token.address}
        </a>
        {token.website  && <a href={token.website}  target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🌐 Web</a>}
        {token.twitter  && <a href={token.twitter}  target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🐦 Twitter</a>}
        {token.telegram && <a href={token.telegram} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>✈️ TG</a>}
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16 }}>

        {/* Left */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

          {/* Chart */}
          <div className="arc-card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {RES.map(r => (
                <button key={r} onClick={() => setRes(r)}
                  style={{ padding: '4px 10px', borderRadius: 6, fontSize: '0.75rem', border: '1px solid',
                    borderColor: res === r ? 'var(--accent)' : 'var(--card-border)',
                    background: res === r ? 'rgba(59,130,246,0.15)' : 'transparent',
                    color: res === r ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer' }}>
                  {r}
                </button>
              ))}
            </div>
            <PriceChart tokenAddress={token.address} candles={candles} />
          </div>

          {/* Trades — live */}
          <div className="arc-card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--card-border)',
              display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Live Transactions</h3>
              <div className="pulse-dot" />
              {newCount > 0 && (
                <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: 999,
                  fontSize: '0.6875rem', padding: '1px 7px', fontWeight: 700 }}>
                  +{newCount} new
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                Updates every 10s
              </span>
            </div>
            {trades.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                No transactions yet
              </div>
            ) : (
              <div className="table-scroll">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--card-border)' }}>
                      {['Type','Price','USD In','Tokens Out','Wallet','Tx','Time'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left',
                          color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.6875rem',
                          textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map(t => (
                      <tr key={t.txHash || `${t.timestamp}-${t.maker}`}
                        style={{ borderBottom: '1px solid rgba(30,48,80,0.4)',
                          background: 'transparent', transition: 'background 0.1s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-3)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{
                            color: t.type === 'buy' ? 'var(--green)' : 'var(--red)',
                            fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase',
                            background: t.type === 'buy' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                            padding: '2px 8px', borderRadius: 4,
                          }}>
                            {t.type}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
                          {fmtPrice(t.price)}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)',
                          color: t.type === 'buy' ? 'var(--green)' : 'var(--red)', fontSize: '0.8125rem' }}>
                          ${t.amountIn.toFixed(2)}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
                          {t.amountOut > 0 ? t.amountOut.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
                          {t.maker ? (
                            <a href={`https://explorer.mainnet.arc.io/address/${t.maker}`}
                              target="_blank" rel="noreferrer"
                              style={{ color: 'var(--accent)', textDecoration: 'none' }}
                              title={t.maker}>
                              {trunc(t.maker)}
                            </a>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
                          {t.txHash ? (
                            <a href={`https://explorer.mainnet.arc.io/tx/${t.txHash}`}
                              target="_blank" rel="noreferrer"
                              style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
                              title={t.txHash}>
                              {trunc(t.txHash, 6)}
                            </a>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-muted)',
                          fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                          {t.timestamp ? timeAgo(t.timestamp) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Token info */}
          <div className="arc-card" style={{ padding: 16 }}>
            <h3 style={{ fontWeight: 600, marginBottom: 14, fontSize: '0.9375rem' }}>Token Info</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
              {[
                ['Launchpad', token.launchpad],
                ['24h Buys',  token.buys24h.toLocaleString()],
                ['24h Sells', token.sells24h.toLocaleString()],
                ['Txns 24h',  token.txCount24h.toLocaleString()],
                ['Quote',     token.quoteSymbol],
                ['Verified',  token.verified ? '✓ Yes' : '✗ No'],
                ['Bonding',   token.bondingProgress !== null ? `${token.bondingProgress.toFixed(1)}%` : 'N/A'],
                ['B/S Ratio', token.sells24h > 0 ? (token.buys24h / token.sells24h).toFixed(2) : '∞'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                  borderBottom: '1px solid rgba(30,48,80,0.5)', paddingBottom: 8 }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{k}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8125rem', fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
            {token.deployer && (
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between',
                borderBottom: '1px solid rgba(30,48,80,0.5)', paddingBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>Deployer</span>
                <a href={`https://explorer.mainnet.arc.io/address/${token.deployer}`}
                  target="_blank" rel="noreferrer"
                  style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'none' }}>
                  {trunc(token.deployer, 8)}
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Right — swap */}
        <div style={{ position: 'sticky', top: 76, alignSelf: 'start', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="arc-card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--card-border)' }}>
              <h3 style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Swap</h3>
            </div>
            <SwapWidget token={token} />
          </div>

          {/* Price changes */}
          <div className="arc-card" style={{ padding: 16 }}>
            <h3 style={{ fontWeight: 600, marginBottom: 12, fontSize: '0.875rem' }}>Price Change</h3>
            {[
              ['5m',  token.priceChange5m],
              ['1h',  token.priceChange1h],
              ['24h', token.priceChange24h],
            ].map(([label, val]) => {
              const v = val as number
              return (
                <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between',
                  marginBottom: 8, alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{label as string}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 700,
                    color: v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text-muted)',
                    fontSize: '0.875rem' }}>
                    {v > 0 ? '+' : ''}{v.toFixed(2)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
