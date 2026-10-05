// The spot screen's side panels, laid out as on Binance: where Binance has its order book, the coin's
// market trades (Arc coins trade against pools, so the trades are the book), with the buy/sell
// balance underneath; on the right, the pair list ($ARCDEX first) to switch coins in one click.

import { isLaunchpadCoin } from '../../../api/_launchpads'
import { isListable, isRugged } from '../lib/safety'
import { useEffect, useMemo, useState } from 'react'
import type { TradeRow } from './TokenSocialTabs'
import Ago from './Ago'
import type { Page } from '../App'
import type { ActiveToken } from '../../../api/_marketProtocol'
import { cachedArgusMarket } from '../api/argusMarket'
import { engineApiUrl } from '../api/marketStream'
import { toggleWatch, usePrefs } from '../lib/prefs'
import { t as T } from '../lib/i18n'
import { COIN_IMAGE, COIN_LC, COIN_POOL, fmtSmallUsd, useCoin } from '../lib/coin'

const fmtAmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(2)
const fmtPrice = (p: number) => !p || !Number.isFinite(p) ? '—' : p >= 1 ? p.toFixed(4) : p.toPrecision(4)

/** The coin's trades, newest first, as Binance's order book column: price, amount, time. */
export function MarketTrades({ rows, priceUsd, change24h, symbol, buys24h, sells24h, loaded }: {
  rows: TradeRow[]; priceUsd: number; change24h: number | null; symbol: string; buys24h: number | null; sells24h: number | null; loaded: boolean
}) {
  const list = rows.slice(0, 60)
  // The balance of buying and selling: the last 24h's trade counts, else the trades shown.
  const b = buys24h ?? list.filter(r => r.kind === 'buy').length
  const s = sells24h ?? list.filter(r => r.kind === 'sell').length
  const buyPct = b + s > 0 ? Math.round((b / (b + s)) * 100) : 50
  const up = (change24h ?? 0) >= 0
  return (
    <div className="spot-panel spot-trades">
      <div className="spot-panel-h"><span>{T('Market trades')}</span></div>
      <div className="spot-trades-head"><span>{T('Price (USD)')}</span><span>{T('Amount ({symbol})', { symbol })}</span><span>{T('Time')}</span></div>
      <div className="spot-trades-mid">
        <b className={up ? 'up-txt' : 'down-txt'}>{fmtPrice(priceUsd)} {up ? '↑' : '↓'}</b>
        <span>{fmtSmallUsd(priceUsd)}</span>
      </div>
      <div className="spot-trades-list">
        {list.length === 0 && <div className="spot-empty">{loaded ? T('No trades yet') : T('Loading trades…')}</div>}
        {list.map((r, i) => {
          const price = r.tokenAmount > 0 ? r.usd / r.tokenAmount : 0
          // A row's own id where it has one (a transaction can hold two identical swaps).
          const id = (r as { id?: string }).id ?? `${r.txHash}${r.kind}${r.tokenAmount}:${i}`
          return (
            <div key={id} className={`spot-trade${r.live ? ' live' : ''}`}>
              <span className={r.kind === 'buy' ? 'up-txt' : 'down-txt'}>{fmtPrice(price)}</span>
              <span>{fmtAmt(r.tokenAmount)}</span>
              <span className="spot-time"><Ago ts={r.timestamp} /></span>
            </div>
          )
        })}
      </div>
      <div className="spot-ratio" title={T('Buys and sells in the last 24 hours')}>
        <span className="up-txt">B {buyPct}%</span>
        <div className="spot-ratio-bar"><span style={{ width: `${buyPct}%` }} /></div>
        <span className="down-txt">{100 - buyPct}% S</span>
      </div>
    </div>
  )
}

interface PairRow { address: string; pool: string; symbol: string; image: string | null; priceUsd: number; change24h: number; volume: number }

