import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { getClanLeaderboard, getFollowing, getLeaderboard, getProfiles, socialWrite, type ClanRank, type LeaderRow, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { loadBlueChips, type TokenMeta } from '../lib/tokenMeta'
import { client } from '../api/launchpad'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Right-rail suggestions (fomo: "Follow top traders", "Discover clans")
// and the bottom ticker bar (blue-chip prices + network status).

export function FollowTopTraders({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const [rows, setRows] = useState<LeaderRow[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [following, setFollowing] = useState<Set<string>>(new Set())

  useEffect(() => {
    void getLeaderboard('7d', 12).then(async r => {
      setRows(r)
      setProfiles(await getProfiles(r.map(x => x.trader)).catch(() => new Map()))
    }).catch(() => {})
  }, [])
  useEffect(() => { if (me) void getFollowing(me).then(f => setFollowing(new Set(f))).catch(() => {}) }, [me])

  const list = rows.filter(r => r.trader !== me).slice(0, 8)
  if (list.length === 0) return null
  const toggle = async (a: string) => {
    const on = following.has(a)
    setFollowing(f => { const n = new Set(f); if (on) n.delete(a); else n.add(a); return n })
    try { await socialWrite(trader, on ? 'unfollow' : 'follow', { target: a }) } catch { setFollowing(f => { const n = new Set(f); if (on) n.add(a); else n.delete(a); return n }) }
  }
  return (
    <div>
      <div className="rail-section">{T("👥 Follow top traders")}</div>
      {list.map(r => {
        const p = profiles.get(r.trader)
        return (
          <div key={r.trader} className="rail-row">
            <button onClick={() => navigate({ name: 'trader', address: r.trader })} style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, minWidth: 0 }}>
              <Avatar address={r.trader} url={p?.avatar_url} size={26} />
              <span style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontSize: '0.76rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(r.trader))}</div>
                <div style={{ fontSize: '0.66rem', color: r.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{r.realized_pnl >= 0 ? '+' : ''}${Math.abs(r.realized_pnl).toFixed(0)}{' '}{T("7d")}</div>
              </span>
            </button>
            {me && <button className={`rail-follow${following.has(r.trader) ? ' on' : ''}`} onClick={() => void toggle(r.trader)}>{following.has(r.trader) ? T("Following") : T("Follow")}</button>}
          </div>
        )
      })}
    </div>
  )
}

export function DiscoverClans({ navigate }: { navigate: (p: Page) => void }) {
  const [clans, setClans] = useState<ClanRank[]>([])
  useEffect(() => { void getClanLeaderboard('7d', 5).then(setClans).catch(() => {}) }, [])
  return (
    <div>
      <div className="rail-section">{T("⚑ Discover clans")}{' '}<button className="disc-link" onClick={() => navigate({ name: 'clans' })}>{clans.length ? T("All ›") : T("Start one ›")}</button></div>
      {clans.map(c => (
        <button key={c.clan_id} className="rail-row" onClick={() => navigate({ name: 'clan', slug: c.slug })} style={{ width: '100%', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
          {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: 26, height: 26, borderRadius: 6 }} /> : <span style={{ width: 26, textAlign: 'center' }}>⚑</span>}
          <span style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: '0.76rem', fontWeight: 700 }}>{c.name}</div><div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>👥 {c.members}</div></span>
          <span style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', color: c.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{c.realized_pnl >= 0 ? '+' : ''}${Math.abs(c.realized_pnl).toFixed(0)}</span>
        </button>
      ))}
    </div>
  )
}

export function TickerBar({ navigate }: { navigate: (p: Page) => void }) {
  const [chips, setChips] = useState<TokenMeta[]>([])
  const [status, setStatus] = useState<'ok' | 'slow' | 'down'>('ok')
  useEffect(() => {
    const load = () => void loadBlueChips().then(setChips)
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => clearInterval(id)
  }, [])
  // Network status: how fresh Arc's latest block is.
  useEffect(() => {
    const check = () => void client.getBlock().then(b => {
      const age = Date.now() / 1000 - Number(b.timestamp)
      setStatus(age < 30 ? 'ok' : age < 120 ? 'slow' : 'down')
    }).catch(() => setStatus('down'))
    check()
    const id = setInterval(() => { if (!document.hidden) check() }, 30_000)
    return () => clearInterval(id)
  }, [])
  const color = { ok: 'var(--green)', slow: 'var(--amber)', down: 'var(--red)' }[status]
  return (
    <div className="ticker-bar">
      {chips.map(c => (
        <button key={c.address} onClick={() => navigate({ name: 'argus', address: c.address, pool: c.pool })}>
          {c.image && <img src={c.image} alt="" style={{ width: 12, height: 12, borderRadius: '50%' }} />}
          <span>{c.priceUsd >= 1 ? `$${c.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${c.priceUsd.toPrecision(3)}`}</span>
          <span style={{ color: c.change24h >= 0 ? 'var(--green)' : 'var(--red)' }}>{c.change24h >= 0 ? '▲' : '▼'}{Math.abs(c.change24h).toFixed(2)}%</span>
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <span style={{ color }}>● {status === 'ok' ? T("Arc: Stable") : status === 'slow' ? T("Arc: Slow") : T("Arc: Unreachable")}</span>
      <a href="https://explorer.arc.io" target="_blank" rel="noopener noreferrer">{T("Explorer")}</a>
    </div>
  )
}
