import { useEffect, useMemo, useRef, useState } from 'react'
import Avatar from './Avatar'
import { getFollowing, searchClans, searchProfiles, socialWrite, type Clan, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { loadBlueChips, useMarket, type TokenMeta } from '../lib/tokenMeta'
import { setPrefs, usePrefs } from '../lib/prefs'
import type { Page } from '../App'

// fomo-style search: recently viewed coins when empty; otherwise coins,
// traders and clans (All / Tokens / Users / Clans), with Follow inline.
// "/" focuses it from anywhere; Esc closes.

type Tab = 'all' | 'tokens' | 'users' | 'clans'
const money = (n: number | null) => n == null ? '—' : `$${n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`

export default function SearchBox({ navigate, mobileOpen = false }: { navigate: (p: Page) => void; mobileOpen?: boolean }) {
  const trader = useTrader()
  const prefs = usePrefs()
  const market = useMarket()
  const [chips, setChips] = useState<TokenMeta[]>([])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('all')
  const [users, setUsers] = useState<Profile[]>([])
  const [clans, setClans] = useState<Clan[]>([])
  const [following, setFollowing] = useState<Set<string>>(new Set())
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { void loadBlueChips().then(setChips) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) { e.preventDefault(); input.current?.focus(); setOpen(true) }
      if (e.key === 'Escape') { setOpen(false); input.current?.blur() }
    }
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [])
  useEffect(() => { if (open && trader.address) void getFollowing(trader.address).then(f => setFollowing(new Set(f))).catch(() => {}) }, [open, trader.address])

  const s = q.trim().toLowerCase()
  useEffect(() => {
    if (s.length < 2) { setUsers([]); setClans([]); return }
    let alive = true
    const id = setTimeout(() => {
      void searchProfiles(s.replace(/^@/, ''), 8).then(u => { if (alive) setUsers(u) }).catch(() => {})
      void searchClans(s, 6).then(c => { if (alive) setClans(c) }).catch(() => {})
    }, 250)
    return () => { alive = false; clearTimeout(id) }
  }, [s])

  const tokens = useMemo(() => {
    if (!s) return []
    const all = [...chips, ...market.filter(m => !chips.some(c => c.address === m.address))]
    return all.filter(t => t.address === s || t.symbol.toLowerCase().includes(s.replace(/^\$/, '')) || t.name.toLowerCase().includes(s)).slice(0, 12)
  }, [s, market, chips])
  const isAddr = /^0x[0-9a-f]{40}$/.test(s)

  const openToken = (t: { address: string; pool: string | null }) => { setOpen(false); setQ(''); navigate({ name: 'argus', address: t.address, pool: t.pool ?? '' }) }
  const follow = async (a: string) => {
    const on = following.has(a)
    setFollowing(f => { const n = new Set(f); if (on) n.delete(a); else n.add(a); return n })
    try { await socialWrite(trader, on ? 'unfollow' : 'follow', { target: a }) } catch { setFollowing(f => { const n = new Set(f); if (on) n.add(a); else n.delete(a); return n }) }
  }

  const tokenRow = (t: TokenMeta | { address: string; symbol: string; image: string | null; pool: string | null; priceUsd?: number; marketCapUsd?: number | null; change24h?: number }) => (
    <button key={t.address} className="menu-item" onClick={() => openToken(t)}>
      {t.image ? <img src={t.image} alt="" style={{ width: 26, height: 26, borderRadius: '50%' }} /> : <Avatar address={t.address} size={26} />}
      <span style={{ minWidth: 0, flex: 1 }}><b>{t.symbol}</b> <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontFamily: 'var(--mono)' }}>{shortAddr(t.address)}</span></span>
      {'marketCapUsd' in t && <span style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>MC {money(t.marketCapUsd ?? null)}</span>}
      {'change24h' in t && t.change24h != null && <span style={{ fontSize: '0.72rem', width: 60, textAlign: 'right', color: t.change24h >= 0 ? 'var(--green)' : 'var(--red)' }}>{t.change24h >= 0 ? '+' : ''}{t.change24h.toFixed(1)}%</span>}
    </button>
  )

  return (
    <div ref={box} className={`navbar-search-wrap${mobileOpen ? ' open' : ''}`} style={{ position: 'relative' }}>
      <input ref={input} className="navbar-search" value={q} placeholder="Search tokens or traders…   /"
        onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={e => { if (e.key === 'Enter' && isAddr) openToken({ address: s, pool: tokens[0]?.pool ?? '' }) }} />
      {open && (
        <div className="menu-pop" style={{ top: 36, left: 0, right: 0, minWidth: 320, maxHeight: 460, overflowY: 'auto' }}>
          {!s ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                <span>Recents</span>{prefs.recents.length > 0 && <button className="disc-link" onClick={() => setPrefs({ recents: [] })}>Clear all</button>}
              </div>
              {prefs.recents.length === 0 ? <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>Coins you open show up here. Paste a contract address or type a name.</div>
                : prefs.recents.map(r => tokenRow({ ...r, ...(market.find(m => m.address === r.address) ?? {}) }))}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 4, padding: '2px 4px 6px' }}>
                {(['all', 'tokens', 'users', 'clans'] as Tab[]).map(t => <button key={t} onClick={() => setTab(t)} className={`disc-sub${tab === t ? ' active' : ''}`}>{t[0].toUpperCase() + t.slice(1)}</button>)}
              </div>
              {(tab === 'all' || tab === 'tokens') && (tokens.length ? tokens.map(tokenRow) : isAddr ? tokenRow({ address: s, symbol: 'Open token', image: null, pool: '' }) : tab === 'tokens' ? <Nothing /> : null)}
              {(tab === 'all' || tab === 'users') && (users.length ? users.map(u => (
                <div key={u.address} className="menu-item" style={{ cursor: 'default' }}>
                  <button onClick={() => { setOpen(false); setQ(''); navigate({ name: 'trader', address: u.address }) }} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, flex: 1, minWidth: 0 }}>
                    <Avatar address={u.address} url={u.avatar_url} size={26} />
                    <span style={{ textAlign: 'left' }}><b>{u.display_name || `@${u.username}`}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>@{u.username}</div></span>
                  </button>
                  {trader.address && trader.address.toLowerCase() !== u.address && (
                    <button className={`rail-follow${following.has(u.address) ? ' on' : ''}`} onClick={() => void follow(u.address)}>{following.has(u.address) ? 'Following' : 'Follow'}</button>
                  )}
                </div>
              )) : isAddr ? (
                <button className="menu-item" onClick={() => { setOpen(false); setQ(''); navigate({ name: 'trader', address: s }) }}><Avatar address={s} size={26} /> View trader {shortAddr(s)}</button>
              ) : tab === 'users' ? <Nothing /> : null)}
              {(tab === 'all' || tab === 'clans') && (clans.length ? clans.map(c => (
                <button key={c.id} className="menu-item" onClick={() => { setOpen(false); setQ(''); navigate({ name: 'clan', slug: c.slug }) }}>
                  {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: 26, height: 26, borderRadius: 6 }} /> : <span style={{ width: 26, textAlign: 'center' }}>⚑</span>}
                  <b>{c.name}</b><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>clan</span>
                </button>
              )) : tab === 'clans' ? <Nothing /> : null)}
              {tab === 'all' && !tokens.length && !users.length && !clans.length && !isAddr && <Nothing />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Nothing() { return <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>No matches.</div> }