/** Coins to switch to: what's trading now on the engine (else the last market list), $ARCDEX first. */
function usePairs(): PairRow[] {
  // Listed coins only (lib/safety.ts isListable: $15K or more of market cap, not rugged; owner, 2026-10-04).
  const [rows, setRows] = useState<PairRow[]>(() => (cachedArgusMarket() ?? [])
    .filter(p => isListable({ official: false, marketCapUsd: p.marketCapUsd ?? p.fdvUsd ?? 0, rugged: isRugged({ change24h: p.change.h24, liquidityUsd: p.liquidityUsd, onCurve: p.bonded === false }) }))
    .slice(0, 80).map(p => ({
    address: p.token.address, pool: p.pool, symbol: p.token.symbol, image: p.token.image, priceUsd: p.priceUsd, change24h: p.change.h24, volume: p.volume24h,
  })))
  useEffect(() => {
    if (!engineApiUrl) return
    let alive = true
    const load = () => void fetch(`${engineApiUrl}/v1/tokens/active?limit=80`, { signal: AbortSignal.timeout(8_000) })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { tokens?: ActiveToken[] } | null) => {
        if (!alive || !j?.tokens?.length) return
        // Launchpad coins only (owner, 2026-10-04).
        const fresh = j.tokens.filter(a => isLaunchpadCoin(a.meta?.launchpad) && isListable({ official: false, marketCapUsd: a.stats.marketCapUsd ?? 0, rugged: (a.stats.chg.h24 ?? 0) <= -90 })).flatMap(a => (a.meta?.pool && a.stats.priceUsd ? [{
          address: a.token, pool: a.meta.pool, symbol: a.meta.symbol, image: a.meta.image ?? null, priceUsd: a.stats.priceUsd,
          change24h: a.stats.chg.h24 ?? 0, volume: a.stats.vol24,
        }] : []))
        if (fresh.length) setRows(fresh)
      }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return rows
}

function PairLogo({ src, symbol }: { src: string | null; symbol: string }) {
  const [err, setErr] = useState(false)
  if (!src || err) return <span className="spot-pair-logo blank">{symbol.slice(0, 2)}</span>
  return <img className="spot-pair-logo" src={src} alt="" onError={() => setErr(true)} />
}

export function PairList({ current, navigate }: { current: string; navigate: (p: Page) => void }) {
  const pairs = usePairs()
  const coinQ = useCoin()
  const watch = usePrefs().watchlist
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'all' | 'fav'>('all')
  const list = useMemo(() => {
    const coinRow: PairRow = { address: COIN_LC, pool: COIN_POOL, symbol: 'ARCDEX', image: COIN_IMAGE, priceUsd: coinQ?.priceUsd ?? 0, change24h: coinQ?.change24h ?? 0, volume: coinQ?.volume24h ?? 0 }
    let all = [coinRow, ...pairs.filter(p => p.address !== COIN_LC)]
    if (tab === 'fav') all = all.filter(p => watch.includes(p.address))
    const needle = q.trim().toLowerCase()
    if (needle) all = all.filter(p => p.symbol.toLowerCase().includes(needle) || p.address.includes(needle))
    return all
  }, [pairs, coinQ, tab, watch, q])
  return (
    <div className="spot-panel spot-pairs">
      <input className="spot-search" placeholder={T('Search')} value={q} onChange={e => setQ(e.target.value)} />
      <div className="spot-pair-tabs">
        <button className={tab === 'fav' ? 'active' : ''} onClick={() => setTab('fav')}>★</button>
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>USDC</button>
      </div>
      <div className="spot-pairs-head"><span>{T('Pair')}</span><span>{T('Price')}</span><span>{T('Change')}</span></div>
      <div className="spot-pairs-list">
        {list.length === 0 && <div className="spot-empty">{tab === 'fav' ? T('Star a coin to keep it here.') : T('No coin matches.')}</div>}
        {list.map(p => (
          <div key={p.address} role="button" tabIndex={0} className={`spot-pair${p.address === current ? ' active' : ''}${p.address === COIN_LC ? ' arcdex' : ''}`}
            onClick={() => navigate({ name: 'argus', address: p.address, pool: p.pool })}
            onKeyDown={e => { if (e.key === 'Enter') navigate({ name: 'argus', address: p.address, pool: p.pool }) }}>
            <span className="spot-pair-name">
              <button className={`spot-star${watch.includes(p.address) ? ' on' : ''}`} onClick={e => { e.stopPropagation(); toggleWatch(p.address) }} aria-label={T('Add to watchlist')}>{watch.includes(p.address) ? '★' : '☆'}</button>
              <PairLogo src={p.image} symbol={p.symbol} />
              <b>{p.symbol}</b><small>/USDC</small>
            </span>
            <span>{fmtPrice(p.priceUsd)}</span>
            <span className={p.change24h >= 0 ? 'up-txt' : 'down-txt'}>{p.change24h >= 0 ? '+' : ''}{p.change24h.toFixed(2)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}
