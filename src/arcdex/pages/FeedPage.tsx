import { useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar'
import { getFollowing, getProfiles, getTheses, getTrades, triggerIndex, type IndexedTrade, type Profile, type Thesis } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { useTokenMeta } from '../lib/tokenMeta'
import type { Page } from '../App'

// What's happening on ARCDEX right now: trades and theses from everyone,
// or just the traders you follow.

type Item = { kind: 'trade'; at: number; t: IndexedTrade } | { kind: 'thesis'; at: number; t: Thesis }

const money = (n: number) => `$${n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`
function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

export default function FeedPage({ navigate }: { navigate: (p: Page) => void }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const meta = useTokenMeta()
  const [scope, setScope] = useState<'all' | 'following'>('all')
  const [items, setItems] = useState<Item[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [, tick] = useState(0)

  useEffect(() => {
    let alive = true
    setItems(null)
    triggerIndex()
    const load = async () => {
      const who = scope === 'following' && me ? await getFollowing(me).catch(() => []) : undefined
      const [trades, theses] = await Promise.all([
        getTrades({ traders: who, limit: 60 }).catch(() => []),
        getTheses({ authors: who, limit: 60 }).catch(() => []),
      ])
      const merged: Item[] = [
        ...trades.map(t => ({ kind: 'trade' as const, at: Date.parse(t.block_time), t })),
        ...theses.map(t => ({ kind: 'thesis' as const, at: Date.parse(t.created_at), t })),
      ].sort((a, b) => b.at - a.at).slice(0, 80)
      if (!alive) return
      setItems(merged)
      setProfiles(await getProfiles(merged.map(i => (i.kind === 'trade' ? i.t.trader : i.t.author))).catch(() => new Map()))
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) { triggerIndex(); void load() } }, 15_000)
    const t = setInterval(() => tick(n => n + 1), 10_000)
    return () => { alive = false; clearInterval(id); clearInterval(t) }
  }, [scope, me])

  const openToken = (token: string) => {
    const m = meta.get(token)
    navigate(m ? { name: 'argus', address: token, pool: m.pool } : { name: 'token', address: token })
  }
  const who = (a: string) => {
    const p = profiles.get(a)
    return (
      <button onClick={() => navigate({ name: 'trader', address: a })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text)', fontWeight: 700, cursor: 'pointer' }}>
        {p?.username ? `@${p.username}` : shortAddr(a)}
      </button>
    )
  }
  const empty = useMemo(() => scope === 'following'
    ? (me ? 'Nothing yet from people you follow — find traders on the Leaderboard and follow them.' : 'Connect or unlock a wallet to see people you follow.')
    : 'No activity yet. Trades made on ARCDEX and theses show up here live.', [scope, me])

  return (
    <div className="token-page" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Feed</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Live trades and theses from ARCDEX traders.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'following'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{ padding: '5px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', border: '1px solid var(--adx-card-border)', background: scope === s ? 'var(--adx-accent)' : 'transparent', color: scope === s ? '#fff' : 'var(--text-muted)' }}>{s === 'all' ? 'Everyone' : 'Following'}</button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
        {items === null ? <Empty>Loading…</Empty> : items.length === 0 ? <Empty>{empty}</Empty> : items.map(i => {
          const addr = i.kind === 'trade' ? i.t.trader : i.t.author
          const token = i.t.token
          const m = meta.get(token)
          const sym = m ? `$${m.symbol}` : shortAddr(token)
          return (
            <div key={i.kind + (i.kind === 'trade' ? i.t.tx_hash + i.t.log_index : i.t.id)} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)' }}>
              <Avatar address={addr} url={profiles.get(addr)?.avatar_url} size={34} />
              <div style={{ flex: 1, minWidth: 0, fontSize: '0.86rem' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {who(addr)}
                  {i.kind === 'trade' ? (
                    <>
                      <span style={{ color: i.t.side === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{i.t.side === 'buy' ? 'bought' : 'sold'}</span>
                      <span style={{ fontFamily: 'var(--mono)' }}>{money(i.t.usdc)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>of</span>
                    </>
                  ) : <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>THESIS</span>}
                  <button onClick={() => openToken(token)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', fontWeight: 700, cursor: 'pointer' }}>{sym}</button>
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{ago(i.at)}</span>
                </div>
                {i.kind === 'thesis' && <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{i.t.body}</div>}
                {i.kind === 'thesis' && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>♥ {i.t.likes}{i.t.position_usd ? ` · holds $${i.t.position_usd.toFixed(0)}` : ''}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.86rem' }}>{children}</div>
}
