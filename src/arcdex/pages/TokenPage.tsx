import { useEffect, useState } from 'react'
import { getToken, getTrades, type ArcToken, type Trade, getLaunchpadColor } from '../api/radardex'
import PriceChart from '../components/PriceChart'
import SwapWidget from '../components/SwapWidget'
import type { Page } from '../App'

interface Props {
  address:  string
  navigate: (p: Page) => void
}

function fmt(n: number, usd = true): string {
  const prefix = usd ? '$' : ''
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`
  return `${prefix}${n.toFixed(4)}`
}

function trunc(s: string, n = 8): string {
  return `${s.slice(0, n)}…${s.slice(-6)}`
}

export default function TokenPage({ address, navigate }: Props) {
  const [token,   setToken]   = useState<ArcToken | null>(null)
  const [trades,  setTrades]  = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([getToken(address), getTrades(address)]).then(([t, tr]) => {
      setToken(t)
      setTrades(tr)
      setLoading(false)
    })
  }, [address])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300,
      color: 'var(--text-muted)' }}>Loading…</div>
  )

  if (!token) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: 300, gap: 16 }}>
      <div style={{ color: 'var(--text-muted)' }}>Token not found</div>
      <button onClick={() => navigate({ name: 'terminal' })}
        style={{ padding: '8px 20px', borderRadius: 8, background: 'var(--accent)',
          color: '#fff', border: 'none', cursor: 'pointer' }}>
        ← Back to Terminal
      </button>
    </div>
  )

  const lpColor = getLaunchpadColor(token.launchpad)
  const chg = token.priceChange24h

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate({ name: 'terminal' })}
          style={{ color: 'var(--text-muted)', background: 'none', border: 'none',
            cursor: 'pointer', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          ← Terminal
        </button>
      </div>

      {/* Token header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {token.logoUrl ? (
          <img src={token.logoUrl} width={48} height={48} style={{ borderRadius: '50%' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} alt="" />
        ) : (
          <div style={{
            width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
            background: `hsl(${parseInt(token.address.slice(2,4), 16) * 1.4}deg 60% 40%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: '1rem', color: '#fff',
          }}>{token.symbol.slice(0, 2)}</div>
        )}
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800 }}>{token.symbol}</h1>
            <span style={{ color: 'var(--text-muted)', fontSize: '1rem' }}>{token.name}</span>
            <span className="lp-badge" style={{ color: lpColor, borderColor: `${lpColor}40`, background: `${lpColor}15` }}>
              {token.launchpad}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 20, marginTop: 6, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '1.25rem', fontWeight: 700 }}>
              {token.price < 0.001 ? `$${token.price.toExponential(3)}` : `$${token.price.toFixed(6)}`}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '1rem',
              color: chg > 0 ? 'var(--green)' : chg < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
              {chg > 0 ? '+' : ''}{chg.toFixed(2)}%
            </div>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['MCap',      fmt(token.marketCap)],
            ['Volume 24h',fmt(token.volume24h)],
            ['Liquidity', fmt(token.liquidity)],
          ].map(([l, v]) => (
            <div key={l} className="arc-card" style={{ padding: '10px 16px', textAlign: 'right' }}>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{l}</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Contract address */}
      <div style={{ marginBottom: 24, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Contract:</span>
        <a
          href={`https://explorer.mainnet.arc.io/address/${token.address}`}
          target="_blank" rel="noreferrer"
          style={{ fontFamily: 'var(--mono)', fontSize: '0.8125rem', color: 'var(--accent)', textDecoration: 'none' }}
        >
          {token.address}
        </a>
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20 }}>
        {/* Left — chart + trades */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Chart */}
          <div className="arc-card" style={{ padding: '20px' }}>
            <PriceChart tokenAddress={token.address} />
          </div>

          {/* Trades */}
          <div className="arc-card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--card-border)' }}>
              <h3 style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Recent Trades</h3>
            </div>
            {trades.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No trades found
              </div>
            ) : (
              <div className="table-scroll">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--card-border)' }}>
                      {['Type','Price','Amount In','Amount Out','Maker','Time'].map(h => (
                        <th key={h} style={{ padding: '8px 16px', textAlign: 'left',
                          color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.75rem',
                          whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map(t => (
                      <tr key={t.txHash} style={{ borderBottom: '1px solid rgba(30,48,80,0.5)' }}>
                        <td style={{ padding: '10px 16px' }}>
                          <span style={{ color: t.type === 'buy' ? 'var(--green)' : 'var(--red)',
                            fontWeight: 600, textTransform: 'uppercase', fontSize: '0.75rem' }}>
                            {t.type}
                          </span>
                        </td>
                        <td style={{ padding: '10px 16px', fontFamily: 'var(--mono)' }}>
                          ${t.price.toFixed(6)}
                        </td>
                        <td style={{ padding: '10px 16px', fontFamily: 'var(--mono)' }}>
                          ${t.amountIn.toFixed(2)}
                        </td>
                        <td style={{ padding: '10px 16px', fontFamily: 'var(--mono)' }}>
                          {t.amountOut.toFixed(4)}
                        </td>
                        <td style={{ padding: '10px 16px', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
                          <a href={`https://explorer.mainnet.arc.io/address/${t.maker}`}
                            target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                            {trunc(t.maker)}
                          </a>
                        </td>
                        <td style={{ padding: '10px 16px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {new Date(t.timestamp * 1000).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right — swap widget */}
        <div style={{ position: 'sticky', top: 76, alignSelf: 'start' }}>
          <div className="arc-card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--card-border)' }}>
              <h3 style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Swap</h3>
            </div>
            <SwapWidget token={token} />
          </div>
        </div>
      </div>
    </div>
  )
}
