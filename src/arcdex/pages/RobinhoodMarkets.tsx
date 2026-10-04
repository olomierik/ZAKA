// Markets on Robinhood Chain: its coins and Robinhood's stock tokens, in the
// Arc Markets page's layout (Terminal.tsx). Data from GeckoTerminal
// (api/robinhoodMarket.ts); each coin opens its own page, where it's bought
// with USDC on Arc and sold back to USDC on Arc (through Across).

import { useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import { cachedRhMarket, isWashPool, loadRhMarket, searchRh, type RhCoin } from '../api/robinhoodMarket'
import { ChainSwitch, RhLogo, StockTag } from '../components/Robinhood'
import { rhAddress, stockCompany } from '../lib/robinhood'
import { useIsMobile } from '../lib/useMobile'
import { t as T, N_ } from '../lib/i18n'

const TABS = [N_('All'), N_('Memecoins'), N_('Stocks'), N_('New')] as const
type Tab = typeof TABS[number]
type Sort = 'volume' | 'mcap' | 'liq' | 'change' | 'txns' | 'age'
const PAGE = 50

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

const rhPage = (c: Pick<RhCoin, 'address' | 'pool'>): Page => ({ name: 'rh-token', address: c.address, pool: c.pool })

export default function RobinhoodMarkets({ navigate }: { navigate: (p: Page) => void }) {
  const mobile = useIsMobile()
  const [rows, setRows] = useState<RhCoin[]>(cachedRhMarket)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('All')
  const [sort, setSort] = useState<Sort>('volume')
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [found, setFound] = useState<RhCoin[]>([])

  useEffect(() => {
    let live = true
    const load = () => loadRhMarket(r => { if (live && r.length) setRows(r) }).finally(() => { if (live) setLoading(false) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 120_000)
    return () => { live = false; clearInterval(id) }
  }, [])
  useEffect(() => { setShown(PAGE) }, [tab, sort, search])

  const q = search.trim().toLowerCase()
  const isAddr = /^0x[0-9a-f]{40}$/.test(q)
  const matches = (c: RhCoin) => !q || c.address === q || c.symbol.toLowerCase().includes(q.replace(/^\$/, '')) || c.name.toLowerCase().includes(q)

  const list = useMemo(() => {
    const now = Date.now()
    let l = rows.filter(c => !isWashPool(c, now) || (q && c.address === q))
    if (tab === 'Memecoins') l = l.filter(c => !c.stock)
    if (tab === 'Stocks') l = l.filter(c => c.stock)
    if (tab === 'New') l = l.filter(c => c.createdAt > now - 3 * 86400_000)
    l = l.filter(matches)
    const key: Record<Sort, (c: RhCoin) => number> = {
      volume: c => c.volume24h, mcap: c => c.marketCap, liq: c => c.liquidity, change: c => c.change24h,
      txns: c => c.buys24h + c.sells24h, age: c => c.createdAt,
    }
    const by = key[tab === 'New' && sort === 'volume' ? 'age' : sort]
    return l.slice().sort((a, b) => by(b) - by(a))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, sort, q])

  // A name or address the list doesn't have: asked of GeckoTerminal (debounced).
  useEffect(() => {
    setFound([])
    if (q.length < 2 || list.some(c => c.address === q)) return
    const id = setTimeout(() => { searchRh(q).then(r => setFound(r.filter(c => !list.some(x => x.address === c.address)).slice(0, 8))).catch(() => {}) }, 600)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const now = Date.now()
  const live = rows.filter(c => !isWashPool(c, now))
  const overview: [string, RhCoin[]][] = [
    [T('Stock tokens'), live.filter(c => c.stock).sort((a, b) => b.volume24h - a.volume24h).slice(0, 3)],
    [`🔥 ${T('Hot coins')}`, live.filter(c => !c.stock).sort((a, b) => (b.buys24h + b.sells24h) - (a.buys24h + a.sells24h)).slice(0, 3)],
    // A day old at least: a younger coin's "24h change" runs from its launch price.
    [T('Top gainers'), live.filter(c => c.volume24h >= 5_000 && c.liquidity >= 5_000 && c.createdAt > 0 && c.createdAt < now - 86400_000).sort((a, b) => b.change24h - a.change24h).slice(0, 3)],
  ]

  const name = (c: RhCoin) => (c.stock ? stockCompany(c.name) : c.name)

  return (
    <div className="terminal-shell rh-markets">
      <div className="mk-head rh-head">
        {!mobile && (
          <div className="mk-overview rh-overview">
            <div className="mk-card rh-how">
              <div className="mk-card-h"><span>{T('How it works')}</span></div>
              <ol>
                <li>{T('Pay with USDC on Arc: the coin lands at your same address on Robinhood Chain.')}</li>
                <li>{T('Sell any time: your USDC comes back to Arc.')}</li>
                <li>{T('Selling needs a few cents of ETH for gas there: one tap adds it.')}</li>
              </ol>
            </div>
            {overview.map(([title, l]) => (
              <div key={title} className="mk-card">
                <div className="mk-card-h"><span>{title}</span></div>
                {l.length === 0 && <div className="mk-card-empty">{loading ? T('Loading…') : '—'}</div>}
                {l.map(c => (
                  <button key={c.address} className="mk-card-row" onClick={() => navigate(rhPage(c))}>
                    <RhLogo src={c.image} symbol={c.symbol} size={18} />
                    <b>{c.symbol}</b>
                    <span className="mk-card-price">{fmtPrice(c.priceUsd)}</span>
                    <span style={{ color: pctColor(c.change24h) }}>{pct(c.change24h)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mk-toolbar">
        {!mobile && <ChainSwitch chain="robinhood" navigate={navigate} />}
        <div className="view-tabs">
          {mobile && <button className="view-tab rh-tab-arc" onClick={() => navigate({ name: 'terminal' })}>◂ Arc</button>}
          {TABS.map(t => (
            <button key={t} className={`view-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{T(t)}</button>
          ))}
        </div>
        <div className="mk-tools">
          <input className="filter-input mk-search" placeholder={T('🔍 Search…')} value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sort-select" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="volume">{T('Sort: volume')}</option>
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

      <div className="table-scroll">
        {list.length === 0 && loading ? (
          <div className="loading-state">{T('Loading Robinhood Chain…')}</div>
        ) : list.length === 0 && found.length === 0 ? (
          <div className="loading-state">
            {isAddr
              ? <button className="mk-trade mk-trade-solid" onClick={() => navigate({ name: 'rh-token', address: q, pool: '' })}>{T('Open {a}', { a: `${q.slice(0, 6)}…${q.slice(-4)}` })}</button>
              : q ? T('No coin matches “{q}”', { q: search.trim() }) : T('No coins to show right now.')}
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
                <th className="th-sort" />
              </tr>
            </thead>
            <tbody>
              {[...list.slice(0, shown), ...found].map((c, i) => (
                <tr key={c.address} className="token-row" onClick={() => navigate(rhPage(c))}>
                  <td className="td-rank"><span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{i < Math.min(shown, list.length) ? i + 1 : '·'}</span></td>
                  <td className="td-token">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <RhLogo src={c.image} symbol={c.symbol} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          <span className="mk-sym">{c.symbol}</span>
                          <span className="mk-quote">/{c.quoteSymbol || '—'}</span>
                          {c.stock && <StockTag />}
                        </div>
                        <div className="mk-sub">
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(c)}</span>
                          {c.createdAt > 0 && <span style={{ flexShrink: 0 }}>· {fmtAge(c.createdAt)}</span>}
                          <a href={rhAddress(c.address)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="mk-addr">
                            {c.address.slice(0, 6)}…{c.address.slice(-4)} ↗
                          </a>
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
                  <td className="td-num td-trade"><button className="mk-trade" onClick={e => { e.stopPropagation(); navigate(rhPage(c)) }}>{T('Trade')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="token-cards rh-cards">
            {[...list.slice(0, shown), ...found].map(c => (
              <div key={c.address} className="token-card mk-row" onClick={() => navigate(rhPage(c))}>
                <RhLogo src={c.image} symbol={c.symbol} size={30} />
                <div className="mk-row-name">
                  <div className="mk-row-sym"><b>{c.symbol}</b><span>/{c.quoteSymbol || '—'}</span>{c.stock && <StockTag />}</div>
                  <div className="mk-row-meta">{T('Vol')} {fmt(c.volume24h, '$')} · {T('MCap')} {fmt(c.marketCap, '$')}</div>
                </div>
                <div className="mk-row-price">{fmtPrice(c.priceUsd)}<small>{name(c).slice(0, 18)}</small></div>
                <span className={`mk-row-chg ${c.change24h > 0 ? 'up' : c.change24h < 0 ? 'down' : 'flat'}`}>{pct(c.change24h)}</span>
              </div>
            ))}
          </div>
        )}
        {shown < list.length && (
          <button className="show-more" onClick={() => setShown(n => n + PAGE)}>{T('Show more')} · {(list.length - shown).toLocaleString()}</button>
        )}
        <p className="rh-source">{T('Prices and trades from GeckoTerminal. Coins on Robinhood Chain are launched by anyone: check a coin before you buy it.')}</p>
      </div>
    </div>
  )
}
