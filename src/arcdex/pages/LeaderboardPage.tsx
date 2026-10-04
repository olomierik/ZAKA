import { useEffect, useState } from 'react'
import Avatar from '../components/Avatar'
import { getClanLeaderboard, getLeaderboard, getProfile, getProfiles, triggerIndex, type ClanRank, type LeaderRow, type Period, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { referralLink } from '../lib/referral'
import { tweetUrl } from '../lib/shareCard'
import { PointsBoard } from '../components/PointsPanel'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Top traders on ARCDEX by realized PnL — the competition that keeps
// traders coming back (and trading through our router).

const money = (n: number) => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
const plain = (n: number) => `$${n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`

export default function LeaderboardPage({ navigate }: { navigate: (p: Page) => void }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const [period, setPeriod] = useState<Period>('7d')
  const [rows, setRows] = useState<LeaderRow[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [kind, setKind] = useState<'traders' | 'clans' | 'points'>('traders')
  const [clans, setClans] = useState<ClanRank[] | null>(null)

  useEffect(() => {
    if (kind !== 'clans') return
    let alive = true
    setClans(null)
    void getClanLeaderboard(period, 100).then(c => { if (alive) setClans(c) }).catch(() => { if (alive) setClans([]) })
    return () => { alive = false }
  }, [kind, period])

  async function shareRank(rank: number, pnl: number) {
    if (!me) return
    const p = await getProfile(me).catch(() => null)
    const label = { '24h': 'today', '7d': 'this week', '30d': 'this month', all: 'all time' }[period]
    window.open(tweetUrl(`I'm #${rank} on the ARCDEX leaderboard ${label} (${money(pnl)}) trading Arc memecoins ⚡ Come beat me:`, referralLink(me, p)), '_blank', 'noopener')
  }

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
    <div className="token-page content-page" style={{ '--page-w': '980px' } as React.CSSProperties}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
            {(['traders', 'clans', 'points'] as const).map(k => (
              <button key={k} onClick={() => setKind(k)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: kind === k ? '1.4rem' : '1.05rem', fontWeight: 800, color: kind === k ? 'var(--text)' : 'var(--text-muted)' }}>{k === 'traders' ? T("Traders") : k === 'clans' ? T("Clans") : T("★ Points")}</button>
            ))}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>{T("Realized profit from trades made on ARCDEX. Trade here to climb it.")}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>{tab('24h', '24H')}{tab('7d', '7D')}{tab('30d', '30D')}{tab('all', T('All'))}</div>
      </div>

      {kind === 'clans' && <ClanBoard clans={clans} navigate={navigate} />}
      {kind === 'points' && <PointsBoard me={me} navigate={navigate} />}

      {kind === 'traders' && me && rows && (
        <div style={{ marginTop: 14, padding: '10px 16px', borderRadius: 12, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: '0.84rem' }}>
          <span>{T("Your rank")}</span>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <b>{myRank >= 0 ? `#${myRank + 1} · ${money(rows[myRank].realized_pnl)}` : T("Not ranked yet — make a trade")}</b>
            {myRank >= 0 && <button onClick={() => void shareRank(myRank + 1, rows[myRank].realized_pnl)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--adx-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.74rem' }}>{T("Share")}</button>}
          </span>
        </div>
      )}

      {kind === 'traders' && <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
        {rows === null ? <Empty>{T("Loading…")}</Empty> : rows.length === 0 ? <Empty>{T("No trades in this period yet. The first trader to take profit on ARCDEX tops this board.")}</Empty> : (
          <table className="lb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['#', T('Trader'), T('Realized PnL'), T('Volume'), T('Trades')].map((h, i) => <th key={h} style={{ padding: '10px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}
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
      </div>}
    </div>
  )
}

function ClanBoard({ clans, navigate }: { clans: ClanRank[] | null; navigate: (p: Page) => void }) {
  return (
    <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
      {clans === null ? <Empty>{T("Loading…")}</Empty> : clans.length === 0 ? (
        <Empty>{T("No clans yet.")}{' '}<button onClick={() => navigate({ name: 'clans' })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.86rem' }}>{T("Start one")}</button>{' '}{T("and trade together.")}</Empty>
      ) : (
        <table className="lb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
            {['#', T('Clan'), T('Members'), T('Clan profit'), T('Volume')].map((h, i) => <th key={h} style={{ padding: '10px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {clans.map((c, i) => (
              <tr key={c.clan_id} onClick={() => navigate({ name: 'clan', slug: c.slug })} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer' }}>
                <td style={{ padding: '10px 16px', fontWeight: 800, color: i === 0 ? '#facc15' : i === 1 ? '#cbd5e1' : i === 2 ? '#d97706' : 'var(--text-muted)' }}>{i + 1}</td>
                <td style={{ padding: '10px 16px' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover' }} /> : <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--bg-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>⚑</span>}
                    <b>{c.name}</b>
                  </div>
                </td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{c.members}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, color: c.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(c.realized_pnl)}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{plain(c.volume_usdc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.86rem' }}>{children}</div>
}
