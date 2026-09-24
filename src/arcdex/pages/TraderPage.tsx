import { useCallback, useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar'
import ProfileEditor from '../components/ProfileEditor'
import {
  getFollowStats, getFollowing, getProfile, getTheses, getTraderPositions, getTrades, socialWrite, triggerIndex,
  type IndexedTrade, type PositionRow, type Profile, type Thesis,
} from '../api/social'
import { ARC_EXPLORER } from '../api/arcRpc'
import { shortAddr, useTrader } from '../lib/identity'
import { referralLink } from '../lib/referral'
import { useTokenMeta, type TokenMeta } from '../lib/tokenMeta'
import type { Page } from '../App'

// A trader's public page (fomo-style): who they are, how they've done
// trading through ARCDEX, what they hold, what they've said.

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
function ago(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}
const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16 }
const head: React.CSSProperties = { padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', fontWeight: 700, fontSize: '0.85rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }

interface Pos extends PositionRow { meta?: TokenMeta; heldTok: number; valueUsd: number | null; pnl: number | null; pnlPct: number | null; closedPnl: number }

export default function TraderPage({ address, navigate }: { address: string; navigate: (p: Page) => void }) {
  const addr = address.toLowerCase()
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const isMe = me === addr
  const meta = useTokenMeta()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState({ followers: 0, following: 0 })
  const [iFollow, setIFollow] = useState(false)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [trades, setTrades] = useState<IndexedTrade[]>([])
  const [theses, setTheses] = useState<Thesis[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    triggerIndex()
    const [p, s, pos, tr, th] = await Promise.all([
      getProfile(addr).catch(() => null), getFollowStats(addr).catch(() => ({ followers: 0, following: 0 })),
      getTraderPositions(addr).catch(() => []), getTrades({ trader: addr, limit: 50 }).catch(() => []), getTheses({ authors: [addr], limit: 30 }).catch(() => []),
    ])
    setProfile(p); setStats(s); setPositions(pos); setTrades(tr); setTheses(th); setLoading(false)
  }, [addr])
  useEffect(() => { setLoading(true); void load() }, [load])
  useEffect(() => {
    if (!me || isMe) { setIFollow(false); return }
    void getFollowing(me).then(list => setIFollow(list.includes(addr))).catch(() => {})
  }, [me, isMe, addr])

  // Open positions valued at live prices; realized PnL on closed ones.
  const enriched: Pos[] = useMemo(() => positions.map(p => {
    const m = meta.get(p.token)
    const heldFrac = p.bought_tok > 0 ? Math.max(0, 1 - p.sold_tok / p.bought_tok) : 0
    const heldTok = (p.bought_tok - p.sold_tok) / 1e18
    const valueUsd = m && heldTok > 0 ? heldTok * m.priceUsd : heldFrac === 0 ? 0 : null
    const pnl = valueUsd !== null ? valueUsd + p.sold_usdc - p.bought_usdc : null
    const closedPnl = p.bought_tok > 0 ? p.sold_usdc - p.bought_usdc * Math.min(1, p.sold_tok / p.bought_tok) : 0
    return { ...p, meta: m, heldTok, valueUsd, pnl, pnlPct: pnl !== null && p.bought_usdc > 0 ? (pnl / p.bought_usdc) * 100 : null, closedPnl }
  }), [positions, meta])
  const open = enriched.filter(p => p.heldTok > 0 && (p.valueUsd ?? 1) > 0.01)
  const totals = useMemo(() => ({
    volume: enriched.reduce((s, p) => s + p.bought_usdc + p.sold_usdc, 0),
    realized: enriched.reduce((s, p) => s + p.closedPnl, 0),
    openValue: open.reduce((s, p) => s + (p.valueUsd ?? 0), 0),
    trades: enriched.reduce((s, p) => s + p.trades, 0),
  }), [enriched, open])
  const best = [...enriched].filter(p => p.pnl !== null).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5)

  async function toggleFollow() {
    if (!me) { setErr('Connect or unlock a wallet to follow'); return }
    setBusy(true); setErr('')
    try {
      await socialWrite(trader, iFollow ? 'unfollow' : 'follow', { target: addr })
      setIFollow(f => !f)
      setStats(s => ({ ...s, followers: s.followers + (iFollow ? -1 : 1) }))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not update') } finally { setBusy(false) }
  }

  const name = profile?.display_name || (profile?.username ? `@${profile.username}` : shortAddr(addr))
  const openToken = (token: string, m?: TokenMeta) => navigate(m ? { name: 'argus', address: token, pool: m.pool } : { name: 'token', address: token })

  return (
    <div className="token-page">
      <button className="back-btn" onClick={() => navigate({ name: 'leaderboard' })}>← Leaderboard</button>

      <div style={{ ...card, padding: 18, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Avatar address={addr} url={profile?.avatar_url} size={72} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{name}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
            {profile?.username && profile.display_name && <span>@{profile.username}</span>}
            <a href={`${ARC_EXPLORER}/address/${addr}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{shortAddr(addr)} ↗</a>
            {profile?.x_handle && <a href={`https://x.com/${profile.x_handle}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)' }}>𝕏 @{profile.x_handle}</a>}
          </div>
          {profile?.bio && <div style={{ fontSize: '0.86rem', marginTop: 8 }}>{profile.bio}</div>}
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '0.8rem' }}>
            <span><b>{stats.followers}</b> <span style={{ color: 'var(--text-muted)' }}>followers</span></span>
            <span><b>{stats.following}</b> <span style={{ color: 'var(--text-muted)' }}>following</span></span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isMe ? (
            <>
              <button onClick={() => setEditing(true)} style={btn('var(--bg-2)')}>Edit profile</button>
              <button onClick={() => { void navigator.clipboard?.writeText(referralLink(addr, profile)); setCopied(true) }} style={btn('var(--adx-accent)')}>{copied ? 'Link copied ✓' : 'Copy invite link'}</button>
            </>
          ) : (
            <button onClick={() => void toggleFollow()} disabled={busy} style={btn(iFollow ? 'var(--bg-2)' : 'var(--adx-accent)')}>{iFollow ? 'Following' : 'Follow'}</button>
          )}
        </div>
        {err && <div style={{ width: '100%', fontSize: '0.78rem', color: '#fca5a5' }}>{err}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 16 }}>
        <Stat label="Realized PnL" value={money(totals.realized)} color={totals.realized >= 0 ? 'var(--green)' : 'var(--red)'} />
        <Stat label="Open positions" value={money(totals.openValue)} />
        <Stat label="Volume on ARCDEX" value={money(totals.volume)} />
        <Stat label="Trades" value={String(totals.trades)} />
      </div>

      {best.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 16, overflowX: 'auto', paddingBottom: 4 }}>
          {best.map((p, i) => (
            <button key={p.token} onClick={() => openToken(p.token, p.meta)} style={{ ...card, marginTop: 0, padding: '10px 14px', minWidth: 170, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
              <div style={{ fontSize: '0.66rem', color: i === 0 ? '#facc15' : 'var(--text-muted)', fontWeight: 700 }}>#{i + 1} TRADE</div>
              <div style={{ fontWeight: 700, margin: '2px 0' }}>${p.meta?.symbol ?? shortAddr(p.token)}</div>
              <div style={{ fontFamily: 'var(--mono)', color: (p.pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '0.84rem' }}>
                {(p.pnl ?? 0) >= 0 ? '+' : ''}{money(p.pnl ?? 0)}{p.pnlPct !== null ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(0)}%)` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="token-detail-grid">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={card}>
            <div style={head}><span>Positions</span><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>trades through ARCDEX</span></div>
            {loading ? <Empty>Loading…</Empty> : open.length === 0 ? <Empty>{isMe ? 'No open positions yet — buy a coin to see it here.' : 'No open positions traded through ARCDEX.'}</Empty> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <tbody>
                  {open.map(p => (
                    <tr key={p.token} onClick={() => openToken(p.token, p.meta)} style={{ borderBottom: '1px solid var(--adx-card-border)', cursor: 'pointer' }}>
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          {p.meta?.image ? <img src={p.meta.image} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} /> : <Avatar address={p.token} size={28} />}
                          <div><b>${p.meta?.symbol ?? shortAddr(p.token)}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>invested {money(p.bought_usdc)}</div></div>
                        </div>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                        <div>{p.valueUsd !== null ? money(p.valueUsd) : '—'}</div>
                        {p.pnl !== null && <div style={{ fontSize: '0.72rem', color: p.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{p.pnl >= 0 ? '+' : ''}{money(p.pnl)}{p.pnlPct !== null ? ` · ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%` : ''}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={card}>
            <div style={head}>Recent trades</div>
            {trades.length === 0 ? <Empty>No trades through ARCDEX yet.</Empty> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                <tbody>
                  {trades.map(t => {
                    const m = meta.get(t.token)
                    return (
                      <tr key={t.tx_hash + t.log_index} style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
                        <td style={{ padding: '8px 16px', color: t.side === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t.side.toUpperCase()}</td>
                        <td style={{ padding: '8px 16px' }}><button onClick={() => openToken(t.token, m)} style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, fontWeight: 600 }}>${m?.symbol ?? shortAddr(t.token)}</button></td>
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
          <div style={card}>
            <div style={head}>Theses</div>
            {theses.length === 0 ? <Empty>No theses yet.</Empty> : theses.map(t => {
              const m = meta.get(t.token)
              return (
                <div key={t.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                    <button onClick={() => openToken(t.token, m)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontWeight: 700 }}>${m?.symbol ?? shortAddr(t.token)}</button>
                    <span>{ago(t.created_at)} · ♥ {t.likes}</span>
                  </div>
                  <div style={{ fontSize: '0.84rem', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.body}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {editing && <ProfileEditor trader={trader} profile={profile} onSaved={setProfile} onClose={() => setEditing(false)} />}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{children}</div>
}

function btn(bg: string): React.CSSProperties {
  return { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }
}
