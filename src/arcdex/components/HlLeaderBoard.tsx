// The futures leaderboard (Leaderboard → Futures): Hyperliquid's most profitable traders in a window, from its own
// leaderboard (the engine's /api/hlleaders, refreshed every 10 minutes). Each opens its track record.

import { useEffect, useState } from 'react'
import { t as T } from '../lib/i18n'
import { shortAddr } from '../lib/identity'
import type { Page } from '../App'
import { loadLeaders, type HlLeaders, type HlWindow } from '../hl/leaders'

const usd = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0)
  return `${n < 0 ? '−' : ''}$${s}`
}
/** A return measured against a small starting balance can read in the millions of percent: shown capped. */
const roiText = (r: number) => (r > 10 ? '>1,000%' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(r >= 1 ? 0 : 1)}%`)

export default function HlLeaderBoard({ window: w, navigate }: { window: HlWindow; navigate: (p: Page) => void }) {
  const [data, setData] = useState<HlLeaders | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | null = null
    let tries = 0
    // While the engine warms the board (its first build takes a few seconds), ask again every 10 seconds.
    const load = (): Promise<void> => loadLeaders()
      .then(d => { if (alive) { setData(d); setErr(false) } })
      .catch(() => { if (!alive) return; if (++tries <= 6) retry = setTimeout(() => void load(), 10_000); else setErr(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) { tries = 0; void load() } }, 120_000)
    return () => { alive = false; clearInterval(id); if (retry) clearTimeout(retry) }
  }, [])
  const rows = data ? data.top[w].map(i => data.rows[i]) : null
  return (
    <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
      {!rows ? (
        <div className="fx-empty">{err ? T('The futures leaderboard isn’t available right now.') : T('Loading…')}</div>
      ) : (
        <div className="fx-table-wrap">
          <table className="lb-table hl-lb" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['#', T('Trader'), T('P&L'), T('Return'), T('Volume'), T('Account value')].map((h, i) => <th key={h} style={{ padding: '10px 14px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const [pnl, roi, vlm] = r.w[w]
                return (
                  <tr key={r.a} onClick={() => navigate({ name: 'hl-trader', address: r.a })} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 800, color: i === 0 ? '#facc15' : i === 1 ? '#cbd5e1' : i === 2 ? '#d97706' : 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={{ padding: '9px 14px' }}>
                      <b>{r.n ?? shortAddr(r.a)}</b>
                      {r.n && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--code)' }}>{shortAddr(r.a)}</div>}
                    </td>
                    <td className={pnl >= 0 ? 'fx-up' : 'fx-down'} style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}{usd(pnl)}</td>
                    <td className={roi >= 0 ? 'fx-up' : 'fx-down'} style={{ padding: '9px 14px', textAlign: 'right' }}>{roiText(roi)}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right', color: 'var(--text-muted)' }}>{usd(vlm)}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' }}>{usd(r.v)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="fx-fine" style={{ padding: '10px 14px' }}>
          {T('From Hyperliquid’s own leaderboard of {n} traders, updated every 10 minutes. Ranked by P&L; accounts worth $10K or more.', { n: data.traders.toLocaleString() })}
        </div>
      )}
    </div>
  )
}
