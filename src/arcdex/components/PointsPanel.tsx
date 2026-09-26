import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { currentSeason, getPoints, getPointsOf, getProfiles, season as seasonN, type PointsRow, type Profile, type Season } from '../api/social'
import { shortAddr } from '../lib/identity'
import { t } from '../lib/i18n'
import type { Page } from '../App'

// ARCDEX Points — ARCDEX's own rewards program (fomo has token rewards; we
// start with seasonal points). Earned from real activity only, computed in
// SQL from indexed router trades (arcdex_points): trading volume, 20% of
// referrals' volume, active days and likes from other traders.

export const fmtPts = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : Math.round(n).toLocaleString()
const dateFmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function useSeason(): [Season, (n: number) => void] {
  const [s, setS] = useState<Season>(currentSeason())
  return [s, (n: number) => setS(seasonN(n))]
}

export function SeasonPicker({ s, onPick }: { s: Season; onPick: (n: number) => void }) {
  const cur = currentSeason().n
  const left = Math.max(0, Math.ceil((s.end.getTime() - Date.now()) / 86_400_000))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.76rem' }}>
      <select className="disc-select" value={s.n} onChange={e => onPick(Number(e.target.value))}>
        {Array.from({ length: cur }, (_, i) => cur - i).map(n => <option key={n} value={n}>{t('Season {n}', { n })}</option>)}
      </select>
      <span style={{ color: 'var(--text-muted)' }}>{dateFmt(s.start)} – {dateFmt(s.end)}{s.n === cur ? ` · ${t('{n} days left', { n: left })}` : ` · ${t('ended')}`}</span>
    </div>
  )
}

/** Your points for the season, with the breakdown and how to earn more. */
export function MyPoints({ address, navigate }: { address: string; navigate: (p: Page) => void }) {
  const [s, pick] = useSeason()
  const [mine, setMine] = useState<PointsRow | null | undefined>(undefined)
  const [top, setTop] = useState<PointsRow[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())

  useEffect(() => {
    setMine(undefined)
    void getPointsOf(address, s).then(setMine).catch(() => setMine(null))
    void getPoints(s, 10).then(async r => { setTop(r); setProfiles(await getProfiles(r.map(x => x.trader)).catch(() => new Map())) }).catch(() => setTop([]))
  }, [address, s])

  const row = (label: string, v: number, hint: string) => (
    <div className="reward-row" style={{ padding: '10px 4px' }}>
      <span><b style={{ fontSize: '0.84rem' }}>{label}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</div></span>
      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{fmtPts(v)}</span>
    </div>
  )

  return (
    <div style={{ paddingTop: 12 }}>
      <SeasonPicker s={s} onPick={pick} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 10 }}>
        <Box label={t('Your points')} value={mine === undefined ? '…' : fmtPts(mine?.total ?? 0)} big color="#facc15" />
        <Box label={t('Rank')} value={mine === undefined ? '…' : mine ? `#${mine.rank}` : '—'} />
        <Box label={t('Active days')} value={mine === undefined ? '…' : String(mine?.active_days ?? 0)} />
      </div>
      <div style={{ marginTop: 12 }}>
        {row(t('Trading'), mine?.trade_pts ?? 0, t('1 point for every $1 you trade on ARCDEX'))}
        {row(t('Referrals'), mine?.referral_pts ?? 0, t('20% of the trading points of everyone you invited'))}
        {row(t('Active days'), mine?.day_pts ?? 0, t('10 points for each day you trade $5 or more'))}
        {row(t('Theses'), mine?.social_pts ?? 0, t('2 points per like from other traders (up to 500 a season)'))}
      </div>
      {top.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <b style={{ fontSize: '0.84rem' }}>{t('Top of Season {n}', { n: s.n })}</b>
          {top.map(r => <PointsLine key={r.trader} r={r} p={profiles.get(r.trader)} me={address} navigate={navigate} />)}
        </div>
      )}
      <div style={{ marginTop: 14, fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {t('Points track real activity on ARCDEX and reset every 30-day season. They are not a token and have no cash value; ARCDEX may use them for future rewards, and the rules can change between seasons.')}
      </div>
    </div>
  )
}

/** Season points leaderboard (Leaderboard → Points). */
export function PointsBoard({ me, navigate }: { me: string | null; navigate: (p: Page) => void }) {
  const [s, pick] = useSeason()
  const [rows, setRows] = useState<PointsRow[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  useEffect(() => {
    let alive = true
    setRows(null)
    void getPoints(s, 100).then(async r => {
      if (!alive) return
      setRows(r)
      setProfiles(await getProfiles(r.map(x => x.trader)).catch(() => new Map()))
    }).catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [s])
  const mine = rows?.find(r => r.trader === me)
  return (
    <div style={{ marginTop: 14 }}>
      <SeasonPicker s={s} onPick={pick} />
      {me && rows && (
        <div style={{ marginTop: 10, padding: '10px 16px', borderRadius: 12, background: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.3)', display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem' }}>
          <span>{t('Your points')}</span><b>{mine ? `#${mine.rank} · ${fmtPts(mine.total)}` : t('No points yet — make a trade')}</b>
        </div>
      )}
      <div style={{ marginTop: 10, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
        {rows === null ? <Empty>{t('Loading…')}</Empty> : rows.length === 0 ? <Empty>{t('No points this season yet. Trade on ARCDEX to earn the first ones.')}</Empty> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['#', t('Trader'), t('Points'), t('Trading'), t('Referrals'), t('Days')].map((h, i) => <th key={h} style={{ padding: '10px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const p = profiles.get(r.trader)
                return (
                  <tr key={r.trader} onClick={() => navigate({ name: 'trader', address: r.trader })} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer', background: r.trader === me ? 'rgba(250,204,21,0.07)' : undefined }}>
                    <td style={{ padding: '10px 16px', fontWeight: 800, color: r.rank === 1 ? '#facc15' : r.rank === 2 ? '#cbd5e1' : r.rank === 3 ? '#d97706' : 'var(--text-muted)' }}>{r.rank}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <Avatar address={r.trader} url={p?.avatar_url} size={28} />
                        <b>{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(r.trader))}</b>
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 800, color: '#facc15' }}>{fmtPts(r.total)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtPts(r.trade_pts)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtPts(r.referral_pts)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>{r.active_days}</td>
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

function PointsLine({ r, p, me, navigate }: { r: PointsRow; p?: Profile; me: string; navigate: (p: Page) => void }) {
  return (
    <div className="reward-row" style={{ padding: '8px 4px', background: r.trader === me.toLowerCase() ? 'rgba(250,204,21,0.07)' : undefined }}>
      <button onClick={() => navigate({ name: 'trader', address: r.trader })} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0 }}>
        <span style={{ width: 22, color: 'var(--text-muted)', fontWeight: 700, fontSize: '0.76rem' }}>{r.rank}</span>
        <Avatar address={r.trader} url={p?.avatar_url} size={24} />
        <b style={{ fontSize: '0.8rem' }}>{p?.username ? `@${p.username}` : shortAddr(r.trader)}</b>
      </button>
      <span style={{ fontFamily: 'var(--mono)', color: '#facc15', fontWeight: 700 }}>{fmtPts(r.total)}</span>
    </div>
  )
}

function Box({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: big ? '1.3rem' : '1.1rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.86rem' }}>{children}</div>
}
