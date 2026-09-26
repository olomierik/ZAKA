import { useCallback, useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar'
import TraderHover from '../components/TraderHover'
import { ClanEditor } from './ClansPage'
import {
  getClan, getClanHoldings, getClanMembers, getClanOf, getFollowing, getProfiles, getTheses, getTrades, socialWrite, triggerIndex,
  type Clan, type ClanHolding, type ClanMember, type IndexedTrade, type Period, type Profile, type Thesis,
} from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { useTokenMeta } from '../lib/tokenMeta'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const money = (n: number) => `$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n < 0 ? '-' : '+'}${money(n)}`
const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12 }

export default function ClanPage({ slug, navigate }: { slug: string; navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const meta = useTokenMeta()
  const [clan, setClan] = useState<Clan | null | undefined>(undefined)
  const [period, setPeriod] = useState<Period>('24h')
  const [members, setMembers] = useState<ClanMember[]>([])
  const [holdings, setHoldings] = useState<ClanHolding[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [myClan, setMyClan] = useState<{ clan: Clan; role: string } | null>(null)
  const [tab, setTab] = useState<'members' | 'feed' | 'thesis'>('members')
  const [theses, setTheses] = useState<Thesis[]>([])
  const [trades, setTrades] = useState<IndexedTrade[]>([])
  const [following, setFollowing] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    triggerIndex()
    const c = await getClan(slug).catch(() => null)
    setClan(c)
    if (!c) return
    const [m, h] = await Promise.all([getClanMembers(c.id, period).catch(() => []), getClanHoldings(c.id).catch(() => [])])
    setMembers(m); setHoldings(h)
    const addrs = m.map(x => x.member)
    setProfiles(await getProfiles([...addrs, ...h.flatMap(x => x.holders)]).catch(() => new Map()))
    const [th, tr] = await Promise.all([getTheses({ authors: addrs, limit: 40 }).catch(() => []), getTrades({ traders: addrs, limit: 40 }).catch(() => [])])
    setTheses(th); setTrades(tr)
  }, [slug, period])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (me) { void getClanOf(me).then(setMyClan).catch(() => {}); void getFollowing(me).then(f => setFollowing(new Set(f))).catch(() => {}) } }, [me, clan?.id])

  const priced = useMemo(() => holdings.map(h => {
    const m = meta.get(h.token)
    const held = (h.bought_tok - h.sold_tok) / 1e18
    const value = m ? held * m.priceUsd : null
    const pnl = value !== null ? value + h.sold_usdc - h.bought_usdc : null
    return { ...h, m, held, value, pnl, pct: pnl !== null && h.bought_usdc > 0 ? (pnl / h.bought_usdc) * 100 : null }
  }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)), [holdings, meta])
  const profit = members.reduce((s, m) => s + m.realized_pnl, 0)
  const top3 = [...priced].filter(p => p.pnl !== null).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 3)
  const inThis = myClan?.clan.id === clan?.id
  const isOwner = inThis && myClan?.role === 'owner'

  async function act(action: 'clan.join' | 'clan.leave') {
    setBusy(true); setMsg('')
    try { await socialWrite(trader, action, action === 'clan.join' ? { clan_id: clan!.id } : {}); await load(); if (me) setMyClan(await getClanOf(me)) }
    catch (e) { setMsg(e instanceof Error ? e.message : T("Failed")) } finally { setBusy(false) }
  }
  async function followAll() {
    setBusy(true)
    for (const m of members) if (m.member !== me && !following.has(m.member)) await socialWrite(trader, 'follow', { target: m.member }).catch(() => {})
    if (me) setFollowing(new Set(await getFollowing(me)))
    setBusy(false)
  }

  if (clan === undefined) return <div className="loading-state">{T("Loading…")}</div>
  if (clan === null) return <div className="token-page"><button className="back-btn" onClick={() => navigate({ name: 'clans' })}>{T("← Clans")}</button><div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{T("This clan doesn't exist (or the clans database isn't set up yet).")}</div></div>

  return (
    <div className="token-page">
      <button className="back-btn" onClick={() => navigate({ name: 'clans' })}>{T("← Clans")}</button>
      <div style={{ ...card, overflow: 'hidden', marginTop: 8 }}>
        <div style={{ height: 120, background: clan.banner_url ? `center / cover no-repeat url("${encodeURI(clan.banner_url)}")` : 'linear-gradient(135deg,#1e3a5f,#312e81)' }} />
        <div style={{ padding: '0 18px 16px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: -30 }}>
          {clan.avatar_url ? <img src={clan.avatar_url} alt="" style={{ width: 72, height: 72, borderRadius: 14, objectFit: 'cover', border: '3px solid var(--adx-card-bg)' }} /> : <Avatar address={clan.id.replace(/-/g, '').slice(0, 40).padEnd(40, '0')} size={72} />}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: '1.2rem', fontWeight: 800 }}>{clan.name}</div>
            {clan.motto && <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>{clan.motto}</div>}
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4 }}>👥 {members.length}{' '}{T("member")}{members.length === 1 ? '' : T("s")} · {members.reduce((s, m) => s + (m.volume_usdc > 0 ? 1 : 0), 0)}{' '}{T("active")}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(`https://arcdex.online/clans/${clan.slug}`); setCopied(true) }}>{copied ? T("Link copied ✓") : T("⤴ Share")}</button>
            {isOwner && <button className="btn-ghost" onClick={() => setEditing(true)}>{T("Edit")}</button>}
            {me && (inThis
              ? <button className="btn-ghost" disabled={busy} onClick={() => void act('clan.leave')}>{T("Leave clan")}</button>
              : <button className="btn-primary" style={{ padding: '8px 16px' }} disabled={busy || !!myClan} title={myClan ? T("Leave your current clan first") : ''} onClick={() => void act('clan.join')}>{myClan ? T("In another clan") : T("Join clan")}</button>)}
          </div>
        </div>
        {msg && <div style={{ padding: '0 18px 12px', fontSize: '0.78rem', color: '#fca5a5' }}>{msg}</div>}
      </div>

      <div className="token-detail-grid" style={{ padding: 0, marginTop: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Clan profit")}</span>
              <div style={{ display: 'flex', gap: 4 }}>{(['24h', '7d', '30d', 'all'] as Period[]).map(p => <button key={p} onClick={() => setPeriod(p)} className={`disc-sub${period === p ? ' active' : ''}`}>{p.toUpperCase()}</button>)}</div>
            </div>
            <div className="sensitive" style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'var(--mono)', color: profit >= 0 ? 'var(--green)' : 'var(--red)', margin: '4px 0 10px' }}>{signed(profit)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              {top3.map(p => (
                <button key={p.token} onClick={() => navigate({ name: 'argus', address: p.token, pool: p.m?.pool ?? '' })} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', cursor: 'pointer' }}>
                  {p.m?.image ? <img src={p.m.image} alt="" style={{ width: 26, height: 26, borderRadius: '50%' }} /> : <Avatar address={p.token} size={26} />}
                  <span style={{ textAlign: 'left' }}><b style={{ fontSize: '0.8rem' }}>{p.m?.symbol ?? shortAddr(p.token)}</b><div style={{ fontSize: '0.72rem', color: (p.pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(p.pnl ?? 0)}</div></span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ ...card, marginTop: 16, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', fontWeight: 700, fontSize: '0.86rem' }}>{T("Clan holdings")}{' '}<span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{priced.length}</span></div>
            {priced.length === 0 ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{T("No open positions traded through ARCDEX yet.")}</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: 520 }}>
                  <thead><tr>{[T('Token'), T('Members'), T('Combined position'), T('Combined PnL')].map((h, i) => <th key={h} style={{ padding: '8px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>)}</tr></thead>
                  <tbody>{priced.map(p => (
                    <tr key={p.token} onClick={() => navigate({ name: 'argus', address: p.token, pool: p.m?.pool ?? '' })} style={{ borderTop: '1px solid var(--adx-card-border)', cursor: 'pointer' }}>
                      <td style={{ padding: '10px 16px' }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{p.m?.image ? <img src={p.m.image} alt="" style={{ width: 26, height: 26, borderRadius: '50%' }} /> : <Avatar address={p.token} size={26} />}<b>{p.m?.symbol ?? shortAddr(p.token)}</b></div></td>
                      <td style={{ padding: '10px 16px' }}><div style={{ display: 'flex' }}>{p.holders.map(a => <span key={a} style={{ marginRight: -6 }}><Avatar address={a} url={profiles.get(a)?.avatar_url} size={20} /></span>)}</div></td>
                      <td className="sensitive" style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.value !== null ? money(p.value) : '—'}</td>
                      <td className="sensitive" style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--mono)', color: (p.pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{p.pnl !== null ? signed(p.pnl) : '—'}{p.pct !== null && <div style={{ fontSize: '0.68rem' }}>{p.pct >= 0 ? '+' : ''}{p.pct.toFixed(1)}%</div>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="token-detail-swap">
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 14, padding: '0 16px', borderBottom: '1px solid var(--adx-card-border)' }}>
              {(['members', 'feed', 'thesis'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`disc-tab${tab === t ? ' active' : ''}`}>{t[0].toUpperCase() + t.slice(1)}</button>)}
            </div>
            {tab === 'members' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                  <span>{members.length}{' '}{T("members")}</span>
                  {me && <button className="disc-link" disabled={busy} onClick={() => void followAll()}>{T("Follow all")}</button>}
                </div>
                {members.map(m => {
                  const p = profiles.get(m.member)
                  return (
                    <div key={m.member} className="rail-row" style={{ padding: '8px 16px' }}>
                      <TraderHover address={m.member}>
                        <button onClick={() => navigate({ name: 'trader', address: m.member })} style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0 }}>
                          <Avatar address={m.member} url={p?.avatar_url} size={30} />
                          <span style={{ textAlign: 'left' }}><b style={{ fontSize: '0.8rem' }}>{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(m.member))}{m.role === 'owner' ? ' 👑' : ''}</b>{p?.username && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>@{p.username}</div>}</span>
                        </button>
                      </TraderHover>
                      <span className="sensitive" style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: '0.78rem', color: m.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(m.realized_pnl)}</span>
                    </div>
                  )
                })}
              </>
            )}
            {tab === 'feed' && (trades.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{T("No member trades yet.")}</div> : trades.map(t => {
              const m = meta.get(t.token)
              return (
                <div key={t.tx_hash + t.log_index} className="rail-row" style={{ padding: '8px 16px', fontSize: '0.78rem', gap: 6 }}>
                  <Avatar address={t.trader} url={profiles.get(t.trader)?.avatar_url} size={22} />
                  <b>{profiles.get(t.trader)?.username ? `@${profiles.get(t.trader)!.username}` : shortAddr(t.trader)}</b>
                  <span style={{ color: t.side === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t.side === 'buy' ? T("bought") : T("sold")}</span>
                  <span className="sensitive">{money(t.usdc)}</span>
                  <button className="disc-link" onClick={() => navigate({ name: 'argus', address: t.token, pool: m?.pool ?? '' })}>${m?.symbol ?? shortAddr(t.token)}</button>
                </div>
              )
            }))}
            {tab === 'thesis' && (theses.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{T("No theses from members yet.")}</div> : theses.map(t => (
              <div key={t.id} style={{ padding: '10px 16px', borderTop: '1px solid var(--adx-card-border)', fontSize: '0.8rem' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Avatar address={t.author} url={profiles.get(t.author)?.avatar_url} size={20} /><b>{profiles.get(t.author)?.username ? `@${profiles.get(t.author)!.username}` : shortAddr(t.author)}</b>{' '}{T("on")}{' '}<button className="disc-link" onClick={() => navigate({ name: 'argus', address: t.token, pool: meta.get(t.token)?.pool ?? '' })}>${meta.get(t.token)?.symbol ?? shortAddr(t.token)}</button></div>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.body}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>♡ {t.likes}</div>
              </div>
            )))}
          </div>
        </div>
      </div>

      {editing && <ClanEditor mode="edit" clan={clan} onClose={() => setEditing(false)} onDone={() => void load()} />}
    </div>
  )
}
