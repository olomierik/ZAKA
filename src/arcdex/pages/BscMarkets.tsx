// Markets on BNB Chain (2026-10-05, owner: "go for BNB Chain"): four.meme's coins, on Solana's page layout
// (SolanaMarkets.tsx), with each coin's curve progress and graduation from four.meme's own contract. Data from the
// engine (api/bscMarket.ts); each coin opens its own page, where a graduated coin is bought with USDC on Arc, BNB or
// USDT (through Relay) and a coin on its curve with BNB on four.meme's contract.

import { useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import { cachedBscMarket, isWashBsc, loadBscMarket, searchBsc, type BscCoin } from '../api/bscMarket'
import { ChainSwitch, RhLogo } from '../components/Robinhood'
import SafetyBadge from '../components/SafetyBadge'
import CoinBoard, { type BoardCoin } from '../components/CoinBoard'
import { bscStage, bscStageInput, type Stage } from '../lib/coinStage'
import { isListable, isRugged, LISTING, meetsStandard, bscSafety, SAFETY_COLOR, SAFETY_ICON, type SafetyView } from '../lib/safety'
import { markDupes } from '../lib/dupes'
import { bscToken } from '../lib/bsc'
import { useIsMobile } from '../lib/useMobile'
import { t as T, N_ } from '../lib/i18n'

const TABS = [N_('All'), N_('New'), N_('Near bond'), N_('Bonding'), N_('Graduated'), N_('Established')] as const
const STAGE_TAB: Partial<Record<string, Stage>> = { New: 'new', 'Near bond': 'near', Bonding: 'bonding', Graduated: 'graduated', Established: 'established' }
const readPref = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage blocked */ } }
type Tab = typeof TABS[number]
type Sort = 'volume' | 'mcap' | 'liq' | 'change' | 'txns' | 'age' | 'progress'
const PAGE = 50
const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)

