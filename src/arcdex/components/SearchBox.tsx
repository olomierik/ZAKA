import { useEffect, useMemo, useRef, useState } from 'react'
import Avatar from './Avatar'
import { ChainIcon } from './Chains'
import { getFollowing, searchClans, searchProfiles, socialWrite, type Clan, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { loadBlueChips, useMarket, type TokenMeta } from '../lib/tokenMeta'
import { useRecentLaunches } from '../api/marketStream'
import { setPrefs, usePrefs } from '../lib/prefs'
import { useCoinFinder, type CoinChain, type FoundCoin } from '../lib/coinFinder'
import type { Page } from '../App'
import { t as T, N_ } from '../lib/i18n'
import { logoSrc } from '../lib/logo'

// fomo-style search: recently viewed coins when empty; otherwise coins,
// traders and clans (All / Tokens / Users / Clans), with Follow inline.
// Coins come from everywhere (lib/coinFinder.ts): by name, ticker or any
// contract address, even one no list has, on every chain ARCDEX lists (Arc,
// Robinhood Chain, Solana, BNB Chain). "/" focuses it; Enter opens the best
// match; Esc closes.

type Tab = 'all' | 'tokens' | 'users' | 'clans'
const CHAIN_ICON: Record<Exclude<CoinChain, 'arc'>, string> = { robinhood: 'Robinhood', solana: 'Solana', bsc: 'BNB' }
const isSolAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !/^0x/.test(s)
const money = (n: number | null) => n == null ? '—' : `$${n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`

export default function SearchBox({ navigate, mobileOpen = false }: { navigate: (p: Page) => void; mobileOpen?: boolean }) {
  const trader = useTrader()
  const prefs = usePrefs()
  const market = useMarket()
  // Launches the market engine just detected — searchable before any list has them.
  const launches = useRecentLaunches()
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

  // Everything this page already knows, searched at once; the finder adds the engine, GeckoTerminal and the chain.
  const local = useMemo<FoundCoin[]>(() => {
    const seen = new Set<string>()
    const out: FoundCoin[] = []
    const add = (c: FoundCoin) => { if (!seen.has(c.address)) { seen.add(c.address); out.push(c) } }
    const fromMeta = (t: TokenMeta, trusted = false): FoundCoin => ({ address: t.address.toLowerCase(), symbol: t.symbol, name: t.name, image: t.image, pool: t.pool || null, launchpad: t.launchpad, trusted, priceUsd: t.priceUsd || null, marketCapUsd: t.marketCapUsd, liquidityUsd: t.liquidityUsd || null, change24h: t.change24h, source: 'local' })
    chips.forEach(c => add(fromMeta(c, true)))
    market.forEach(m => add(fromMeta(m)))
    launches.forEach(l => add({ address: l.token.toLowerCase(), symbol: l.symbol, name: l.name, image: l.image ?? null, pool: l.pool ?? null, launchpad: l.launchpad, priceUsd: l.priceUsd ?? null, marketCapUsd: l.marketCapUsd ?? null, liquidityUsd: null, change24h: null, source: 'local' }))
    return out
  }, [market, chips, launches])
  const { results: tokens, searching, noToken, notLaunchpad } = useCoinFinder(q, local, 12)
  const isAddr = /^0x[0-9a-f]{40}$/.test(s)
  const solAddr = isSolAddress(q.trim()) ? q.trim() : ''

  // Each chain's coin page: Arc's spot screen, or Robinhood Chain's, Solana's or BNB Chain's.
  const openToken = (t: { address: string; pool: string | null; chain?: CoinChain }) => {
    setOpen(false); setQ('')
    const pool = t.pool ?? ''
    if (t.chain === 'robinhood') navigate({ name: 'rh-token', address: t.address, pool })
    else if (t.chain === 'solana') navigate({ name: 'sol-token', address: t.address, pool })
    else if (t.chain === 'bsc') navigate({ name: 'bsc-token', address: t.address, pool })
    else navigate({ name: 'argus', address: t.address, pool })
  }
  const follow = async (a: string) => {
    const on = following.has(a)
    setFollowing(f => { const n = new Set(f); if (on) n.delete(a); else n.add(a); return n })
    try { await socialWrite(trader, on ? 'unfollow' : 'follow', { target: a }) } catch { setFollowing(f => { const n = new Set(f); if (on) n.add(a); else n.delete(a); return n }) }
  }

  const tokenRow = (t: { address: string; symbol: string; name?: string; image: string | null; pool: string | null; launchpad?: string | null; marketCapUsd?: number | null; change24h?: number | null; chain?: CoinChain }) => (
    <button key={`${t.chain ?? 'arc'}:${t.address}`} className="menu-item" onClick={() => openToken(t)}>
      {t.image ? <img src={logoSrc(t.image, 26) ?? t.image} alt="" style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0 }} /> : <Avatar address={t.address} size={26} />}
      <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.chain && t.chain !== 'arc' && <span style={{ marginRight: 5, verticalAlign: '-2px' }}><ChainIcon chain={CHAIN_ICON[t.chain]} size={14} /></span>}<b>{t.symbol}</b>{t.name && t.name !== t.symbol ? <span style={{ color: 'var(--text-muted)', fontSize: '0.74rem' }}> {t.name}</span> : null}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem', fontFamily: 'var(--mono)' }}>{shortAddr(t.address)}{t.launchpad ? ` · ${t.launchpad}` : ''}</span>
      </span>
      {t.marketCapUsd != null && <span style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)', flexShrink: 0 }}>{T("MC")}{' '}{money(t.marketCapUsd)}</span>}
      {t.change24h != null && <span style={{ fontSize: '0.72rem', width: 56, textAlign: 'right', flexShrink: 0, color: t.change24h >= 0 ? 'var(--green)' : 'var(--red)' }}>{t.change24h >= 0 ? '+' : ''}{t.change24h.toFixed(1)}%</span>}
    </button>
  )

  return (
    <div ref={box} className={`navbar-search-wrap${mobileOpen ? ' open' : ''}`}>
      <input ref={input} className="navbar-search" value={q} placeholder={T("Search tokens or traders…   /")}
        onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={e => {
          if (e.key !== 'Enter') return
          if (tokens[0]) openToken(tokens[0])
          else if (isAddr) openToken({ address: s, pool: '' })
          else if (solAddr) openToken({ address: solAddr, pool: '', chain: 'solana' })
        }} />
      {open && (
        <div className="menu-pop search-pop" style={{ top: 36, left: 0, right: 0, maxHeight: 460, overflowY: 'auto' }}>
          {!s ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                <span>{T("Recents")}</span>{prefs.recents.length > 0 && <button className="disc-link" onClick={() => setPrefs({ recents: [] })}>{T("Clear all")}</button>}
              </div>
              {prefs.recents.length === 0 ? <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T("Coins you open show up here. Paste a contract address or type a name.")}</div>
                : prefs.recents.map(r => tokenRow({ ...r, ...(market.find(m => m.address === r.address) ?? {}) }))}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 4, padding: '2px 4px 6px' }}>
                {([['all', N_('All')], ['tokens', N_('Tokens')], ['users', N_('Users')], ['clans', N_('Clans')]] as [Tab, string][]).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`disc-sub${tab === k ? ' active' : ''}`}>{T(l)}</button>)}
              </div>
              {(tab === 'all' || tab === 'tokens') && (tokens.length ? tokens.map(tokenRow)
                : searching ? <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T('Searching every chain…')}</div>
                : solAddr ? <button className="menu-item" onClick={() => openToken({ address: solAddr, pool: '', chain: 'solana' })}><ChainIcon chain="Solana" size={20} />{' '}{T('Open {a} on Solana', { a: `${solAddr.slice(0, 4)}…${solAddr.slice(-4)}` })}</button>
                : noToken ? <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T('No listed coin at this address on any chain. It may be a wallet: see it below.')}</div>
                : notLaunchpad ? <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T('This token wasn’t launched on a launchpad, so ARCDEX doesn’t list it: coins from unknown contracts can be malicious.')}</div>
                : tab === 'tokens' ? <Nothing /> : null)}
              {(tab === 'all' || tab === 'users') && (users.length ? users.map(u => (
                <div key={u.address} className="menu-item" style={{ cursor: 'default' }}>
                  <button onClick={() => { setOpen(false); setQ(''); navigate({ name: 'trader', address: u.address }) }} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, flex: 1, minWidth: 0 }}>
                    <Avatar address={u.address} url={u.avatar_url} size={26} />
                    <span style={{ textAlign: 'left' }}><b>{u.display_name || `@${u.username}`}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>@{u.username}</div></span>
                  </button>
                  {trader.address && trader.address.toLowerCase() !== u.address && (
                    <button className={`rail-follow${following.has(u.address) ? ' on' : ''}`} onClick={() => void follow(u.address)}>{following.has(u.address) ? T("Following") : T("Follow")}</button>
                  )}
                </div>
              )) : isAddr ? (
                <button className="menu-item" onClick={() => { setOpen(false); setQ(''); navigate({ name: 'trader', address: s }) }}><Avatar address={s} size={26} />{' '}{T("View trader")}{' '}{shortAddr(s)}</button>
              ) : tab === 'users' ? <Nothing /> : null)}
              {(tab === 'all' || tab === 'clans') && (clans.length ? clans.map(c => (
                <button key={c.id} className="menu-item" onClick={() => { setOpen(false); setQ(''); navigate({ name: 'clan', slug: c.slug }) }}>
                  {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: 26, height: 26, borderRadius: 6 }} /> : <span style={{ width: 26, textAlign: 'center' }}>⚑</span>}
                  <b>{c.name}</b><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("clan")}</span>
                </button>
              )) : tab === 'clans' ? <Nothing /> : null)}
              {tab === 'all' && !tokens.length && !users.length && !clans.length && !isAddr && !searching && <Nothing />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Nothing() { return <div style={{ padding: 12, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T("No matches.")}</div> }
