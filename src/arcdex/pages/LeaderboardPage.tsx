import { useEffect, useState } from 'react'
import Avatar from '../components/Avatar'
import { getLeaderboard, getProfiles, triggerIndex, type LeaderRow, type Period, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import type { Page } from '../App'

// Top traders on ARCDEX by realized PnL — the competition that keeps
// traders coming back (and trading through our router).

const money = (n: number) => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
const plain = (n: number) => `$${n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`

export default function LeaderboardPage({ navigate }: { navigate: (p: Page) => void }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const [period, setPeriod] = useState<Period>('7d')
  const [rows, setRows] = useState<LeaderRow[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())

  useEffect(() => {
    let alive = true
    setRows(null)
    triggerIndex()
    const load = async () => {
      const r = await getLeaderboard(period, 100).catch(() => [])
      if (!alive) return
      setRows(r)
      setProfiles(await getProfiles(r.map(x => x.trader)).catch(() => new Map()))
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [period])

  const myRank = rows && me ? rows.findIndex(r => r.trader === me) : -1
  const tab = (p: Period, label: string) => (
    <button onClick={() => setPeriod(p)} style={{ padding: '5px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', border: '1px solid var(--adx-card-border)', background: period === p ? 'var(--adx-accent)' : 'transparent', color: period === p ? '#fff' : 'var(--text-muted)' }}>{label}</button>
  )

  return (
    <div className="token-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Leaderboard</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Realized profit from trades made on ARCDEX. Trade here to climb it.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>{tab('24h', '24H')}{tab('7d', '7D')}{tab('30d', '30D')}{tab('all', 'All')}</div>
      </div>

      {me && rows && (
        <div style={{ marginTop: 14, padding: '10px 16px', borderRadius: 12, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem' }}>
          <span>Your rank</span>
          <b>{myRank >= 0 ? `#${myRank + 1} · ${money(rows[myRank].realized_pnl)}` : 'Not ranked yet — make a trade'}</b>
        </div>
      )}

      <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
        {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No trades in this period yet. The first trader to take profit on ARCDEX tops this board.</Empty> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['#', 'Trader', 'Realized PnL', 'Volume', 'Trades'].map((h, i) => <th key={h} style={{ padding: '10px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const p = profiles.get(r.trader)
                return (
                  <tr key={r.trader} onClick={() => navigate({ name: 'trader', address: r.trader })} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer', background: r.trader === me ? 'rgba(250,204,21,0.07)' : undefined }}>
                    <td style={{ padding: '10px 16px', fontWeight: 800, color: i === 0 ? '#facc15' : i === 1 ? '#cbd5e1' : i === 2 ? '#d97706' : 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <Avatar address={r.trader} url={p?.avatar_url} size={30} />
                        <div>
                          <div style={{ fontWeight: 700 }}>{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(r.trader))}</div>
                          {p?.username && p.display_name && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>@{p.username}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, color: r.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(r.realized_pnl)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{plain(r.volume_usdc)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>{r.trades}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.86rem' }}>{children}</div>
}