function fmt(n: number, prefix = ''): string {
  if (!n || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `${prefix}${n.toFixed(2)}`
  return `${prefix}${n.toPrecision(3)}`
}
function fmtPrice(p: number): string {
  if (!p || !Number.isFinite(p)) return '—'
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (p >= 1) return `$${p.toFixed(4)}`
  return `$${p.toPrecision(4)}`
}
function fmtAge(ms: number): string {
  if (!ms) return ''
  const s = (Date.now() - ms) / 1000
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
const pctColor = (n: number) => (n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-muted)')
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const bscPage = (c: Pick<BscCoin, 'address' | 'pool'>): Page => ({ name: 'bsc-token', address: c.address, pool: c.pool })

export default function BscMarkets({ navigate }: { navigate: (p: Page) => void }) {
  const mobile = useIsMobile()
  const [rows, setRows] = useState<BscCoin[]>(cachedBscMarket)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('All')
  const [sort, setSort] = useState<Sort>('volume')
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [found, setFound] = useState<BscCoin[]>([])
  const [view, setView] = useState<'list' | 'board'>(() => (readPref('arcdex:mk-view') === 'board' ? 'board' : 'list'))
  const [showRisky, setShowRisky] = useState(() => readPref('arcdex:show-risky') === '1')
  useEffect(() => { writePref('arcdex:mk-view', view) }, [view])
  useEffect(() => { writePref('arcdex:show-risky', showRisky ? '1' : '0') }, [showRisky])
  useEffect(() => { document.title = 'BNB Chain | ARCDEX' }, [])

  useEffect(() => {
    let live = true
    const load = () => loadBscMarket(r => { if (live && r.length) setRows(r) }).finally(() => { if (live) setLoading(false) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [])
  useEffect(() => { setShown(PAGE) }, [tab, sort, search])

  const raw = search.trim()
  const q = raw.toLowerCase()
  const isAddr = isEvmAddress(raw)
  const matches = (c: BscCoin) => !q || c.address === q || c.symbol.toLowerCase().includes(q.replace(/^\$/, '')) || c.name.toLowerCase().includes(q)

  const rated = useMemo(() => new Map(rows.map(c => [c.address, bscSafety(c)])), [rows])
  const safetyOf = (c: BscCoin): SafetyView => rated.get(c.address) ?? bscSafety(c)
  const standardOn = !showRisky && !q
  // Listed at all (owner, 2026-10-04): $15K or more of market cap and not rugged. A search looks at every coin.
  const listable = (c: BscCoin) => isListable({ official: false, marketCapUsd: c.marketCap, rugged: isRugged({ change24h: c.change24h, liquidityUsd: c.liquidity, onCurve: bscStageInput(c).onCurve }) })
  const passes = (c: BscCoin) => meetsStandard({ level: safetyOf(c).level, stage: bscStage(c), onCurve: bscStageInput(c).onCurve, liquidityUsd: c.liquidity, holders: null })
  const hiddenCount = useMemo(() => (standardOn ? rows.filter(c => listable(c) && !passes(c)).length : 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, standardOn, rated])

  const list = useMemo(() => {
    const now = Date.now()
    let l = showRisky ? rows.slice() : rows.filter(c => !isWashBsc(c, now) || (q && c.address === q))
    if (!q) l = l.filter(listable)
    if (standardOn) l = l.filter(passes)
    if (view === 'list') {
      const st = STAGE_TAB[tab]
      if (st) l = l.filter(c => bscStage(c) === st)
    }
    l = l.filter(matches)
    const key: Record<Sort, (c: BscCoin) => number> = {
      volume: c => c.volume24h, mcap: c => c.marketCap, liq: c => c.liquidity, change: c => c.change24h,
      txns: c => c.buys24h + c.sells24h, age: c => c.createdAt, progress: c => (bscStageInput(c).onCurve ? c.curveProgress ?? 0 : -1),
    }
    const by = key[tab === 'New' && sort === 'volume' ? 'age' : (tab === 'Near bond' || tab === 'Bonding') && sort === 'volume' ? 'progress' : sort]
    return l.slice().sort((a, b) => by(b) - by(a))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, sort, q, view, showRisky, standardOn, rated])

  // Same-ticker coins (lib/dupes.ts): the earliest launched is the OG. GeckoTerminal doesn't name creators here.
  const dupes = useMemo(() => markDupes(list, { key: c => c.address, symbol: c => c.symbol, launchedAt: c => c.createdAt, creator: () => null }), [list])
  const dupTags = (c: BscCoin) => {
    const d = dupes.get(c.address)
    return d?.og ? <span className="mk-tag mk-og" title={T('The first coin launched with this ticker; the others are duplicates.')}>OG</span>
      : d?.dup ? <span className="mk-tag" title={T('A later coin using the OG’s ticker: not the original.')} style={{ color: 'var(--amber)', borderColor: '#f0b90b55' }}>{T('⚠ DUPLICATE')}</span> : null
  }
  const progressTag = (c: BscCoin) => {
    const s = bscStageInput(c)
    return s.onCurve ? <span className="mk-tag sol-curve-tag" title={T('How far along its launchpad’s curve, as the launchpad counts it')}>🚀 {s.progress !== null ? `${Math.floor(s.progress)}%` : T('Bonding')}</span> : null
  }

  // A name or address the list doesn't have: asked of GeckoTerminal (debounced).
  useEffect(() => {
    setFound([])
    if (raw.length < 2 || list.some(c => c.address === q)) return
    const id = setTimeout(() => { searchBsc(raw).then(r => setFound(r.filter(c => !list.some(x => x.address === c.address)).slice(0, 8))).catch(() => {}) }, 600)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw])

  const now = Date.now()
  const live = rows.filter(c => !isWashBsc(c, now) && listable(c) && passes(c))
  const overview: [string, BscCoin[]][] = [
    [`🚀 ${T('Near bond')}`, live.filter(c => bscStage(c) === 'near').sort((a, b) => (b.curveProgress ?? 0) - (a.curveProgress ?? 0)).slice(0, 3)],
    [`🔥 ${T('Hot coins')}`, live.slice().sort((a, b) => (b.buys24h + b.sells24h) - (a.buys24h + a.sells24h)).slice(0, 3)],
    [T('Top gainers'), live.filter(c => c.volume24h >= 5_000 && c.liquidity >= 5_000 && c.createdAt > 0 && c.createdAt < now - 86400_000).sort((a, b) => b.change24h - a.change24h).slice(0, 3)],
  ]

  return (
    <div className="terminal-shell rh-markets sol-markets bsc-markets">
      <div className="mk-head rh-head">
        {!mobile && (
          <div className="mk-overview rh-overview">
            <div className="mk-card rh-how">
              <div className="mk-card-h"><span>{T('How it works')}</span></div>
              <ol>
                <li>{T('Graduated coins: pay with USDC on Arc, BNB or USDT. The coin lands at your same address on BNB Chain.')}</li>
                <li>{T('Coins still on four.meme’s curve: buy and sell with BNB on four.meme’s own contract.')}</li>
                <li>{T('Trades signed on BNB Chain pay gas in BNB: one tap adds some from your Arc USDC.')}</li>
              </ol>
            </div>
            {overview.map(([title, l]) => (
              <div key={title} className="mk-card">
                <div className="mk-card-h"><span>{title}</span></div>
                {l.length === 0 && <div className="mk-card-empty">{loading ? T('Loading…') : '—'}</div>}
                {l.map(c => (
                  <button key={c.address} className="mk-card-row" onClick={() => navigate(bscPage(c))}>
                    <RhLogo src={c.image} symbol={c.symbol} size={18} />
                    <b>{c.symbol}</b>
                    <span className="mk-card-price">{fmtPrice(c.priceUsd)}</span>
                    {bscStage(c) === 'near' ? <span style={{ color: 'var(--accent-text)' }}>{Math.floor(c.curveProgress ?? 0)}%</span> : <span style={{ color: pctColor(c.change24h) }}>{pct(c.change24h)}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mk-toolbar">
        {!mobile && <ChainSwitch chain="bsc" navigate={navigate} />}
        <div className="view-tabs">
          {mobile && <button className="view-tab rh-tab-arc" onClick={() => navigate({ name: 'terminal' })}>◂ Arc</button>}
          {TABS.map(t => (
            <button key={t} className={`view-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{T(t)}</button>
          ))}
        </div>
        <div className="mk-tools">
          <div className="mk-view-switch" role="group" aria-label={T('View')}>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>☰ {T('List')}</button>
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>▦ {T('Board')}</button>
          </div>
          <label className="mk-safe-toggle" title={T('Off: coins rated Danger, and pool coins under ${usd} of liquidity or {holders} holders, are left out.', { usd: LISTING.minLiquidityUsd.toLocaleString(), holders: LISTING.minHolders })}>
            <input type="checkbox" checked={showRisky} onChange={e => setShowRisky(e.target.checked)} /><span>{T('Show risky coins')}</span>
          </label>
          <input className="filter-input mk-search" placeholder={T('🔍 Search…')} value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sort-select" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="volume">{T('Sort: volume')}</option>
            <option value="progress">{T('Sort: bonding progress')}</option>
            <option value="mcap">{T('Sort: market cap')}</option>
            <option value="liq">{T('Sort: liquidity')}</option>
            <option value="change">{T('Sort: 24h change')}</option>
            <option value="txns">{T('Sort: transactions')}</option>
            <option value="age">{T('Sort: newest')}</option>
          </select>
        </div>
      </div>
      {mobile && (
        <div className="rh-mobile-search">
          <input className="filter-input" placeholder={T('🔍 Search…')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      {standardOn && hiddenCount > 0 && (
        <div className="mk-hidden-note">
          {T('Hidden by the safety standard: {n} (rated Danger, or under ${usd} of liquidity or {holders} holders).', { n: hiddenCount, usd: LISTING.minLiquidityUsd.toLocaleString(), holders: LISTING.minHolders })}
          <button onClick={() => setShowRisky(true)}>{T('Show them')}</button>
        </div>
      )}

      {view === 'board' && (
        <CoinBoard mobile={mobile} onOpen={b => { const c = list.find(x => x.address === b.key); if (c) navigate(bscPage(c)) }}
          coins={list.map((c): BoardCoin => ({
            key: c.address, symbol: c.symbol, name: c.name, logo: c.image, launchpad: c.launchpad,
            ageMs: c.createdAt > 0 ? Math.max(0, Date.now() - c.createdAt) : 0, marketCap: c.marketCap, liquidity: c.liquidity, volume24h: c.volume24h,
            change24h: c.change24h, holders: null, traders24h: c.traders24h, progress: bscStageInput(c).progress, stage: bscStage(c), safety: safetyOf(c),
            og: dupes.get(c.address)?.og, dup: dupes.get(c.address)?.dup,
          }))} />
      )}

      {view === 'list' && <div className="table-scroll">
        {list.length === 0 && loading ? (
          <div className="loading-state">{T('Loading BNB Chain…')}</div>
        ) : list.length === 0 && found.length === 0 ? (
          <div className="loading-state">
            {isAddr
              ? <button className="mk-trade mk-trade-solid" onClick={() => navigate({ name: 'bsc-token', address: q, pool: '' })}>{T('Open {a}', { a: short(raw) })}</button>
              : q ? T('No coin matches “{q}”', { q: raw }) : T('No coins to show right now.')}
          </div>
        ) : !mobile ? (
          <table className="token-table">
            <thead>
              <tr>
                <th className="th-rank">#</th>
                <th className="th-token" style={{ textAlign: 'left' }}>{T('Name')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('Price')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('24h change')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('Market cap')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('Liquidity')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('24h volume')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('24h trades')}</th>
                <th className="th-sort" style={{ textAlign: 'right' }}>{T('Safety')}</th>
                <th className="th-sort" />
              </tr>
            </thead>
            <tbody>
              {[...list.slice(0, shown), ...found].map((c, i) => (
                <tr key={c.address} className="token-row" onClick={() => navigate(bscPage(c))}>
                  <td className="td-rank"><span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{i < Math.min(shown, list.length) ? i + 1 : '·'}</span></td>
                  <td className="td-token">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <RhLogo src={c.image} symbol={c.symbol} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          <span className="mk-sym">{c.symbol}</span>
                          <span className="mk-quote">/{c.quoteSymbol || '—'}</span>
                          {c.launchpad && <span className="mk-tag rh-lp-tag">{c.launchpad}</span>}
                          {progressTag(c)}
                          {dupTags(c)}
                        </div>
                        <div className="mk-sub">
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                          {c.createdAt > 0 && <span style={{ flexShrink: 0 }}>· {fmtAge(c.createdAt)}</span>}
                          <a href={bscToken(c.address)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="mk-addr">{short(c.address)} ↗</a>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="td-num mk-price">{fmtPrice(c.priceUsd)}</td>
                  <td className="td-num"><span className="mk-chg" style={{ color: pctColor(c.change24h) }}>{pct(c.change24h)}</span></td>
                  <td className="td-num">{fmt(c.marketCap, '$')}</td>
                  <td className="td-num">{fmt(c.liquidity, '$')}</td>
                  <td className="td-num">{fmt(c.volume24h, '$')}</td>
                  <td className="td-num">
                    <div>{(c.buys24h + c.sells24h).toLocaleString()}</div>
                    <div style={{ fontSize: '0.66rem' }}><span style={{ color: 'var(--green)' }}>{c.buys24h}</span>{' / '}<span style={{ color: 'var(--red)' }}>{c.sells24h}</span></div>
                  </td>
                  <td className="td-num"><SafetyBadge view={safetyOf(c)} /></td>
                  <td className="td-num td-trade"><button className="mk-trade" onClick={e => { e.stopPropagation(); navigate(bscPage(c)) }}>{T('Trade')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="token-cards rh-cards">
            {[...list.slice(0, shown), ...found].map(c => (
              <div key={c.address} className="token-card mk-row" onClick={() => navigate(bscPage(c))}>
                <RhLogo src={c.image} symbol={c.symbol} size={30} />
                <div className="mk-row-name">
                  <div className="mk-row-sym"><b>{c.symbol}</b><span>/{c.quoteSymbol || '—'}</span>{c.launchpad && <span className="mk-tag rh-lp-tag">{c.launchpad}</span>}{progressTag(c)}{dupTags(c)}</div>
                  <div className="mk-row-meta"><span style={{ color: SAFETY_COLOR[safetyOf(c).level] }}>{SAFETY_ICON[safetyOf(c).level]}</span> {T('Vol')} {fmt(c.volume24h, '$')} · {T('MCap')} {fmt(c.marketCap, '$')}</div>
                </div>
                <div className="mk-row-price">{fmtPrice(c.priceUsd)}<small>{c.name.slice(0, 18)}</small></div>
                <span className={`mk-row-chg ${c.change24h > 0 ? 'up' : c.change24h < 0 ? 'down' : 'flat'}`}>{pct(c.change24h)}</span>
              </div>
            ))}
          </div>
        )}
        {shown < list.length && (
          <button className="show-more" onClick={() => setShown(n => n + PAGE)}>{T('Show more')} · {(list.length - shown).toLocaleString()}</button>
        )}
      </div>}
      <p className="rh-source">{T('Prices and trades from GeckoTerminal; curves and graduation read from four.meme’s contract on BNB Chain. Coins on four.meme are launched by anyone: check a coin before you buy it.')}</p>
    </div>
  )
}
