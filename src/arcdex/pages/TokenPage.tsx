import { useEffect, useState } from 'react'
import { getPairByAddress, getLaunchpad, type DexPair } from '../api/dexscreener'
import { subscribePair, estimateUsd, ARC_EXPLORER, type LiveTrade } from '../api/arcRpc'
import PriceChart from '../components/PriceChart'
import type { Page } from '../App'

interface Props { address: string; navigate: (p: Page) => void }

function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }
function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString() }
function fmt(n: number | null | undefined, prefix = '') {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e9)  return `${prefix}${(n/1e9).toFixed(2)}B`
  if (n >= 1e6)  return `${prefix}${(n/1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${prefix}${(n/1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(2)}`
}

function TokenImage({ src, symbol }: { src?: string; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) return (
    <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg,#1e3a5f,#0f1e30)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.7rem', fontWeight: 700, color: '#3b82f6' }}>
      {symbol.slice(0, 3)}
    </div>
  )
  return <img src={src} alt={symbol} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }} onError={() => setErr(true)} />
}

export default function TokenPage({ address, navigate }: Props) {
  const [pair,   setPair]   = useState<DexPair | null>(null)
  const [trades, setTrades] = useState<LiveTrade[]>([])
  const [loading, setLoading] = useState(true)

  // load pair data
  useEffect(() => {
    setLoading(true)
    getPairByAddress(address).then(p => { setPair(p); setLoading(false) })
    // refresh every 6s
    const t = setInterval(() => getPairByAddress(address).then(p => { if (p) setPair(p) }), 6000)
    return () => clearInterval(t)
  }, [address])

  // subscribe to live trades via Arc RPC WebSocket
  useEffect(() => {
    const unsub = subscribePair(address, trade => {
      const usd = estimateUsd(trade.amount1)
      setTrades(prev => [{ ...trade, volumeUsd: usd }, ...prev].slice(0, 200))
    })
    return unsub
  }, [address])

  const lp = pair ? getLaunchpad(pair) : null

  return (
    <div className="token-page">
      {/* header */}
      <div className="token-page-header">
        <button className="back-btn" onClick={() => navigate({ name: 'terminal' })}>← Back</button>
        {pair && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <TokenImage src={pair.info?.imageUrl} symbol={pair.baseToken.symbol} />
            <div>
              <div style={{ fontWeight: 800, fontSize: '1.2rem' }}>
                ${pair.baseToken.symbol}
                <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                  {pair.baseToken.name}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3b82f6' }}>
                  ${parseFloat(pair.priceUsd || '0').toPrecision(5)}
                </span>
                {lp && (
                  <span style={{ background: lp.color + '22', color: lp.color, fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, border: `1px solid ${lp.color}44` }}>
                    {lp.name}
                  </span>
                )}
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  / {pair.quoteToken.symbol}
                </span>
              </div>
            </div>
          </div>
        )}
        {loading && !pair && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
      </div>

      {/* stats bar */}
      {pair && (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--card-border)', fontSize: '0.8rem' }}>
          {[
            ['24h Change', `${pair.priceChange?.h24 >= 0 ? '+' : ''}${pair.priceChange?.h24?.toFixed(2) ?? 0}%`, pair.priceChange?.h24 >= 0 ? '#22c55e' : '#ef4444'],
            ['24h Volume', fmt(pair.volume?.h24, '$'), '#3b82f6'],
            ['Liquidity',  fmt(pair.liquidity?.usd, '$'), '#a855f7'],
            ['Market Cap', fmt(pair.marketCap ?? pair.fdv, '$'), '#f97316'],
            ['Buys 24h',   String(pair.txns?.h24?.buys ?? '—'), '#22c55e'],
            ['Sells 24h',  String(pair.txns?.h24?.sells ?? '—'), '#ef4444'],
          ].map(([label, val, color]) => (
            <div key={label as string}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 2 }}>{label}</div>
              <div style={{ fontWeight: 700, color: color as string }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* price chart */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, margin: '16px 16px 0', padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: '0.85rem', color: 'var(--text-muted)' }}>PRICE CHART</div>
        <PriceChart tokenAddress={address} />
      </div>

      {/* live trades */}
      <div style={{ margin: 16, background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Live Trades</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginRight: 5, animation: 'pulse 1.5s infinite' }} />
            Real-time via Arc RPC
          </span>
        </div>

        {trades.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Waiting for trades on this pair…
          </div>
        ) : (
          <div style={{ overflowY: 'auto', maxHeight: 420 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--card-border)' }}>
                  {['Type', 'USD Value', 'Wallet', 'Tx Hash', 'Time'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={t.txHash + i} style={{ borderBottom: '1px solid var(--card-border)', background: i === 0 ? (t.kind === 'buy' ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)') : 'transparent' }}>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ background: t.kind === 'buy' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: t.kind === 'buy' ? '#22c55e' : '#ef4444', fontWeight: 700, padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem' }}>
                        {t.kind.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, color: t.kind === 'buy' ? '#22c55e' : '#ef4444' }}>
                      {t.volumeUsd < 0.01 ? '<$0.01' : `$${fmt(t.volumeUsd)}`}
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>
                      <a href={`${ARC_EXPLORER}/address/${t.walletAddress}`} target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                        {short(t.walletAddress)}
                      </a>
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>
                      <a href={`${ARC_EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
                        {short(t.txHash)}
                      </a>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{fmtTime(t.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
