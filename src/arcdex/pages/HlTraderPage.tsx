// /futures/trader/0x… — any Hyperliquid account's track record (2026-10-11, Liquid's leaderboard profiles): its value
// and P&L over time, open positions and latest trades, all Hyperliquid's own public data. A position's market opens
// in one tap; ARCDEX never copies a trade by itself.

import { useEffect, useMemo, useState } from 'react'
import { t as T } from '../lib/i18n'
import { shortAddr } from '../lib/identity'
import type { Page } from '../App'
import { HL_EXPLORER } from '../hl/client'
import { symbolOf } from '../hl/markets'
import { loadAccount, type HlAccountState } from '../hl/account'
import { useHlMarkets, useHlMids } from '../hl/live'
import { loadFills, loadHistory, loadLeaders, type HlHistory, type HlTraderFill, type HlWindow } from '../hl/leaders'
import { compactUsd, fmtNum, fmtPx } from '../hl/format'

const WINDOWS: [HlWindow, string][] = [['day', '24H'], ['week', '7D'], ['month', '30D'], ['allTime', 'All']]
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${compactUsd(Math.abs(n))}`

function Chart({ points, height = 180 }: { points: [number, number][]; height?: number }) {
  if (points.length < 2) return <div className="fx-empty">{T('No history in this window.')}</div>
  const xs = points.map(p => p[0]), ys = points.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0)
  const W = 600, H = height
  const px = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * W
  const py = (y: number) => H - 6 - ((y - y0) / Math.max(1e-9, y1 - y0)) * (H - 12)
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(' ')
  const up = ys[ys.length - 1] >= ys[0]
  const color = up ? 'var(--green)' : 'var(--red)'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} role="img" aria-label={T('History')}>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {y0 < 0 && y1 > 0 && <line x1={0} x2={W} y1={py(0)} y2={py(0)} stroke="var(--border-hi)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

export default function HlTraderPage({ address, navigate }: { address: string; navigate: (p: Page) => void }) {
  const user = address.toLowerCase()
  const { markets } = useHlMarkets()
  const mids = useHlMids()
  const [acct, setAcct] = useState<HlAccountState | null>(null)
  const [history, setHistory] = useState<Partial<Record<HlWindow, HlHistory>> | null>(null)
  const [fills, setFills] = useState<HlTraderFill[] | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [w, setW] = useState<HlWindow>('month')
  const [view, setView] = useState<'pnl' | 'value'>('pnl')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setAcct(null); setHistory(null); setFills(null); setName(null); setErr(null)
    const load = () => {
      void loadAccount(user).then(a => { if (alive) setAcct(a) }).catch(e => { if (alive) setErr(String((e as Error).message ?? e)) })
      void loadHistory(user).then(h => { if (alive) setHistory(h) }).catch(() => { if (alive) setHistory({}) })
      void loadFills(user).then(f => { if (alive) setFills(f) }).catch(() => { if (alive) setFills([]) })
    }
    load()
    void loadLeaders().then(d => { if (alive) setName(d.rows.find(r => r.a === user)?.n ?? null) }).catch(() => {})
    const id = setInterval(() => { if (!document.hidden) void loadAccount(user).then(a => { if (alive) setAcct(a) }).catch(() => {}) }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [user])

  useEffect(() => { const base = document.title; return () => { document.title = base } }, [])
  useEffect(() => { document.title = `${name ?? shortAddr(user)} | ${T('Futures trader')} | ARCDEX` }, [name, user])

  const bySymbol = useMemo(() => new Map((markets ?? []).map(m => [m.coin, m])), [markets])
  const h = history?.[w]
  const windowPnl = h?.pnl.length ? h.pnl[h.pnl.length - 1][1] : null
  const unrealized = (acct?.positions ?? []).reduce((s, p) => s + ((mids[p.coin] ?? p.entryPx) - p.entryPx) * p.szi, 0)

  return (
    <div className="content-page hl-trader" style={{ '--page-w': '1080px' } as React.CSSProperties}>
      <div className="hl-trader-head">
        <div className="hl-trader-id">
          <span className="hl-trader-avatar" aria-hidden>{(name ?? user.slice(2, 4)).slice(0, 2).toUpperCase()}</span>
          <div>
            <h1 className="page-h" style={{ margin: 0 }}>{name ?? shortAddr(user)}</h1>
            <div className="hl-trader-addr">
              <code>{shortAddr(user)}</code>
              <button className="link-btn" onClick={() => { void navigator.clipboard?.writeText(user); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? T('Copied ✓') : T('Copy')}</button>
              <a href={`${HL_EXPLORER}/address/${user}`} target="_blank" rel="noreferrer">{T('Hyperliquid explorer')} ↗</a>
            </div>
          </div>
        </div>
        <button className="btn-ghost" onClick={() => navigate({ name: 'leaderboard' })}>← {T('Leaderboard')}</button>
      </div>

      <div className="hl-trader-stats">
        <div><span>{T('Account value')}</span><b>{acct ? compactUsd(acct.accountValue) : '…'}</b></div>
        <div><span>{T('Unrealized P&L')}</span><b className={unrealized >= 0 ? 'fx-up' : 'fx-down'}>{acct ? signed(unrealized) : '…'}</b></div>
        {WINDOWS.map(([k, label]) => {
          const hh = history?.[k]
          const v = hh?.pnl.length ? hh.pnl[hh.pnl.length - 1][1] : null
          return <div key={k}><span>{T('P&L')} {label === 'All' ? T('All') : label}</span><b className={v == null ? '' : v >= 0 ? 'fx-up' : 'fx-down'}>{v == null ? (history ? '—' : '…') : signed(v)}</b></div>
        })}
      </div>

      <div className="spot-panel hl-trader-chart">
        <div className="hl-trader-chart-h">
          <div className="hl-mini-tabs" style={{ border: 'none', padding: 0 }}>
            <button className={view === 'pnl' ? 'active' : ''} onClick={() => setView('pnl')}>{T('P&L')}</button>
            <button className={view === 'value' ? 'active' : ''} onClick={() => setView('value')}>{T('Account value')}</button>
          </div>
          <div className="hl-trader-windows">
            {WINDOWS.map(([k, label]) => <button key={k} className={w === k ? 'active' : ''} onClick={() => setW(k)}>{label === 'All' ? T('All') : label}</button>)}
          </div>
        </div>
        {!history ? <div className="fx-empty">{T('Loading…')}</div> : <Chart points={h ? (view === 'pnl' ? h.pnl : h.value) : []} />}
        {h && <div className="fx-fine" style={{ padding: '0 14px 10px' }}>{T('Volume')}: {compactUsd(h.volume)}{windowPnl != null ? ` · ${T('P&L')}: ${signed(windowPnl)}` : ''}</div>}
      </div>

      <div className="spot-panel" style={{ padding: '0 14px 10px' }}>
        <div className="spot-panel-h" style={{ paddingLeft: 0 }}><span>{T('Open positions')}</span></div>
        {err ? <div className="fx-empty">⚠ {err}</div> : !acct ? <div className="fx-empty">{T('Loading…')}</div> : !acct.positions.length ? <div className="fx-empty">{T('No open positions.')}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>{T('Market')}</th><th>{T('Size')}</th><th>{T('Value')}</th><th>{T('Entry')}</th><th>{T('Mark')}</th><th>{T('P&L (ROE)')}</th><th>{T('Liq. price')}</th><th /></tr></thead>
              <tbody>
                {acct.positions.map(p => {
                  const m = bySymbol.get(p.coin)
                  const mark = mids[p.coin] ?? m?.markPx ?? p.entryPx
                  const pnl = (mark - p.entryPx) * p.szi
                  const roe = p.marginUsed > 0 ? (pnl / p.marginUsed) * 100 : 0
                  return (
                    <tr key={p.coin}>
                      <td><b>{m?.symbol ?? symbolOf(p.coin)}</b> <span className={p.szi > 0 ? 'fx-up' : 'fx-down'}>{p.szi > 0 ? T('Long') : T('Short')}</span> <small>{p.leverage.value}×</small></td>
                      <td>{fmtNum(Math.abs(p.szi), m?.szDecimals ?? 4)}</td>
                      <td>{compactUsd(Math.abs(p.szi) * mark)}</td>
                      <td>{fmtPx(p.entryPx)}</td>
                      <td>{fmtPx(mark)}</td>
                      <td className={pnl >= 0 ? 'fx-up' : 'fx-down'}>{signed(pnl)} <small>{roe >= 0 ? '+' : ''}{roe.toFixed(1)}%</small></td>
                      <td className="fx-down">{fmtPx(p.liquidationPx)}</td>
                      <td>{m && <button className="btn-ghost" onClick={() => navigate({ name: 'perps', coin: p.coin })}>{T('Trade {sym}', { sym: m.symbol })}</button>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="spot-panel" style={{ padding: '0 14px 10px' }}>
        <div className="spot-panel-h" style={{ paddingLeft: 0 }}><span>{T('Latest trades')}</span></div>
        {!fills ? <div className="fx-empty">{T('Loading…')}</div> : !fills.length ? <div className="fx-empty">{T('No trades yet.')}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Direction')}</th><th>{T('Price')}</th><th>{T('Size')}</th><th>{T('Closed P&L')}</th><th /></tr></thead>
              <tbody>
                {fills.map(f => (
                  <tr key={`${f.tid}${f.hash}`}>
                    <td><small>{new Date(f.time).toLocaleString()}</small></td>
                    <td><b>{bySymbol.get(f.coin)?.symbol ?? (f.coin.startsWith('#') || f.coin.startsWith('@') ? f.coin : symbolOf(f.coin))}</b></td>
                    <td className={f.side === 'B' ? 'fx-up' : 'fx-down'}>{f.dir}</td>
                    <td>{fmtPx(f.px)}</td>
                    <td>{fmtNum(f.sz, 4)}</td>
                    <td className={f.closedPnl ? (f.closedPnl >= 0 ? 'fx-up' : 'fx-down') : ''}>{f.closedPnl ? signed(f.closedPnl) : '—'}</td>
                    <td>{f.hash && !/^0x0+$/.test(f.hash) ? <a href={`${HL_EXPLORER}/tx/${f.hash}`} target="_blank" rel="noreferrer">↗</a> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="fx-fine hl-foot">{T('Public data from Hyperliquid. ARCDEX never copies a trade for you: open a market to place your own.')}</p>
    </div>
  )
}
