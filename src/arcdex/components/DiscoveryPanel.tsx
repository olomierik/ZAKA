import { useEffect, useMemo, useRef, useState } from 'react'
import Avatar from './Avatar'
import FeedList, { ago } from './FeedList'
import {
  getClanLeaderboard, getFollowing, getLeaderboard, getMostHeld, getProfiles, getTrades, triggerIndex,
  type ClanRank, type IndexedTrade, type LeaderRow, type Period, type Profile,
} from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { loadBlueChips, useMarket, type TokenMeta } from '../lib/tokenMeta'
import { setPrefs, toggleWatch, usePrefs } from '../lib/prefs'
import { copycatOf } from '../api/argusMarket'
import type { Page } from '../App'

// The fomo-style discovery panel: Alerts · Tokens · Leaderboard · Feed on
// the left of every page. Collapsible, and splittable into two columns.

type Tab = 'alerts' | 'tokens' | 'leaderboard' | 'feed'
type List = 'watchlist' | 'crypto' | 'trending' | 'mostheld' | 'graduated' | 'bonding'

const money = (n: number | null | undefined) => n == null ? '—' : `$${n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`
const signed = (n: number) => `${n < 0 ? '-' : '+'}${money(Math.abs(n))}`
const price = (p: number) => !p ? '$0' : p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${p.toPrecision(3)}`

export default function DiscoveryPanel({ navigate, initialTab = 'tokens' }: { navigate: (p: Page) => void; initialTab?: Tab }) {
  const prefs = usePrefs()
  if (prefs.discoveryCollapsed) {
    return (
      <button onClick={() => setPrefs({ discoveryCollapsed: false })} title="Open discovery panel" className="discovery-collapsed">»</button>
    )
  }
  return (
    <div className={`discovery${prefs.discoverySplit ? ' split' : ''}`}>
      <Column navigate={navigate} initial={initialTab} primary />
      {prefs.discoverySplit && <Column navigate={navigate} initial="feed" />}
    </div>
  )
}

function Column({ navigate, initial, primary = false }: { navigate: (p: Page) => void; initial: Tab; primary?: boolean }) {
  const prefs = usePrefs()
  const [tab, setTab] = useState<Tab>(initial)
  const tabBtn = (t: Tab, label: string) => (
    <button onClick={() => setTab(t)} className={`disc-tab${tab === t ? ' active' : ''}`}>{label}</button>
  )
  return (
    <div className="disc-col">
      <div className="disc-tabs">
        {tabBtn('alerts', '🔔 Alerts')}{tabBtn('tokens', 'Tokens')}{tabBtn('leaderboard', 'Leaderboard')}{tabBtn('feed', 'Feed')}
        <span style={{ flex: 1 }} />
        {primary && <button className="disc-icon" title="Collapse" onClick={() => setPrefs({ discoveryCollapsed: true })}>«</button>}
      </div>
      <div className="disc-body">
        {tab === 'alerts' && <Alerts navigate={navigate} />}
        {tab === 'tokens' && <Tokens navigate={navigate} />}
        {tab === 'leaderboard' && <Board navigate={navigate} />}
        {tab === 'feed' && <FeedList navigate={navigate} compact />}
      </div>
      {primary && (
        <div className="disc-foot">
          <button className="disc-foot-btn" onClick={() => setPrefs(p => ({ discoverySplit: !p.discoverySplit }))}>{prefs.discoverySplit ? '▭ Single column' : '◫ Split into 2 columns'}</button>
        </div>
      )}
    </div>
  )
}

// ── Tokens ──────────────────────────────────────────────────────────

function Tokens({ navigate }: { navigate: (p: Page) => void }) {
  const prefs = usePrefs()
  const market = useMarket()
  const [list, setList] = useState<List>('trending')
  const [chips, setChips] = useState<TokenMeta[]>([])
  const [held, setHeld] = useState<{ token: string; holders: number }[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => { if (list === 'crypto') void loadBlueChips().then(setChips) }, [list])
  useEffect(() => { if (list === 'mostheld') { triggerIndex(); void getMostHeld(50).then(setHeld).catch(() => setHeld([])) } }, [list])

  const byAddr = useMemo(() => new Map([...market, ...chips].map(t => [t.address, t])), [market, chips])
  const rows: (TokenMeta & { note?: string })[] = useMemo(() => {
    switch (list) {
      case 'trending': return market
      case 'crypto': return chips
      case 'graduated': return market.filter(t => t.bonded === true)
      case 'bonding': return market.filter(t => t.bonded === false)
      case 'watchlist': return prefs.watchlist.map(a => byAddr.get(a)).filter((t): t is TokenMeta => !!t)
      case 'mostheld': return held.map(h => { const t = byAddr.get(h.token); return t ? { ...t, note: `${h.holders} holder${h.holders === 1 ? '' : 's'}` } : null }).filter(Boolean) as (TokenMeta & { note?: string })[]
    }
  }, [list, market, chips, held, prefs.watchlist, byAddr])

  const sub = (l: List, label: string) => <button onClick={() => setList(l)} className={`disc-sub${list === l ? ' active' : ''}`}>{label}</button>
  const banner = list === 'graduated' ? 'Newly graduated coins are highly volatile. Coins can be launched by anyone, including bad actors.'
    : list === 'bonding' ? 'Coins still on their launch curve are highly volatile and may never graduate. Anyone can launch one.' : null

  return (
    <>
      <div className="disc-subs">
        {sub('watchlist', 'Watchlist')}{sub('crypto', 'Crypto')}{sub('trending', 'Trending')}{sub('mostheld', 'Most held')}{sub('graduated', 'Graduated')}{sub('bonding', 'Bonding')}
      </div>
      {banner && !dismissed.has(list) && (
        <div className="disc-caution"><b>⚠ Trade with caution</b><span>{banner}</span><button onClick={() => setDismissed(s => new Set(s).add(list))}>✕</button></div>
      )}
      {list === 'crypto' && <div className="disc-note">Blue chips on Arc — gas is paid in USDC, no other token needed.</div>}
      {rows.length === 0 ? (
        <div className="disc-empty">
          {list === 'watchlist' ? 'Star ☆ a coin to add it to your watchlist.'
            : list === 'mostheld' ? 'Coins held by the most ARCDEX traders show up here.'
            : list === 'graduated' || list === 'bonding' ? (market.some(t => t.bonded != null) ? 'None right now.' : 'Loading launch status…')
            : 'Loading…'}
        </div>
      ) : rows.map(t => {
        const copy = copycatOf(t.symbol, t.address)
        const starred = prefs.watchlist.includes(t.address)
        return (
          <div key={t.address} className="disc-row" onClick={() => navigate({ name: 'argus', address: t.address, pool: t.pool })}>
            {t.image ? <img src={t.image} alt="" className="disc-img" /> : <Avatar address={t.address} size={32} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="disc-sym">{t.symbol}{copy && <span title={`Not the real ${copy}`} style={{ color: '#fcd34d' }}> ⚠</span>}</div>
              <div className="disc-sub2">{t.note ?? price(t.priceUsd)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="disc-mc">{money(t.marketCapUsd)} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>MC</span></div>
              <div style={{ fontSize: '0.7rem', color: t.change24h >= 0 ? 'var(--green)' : 'var(--red)' }}>{t.change24h >= 0 ? '▲' : '▼'} {Math.abs(t.change24h).toFixed(2)}%</div>
            </div>
            <button className="disc-star" title={starred ? 'Remove from watchlist' : 'Add to watchlist'} onClick={e => { e.stopPropagation(); toggleWatch(t.address) }}>{starred ? '★' : '☆'}</button>
          </div>
        )
      })}
    </>
  )
}

// ── Leaderboard (clans + traders) ────────────────────────────────────

function Board({ navigate }: { navigate: (p: Page) => void }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const [period, setPeriod] = useState<Period>('24h')
  const [clans, setClans] = useState<ClanRank[]>([])
  const [rows, setRows] = useState<LeaderRow[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())

  useEffect(() => {
    let alive = true
    setRows(null)
    triggerIndex()
    void Promise.all([getLeaderboard(period, 50).catch(() => []), getClanLeaderboard(period, 6).catch(() => [])]).then(async ([r, c]) => {
      if (!alive) return
      setRows(r); setClans(c)
      setProfiles(await getProfiles(r.map(x => x.trader)).catch(() => new Map()))
    })
    return () => { alive = false }
  }, [period])

  const myRank = rows && me ? rows.findIndex(r => r.trader === me) : -1
  return (
    <>
      <div className="disc-section">
        <span>Clans <span className="disc-new">New</span></span>
        <button onClick={() => navigate({ name: 'clans' })} className="disc-link">View all ›</button>
      </div>
      {clans.length === 0 ? <div className="disc-empty" style={{ padding: '6px 12px 10px' }}>No clans yet — <button className="disc-link" onClick={() => navigate({ name: 'clans' })}>start one</button></div> : (
        <div className="disc-clans">
          {clans.map((c, i) => (
            <button key={c.clan_id} className="disc-clan" onClick={() => navigate({ name: 'clan', slug: c.slug })}>
              {c.avatar_url ? <img src={c.avatar_url} alt="" /> : <Avatar address={c.clan_id.replace(/-/g, '').padEnd(40, '0').slice(0, 40)} size={30} />}
              <div style={{ minWidth: 0, textAlign: 'left' }}>
                <div className="disc-clan-name">{i < 3 ? ['🥇', '🥈', '🥉'][i] + ' ' : ''}{c.name}</div>
                <div className="disc-sub2">👥 {c.members} · <span style={{ color: c.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(c.realized_pnl)}</span></div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="disc-periods">
        {(['24h', '7d', '30d', 'all'] as Period[]).map(p => <button key={p} onClick={() => setPeriod(p)} className={`disc-sub${period === p ? ' active' : ''}`}>{p.toUpperCase()}</button>)}
      </div>
      {me && rows && (
        <div className="disc-row" style={{ cursor: 'default', background: 'rgba(59,130,246,0.08)' }}>
          <Avatar address={me} size={28} />
          <div style={{ flex: 1 }}><div className="disc-sub2">Your rank</div><b>{myRank >= 0 ? `#${myRank + 1}` : '—'}</b></div>
          <div style={{ textAlign: 'right' }}><div className="disc-sub2">PnL</div><b className="sensitive">{myRank >= 0 ? signed(rows[myRank].realized_pnl) : '—'}</b></div>
        </div>
      )}
      {rows === null ? <div className="disc-empty">Loading…</div> : rows.length === 0 ? <div className="disc-empty">No trades in this period yet.</div> : rows.map((r, i) => {
        const p = profiles.get(r.trader)
        return (
          <div key={r.trader} className="disc-row" onClick={() => navigate({ name: 'trader', address: r.trader })}>
            <span style={{ width: 18, fontWeight: 800, color: i < 3 ? ['#facc15', '#cbd5e1', '#d97706'][i] : 'var(--text-muted)', fontSize: '0.76rem' }}>{i + 1}</span>
            <Avatar address={r.trader} url={p?.avatar_url} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="disc-sym">{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(r.trader))}</div>
              {p?.username && <div className="disc-sub2">@{p.username}</div>}
            </div>
            <b style={{ color: r.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{signed(r.realized_pnl)}</b>
          </div>
        )
      })}
    </>
  )
}

