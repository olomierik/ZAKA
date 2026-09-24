import { useCallback, useEffect, useMemo, useState } from 'react'
import Avatar from './Avatar'
import { ARC_EXPLORER } from '../api/arcRpc'
import { getMyLikes, getTheses, socialWrite, type Profile, type Thesis } from '../api/social'
import { shortAddr, type Trader } from '../lib/identity'
import type { Page } from '../App'

// Under the chart on a coin page: who's trading it, who's winning on it,
// and what holders are saying about it (fomo's core social loop).

export interface TradeRow {
  txHash: string
  maker: string | null
  kind: 'buy' | 'sell'
  usd: number
  tokenAmount: number
  timestamp: number
  live: boolean
}

interface Props {
  token: string
  symbol: string
  rows: TradeRow[]
  tradesLoaded: boolean
  profiles: Map<string, Profile>
  trader: Trader
  positionUsd: number | null
  creator: string | null
  navigate: (p: Page) => void
  onProfilesNeeded: (addresses: string[]) => void
}

type Tab = 'trades' | 'traders' | 'thesis'

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toFixed(4)
const usd = (n: number) => (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n))
function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function Who({ address, profiles, navigate, creator }: { address: string; profiles: Map<string, Profile>; navigate: (p: Page) => void; creator?: string | null }) {
  const p = profiles.get(address.toLowerCase())
  const isDev = creator && creator.toLowerCase() === address.toLowerCase()
  return (
    <button onClick={() => navigate({ name: 'trader', address })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', minWidth: 0 }}>
      <Avatar address={address} url={p?.avatar_url} size={20} />
      <span style={{ fontFamily: p?.username ? undefined : 'var(--mono)', fontSize: '0.76rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p?.username ? `@${p.username}` : shortAddr(address)}
      </span>
      {isDev && <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'rgba(245,158,11,0.18)', color: '#fcd34d' }}>DEV</span>}
    </button>
  )
}

export default function TokenSocialTabs({ token, symbol, rows, tradesLoaded, profiles, trader, positionUsd, creator, navigate, onProfilesNeeded }: Props) {
  const [tab, setTab] = useState<Tab>('trades')
  const [theses, setTheses] = useState<Thesis[] | null>(null)
  const [liked, setLiked] = useState<Set<number>>(new Set())
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [err, setErr] = useState('')

  const loadTheses = useCallback(async () => {
    const t = await getTheses({ token, limit: 100 }).catch(() => [] as Thesis[])
    setTheses(t)
    onProfilesNeeded(t.map(x => x.author))
    if (trader.address) setLiked(await getMyLikes(trader.address, t.map(x => x.id)).catch(() => new Set<number>()))
  }, [token, trader.address, onProfilesNeeded])
  useEffect(() => { void loadTheses() }, [loadTheses])

  // Top traders from the recent trades we have (GeckoTerminal's latest
  // window + live pushes) — not all-time; labelled as such.
  const traders = useMemo(() => {
    const m = new Map<string, { address: string; bought: number; sold: number; n: number; last: number }>()
    for (const r of rows) {
      if (!r.maker) continue
      const k = r.maker.toLowerCase()
      const e = m.get(k) ?? { address: r.maker, bought: 0, sold: 0, n: 0, last: 0 }
      if (r.kind === 'buy') e.bought += r.usd; else e.sold += r.usd
      e.n++; e.last = Math.max(e.last, r.timestamp)
      m.set(k, e)
    }
    return [...m.values()].sort((a, b) => (b.bought + b.sold) - (a.bought + a.sold)).slice(0, 50)
  }, [rows])

  async function post() {
    if (!draft.trim()) return
    setPosting(true); setErr('')
    try {
      await socialWrite(trader, 'thesis', { token, body: draft.trim(), position_usd: positionUsd ?? undefined })
      setDraft('')
      await loadTheses()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not post')
    } finally {
      setPosting(false)
    }
  }

  async function toggleLike(t: Thesis) {
    if (!trader.address) { setErr('Connect or unlock a wallet to like'); return }
    const isLiked = liked.has(t.id)
    setLiked(s => { const n = new Set(s); if (isLiked) n.delete(t.id); else n.add(t.id); return n })
    setTheses(ts => ts?.map(x => x.id === t.id ? { ...x, likes: x.likes + (isLiked ? -1 : 1) } : x) ?? ts)
    try { await socialWrite(trader, isLiked ? 'unlike' : 'like', { thesis_id: t.id }) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not update like'); void loadTheses() }
  }

  const tabBtn = (t: Tab, label: string) => (
    <button onClick={() => setTab(t)} style={{ padding: '10px 4px', marginRight: 16, background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--adx-accent)' : 'transparent'}`, color: tab === t ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>{label}</button>
  )
  const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.05em' }
  const td: React.CSSProperties = { padding: '8px 12px' }

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16, overflow: 'hidden' }}>
      <div style={{ padding: '0 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', alignItems: 'center' }}>
        {tabBtn('trades', 'Trades')}
        {tabBtn('traders', 'Top traders')}
        {tabBtn('thesis', `Thesis${theses?.length ? ` (${theses.length})` : ''}`)}
        <span style={{ flex: 1 }} />
        {tab === 'trades' && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginRight: 5, animation: 'pulse 1.5s infinite' }} />
            Live
          </span>
        )}
      </div>

      {tab === 'trades' && (rows.length === 0 ? (
        <Empty>{tradesLoaded ? 'No recent trades on this pool — new ones appear here instantly.' : 'Loading trades…'}</Empty>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: 460 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 540 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['Age', 'Type', 'USD', symbol, 'Trader', 'Tx'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(t => {
                const c = t.kind === 'buy' ? 'var(--green)' : 'var(--red)'
                const mine = trader.address && t.maker?.toLowerCase() === trader.address.toLowerCase()
                return (
                  <tr key={t.txHash + t.kind + t.tokenAmount} style={{ borderBottom: '1px solid var(--adx-card-border)', background: mine ? 'rgba(250,204,21,0.07)' : t.live ? 'rgba(59,130,246,0.06)' : 'transparent' }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(t.timestamp)}</td>
                    <td style={{ ...td, color: c, fontWeight: 700 }}>{t.kind.toUpperCase()}</td>
                    <td style={{ ...td, color: c, fontFamily: 'var(--mono)' }}>{t.usd < 0.01 ? '<$0.01' : usd(t.usd)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{fmt(t.tokenAmount)}</td>
                    <td style={td}>{t.maker ? <Who address={t.maker} profiles={profiles} navigate={navigate} creator={creator} /> : <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>just now…</span>}</td>
                    <td style={td}><a href={`${ARC_EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', textDecoration: 'none' }}>{shortAddr(t.txHash)} ↗</a></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {tab === 'traders' && (traders.length === 0 ? <Empty>No traders in the recent window yet.</Empty> : (
        <div style={{ overflow: 'auto', maxHeight: 460 }}>
          <div style={{ padding: '8px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>From the {rows.length} most recent trades on this pool.</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 520 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
              {['#', 'Trader', 'Bought', 'Sold', 'Net flow', 'Trades', 'Last'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {traders.map((t, i) => {
                const net = t.sold - t.bought
                return (
                  <tr key={t.address} style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={td}><Who address={t.address} profiles={profiles} navigate={navigate} creator={creator} /></td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{usd(t.bought)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--red)' }}>{usd(t.sold)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: net >= 0 ? 'var(--green)' : 'var(--red)' }} title="Sold minus bought within this window">{net >= 0 ? '+' : ''}{usd(net)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{t.n}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(t.last)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {tab === 'thesis' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {trader.address ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Avatar address={trader.address} url={profiles.get(trader.address.toLowerCase())?.avatar_url} size={32} />
              <div style={{ flex: 1 }}>
                <textarea value={draft} maxLength={280} onChange={e => setDraft(e.target.value)} placeholder={`Why are you in $${symbol}? Share your thesis…`} rows={2}
                  style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'inherit' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{draft.length}/280{positionUsd ? ` · shows your $${fmt(positionUsd)} position` : ''}</span>
                  <button onClick={() => void post()} disabled={posting || !draft.trim()} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--adx-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: posting || !draft.trim() ? 0.5 : 1 }}>{posting ? 'Posting…' : 'Post'}</button>
                </div>
              </div>
            </div>
          ) : <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Connect or unlock a wallet to post your thesis.</div>}
          {err && <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>{err}</div>}
          {theses === null ? <Empty>Loading…</Empty> : theses.length === 0 ? <Empty>No theses yet — be the first to call it.</Empty> : theses.map(t => (
            <div key={t.id} style={{ display: 'flex', gap: 10, paddingTop: 12, borderTop: '1px solid var(--adx-card-border)' }}>
              <Avatar address={t.author} url={profiles.get(t.author)?.avatar_url} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Who address={t.author} profiles={profiles} navigate={navigate} creator={creator} />
                  {t.position_usd != null && t.position_usd > 0 && <span style={{ fontSize: '0.68rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>holds ${fmt(t.position_usd)}</span>}
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{ago(Date.parse(t.created_at))}</span>
                </div>
                <div style={{ fontSize: '0.86rem', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.body}</div>
                <button onClick={() => void toggleLike(t)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: liked.has(t.id) ? '#f472b6' : 'var(--text-muted)', fontSize: '0.76rem' }}>
                  {liked.has(t.id) ? '♥' : '♡'} {t.likes}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.84rem' }}>{children}</div>
}
