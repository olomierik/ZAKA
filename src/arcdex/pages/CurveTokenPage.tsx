import { useEffect, useState, useCallback } from 'react'
import { getLaunchpadToken, getRecentTrades, getDevHoldingPct, LAUNCHPAD_ADDRESS, type LaunchpadToken, type CurveTrade } from '../api/launchpad'
import { subscribeLaunchpadTrades } from '../api/launchpadRpc'
import { computeTrustReport, type TrustReport } from '../api/trustScore'
import { ARC_EXPLORER } from '../api/arcRpc'
import CurveSwapWidget from '../components/CurveSwapWidget'
import CurveChart from '../components/CurveChart'
import type { Page } from '../App'

interface Props { address: string; navigate: (p: Page) => void }

function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }
const socialLinkStyle: React.CSSProperties = {
  background: 'var(--bg-2)', color: 'var(--text-muted)', fontSize: '0.65rem', fontWeight: 700,
  padding: '2px 8px', borderRadius: 99, border: '1px solid var(--card-border)', textDecoration: 'none',
}
function fmt(n: number, prefix = '') {
  if (!n || isNaN(n)) return '—'
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(n < 1 ? 6 : 2)}`
}

export default function CurveTokenPage({ address, navigate }: Props) {
  const [token, setToken]   = useState<LaunchpadToken | null>(null)
  const [trades, setTrades] = useState<CurveTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [devPct, setDevPct] = useState<number | null>(null)
  const [trust, setTrust] = useState<TrustReport | null>(null)
  const [trustLoading, setTrustLoading] = useState(false)

  const load = useCallback(() => {
    void getLaunchpadToken(address as `0x${string}`).then(t => {
      setToken(t); setLoading(false)
      if (t) void getDevHoldingPct(t.address, t.curve.creator).then(setDevPct)
    })
  }, [address])

  // Trust report is a heavier scan (walks early buyers' funding history) —
  // computed once per token visit, not on the 8s poll interval.
  useEffect(() => {
    setTrust(null)
    void getLaunchpadToken(address as `0x${string}`).then(t => {
      if (!t) return
      setTrustLoading(true)
      computeTrustReport(t.address, t.curve).then(setTrust).finally(() => setTrustLoading(false))
    })
  }, [address])

  // Curve state (price, bonding progress, reserves) isn't event-driven on
  // its own, so it's still polled — but at a lighter interval now that
  // trades themselves push live below, instead of the polling itself
  // being the only source of "new trade" updates.
  useEffect(() => { setLoading(true); load(); const iv = setInterval(load, 8000); return () => clearInterval(iv) }, [load])

  // Trades: one historical fetch for backfill, then genuinely live via
  // WebSocket — no more waiting on the next poll tick to see a new trade.
  useEffect(() => {
    setTrades([])
    void getRecentTrades(address as `0x${string}`).then(setTrades)

    const unsub = subscribeLaunchpadTrades(LAUNCHPAD_ADDRESS, live => {
      if (live.token.toLowerCase() !== address.toLowerCase()) return
      const trade: CurveTrade = {
        trader: live.trader as `0x${string}`,
        isBuy: live.isBuy,
        usdcAmount: BigInt(Math.round(live.usdcAmount * 1e6)),
        tokenAmount: BigInt(Math.round(live.tokenAmount * 1e18)),
        blockNumber: BigInt(live.blockNumber),
        txHash: live.txHash as `0x${string}`,
      }
      setTrades(prev => prev.some(t => t.txHash === trade.txHash) ? prev : [trade, ...prev].slice(0, 200))
    })
    return unsub
  }, [address])

  if (loading && !token) return <div className="loading-state">Loading…</div>
  if (!token) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Token not found.</div>

  const rUsdcUsd = Number(token.curve.rUsdc) / 1e6
  const marketCap = token.priceUsd * (Number(token.curve.vToken) / 1e18 > 0 ? 1_000_000_000 : 0)

  return (
    <div className="token-page">
      <div className="token-page-header">
        <button className="back-btn" onClick={() => navigate({ name: 'terminal' })}>← Back</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {token.metadata?.image ? (
            <img src={token.metadata.image} alt="" width={44} height={44}
              style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg,#1e3a5f,#0f1e30)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>
              {token.symbol.slice(0, 3)}
            </div>
          )}
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.2rem' }}>
              ${token.symbol}
              <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>{token.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3b82f6' }}>${fmt(token.priceUsd)}</span>
              <span style={{ background: '#7c3aed22', color: '#a78bfa', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, border: '1px solid #7c3aed44' }}>
                ARCDEX Launchpad
              </span>
              {token.curve.graduated && (
                <span style={{ background: '#22c55e22', color: '#22c55e', fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, border: '1px solid #22c55e44' }}>
                  ✓ Graduated
                </span>
              )}
              {token.metadata?.website && (
                <a href={token.metadata.website} target="_blank" rel="noopener noreferrer" style={socialLinkStyle}>🌐 Website</a>
              )}
              {token.metadata?.twitter && (
                <a href={token.metadata.twitter} target="_blank" rel="noopener noreferrer" style={socialLinkStyle}>𝕏</a>
              )}
              {token.metadata?.telegram && (
                <a href={token.metadata.telegram} target="_blank" rel="noopener noreferrer" style={socialLinkStyle}>✈ Telegram</a>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--card-border)', fontSize: '0.8rem' }}>
        {[
          ['Market Cap', `$${fmt(marketCap)}`, '#f97316'],
          ['Raised', `$${fmt(rUsdcUsd)}`, '#a855f7'],
          ['To graduation', token.curve.graduated ? '100%' : `${token.bondingProgress.toFixed(1)}%`, '#3b82f6'],
          ['Status', token.curve.graduated ? 'Graduated' : 'Bonding', token.curve.graduated ? '#22c55e' : '#f59e0b'],
          ['Dev holds', devPct === null ? '…' : `${devPct.toFixed(2)}%`, devPct !== null && devPct > 5 ? '#f59e0b' : '#22c55e'],
        ].map(([label, val, color]) => (
          <div key={label}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 2 }}>{label}</div>
            <div style={{ fontWeight: 700, color }}>{val}</div>
          </div>
        ))}
      </div>

      <div className="token-detail-grid">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, marginTop: 16, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: '0.85rem', color: 'var(--text-muted)' }}>PRICE CHART</div>
            <CurveChart token={token.address} />
          </div>

          {!token.curve.graduated && (
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, marginTop: 16, padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 10, fontSize: '0.85rem', color: 'var(--text-muted)' }}>BONDING CURVE PROGRESS</div>
              <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-2)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, token.bondingProgress)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#22c55e)' }} />
              </div>
              <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                ${fmt(rUsdcUsd)} of $25,000 raised — graduates automatically, no external migration step.
              </div>
            </div>
          )}

          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, marginTop: 16, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-muted)' }}>TRUST SIGNALS</span>
              {trust && (
                <span style={{
                  fontWeight: 800, fontSize: '0.9rem', padding: '2px 10px', borderRadius: 99,
                  color: trust.score >= 75 ? '#22c55e' : trust.score >= 40 ? '#f59e0b' : '#ef4444',
                  background: trust.score >= 75 ? '#22c55e22' : trust.score >= 40 ? '#f59e0b22' : '#ef444422',
                }}>
                  {trust.score}/100
                </span>
              )}
            </div>
            {trustLoading && !trust ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Scanning early-buyer funding history…</div>
            ) : trust ? (
              <>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {trust.flags.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
                <div style={{ marginTop: 10, fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.5, opacity: 0.85 }}>
                  Based on {trust.earlyBuyerCount} early buyer wallet(s)' public on-chain USDC funding history — a heuristic signal, not proof. Every token on this launchpad already gets the same on-chain floor regardless of this score: $2k/tx buy cap for 10 minutes after launch, $5k/block cap across all wallets, no contract-mediated bots, and no owner withdrawal path for real reserves.
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Not enough trade history yet.</div>
            )}
          </div>

          <div style={{ marginTop: 16, background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Trades</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginRight: 5 }} />
                On-chain via ArcLaunchpad
              </span>
            </div>
            {trades.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No trades yet — be the first buyer.</div>
            ) : (
              <div style={{ overflowY: 'auto', maxHeight: 420 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--card-border)' }}>
                      {['Type', 'USDC', 'Tokens', 'Trader', 'Tx'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={t.txHash + i} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td style={{ padding: '8px 12px' }}>
                          <span style={{ background: t.isBuy ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: t.isBuy ? '#22c55e' : '#ef4444', fontWeight: 700, padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem' }}>
                            {t.isBuy ? 'BUY' : 'SELL'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>${fmt(Number(t.usdcAmount) / 1e6)}</td>
                        <td style={{ padding: '8px 12px' }}>{fmt(Number(t.tokenAmount) / 1e18)}</td>
                        <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>
                          <a href={`${ARC_EXPLORER}/address/${t.trader}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{short(t.trader)}</a>
                        </td>
                        <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>
                          <a href={`${ARC_EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>{short(t.txHash)}</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="token-detail-swap" style={{ marginTop: 16, background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, overflow: 'hidden' }}>
          <CurveSwapWidget token={token} onTraded={load} />
        </div>
      </div>
    </div>
  )
}

export function isLaunchpadConfigured() { return LAUNCHPAD_ADDRESS.length === 42 }