// ── Alerts: moves by traders you follow ──────────────────────────────

interface Alert { key: string; token: string; side: 'buy' | 'sell'; traders: string[]; usdc: number; tokenAmount: number; at: number }

function beep() {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 880; g.gain.value = 0.06
    o.connect(g); g.connect(ctx.destination); o.start()
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    o.stop(ctx.currentTime + 0.26)
  } catch { /* audio blocked */ }
}

function Alerts({ navigate }: { navigate: (p: Page) => void }) {
  const me = useTrader().address?.toLowerCase() ?? null
  const prefs = usePrefs()
  const market = useMarket()
  const meta = useMemo(() => new Map(market.map(t => [t.address, t])), [market])
  const [scope, setScope] = useState<'following' | 'everyone'>(me ? 'following' : 'everyone')
  const [trades, setTrades] = useState<IndexedTrade[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    let alive = true
    seen.current = null
    setTrades(null)
    const load = async () => {
      triggerIndex()
      const who = scope === 'following' && me ? await getFollowing(me).catch(() => []) : undefined
      const t = await getTrades({ traders: who, limit: 120 }).catch(() => [])
      if (!alive) return
      // New alerts since last poll → sound.
      const keys = new Set(t.map(x => x.tx_hash + x.log_index))
      if (seen.current && prefs.alertSound && [...keys].some(k => !seen.current!.has(k))) beep()
      seen.current = keys
      setTrades(t)
      setProfiles(await getProfiles(t.map(x => x.trader)).catch(() => new Map()))
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [scope, me, prefs.alertSound])

  // Group same coin + side within 15 minutes → "3 traders bought $X".
  const alerts = useMemo(() => {
    const out: Alert[] = []
    for (const t of (trades ?? []).filter(x => x.usdc >= prefs.alertMinUsd)) {
      const at = Date.parse(t.block_time)
      const g = out.find(a => a.token === t.token && a.side === t.side && Math.abs(a.at - at) < 15 * 60_000)
      const tok = Number(t.token_amount) / 1e18
      if (g) { if (!g.traders.includes(t.trader)) g.traders.push(t.trader); g.usdc += t.usdc; g.tokenAmount += tok; g.at = Math.max(g.at, at) }
      else out.push({ key: t.tx_hash + t.log_index, token: t.token, side: t.side, traders: [t.trader], usdc: t.usdc, tokenAmount: tok, at })
    }
    return out
  }, [trades, prefs.alertMinUsd])

  return (
    <>
      <div className="disc-alert-bar">
        <select value={scope} onChange={e => setScope(e.target.value as 'following' | 'everyone')} className="disc-select">
          <option value="following">👥 Following</option>
          <option value="everyone">🌐 Everyone</option>
        </select>
        <select value={prefs.alertMinUsd} onChange={e => setPrefs({ alertMinUsd: Number(e.target.value) })} className="disc-select">
          {[0, 10, 100, 1000].map(v => <option key={v} value={v}>{v === 0 ? 'Any size' : `>$${v >= 1000 ? '1K' : v}`}</option>)}
        </select>
        <button className="disc-icon" title={prefs.alertSound ? 'Sound on' : 'Sound off'} onClick={() => { setPrefs(p => ({ alertSound: !p.alertSound })); if (!prefs.alertSound) beep() }}>{prefs.alertSound ? '🔊' : '🔈'}</button>
      </div>
      {scope === 'following' && !me ? <div className="disc-empty">Connect or unlock a wallet, then follow traders to get alerts.</div>
        : trades === null ? <div className="disc-empty">Loading…</div>
        : alerts.length === 0 ? <div className="disc-empty">{scope === 'following' ? 'No moves yet from traders you follow. Follow top traders from the Leaderboard.' : 'No trades on ARCDEX yet.'}</div>
        : alerts.map(a => {
          const m = meta.get(a.token)
          const priceAt = a.tokenAmount > 0 ? (a.usdc / a.tokenAmount) : 0
          const mcAt = m && m.priceUsd > 0 && m.marketCapUsd ? priceAt * (m.marketCapUsd / m.priceUsd) : null
          return (
            <div key={a.key} className="disc-row" onClick={() => a.traders.length === 1 ? navigate({ name: 'trader', address: a.traders[0] }) : navigate({ name: 'argus', address: a.token, pool: m?.pool ?? '' })}>
              <div style={{ display: 'flex', width: 34 }}>{a.traders.slice(0, 3).map(t => <span key={t} style={{ marginRight: -12 }}><Avatar address={t} url={profiles.get(t)?.avatar_url} size={22} /></span>)}</div>
              <div style={{ flex: 1, minWidth: 0, fontSize: '0.78rem' }}>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{a.traders.length > 1 ? `${a.traders.length} traders` : (profiles.get(a.traders[0])?.username ? `@${profiles.get(a.traders[0])!.username}` : shortAddr(a.traders[0]))}</b>
                  <span style={{ fontSize: '0.64rem', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: a.side === 'buy' ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)', color: a.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>{a.side === 'buy' ? 'Buy' : 'Sell'}</span>
                  <b className="sensitive">{money(a.usdc)}</b>
                </div>
                <div className="disc-sub2">${m?.symbol ?? shortAddr(a.token)}{mcAt ? ` at ${money(mcAt)} MC` : ''}</div>
              </div>
              <span className="disc-sub2">{ago(a.at)}</span>
            </div>
          )
        })}
    </>
  )
}
