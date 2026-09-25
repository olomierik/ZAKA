import { useEffect, useMemo, useState } from 'react'
import Avatar from './Avatar'
import {
  getClosedPositions, getFollowing, getMultiBuys, getNewProfiles, getProfiles, getTheses, getTrades, triggerIndex,
  type ClosedPosition, type IndexedTrade, type MultiBuy, type Profile, type Thesis,
} from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { useMarket, type TokenMeta } from '../lib/tokenMeta'
import type { Page } from '../App'
import { t as T, N_ } from '../lib/i18n'

// Everything happening on ARCDEX, fomo-style: trades, theses, closed
// positions, several traders piling into one coin, new listings, price
// spikes, profit milestones and new traders — each filterable — under a
// pinned daily recap.

export const FEED_TYPES = [
  ['trade', N_('Trades')], ['closed', N_('Closed positions')], ['thesis', N_('Theses')], ['multi', N_('Multi-trader buys')],
  ['listing', N_('New listings')], ['spike', N_('Price spikes')], ['milestone', N_('Profit milestones')], ['newtrader', N_('New traders')],
] as const
export type FeedType = (typeof FEED_TYPES)[number][0]

type Item =
  | { kind: 'trade'; at: number; t: IndexedTrade }
  | { kind: 'thesis'; at: number; t: Thesis }
  | { kind: 'closed' | 'milestone'; at: number; t: ClosedPosition }
  | { kind: 'multi'; at: number; t: MultiBuy }
  | { kind: 'listing' | 'spike'; at: number; t: TokenMeta }
  | { kind: 'newtrader'; at: number; t: Profile }

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`
export function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

const FILTER_KEY = 'arcdex:feed-filter'
function loadFilter(): Set<FeedType> {
  try { const r = localStorage.getItem(FILTER_KEY); if (r) return new Set(JSON.parse(r) as FeedType[]) } catch { /* default */ }
  return new Set(FEED_TYPES.map(t => t[0]))
}

export default function FeedList({ navigate, compact = false, scope = 'all' }: { navigate: (p: Page) => void; compact?: boolean; scope?: 'all' | 'following' }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const market = useMarket()
  const meta = useMemo(() => new Map(market.map(t => [t.address, t])), [market])
  const [types, setTypes] = useState<Set<FeedType>>(loadFilter)
  const [showFilter, setShowFilter] = useState(false)
  const [items, setItems] = useState<Item[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [, tick] = useState(0)

  useEffect(() => { try { localStorage.setItem(FILTER_KEY, JSON.stringify([...types])) } catch { /* ignore */ } }, [types])

  // Clear only when the audience changes — market refreshes update in place.
  useEffect(() => { setItems(null) }, [scope, me])
  useEffect(() => {
    let alive = true
    const load = async () => {
      triggerIndex()
      const who = scope === 'following' && me ? await getFollowing(me).catch(() => []) : undefined
      const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const [trades, theses, closed, multi, newbies] = await Promise.all([
        getTrades({ traders: who, limit: 60 }).catch(() => []),
        getTheses({ authors: who, limit: 60 }).catch(() => []),
        getClosedPositions(since7d, 60).catch(() => []),
        getMultiBuys(new Date(Date.now() - 3600_000).toISOString(), 3).catch(() => []),
        scope === 'all' ? getNewProfiles(15).catch(() => []) : Promise.resolve([] as Profile[]),
      ])
      const inScope = (a: string) => !who || who.includes(a)
      const list: Item[] = [
        ...trades.map(t => ({ kind: 'trade' as const, at: Date.parse(t.block_time), t })),
        ...theses.map(t => ({ kind: 'thesis' as const, at: Date.parse(t.created_at), t })),
        ...closed.filter(c => inScope(c.trader)).map(t => ({ kind: (t.pnl >= 100 ? 'milestone' : 'closed') as 'closed' | 'milestone', at: Date.parse(t.closed_at), t })),
        ...multi.map(t => ({ kind: 'multi' as const, at: Date.parse(t.last_buy), t })),
        ...newbies.filter(p => p.created_at).map(t => ({ kind: 'newtrader' as const, at: Date.parse(t.created_at!), t })),
      ]
      if (scope === 'all') {
        const day = Date.now() - 86_400_000
        for (const t of market) {
          if (t.createdAt && Date.parse(t.createdAt) > day) list.push({ kind: 'listing', at: Date.parse(t.createdAt), t })
          if (t.change1h >= 25) list.push({ kind: 'spike', at: Date.now() - 60_000, t })
        }
      }
      list.sort((a, b) => b.at - a.at)
      if (!alive) return
      setItems(list.slice(0, 150))
      const addrs = list.flatMap(i => i.kind === 'trade' ? [i.t.trader] : i.kind === 'thesis' ? [i.t.author] : i.kind === 'closed' || i.kind === 'milestone' ? [i.t.trader] : i.kind === 'multi' ? i.t.traders : [])
      setProfiles(await getProfiles(addrs).catch(() => new Map()))
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 20_000)
    const t = setInterval(() => tick(n => n + 1), 10_000)
    return () => { alive = false; clearInterval(id); clearInterval(t) }
  }, [scope, me, market])

  // Daily recap: the day on ARCDEX / Arc in one pinned card.
  const recap = useMemo(() => {
    if (market.length === 0) return null
    const gainer = [...market].sort((a, b) => b.change24h - a.change24h)[0]
    const volume = [...market].sort((a, b) => b.volume24h - a.volume24h)[0]
    const total = market.reduce((s, t) => s + t.volume24h, 0)
    const trades24 = (items ?? []).filter(i => i.kind === 'trade' && i.at > Date.now() - 86_400_000).length
    return { gainer, volume, total, trades24 }
  }, [market, items])

  const openToken = (address: string) => {
    const m = meta.get(address)
    navigate({ name: 'argus', address, pool: m?.pool ?? '' })
  }
  const who = (a: string) => {
    const p = profiles.get(a)
    return <button onClick={() => navigate({ name: 'trader', address: a })} style={linkBtn}>{p?.username ? `@${p.username}` : shortAddr(a)}</button>
  }
  const coin = (address: string, sym?: string) => (
    <button onClick={() => openToken(address)} style={{ ...linkBtn, color: 'var(--adx-accent)' }}>${sym ?? meta.get(address)?.symbol ?? shortAddr(address)}</button>
  )

  const visible = (items ?? []).filter(i => types.has(i.kind as FeedType))
  const pad = compact ? '10px 12px' : '12px 16px'
  const fs = compact ? '0.78rem' : '0.86rem'

  return (
    <div>
      <div style={{ padding: compact ? '6px 12px' : '10px 16px', position: 'relative' }}>
        <button onClick={() => setShowFilter(s => !s)} style={{ ...linkBtn, fontSize: '0.74rem', color: 'var(--text-muted)' }}>{T("⚲ Filter")}{types.size < FEED_TYPES.length ? ` (${types.size})` : ''}</button>
        {showFilter && (
          <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: compact ? 12 : 16, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: 8, minWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            <button onClick={() => setTypes(types.size ? new Set() : new Set(FEED_TYPES.map(t => t[0])))} style={{ ...linkBtn, fontSize: '0.74rem', color: 'var(--adx-accent)', padding: '4px 6px' }}>{types.size ? T("Deselect all") : T("Select all")}</button>
            {FEED_TYPES.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 6px', fontSize: '0.78rem', cursor: 'pointer' }}>
                {T(label)}
                <input type="checkbox" checked={types.has(k)} onChange={() => setTypes(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })} />
              </label>
            ))}
          </div>
        )}
      </div>

      {recap && scope === 'all' && (
        <div style={{ margin: compact ? '0 12px 8px' : '0 16px 10px', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', fontSize: compact ? '0.74rem' : '0.8rem', lineHeight: 1.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 4 }}><span>{T("📌 Recap ·")}{' '}{new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span><span>{T("ARCDEX")}</span></div>{T("• Top gainer:")}{' '}{coin(recap.gainer.address, recap.gainer.symbol)} <span style={{ color: 'var(--green)' }}>+{recap.gainer.change24h.toFixed(1)}%</span><br />{T("• Most traded:")}{' '}{coin(recap.volume.address, recap.volume.symbol)}{' '}{T("with")}{' '}{money(recap.volume.volume24h)}{' '}{T("volume")}<br />
          • {money(recap.total)}{' '}{T("traded across Argus coins in 24h")}{recap.trades24 ? ' · ' + T('{n} trades on ARCDEX', { n: recap.trades24 }) : ''}
        </div>
      )}

      {items === null ? <Empty>{T("Loading…")}</Empty> : visible.length === 0 ? (
        <Empty>{scope === 'following' ? (me ? T("Nothing yet from people you follow.") : T("Connect or unlock a wallet to see people you follow.")) : T("No activity yet.")}</Empty>
      ) : visible.map((i, idx) => {
        const key = `${i.kind}-${idx}-${i.at}`
        const row = (avatar: string | null, children: React.ReactNode, extra?: React.ReactNode) => (
          <div key={key} style={{ display: 'flex', gap: 10, padding: pad, borderBottom: '1px solid var(--adx-card-border)', fontSize: fs }}>
            {avatar ? <Avatar address={avatar} url={profiles.get(avatar)?.avatar_url} size={compact ? 26 : 32} /> : <div style={{ width: compact ? 26 : 32, height: compact ? 26 : 32, borderRadius: '50%', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✦</div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>{children}<span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{ago(i.at)}</span></div>
              {extra}
            </div>
          </div>
        )
        switch (i.kind) {
          case 'trade': return row(i.t.trader, <>{who(i.t.trader)}<b style={{ color: i.t.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>{i.t.side === 'buy' ? T("bought") : T("sold")}</b><span className="sensitive" style={{ fontFamily: 'var(--mono)' }}>{money(i.t.usdc)}</span>{T("of")}{' '}{coin(i.t.token)}</>)
          case 'thesis': return row(i.t.author, <>{who(i.t.author)}<Tag c="#93c5fd">{T("THESIS")}</Tag>{coin(i.t.token)}</>,
            <><div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{i.t.body}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>♡ {i.t.likes}{i.t.position_usd ? ' · ' + T('holds {usd}', { usd: money(i.t.position_usd) }) : ''}</div></>)
          case 'closed':
          case 'milestone': return row(i.t.trader, <>{who(i.t.trader)}{i.kind === 'milestone' && <Tag c="#fcd34d">{T("🏆 MILESTONE")}</Tag>}{T("closed")}{' '}{coin(i.t.token)}<b style={{ color: i.t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{i.t.pnl >= 0 ? '+' : ''}{money(i.t.pnl)}</b>{i.t.bought_usdc > 0 && <span style={{ color: 'var(--text-muted)' }}>({i.t.pnl >= 0 ? '+' : ''}{((i.t.pnl / i.t.bought_usdc) * 100).toFixed(0)}%)</span>}</>)
          case 'multi': return row(null, <><b>{i.t.buyers}{' '}{T("traders")}</b><b style={{ color: 'var(--green)' }}>{T("bought")}</b>{coin(i.t.token)}<span style={{ fontFamily: 'var(--mono)' }}>{money(i.t.usdc)}</span></>,
            <div style={{ display: 'flex', marginTop: 4 }}>{i.t.traders.slice(0, 6).map(a => <span key={a} style={{ marginRight: -6 }}><Avatar address={a} url={profiles.get(a)?.avatar_url} size={18} /></span>)}</div>)
          case 'listing': return row(null, <><Tag c="#86efac">{T("NEW")}</Tag>{coin(i.t.address, i.t.symbol)}{T("listed")}{i.t.marketCapUsd ? <span style={{ color: 'var(--text-muted)' }}>{T("at")}{' '}{money(i.t.marketCapUsd)}{' '}{T("MC")}</span> : null}</>)
          case 'spike': return row(null, <><Tag c="#f472b6">{T("⚡ SPIKE")}</Tag>{coin(i.t.address, i.t.symbol)}<b style={{ color: 'var(--green)' }}>+{i.t.change1h.toFixed(0)}%</b><span style={{ color: 'var(--text-muted)' }}>{T("in 1h")}</span></>)
          case 'newtrader': return row(i.t.address, <>{who(i.t.address)}<span style={{ color: 'var(--text-muted)' }}>{T("joined ARCDEX")}</span><Tag c="#c4b5fd">{T("NEW TRADER")}</Tag></>)
        }
      })}
    </div>
  )
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 'inherit' }
function Tag({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: c }}>{children}</span>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.84rem' }}>{children}</div>
}
