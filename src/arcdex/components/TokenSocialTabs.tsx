import { useCallback, useEffect, useMemo, useState } from 'react'
import Avatar from './Avatar'
import TraderHover from './TraderHover'
import { ARC_EXPLORER } from '../api/arcRpc'
import { getMyLikes, getTheses, getTokenHolders, socialWrite, type HolderRow, type Profile, type Thesis } from '../api/social'
import { shortAddr, type Trader } from '../lib/identity'
import type { ChainHolders } from '../api/holders'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Under the chart on a coin page (fomo parity): Holders (every on-chain
// holder from ARCDEX's own index, with PnL and average entry market cap for
// those who trade on ARCDEX — or just the ARCDEX traders), Swaps (every trade,
// with the market cap at that moment), Thesis (holders' notes with their
// live position), and Top traders (recent flow).

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
  /** On-chain holders (null: index unavailable or still loading). */
  chainHolders?: ChainHolders | null
  trader: Trader
  positionUsd: number | null
  creator: string | null
  priceUsd: number
  supply: number | null
  navigate: (p: Page) => void
  onProfilesNeeded: (addresses: string[]) => void
  onThesesLoaded?: (theses: Thesis[]) => void
}

type Tab = 'holders' | 'swaps' | 'thesis' | 'traders'

