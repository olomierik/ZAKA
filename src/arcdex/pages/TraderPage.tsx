import { useCallback, useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar'
import ProfileEditor from '../components/ProfileEditor'
import PnlChart from '../components/PnlChart'
import { DepositModal, SendCashModal, WithdrawModal } from '../components/CashModals'
import {
  getClanOf, getFollowStats, getFollowing, getMutuals, getPnlHistory, getProfile, getProfileByUsername, getProfiles, getTheses,
  getTraderPositions, getTraderStats, getTrades, socialWrite, triggerIndex, currentSeason, getPointsOf,
  type Clan, type PointsRow, type IndexedTrade, type Period, type PnlPoint, type PositionRow, type Profile, type Thesis, type TraderStats,
} from '../api/social'
import { ARC_EXPLORER } from '../api/arcRpc'
import { shortAddr, useTrader } from '../lib/identity'
import { referralLink } from '../lib/referral'
import { tweetUrl } from '../lib/shareCard'
import { useCash } from '../lib/usdc'
import { useTokenMeta, type TokenMeta } from '../lib/tokenMeta'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// A trader's public page (fomo parity): banner, identity, mutuals, clan,
// avg hold / trades / joined, top trades, PnL chart by window, cash with
// Deposit/Withdraw (own page) or Send cash (others), positions
// (Open/Closed, sort, dust), pinned most-liked thesis, and swaps
// (All/Buys/Sells).

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`
function ago(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}
const dur = (sec: number) => sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}m` : sec < 172800 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`
const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16 }
const head: React.CSSProperties = { padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', fontWeight: 700, fontSize: '0.85rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const PERIODS: { k: Period; label: string; ms: number }[] = [
  { k: '24h', label: '24H', ms: 86_400_000 }, { k: '7d', label: '7D', ms: 7 * 86_400_000 }, { k: '30d', label: '30D', ms: 30 * 86_400_000 }, { k: 'all', label: 'All', ms: 0 },
]

interface Pos extends PositionRow { meta?: TokenMeta; heldTok: number; valueUsd: number | null; pnl: number | null; pnlPct: number | null; closedPnl: number }

export default function TraderPage({ address, navigate }: { address: string; navigate: (p: Page) => void }) {
  // /profile/<username> as well as /profile/<0x…>.
  const [resolved, setResolved] = useState<string | null>(/^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) { setResolved(address.toLowerCase()); return }
    void getProfileByUsername(address).then(p => { if (p) setResolved(p.address.toLowerCase()); else setMissing(true) }).catch(() => setMissing(true))
  }, [address])

  if (!resolved) return (
    <div className="token-page" style={{ padding: 24, color: 'var(--text-muted)' }}>
      {missing ? <>{T("No trader called @")}{address}. <button className="disc-link" onClick={() => navigate({ name: 'leaderboard' })}>{T("See the leaderboard")}</button></> : T("Loading…")}
    </div>
  )
  return <Profile_ addr={resolved} navigate={navigate} />
}

function Profile_({ addr, navigate }: { addr: string; navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const isMe = me === addr
  const meta = useTokenMeta()
  const { cash, refresh: refreshCash } = useCash(isMe ? addr : null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState({ followers: 0, following: 0 })
  const [iFollow, setIFollow] = useState(false)
  const [mutuals, setMutuals] = useState<Profile[]>([])
  const [clan, setClan] = useState<Clan | null>(null)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [trades, setTrades] = useState<IndexedTrade[]>([])
  const [theses, setTheses] = useState<Thesis[]>([])
  const [pnl, setPnl] = useState<PnlPoint[]>([])
  const [period, setPeriod] = useState<Period>('7d')
  const [pstats, setPstats] = useState<TraderStats | null>(null)
  const [allStats, setAllStats] = useState<TraderStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'edit' | 'deposit' | 'withdraw' | 'send' | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState<'' | 'invite' | 'profile'>('')
  const [posTab, setPosTab] = useState<'open' | 'closed'>('open')
  const [sort, setSort] = useState<'recent' | 'value' | 'pnl'>('recent')
  const [dust, setDust] = useState(false)
  const [swapTab, setSwapTab] = useState<'all' | 'buy' | 'sell'>('all')
  const [points, setPoints] = useState<PointsRow | null>(null)
  const seasonNow = currentSeason()
  useEffect(() => { void getPointsOf(addr, currentSeason()).then(setPoints).catch(() => setPoints(null)) }, [addr])

  const load = useCallback(async () => {
    triggerIndex()
    const [p, s, pos, tr, th, h, all, c] = await Promise.all([
      getProfile(addr).catch(() => null), getFollowStats(addr).catch(() => ({ followers: 0, following: 0 })),
      getTraderPositions(addr).catch(() => []), getTrades({ trader: addr, limit: 100 }).catch(() => []),
      getTheses({ authors: [addr], limit: 50 }).catch(() => []), getPnlHistory(addr).catch(() => []),
      getTraderStats(addr, 'all').catch(() => null), getClanOf(addr).catch(() => null),
    ])
    setProfile(p); setStats(s); setPositions(pos); setTrades(tr); setTheses(th); setPnl(h); setAllStats(all); setClan(c?.clan ?? null); setLoading(false)
  }, [addr])
  useEffect(() => { setLoading(true); void load() }, [load])
  useEffect(() => { void getTraderStats(addr, period).then(setPstats).catch(() => setPstats(null)) }, [addr, period])
  useEffect(() => {
    if (!me || isMe) { setIFollow(false); setMutuals([]); return }
    void getFollowing(me).then(list => setIFollow(list.includes(addr))).catch(() => {})
    void getMutuals(me, addr).then(async m => {
      if (!m.length) { setMutuals([]); return }
      const found = await getProfiles(m.slice(0, 20))
      setMutuals(m.map(a => found.get(a) ?? { address: a, username: null, display_name: null, avatar_url: null, bio: null, x_handle: null }))
    }).catch(() => {})
  }, [me, isMe, addr])

  // Positions valued at live prices; realized PnL on what's been sold.
  const enriched: Pos[] = useMemo(() => positions.map(p => {
    const m = meta.get(p.token)
    const heldTok = Math.max(0, (p.bought_tok - p.sold_tok) / 1e18)
    const valueUsd = m && heldTok > 0 ? heldTok * m.priceUsd : heldTok === 0 ? 0 : null
    const pnl = valueUsd !== null ? valueUsd + p.sold_usdc - p.bought_usdc : null
    const closedPnl = p.bought_tok > 0 ? p.sold_usdc - p.bought_usdc * Math.min(1, p.sold_tok / p.bought_tok) : 0
    return { ...p, meta: m, heldTok, valueUsd, pnl, pnlPct: pnl !== null && p.bought_usdc > 0 ? (pnl / p.bought_usdc) * 100 : null, closedPnl }
  }), [positions, meta])
  const isOpen = (p: Pos) => p.heldTok > 0 && (p.valueUsd === null || p.valueUsd >= (dust ? 0 : 1))
  const isClosed = (p: Pos) => p.heldTok === 0 || (p.valueUsd !== null && p.valueUsd < 0.01)
  const open = enriched.filter(isOpen)
  const shownPos = useMemo(() => {
    const list = enriched.filter(posTab === 'open' ? isOpen : isClosed)
    const key = (p: Pos) => sort === 'recent' ? Date.parse(p.last_trade) : sort === 'value' ? (p.valueUsd ?? 0) : (posTab === 'open' ? (p.pnl ?? 0) : p.closedPnl)
    return [...list].sort((a, b) => key(b) - key(a))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched, posTab, sort, dust])
  const openValue = open.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
  const best = [...enriched].filter(p => p.pnl !== null && p.bought_usdc > 0).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5)
  const pinned = useMemo(() => [...theses].sort((a, b) => b.likes - a.likes)[0] ?? null, [theses])
  const swaps = trades.filter(t => swapTab === 'all' || t.side === swapTab)
  const since = PERIODS.find(p => p.k === period)!
  const sinceMs = since.ms ? Date.now() - since.ms : 0

  async function toggleFollow() {
    if (!me) { setErr(T("Connect or unlock a wallet to follow")); return }
    setBusy(true); setErr('')
    try {
      await socialWrite(trader, iFollow ? 'unfollow' : 'follow', { target: addr })
      setIFollow(f => !f)
      setStats(s => ({ ...s, followers: s.followers + (iFollow ? -1 : 1) }))
    } catch (e) { setErr(e instanceof Error ? e.message : T("Could not update")) } finally { setBusy(false) }
  }

  const name = profile?.display_name || (profile?.username ? `@${profile.username}` : shortAddr(addr))
  const profileUrl = `https://arcdex.online/profile/${profile?.username ?? addr}`
  const openToken = (token: string, m?: TokenMeta) => navigate(m?.pool ? { name: 'argus', address: token, pool: m.pool } : { name: 'argus', address: token, pool: '' })
  const joined = profile?.created_at ?? allStats?.first_trade ?? null
  const mutualName = (p: Profile) => p.username ? `@${p.username}` : shortAddr(p.address)

  return (
    <div className="token-page">
      <div className="profile-banner" style={profile?.banner_url && /^https:\/\//.test(profile.banner_url) ? { backgroundImage: `url("${profile.banner_url.replace(/"/g, '')}")` } : undefined}>
        <button className="back-btn" onClick={() => history.length > 1 ? history.back() : navigate({ name: 'leaderboard' })}>{T("← Back")}</button>
      </div>

      <div style={{ padding: '0 16px' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: -36 }}>
          <div style={{ borderRadius: '50%', border: '4px solid var(--adx-bg)', background: 'var(--adx-bg)' }}><Avatar address={addr} url={profile?.avatar_url} size={84} /></div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 4 }}>
            <button onClick={() => { void navigator.clipboard?.writeText(profileUrl); setCopied('profile'); setTimeout(() => setCopied(''), 1500) }} style={btn('var(--bg-2)')}>{copied === 'profile' ? T("Copied ✓") : T("Share")}</button>
            <a href={tweetUrl(`Check out ${name} on ARCDEX — trading Arc memecoins`, profileUrl)} target="_blank" rel="noopener noreferrer" style={{ ...btn('var(--bg-2)'), textDecoration: 'none' }}>𝕏</a>
            {isMe ? (
              <>
                <button onClick={() => setModal('edit')} style={btn('var(--bg-2)')}>{T("Edit profile")}</button>
                <button onClick={() => { void navigator.clipboard?.writeText(referralLink(addr, profile)); setCopied('invite'); setTimeout(() => setCopied(''), 1500) }} style={btn('var(--adx-accent)')}>{copied === 'invite' ? T("Link copied ✓") : T("Copy invite link")}</button>
              </>
            ) : (
              <>
                <button onClick={() => me ? setModal('send') : setErr(T("Connect or unlock a wallet to send cash"))} style={btn('var(--bg-2)')}>{T("Send cash")}</button>
                <button onClick={() => void toggleFollow()} disabled={busy} style={btn(iFollow ? 'var(--bg-2)' : 'var(--adx-accent)')}>{iFollow ? T("Following") : T("Follow")}</button>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: '1.35rem', fontWeight: 800, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {name}
            {clan && <button onClick={() => navigate({ name: 'clan', slug: clan.slug })} className="clan-badge">⚑ {clan.name}</button>}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
            {profile?.username && profile.display_name && <span>@{profile.username}</span>}
            <a href={`${ARC_EXPLORER}/address/${addr}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{shortAddr(addr)} ↗</a>
            {profile?.x_handle && <a href={`https://x.com/${profile.x_handle}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)' }}>𝕏 @{profile.x_handle}</a>}
          </div>
          {profile?.bio && <div style={{ fontSize: '0.88rem', marginTop: 8, whiteSpace: 'pre-wrap' }}>{profile.bio}</div>}
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '0.8rem', flexWrap: 'wrap' }}>
            <span><b>{stats.following}</b> <span style={{ color: 'var(--text-muted)' }}>{T("following")}</span></span>
            <span><b>{stats.followers}</b> <span style={{ color: 'var(--text-muted)' }}>{T("followers")}</span></span>
            {allStats?.avg_hold_seconds != null && <span><span style={{ color: 'var(--text-muted)' }}>{T("Avg hold")}</span> <b>{dur(allStats.avg_hold_seconds)}</b></span>}
            <span><b>{allStats?.trades ?? 0}</b> <span style={{ color: 'var(--text-muted)' }}>{T("trades")}</span></span>
            {joined && <span><span style={{ color: 'var(--text-muted)' }}>{T("Joined")}</span> <b>{new Date(joined).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</b></span>}
          </div>
          {mutuals.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex' }}>{mutuals.slice(0, 3).map((m, i) => <span key={m.address} style={{ marginLeft: i ? -6 : 0 }}><Avatar address={m.address} url={m.avatar_url} size={18} /></span>)}</span>{T("Followed by")}{' '}{mutuals.slice(0, 2).map(mutualName).join(', ')}{mutuals.length > 2 ? ' ' + T(mutuals.length > 3 ? 'and {n} others you follow' : 'and {n} other you follow', { n: mutuals.length - 2 }) : ''}
            </div>
          )}
          {err && <div style={{ fontSize: '0.78rem', color: '#fca5a5', marginTop: 6 }}>{err}</div>}
        </div>

        {best.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginTop: 16, overflowX: 'auto', paddingBottom: 4 }}>
            {best.map((p, i) => (
              <button key={p.token} onClick={() => openToken(p.token, p.meta)} style={{ ...card, marginTop: 0, padding: '10px 14px', minWidth: 170, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
                <div style={{ fontSize: '0.66rem', color: i === 0 ? '#facc15' : 'var(--text-muted)', fontWeight: 700 }}>#{i + 1}{' '}{T("TRADE")}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
                  {p.meta?.image ? <img src={p.meta.image} alt="" style={{ width: 18, height: 18, borderRadius: '50%' }} /> : null}
                  <b>${p.meta?.symbol ?? shortAddr(p.token)}</b>
                </div>
                <div style={{ fontFamily: 'var(--mono)', color: (p.pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '0.84rem' }}>
                  {signed(p.pnl ?? 0)}{p.pnlPct !== null ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(0)}%)` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="token-detail-grid" style={{ marginTop: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: '0.85rem' }}>{T("PnL")}</b>
              <div style={{ display: 'flex', gap: 4 }}>
                {PERIODS.map(p => <button key={p.k} onClick={() => setPeriod(p.k)} className={`disc-sub${period === p.k ? ' active' : ''}`}>{T(p.label)}</button>)}
              </div>
            </div>
            <PnlChart points={pnl} sinceMs={sinceMs} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginTop: 12 }}>
              <Stat label={T('Realized · {period}', { period: T(since.label) })} value={pstats ? signed(pstats.realized_pnl) : '…'} color={(pstats?.realized_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'} />
              <Stat label={T('Volume · {period}', { period: T(since.label) })} value={pstats ? money(pstats.volume_usdc) : '…'} />
              <Stat label={T("Open positions")} value={<span className="sensitive">{money(openValue)}</span>} />
              <Stat label={T('Season {n} points', { n: seasonNow.n })} value={points ? `${Math.round(points.total).toLocaleString()} · #${points.rank}` : '0'} color="#facc15" />
              {isMe && <Stat label={T("Cash")} value={<span className="sensitive">{cash == null ? '…' : money(cash)}</span>} />}
            </div>
            {isMe && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => setModal('deposit')} style={{ ...btn('var(--adx-accent)'), flex: 1 }}>{T("Deposit")}</button>
                <button onClick={() => setModal('withdraw')} style={{ ...btn('var(--bg-2)'), flex: 1 }}>{T("Withdraw")}</button>
              </div>
            )}
          </div>

          <div style={card}>
            <div style={head}>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['open', 'closed'] as const).map(t => <button key={t} onClick={() => setPosTab(t)} className={`disc-sub${posTab === t ? ' active' : ''}`}>{t === 'open' ? T('Open ({n})', { n: open.length }) : T("Closed")}</button>)}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.72rem', fontWeight: 500 }}>
                {posTab === 'open' && <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-muted)', cursor: 'pointer' }}><input type="checkbox" checked={dust} onChange={e => setDust(e.target.checked)} />{' '}{T("Show dust")}</label>}
                <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} className="disc-select">
                  <option value="recent">{T("Recent")}</option><option value="value">{T("Value")}</option><option value="pnl">{T("PnL")}</option>
                </select>
              </div>
            </div>
            {loading ? <Empty>{T("Loading…")}</Empty> : shownPos.length === 0 ? <Empty>{posTab === 'open' ? (isMe ? T("No open positions yet — buy a coin to see it here.") : T("No open positions traded through ARCDEX.")) : T("No closed positions yet.")}</Empty> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <tbody>
                  {shownPos.map(p => {
                    const v = posTab === 'open' ? p.pnl : p.closedPnl
                    const pct = posTab === 'open' ? p.pnlPct : p.bought_usdc > 0 ? (p.closedPnl / p.bought_usdc) * 100 : null
                    return (
                      <tr key={p.token} onClick={() => openToken(p.token, p.meta)} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer' }}>
                        <td style={{ padding: '10px 16px' }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                            {p.meta?.image ? <img src={p.meta.image} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} /> : <Avatar address={p.token} size={28} />}
                            <div><b>${p.meta?.symbol ?? shortAddr(p.token)}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("invested")}{' '}<span className="sensitive">{money(p.bought_usdc)}</span> · {ago(p.last_trade)}</div></div>
                          </div>
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                          <div className="sensitive">{posTab === 'open' ? (p.valueUsd !== null ? money(p.valueUsd) : '—') : `sold ${money(p.sold_usdc)}`}</div>
                          {v !== null && <div style={{ fontSize: '0.72rem', color: v >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(v)}{pct !== null ? ` · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}</div>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div style={card}>
            <div style={head}>
              <span>{T("Swaps")}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['all', 'buy', 'sell'] as const).map(t => <button key={t} onClick={() => setSwapTab(t)} className={`disc-sub${swapTab === t ? ' active' : ''}`}>{t === 'all' ? T("All swaps") : t === 'buy' ? T("Buys") : T("Sells")}</button>)}
              </div>
            </div>
            {swaps.length === 0 ? <Empty>{T("No")}{' '}{swapTab === 'all' ? T("trades") : swapTab + 's'}{' '}{T("through ARCDEX yet.")}</Empty> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                <tbody>
                  {swaps.map(t => {
                    const m = meta.get(t.token)
                    return (
                      <tr key={t.tx_hash + t.log_index} style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
                        <td style={{ padding: '8px 16px', color: t.side === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t.side === 'buy' ? T("Buy") : T("Sell")}</td>
                        <td style={{ padding: '8px 16px' }}><button onClick={() => openToken(t.token, m)} style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, fontWeight: 600, display: 'inline-flex', gap: 6, alignItems: 'center' }}>{m?.image && <img src={m.image} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} />}${m?.symbol ?? shortAddr(t.token)}</button></td>
                        <td style={{ padding: '8px 16px', fontFamily: 'var(--mono)' }}>{money(t.usdc)}</td>
                        <td style={{ padding: '8px 16px', color: 'var(--text-muted)' }}>{ago(t.block_time)}</td>
                        <td style={{ padding: '8px 16px' }}><a href={`${ARC_EXPLORER}/tx/${t.tx_hash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)' }}>↗</a></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="token-detail-swap">
          {pinned && pinned.likes > 0 && (
            <div style={{ ...card, border: '1px solid rgba(250,204,21,0.35)' }}>
              <div style={head}><span>{T("📌 Pinned thesis")}</span><span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>♥ {pinned.likes}</span></div>
              <ThesisItem t={pinned} meta={meta} openToken={openToken} />
            </div>
          )}
          <div style={card}>
            <div style={head}>{T("Theses")}{' '}<span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>{theses.length}</span></div>
            {theses.length === 0 ? <Empty>{T("No theses yet.")}</Empty> : theses.map(t => <ThesisItem key={t.id} t={t} meta={meta} openToken={openToken} />)}
          </div>
        </div>
      </div>

      {modal === 'edit' && <ProfileEditor trader={trader} profile={profile} onSaved={setProfile} onClose={() => setModal(null)} />}
      {modal === 'deposit' && <DepositModal trader={trader} navigate={navigate} onClose={() => { setModal(null); refreshCash() }} />}
      {modal === 'withdraw' && <WithdrawModal trader={trader} onClose={() => { setModal(null); refreshCash() }} />}
      {modal === 'send' && <SendCashModal trader={trader} to={addr} toName={name} onClose={() => setModal(null)} />}
    </div>
  )
}

function ThesisItem({ t, meta, openToken }: { t: Thesis; meta: Map<string, TokenMeta>; openToken: (token: string, m?: TokenMeta) => void }) {
  const m = meta.get(t.token)
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
        <button onClick={() => openToken(t.token, m)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontWeight: 700 }}>${m?.symbol ?? shortAddr(t.token)}</button>
        <span>{ago(t.created_at)} · ♥ {t.likes}</span>
      </div>
      <div style={{ fontSize: '0.84rem', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.body}</div>
      {t.position_usd != null && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4 }}>{T("Position when posted:")}{' '}{money(t.position_usd)}</div>}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{children}</div>
}

function btn(bg: string): React.CSSProperties {
  return { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }
}