const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toFixed(4)
const usd = (n: number) => (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n))
function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
const dur = (ms: number) => { const h = ms / 3600_000; return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d` }

export function Who({ address, profiles, navigate, creator }: { address: string; profiles: Map<string, Profile>; navigate: (p: Page) => void; creator?: string | null }) {
  const p = profiles.get(address.toLowerCase())
  const isDev = creator && creator.toLowerCase() === address.toLowerCase()
  return (
    <TraderHover address={address}>
      <button onClick={() => navigate({ name: 'trader', address })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', minWidth: 0 }}>
        <Avatar address={address} url={p?.avatar_url} size={20} />
        <span style={{ fontFamily: p?.username ? undefined : 'var(--mono)', fontSize: '0.76rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p?.username ? `@${p.username}` : shortAddr(address)}
        </span>
        {isDev && <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'rgba(245,158,11,0.18)', color: '#fcd34d' }}>{T("DEV")}</span>}
      </button>
    </TraderHover>
  )
}

export default function TokenSocialTabs({ token, symbol, rows, tradesLoaded, profiles, chainHolders, trader, positionUsd, creator, priceUsd, supply, navigate, onProfilesNeeded, onThesesLoaded }: Props) {
  const [tab, setTab] = useState<Tab>('holders')
  const [holderView, setHolderView] = useState<'all' | 'arcdex'>('all')
  const [theses, setTheses] = useState<Thesis[] | null>(null)
  const [holders, setHolders] = useState<HolderRow[] | null>(null)
  const [liked, setLiked] = useState<Set<number>>(new Set())
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [err, setErr] = useState('')
  const [minSwap, setMinSwap] = useState(0)
  const [thesisOnly, setThesisOnly] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const loadTheses = useCallback(async () => {
    const t = await getTheses({ token, limit: 200 }).catch(() => [] as Thesis[])
    setTheses(t)
    onThesesLoaded?.(t)
    onProfilesNeeded(t.map(x => x.author))
    if (trader.address) setLiked(await getMyLikes(trader.address, t.map(x => x.id)).catch(() => new Set<number>()))
  }, [token, trader.address, onProfilesNeeded, onThesesLoaded])
  useEffect(() => { void loadTheses() }, [loadTheses])
  useEffect(() => {
    let alive = true
    const load = () => void getTokenHolders(token).then(h => { if (alive) { setHolders(h); onProfilesNeeded(h.map(x => x.trader)) } }).catch(() => { if (alive) setHolders([]) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [token, onProfilesNeeded])

  // Live position for any trader (holders list) — used by holders & theses.
  const positionOf = useMemo(() => {
    const m = new Map<string, { value: number; pnl: number; pct: number | null; entryMc: number | null; since: number | null }>()
    for (const h of holders ?? []) {
      const held = (h.bought_tok - h.sold_tok) / 1e18
      const value = held * priceUsd
      const pnl = value + h.sold_usdc - h.bought_usdc
      const avgPrice = h.bought_tok > 0 ? h.bought_usdc / (h.bought_tok / 1e18) : 0
      m.set(h.trader, { value, pnl, pct: h.bought_usdc > 0 ? (pnl / h.bought_usdc) * 100 : null, entryMc: supply && avgPrice ? avgPrice * supply : null, since: h.first_buy ? Date.parse(h.first_buy) : null })
    }
    return m
  }, [holders, priceUsd, supply])

  // Usernames/avatars for the on-chain holders too.
  const chainTop = chainHolders?.top
  useEffect(() => { if (chainTop?.length) onProfilesNeeded(chainTop.filter(h => !h.tag).map(h => h.address)) }, [chainTop, onProfilesNeeded])
  const showAll = holderView === 'all' && !!chainTop?.length

  const latestThesisBy = useMemo(() => {
    const m = new Map<string, Thesis>()
    for (const t of theses ?? []) if (!m.has(t.author)) m.set(t.author, t)
    return m
  }, [theses])

  // Theses grouped fomo-style: newest per author, with "N older" under it.
  const thesisThreads = useMemo(() => {
    const by = new Map<string, Thesis[]>()
    for (const t of theses ?? []) by.set(t.author, [...(by.get(t.author) ?? []), t])
    return [...by.values()].map(list => ({ head: list[0], older: list.slice(1) })).sort((a, b) => Date.parse(b.head.created_at) - Date.parse(a.head.created_at))
  }, [theses])

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
    } catch (e) { setErr(e instanceof Error ? e.message : T("Could not post")) } finally { setPosting(false) }
  }
  async function toggleLike(t: Thesis) {
    if (!trader.address) { setErr(T("Connect or unlock a wallet to like")); return }
    const isLiked = liked.has(t.id)
    setLiked(s => { const n = new Set(s); if (isLiked) n.delete(t.id); else n.add(t.id); return n })
    setTheses(ts => ts?.map(x => x.id === t.id ? { ...x, likes: x.likes + (isLiked ? -1 : 1) } : x) ?? ts)
    try { await socialWrite(trader, isLiked ? 'unlike' : 'like', { thesis_id: t.id }) }
    catch (e) { setErr(e instanceof Error ? e.message : T("Could not update like")); void loadTheses() }
  }

  const tabBtn = (t: Tab, label: string) => (
    <button onClick={() => setTab(t)} style={{ padding: '10px 4px', marginRight: 16, background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--adx-accent)' : 'transparent'}`, color: tab === t ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</button>
  )
  const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.05em' }
  const td: React.CSSProperties = { padding: '8px 12px' }
  const swaps = rows.filter(r => r.usd >= minSwap)
  const holderRows = (holders ?? []).filter(h => !thesisOnly || latestThesisBy.has(h.trader))
  const chainRows = (chainTop ?? []).filter(h => !thesisOnly || latestThesisBy.has(h.address))
  const holderCount = chainHolders?.holders ?? holders?.length ?? 0

  const thesisCard = (t: Thesis, older = false) => {
    const pos = positionOf.get(t.author)
    return (
      <div key={t.id} style={{ display: 'flex', gap: 10, paddingTop: 12, borderTop: older ? 'none' : '1px solid var(--adx-card-border)', marginLeft: older ? 40 : 0 }}>
        <Avatar address={t.author} url={profiles.get(t.author)?.avatar_url} size={older ? 24 : 32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Who address={t.author} profiles={profiles} navigate={navigate} creator={creator} />
            <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>{T("Thesis")}</span>
            {!older && pos && <span className="sensitive" style={{ fontSize: '0.74rem', fontFamily: 'var(--mono)' }}>{usd(pos.value)} {pos.pct !== null && <span style={{ color: pos.pct >= 0 ? 'var(--green)' : 'var(--red)' }}>({pos.pct >= 0 ? '▲' : '▼'}{Math.abs(pos.pct).toFixed(2)}%)</span>}</span>}
            {!older && !pos && t.position_usd != null && t.position_usd > 0 && <span style={{ fontSize: '0.68rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>{T("held $")}{fmt(t.position_usd)}{' '}{T("when posted")}</span>}
            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{ago(Date.parse(t.created_at))}</span>
          </div>
          <div style={{ fontSize: '0.86rem', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.body}</div>
          <button onClick={() => void toggleLike(t)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: liked.has(t.id) ? '#f472b6' : 'var(--text-muted)', fontSize: '0.76rem' }}>{liked.has(t.id) ? '♥' : '♡'} {t.likes}</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16, overflow: 'visible' }}>
      <div style={{ padding: '0 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', alignItems: 'center', overflowX: 'auto' }}>
        {tabBtn('holders', T('Holders') + (holderCount ? ` (${holderCount.toLocaleString()}${chainHolders && !chainHolders.complete ? '…' : ''})` : ''))}
        {tabBtn('swaps', T('Swaps'))}
        {tabBtn('thesis', T('Thesis') + (theses?.length ? ` (${theses.length})` : ''))}
        {tabBtn('traders', T('Top traders'))}
        <span style={{ flex: 1 }} />
        {tab === 'swaps' && (
          <select value={minSwap} onChange={e => setMinSwap(Number(e.target.value))} className="disc-select">
            {[0, 10, 100, 1000].map(v => <option key={v} value={v}>{v === 0 ? T("Any size") : T('Min size {v}', { v: '>$' + (v >= 1000 ? '1K' : v) })}</option>)}
          </select>
        )}
        {tab === 'holders' && !!chainTop?.length && (
          <span style={{ display: 'inline-flex', border: '1px solid var(--adx-card-border)', borderRadius: 6, overflow: 'hidden', marginRight: 10, flexShrink: 0 }}>
            {(['all', 'arcdex'] as const).map(v => (
              <button key={v} onClick={() => setHolderView(v)} style={{ padding: '3px 9px', fontSize: '0.7rem', fontWeight: 700, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: holderView === v ? 'rgba(59,130,246,0.15)' : 'transparent', color: holderView === v ? 'var(--adx-accent)' : 'var(--text-muted)' }}>{v === 'all' ? T("All holders") : T("On ARCDEX")}</button>
            ))}
          </span>
        )}
        {tab === 'holders' && <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}><input type="checkbox" checked={thesisOnly} onChange={e => setThesisOnly(e.target.checked)} />{T("Thesis only")}</label>}
      </div>

      {tab === 'holders' && showAll && (chainRows.length === 0 ? <Empty>{T("No holder has posted a thesis yet.")}</Empty> : (
        <div style={{ overflow: 'auto', maxHeight: 480 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 680 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>{['#', T('Holder'), T('Balance'), T('Supply'), T('Value'), T('PnL'), T('Thesis')].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {chainRows.map((h, i) => {
                const pos = positionOf.get(h.address)
                const ts = latestThesisBy.get(h.address)
                const mine = trader.address?.toLowerCase() === h.address
                return (
                  <tr key={h.address} style={{ borderBottom: '1px solid var(--adx-card-border)', background: mine ? 'rgba(250,204,21,0.07)' : undefined }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={td}>
                      {h.tag === 'pool' ? <span style={{ fontSize: '0.76rem' }}>💧 {T("Liquidity pool")}</span>
                        : h.tag === 'burn' ? <span style={{ fontSize: '0.76rem' }}>🔥 {T("Burned")}</span>
                        : <Who address={h.address} profiles={profiles} navigate={navigate} creator={creator} />}
                      {pos?.since && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 2 }}>◷ {dur(Date.now() - pos.since)}{' '}{T("hold")}</div>}
                    </td>
                    <td className="sensitive" style={{ ...td, fontFamily: 'var(--mono)' }}>{fmt(h.balance)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{h.pct != null ? `${h.pct < 0.01 ? '<0.01' : h.pct.toFixed(2)}%` : '—'}</td>
                    <td className="sensitive" style={{ ...td, fontFamily: 'var(--mono)' }}>{priceUsd ? usd(h.balance * priceUsd) : '—'}</td>
                    <td className="sensitive" style={{ ...td, fontFamily: 'var(--mono)', color: pos ? (pos.pnl >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-muted)' }}>{pos ? <>{pos.pnl >= 0 ? '+' : ''}{usd(pos.pnl)}{pos.pct !== null && <div style={{ fontSize: '0.66rem' }}>{pos.pct >= 0 ? '▲' : '▼'}{Math.abs(pos.pct).toFixed(2)}%</div>}</> : '—'}</td>
                    <td style={{ ...td, maxWidth: 240 }}>{ts ? <span style={{ fontSize: '0.76rem' }}>♡ {ts.likes} · {ts.body.slice(0, 80)}{ts.body.length > 80 ? '…' : ''}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '8px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {chainHolders!.complete
              ? T("Top {n} of {total} holders, live from the chain. PnL is shown for wallets that trade on ARCDEX.", { n: String(chainRows.length), total: chainHolders!.holders.toLocaleString() })
              : T("Counting every holder on-chain… {pct}% done.", { pct: String(Math.floor(chainHolders!.progress * 100)) })}
          </div>
        </div>
      ))}

      {tab === 'holders' && !showAll && (holders === null ? <Empty>{T("Loading holders…")}</Empty> : holderRows.length === 0 ? <Empty>{thesisOnly ? T("No holder has posted a thesis yet.") : T("No ARCDEX traders hold ${symbol} yet — buy some and you'll be first here.", { symbol })}</Empty> : (
        <div style={{ overflow: 'auto', maxHeight: 480 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 640 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>{[T('Trader'), T('Position'), T('PnL'), T('Avg. entry'), T('Thesis')].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {holderRows.map(h => {
                const pos = positionOf.get(h.trader)!
                const ts = latestThesisBy.get(h.trader)
                const held = (h.bought_tok - h.sold_tok) / 1e18
                return (
                  <tr key={h.trader} style={{ borderBottom: '1px solid var(--adx-card-border)', background: trader.address?.toLowerCase() === h.trader ? 'rgba(250,204,21,0.07)' : undefined }}>
                    <td style={td}><Who address={h.trader} profiles={profiles} navigate={navigate} creator={creator} />{pos.since && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 2 }}>◷ {dur(Date.now() - pos.since)}{' '}{T("hold")}</div>}</td>
                    <td className="sensitive" style={{ ...td, fontFamily: 'var(--mono)' }}>{usd(pos.value)}<div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{fmt(held)} {symbol}</div></td>
                    <td className="sensitive" style={{ ...td, fontFamily: 'var(--mono)', color: pos.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{pos.pnl >= 0 ? '+' : ''}{usd(pos.pnl)}{pos.pct !== null && <div style={{ fontSize: '0.66rem' }}>{pos.pct >= 0 ? '▲' : '▼'}{Math.abs(pos.pct).toFixed(2)}%</div>}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{pos.entryMc !== null ? `${usd(pos.entryMc)} MC` : '—'}</td>
                    <td style={{ ...td, maxWidth: 260 }}>{ts ? <span style={{ fontSize: '0.76rem' }}>♡ {ts.likes} · {ts.body.slice(0, 90)}{ts.body.length > 90 ? '…' : ''}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {tab === 'swaps' && (swaps.length === 0 ? (
        <Empty>{tradesLoaded ? T("No recent trades on this pool — new ones appear here instantly.") : T("Loading trades…")}</Empty>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: 480 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 560 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>{[T('Trader'), T('Action'), T('Amount'), T('Market cap'), T('Time'), ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {swaps.map(t => {
                const c = t.kind === 'buy' ? 'var(--green)' : 'var(--red)'
                const mine = trader.address && t.maker?.toLowerCase() === trader.address.toLowerCase()
                const mcAt = supply && t.tokenAmount > 0 ? (t.usd / t.tokenAmount) * supply : null
                return (
                  <tr key={t.txHash + t.kind + t.tokenAmount} style={{ borderBottom: '1px solid var(--adx-card-border)', background: mine ? 'rgba(250,204,21,0.07)' : t.live ? 'rgba(59,130,246,0.06)' : 'transparent' }}>
                    <td style={td}>{t.maker ? <Who address={t.maker} profiles={profiles} navigate={navigate} creator={creator} /> : <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{T("just now…")}</span>}</td>
                    <td style={td}><span style={{ fontSize: '0.68rem', fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: t.kind === 'buy' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: c }}>{t.kind === 'buy' ? T("Buy") : T("Sell")}</span></td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{t.usd < 0.01 ? '<$0.01' : usd(t.usd)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{mcAt ? usd(mcAt) : '—'}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(t.timestamp)}</td>
                    <td style={td}><a href={`${ARC_EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>↗</a></td>
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
                <textarea value={draft} maxLength={280} onChange={e => setDraft(e.target.value)} placeholder={T('Why are you in ${symbol}? Share your thesis…', { symbol })} rows={2}
                  style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'inherit' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{draft.length}/280{positionUsd ? ' · ' + T('shows your live {usd} position', { usd: '$' + fmt(positionUsd) }) : ''}</span>
                  <button onClick={() => void post()} disabled={posting || !draft.trim()} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--adx-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: posting || !draft.trim() ? 0.5 : 1 }}>{posting ? T("Posting…") : T("Post")}</button>
                </div>
              </div>
            </div>
          ) : <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Connect or unlock a wallet to post your thesis.")}</div>}
          {err && <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>{err}</div>}
          {theses === null ? <Empty>{T("Loading…")}</Empty> : thesisThreads.length === 0 ? <Empty>{T("No theses yet — be the first to call it.")}</Empty> : thesisThreads.map(({ head, older }) => (
            <div key={head.id}>
              {thesisCard(head)}
              {older.length > 0 && (expanded.has(head.author)
                ? older.map(o => thesisCard(o, true))
                : <button onClick={() => setExpanded(s => new Set(s).add(head.author))} style={{ marginLeft: 42, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.72rem' }}>↳ {older.length}{' '}{T("older")}</button>)}
            </div>
          ))}
        </div>
      )}

      {tab === 'traders' && (traders.length === 0 ? <Empty>{T("No traders in the recent window yet.")}</Empty> : (
        <div style={{ overflow: 'auto', maxHeight: 480 }}>
          <div style={{ padding: '8px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("From the")}{' '}{rows.length}{' '}{T("most recent trades on this pool.")}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 520 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--adx-card-border)' }}>{['#', T('Trader'), T('Bought'), T('Sold'), T('Net flow'), T('Trades'), T('Last')].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {traders.map((t, i) => {
                const net = t.sold - t.bought
                return (
                  <tr key={t.address} style={{ borderBottom: '1px solid var(--adx-card-border)' }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={td}><Who address={t.address} profiles={profiles} navigate={navigate} creator={creator} /></td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{usd(t.bought)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--red)' }}>{usd(t.sold)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: net >= 0 ? 'var(--green)' : 'var(--red)' }}>{net >= 0 ? '+' : ''}{usd(net)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{t.n}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(t.last)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.84rem' }}>{children}</div>
}
