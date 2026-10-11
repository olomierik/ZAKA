// /futures — perpetual futures on Hyperliquid, traded from ARCDEX (owner, 2026-10-11: "compete with liquid.trade").
//
// Every market Hyperliquid lists with USDC margin: crypto on its own dex, stocks, indices, commodities, FX and
// pre-IPO companies on the xyz and io dexes. Up to each market's own maximum leverage. Orders are signed in the
// browser and go straight to Hyperliquid (hl/exec.ts); prices, the book, trades and the account are the venue's own,
// live over its WebSocket. ARCDEX's fee is a Hyperliquid builder fee on each order, approved by the trader, and only
// once the builder can receive it (hl/access.ts BUILDER).
//
// Where Hyperliquid's terms don't allow it (the US, Ontario, sanctioned regions; unknown counts as blocked), opening
// positions and depositing are off. Closing, cancelling and withdrawing always work.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import PriceChart, { type ChartTrade } from '../components/PriceChart'
import type { Tick } from '../lib/candles'
import Sheet from '../components/Sheet'
import { t as T } from '../lib/i18n'
import { useIsMobile } from '../lib/useMobile'
import { openConnectModal } from '../components/ConnectWallet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { HL_CATEGORIES, hlIcon, type HlCategory, type HlMarket } from '../hl/markets'
import { useAssetCtx, useAssetData, useHlCandles, useHlMarkets, useHlMids, useHlSocketUp, useHlTrades, useL2Book, useUserFees, type AssetData, type Book, type HlTrade } from '../hl/live'
import { useHlAccount, type HlAccountState, type HlFill, type HlOpenOrder, type HlPosition } from '../hl/account'
import { buildPerpOrders, cancelOrders, DEFAULT_SLIPPAGE, estLiquidation, MIN_ORDER_USD, NeedsEnable, perpBuilder, placeOrders, setLeverage, type OrderOutcome } from '../hl/exec'
import { marketPrice, roundPrice, roundSize, type OrderRequest } from '../hl/wire'
import { HL_EXPLORER, HL_TRADING } from '../hl/client'
import { BUILDER } from '../hl/access'
import { EnableTradingModal, HlAccountBox, HlFundingModal, TradingSoon, errText, money, regionNote, useHlGate, type HlGate } from '../components/HlShared'

// ── numbers ──────────────────────────────────────────────────────────────

export function pxDp(px: number): number {
  if (!(px > 0)) return 2
  if (px >= 10_000) return 0
  if (px >= 1_000) return 1
  if (px >= 100) return 2
  if (px >= 10) return 3
  if (px >= 1) return 4
  return Math.min(8, 4 - Math.floor(Math.log10(px)))
}
export const fmtPx = (px: number | null | undefined) => px == null || !(px > 0) ? '—' : px.toLocaleString(undefined, { minimumFractionDigits: pxDp(px), maximumFractionDigits: pxDp(px) })
export const fmtNum = (n: number | null | undefined, dp: number) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
export function compactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}
const pct = (n: number | null | undefined, dp = 2) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`
const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const upDown = (n: number | null | undefined) => (n == null ? '' : n >= 0 ? 'fx-up' : 'fx-down')
const sanitize = (s: string) => s.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')

export const CATEGORY_LABEL: Record<HlCategory, string> = {
  crypto: 'Crypto', stocks: 'Stocks', preipo: 'Pre-IPO', indices: 'Indices', commodities: 'Commodities', fx: 'FX',
}

const FAV_KEY = 'arcdex:hl-fav'
function loadFavs(): Set<string> {
  try { const raw = localStorage.getItem(FAV_KEY); if (raw) return new Set(JSON.parse(raw) as string[]) } catch { /* storage blocked */ }
  return new Set(['BTC', 'ETH', 'SOL', 'HYPE'])
}
function useFavs(): [Set<string>, (coin: string) => void] {
  const [favs, setFavs] = useState(loadFavs)
  const toggle = (coin: string) => setFavs(prev => {
    const n = new Set(prev)
    if (n.has(coin)) n.delete(coin); else n.add(coin)
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...n])) } catch { /* storage blocked */ }
    return n
  })
  return [favs, toggle]
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return now
}

/** A market's live price: the mid when there is one, else its mark. */
const liveOf = (m: HlMarket, mids: Readonly<Record<string, number>>) => mids[m.coin] ?? m.midPx ?? m.markPx
const changeOf = (m: HlMarket, px: number) => (m.prevDayPx > 0 ? (px / m.prevDayPx - 1) * 100 : 0)

function CoinIcon({ m, size = 22 }: { m: Pick<HlMarket, 'coin' | 'symbol'>; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="fxb-coin" style={{ width: size, height: size, fontSize: size * 0.36 }}>{m.symbol.slice(0, 2)}</span>
  return <img className="hl-icon" src={hlIcon(m.coin)} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
}

// ── the market picker ────────────────────────────────────────────────────

type PickCat = 'all' | 'fav' | HlCategory
type PickSort = 'volume' | 'change' | 'oi' | 'funding'

function MarketPicker({ markets, mids, coin, favs, toggleFav, onPick, onClose }: {
  markets: HlMarket[]; mids: Readonly<Record<string, number>>; coin: string; favs: Set<string>; toggleFav: (c: string) => void
  onPick: (coin: string) => void; onClose: () => void
}) {
  const [cat, setCat] = useState<PickCat>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<PickSort>('volume')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [onClose])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = markets.filter(m => (cat === 'all' || (cat === 'fav' ? favs.has(m.coin) : m.category === cat))
      && (!needle || m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle) || m.coin.toLowerCase().includes(needle)))
    // Highest first: the busiest, the biggest gainers, the highest funding.
    const key = (m: HlMarket) => sort === 'volume' ? m.volume24h : sort === 'oi' ? m.openInterestUsd : sort === 'funding' ? m.funding : changeOf(m, liveOf(m, mids))
    return list.sort((a, b) => key(b) - key(a)).slice(0, 250)
  }, [markets, mids, cat, q, sort, favs])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: markets.length, fav: markets.filter(m => favs.has(m.coin)).length }
    for (const m of markets) c[m.category] = (c[m.category] ?? 0) + 1
    return c
  }, [markets, favs])
  return (
    <div className="hl-pick-pop" ref={ref}>
      <input className="field hl-pick-search" autoFocus placeholder={T('Search markets')} value={q} onChange={e => setQ(e.target.value)} />
      <div className="hl-cats">
        {(['all', 'fav', ...HL_CATEGORIES] as PickCat[]).filter(c => c === 'all' || c === 'fav' || counts[c]).map(c => (
          <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>
            {c === 'all' ? T('All') : c === 'fav' ? `★ ${T('Favourites')}` : T(CATEGORY_LABEL[c])}<small>{counts[c] ?? 0}</small>
          </button>
        ))}
      </div>
      <div className="hl-pick-head">
        <span>{T('Market')}</span>
        <span>{T('Price')}</span>
        {(['change', 'funding', 'volume', 'oi'] as PickSort[]).map(s => (
          <button key={s} className={sort === s ? 'active' : ''} onClick={() => setSort(s)}>
            {s === 'change' ? T('24h change') : s === 'funding' ? T('Funding (1h)') : s === 'volume' ? T('24h volume') : T('Open interest')}{sort === s ? ' ▾' : ''}
          </button>
        ))}
      </div>
      <div className="hl-pick-list">
        {rows.length === 0 && <div className="fx-empty">{T('No market matches.')}</div>}
        {rows.map(m => {
          const px = liveOf(m, mids)
          const ch = changeOf(m, px)
          return (
            <div key={m.coin} className={`hl-pick-row${m.coin === coin ? ' active' : ''}`} onClick={() => onPick(m.coin)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onPick(m.coin) }}>
              <span className="hl-pick-name">
                <button className={`hl-star${favs.has(m.coin) ? ' on' : ''}`} onClick={e => { e.stopPropagation(); toggleFav(m.coin) }} aria-label={T('Favourite')}>★</button>
                <CoinIcon m={m} size={18} />
                <b>{m.symbol}</b>
                <span className="hl-badge">{m.maxLeverage}×</span>
                {m.dex && <span className="hl-dex">{m.dex}</span>}
              </span>
              <span>{fmtPx(px)}</span>
              <span className={upDown(ch)}>{pct(ch)}</span>
              <span className={upDown(m.funding)}>{(m.funding * 100).toFixed(4)}%</span>
              <span>{compactUsd(m.volume24h)}</span>
              <span>{compactUsd(m.openInterestUsd)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── the pair bar ─────────────────────────────────────────────────────────

function PairBar({ market, px, ctx, onPick, picker }: {
  market: HlMarket; px: number; ctx: ReturnType<typeof useAssetCtx>; onPick: () => void; picker: ReactNode
}) {
  const now = useNow(1_000)
  const prev = ctx?.prevDayPx || market.prevDayPx
  const ch = prev > 0 ? (px / prev - 1) * 100 : null
  const funding = ctx?.funding ?? market.funding
  const mark = ctx?.markPx || market.markPx
  const oracle = ctx?.oraclePx || market.oraclePx
  const oi = ctx ? ctx.openInterest * (ctx.markPx || market.markPx) : market.openInterestUsd
  const vol = ctx?.dayNtlVlm ?? market.volume24h
  // Funding is paid every hour, on the hour.
  const left = Math.max(0, Math.ceil(now / 3_600_000) * 3_600_000 - now)
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0'), ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')
  const [dir, setDir] = useState<'' | 'fx-up' | 'fx-down'>('')
  const last = useRef(0)
  useEffect(() => {
    if (last.current && px && px !== last.current) setDir(px > last.current ? 'fx-up' : 'fx-down')
    last.current = px
  }, [px])
  useEffect(() => { last.current = 0; setDir('') }, [market.coin])
  return (
    <div className="fxb-bar hl-bar">
      <div className="fxb-pick">
        <button className="fxb-pair" onClick={onPick} aria-haspopup="true">
          <CoinIcon m={market} size={26} />
          <b>{market.symbol}-USD</b>
          <span className="hl-badge">{market.maxLeverage}×</span>
          <span className="fxb-caret">▾</span>
        </button>
        <div className="hl-pair-sub">{market.name}{market.dex ? ` · ${T(CATEGORY_LABEL[market.category])} · ${market.dex}` : ''}</div>
        {picker}
      </div>
      <div className="fxb-last">
        <b className={dir || upDown(ch)}>{fmtPx(px)}</b>
        <span>{T('Mark')} {fmtPx(mark)}</span>
      </div>
      <div className="fxb-stats">
        <div><span>{T('24h change')}</span><b className={upDown(ch)}>{ch == null ? '—' : `${px && prev ? `${px - prev >= 0 ? '+' : ''}${fmtNum(px - prev, pxDp(px))} / ` : ''}${pct(ch)}`}</b></div>
        <div><span>{T('Oracle')}</span><b>{fmtPx(oracle)}</b></div>
        <div><span>{T('24h volume')}</span><b>{compactUsd(vol)}</b></div>
        <div><span>{T('Open interest')}</span><b>{compactUsd(oi)}</b></div>
        <div><span>{T('Funding / countdown')}</span><b><span className={upDown(funding)}>{(funding * 100).toFixed(4)}%</span> · {mm}:{ss}</b></div>
        <div><span>{T('Max leverage')}</span><b>{market.maxLeverage}×{market.onlyIsolated ? ` · ${T('isolated')}` : ''}</b></div>
      </div>
    </div>
  )
}

// ── the order book and trades ────────────────────────────────────────────

function sigOptions(px: number): { label: string; sig: number | null }[] {
  if (!(px > 0)) return [{ label: T('Every tick'), sig: null }]
  const mag = Math.floor(Math.log10(px))
  const tick = (k: number) => { const t = 10 ** (mag - k + 1); return t >= 1 ? String(t) : t.toFixed(Math.min(10, Math.max(0, -Math.floor(Math.log10(t))))) }
  return [{ label: T('Every tick'), sig: null }, { label: tick(5), sig: 5 }, { label: tick(4), sig: 4 }, { label: tick(3), sig: 3 }, { label: tick(2), sig: 2 }]
}

function OrderBook({ book, symbol, px, sig, setSig, onPrice, rows }: {
  book: Book | null; symbol: string; px: number; sig: number | null; setSig: (s: number | null) => void; onPrice: (p: number) => void; rows: number
}) {
  const [inUsd, setInUsd] = useState(false)
  const asks = (book?.asks ?? []).slice(0, rows)
  const bids = (book?.bids ?? []).slice(0, rows)
  const val = (l: { px: number; sz: number }) => (inUsd ? l.px * l.sz : l.sz)
  let acc = 0
  const askRows = asks.map(l => ({ ...l, total: (acc += val(l)) })).reverse()
  acc = 0
  const bidRows = bids.map(l => ({ ...l, total: (acc += val(l)) }))
  const maxTotal = Math.max(askRows[0]?.total ?? 0, bidRows[bidRows.length - 1]?.total ?? 0, 1e-12)
  const bestAsk = asks[0]?.px, bestBid = bids[0]?.px
  const spread = bestAsk && bestBid ? bestAsk - bestBid : null
  const fmtSz = (v: number) => (inUsd ? compactUsd(v).replace('$', '') : fmtNum(v, v >= 1000 ? 0 : v >= 1 ? 2 : 4))
  const row = (l: { px: number; sz: number; total: number }, side: 'ask' | 'bid') => (
    <button key={`${side}${l.px}`} className={`hl-book-row ${side}`} onClick={() => onPrice(l.px)} title={T('Use this price')}>
      <i style={{ width: `${Math.min(100, (l.total / maxTotal) * 100)}%` }} />
      <span className={side === 'ask' ? 'fx-down' : 'fx-up'}>{fmtPx(l.px)}</span>
      <span>{fmtSz(val(l))}</span>
      <span>{fmtSz(l.total)}</span>
    </button>
  )
  return (
    <div className="hl-book">
      <div className="hl-book-tools">
        <select value={sig ?? ''} onChange={e => setSig(e.target.value ? Number(e.target.value) : null)} aria-label={T('Price grouping')}>
          {sigOptions(px).map(o => <option key={o.label} value={o.sig ?? ''}>{o.label}</option>)}
        </select>
        <button className="hl-unit" onClick={() => setInUsd(u => !u)}>{inUsd ? 'USD' : symbol}</button>
      </div>
      <div className="hl-book-head"><span>{T('Price')}</span><span>{T('Size')} ({inUsd ? 'USD' : symbol})</span><span>{T('Total')}</span></div>
      {!book ? <div className="spot-empty">{T('Loading…')}</div> : (
        <>
          <div className="hl-book-side asks">{askRows.map(l => row(l, 'ask'))}</div>
          <div className="hl-spread"><b>{fmtPx(px)}</b><span>{T('Spread')} {spread == null ? '—' : `${fmtNum(spread, pxDp(px))} (${((spread / px) * 100).toFixed(3)}%)`}</span></div>
          <div className="hl-book-side bids">{bidRows.map(l => row(l, 'bid'))}</div>
        </>
      )}
    </div>
  )
}

function TradesList({ trades }: { trades: HlTrade[] | null }) {
  return (
    <div className="hl-trades">
      <div className="hl-book-head"><span>{T('Price')}</span><span>{T('Size')}</span><span>{T('Time')}</span></div>
      <div className="hl-trades-list">
        {trades === null && <div className="spot-empty">{T('Loading…')}</div>}
        {(trades ?? []).map(t => (
          <a key={t.tid} className={`hl-trade${t.live ? ' live' : ''}`} href={`${HL_EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer">
            <span className={t.side === 'B' ? 'fx-up' : 'fx-down'}>{fmtPx(t.px)}</span>
            <span>{fmtNum(t.sz, t.sz >= 1000 ? 0 : t.sz >= 1 ? 2 : 4)}</span>
            <span className="spot-time">{new Date(t.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
          </a>
        ))}
      </div>
    </div>
  )
}

function BookAndTrades(props: { book: Book | null; trades: HlTrade[] | null; symbol: string; px: number; sig: number | null; setSig: (s: number | null) => void; onPrice: (p: number) => void; rows: number }) {
  const [tab, setTab] = useState<'book' | 'trades'>('book')
  return (
    <div className="spot-panel hl-bt">
      <div className="hl-mini-tabs">
        <button className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>{T('Order book')}</button>
        <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>{T('Trades')}</button>
      </div>
      {tab === 'book' ? <OrderBook {...props} /> : <TradesList trades={props.trades} />}
    </div>
  )
}

// ── the order panel ──────────────────────────────────────────────────────

/** Where a market's leverage starts (owner's plan, docs/UPGRADE-2026-10.md: "the default is low"). */
const DEFAULT_LEVERAGE = 3

function outcomeText(o: OrderOutcome, symbol: string): { ok: boolean; text: string } {
  switch (o.kind) {
    case 'filled': return { ok: true, text: T('Filled {sz} {symbol} at {px}', { sz: fmtNum(o.totalSz, o.totalSz >= 1 ? 4 : 6), symbol, px: fmtPx(o.avgPx) }) }
    case 'resting': return { ok: true, text: T('Order placed: it’s on the book.') }
    case 'waiting': return { ok: true, text: T('Order placed: it waits for its trigger price.') }
    case 'error': return { ok: false, text: o.message }
    default: return { ok: false, text: o.message }
  }
}

function OrderPanel({ market, px, gate, account, assetData, fees, prefill, onFund, onEnable, onDone }: {
  market: HlMarket; px: number; gate: HlGate; account: HlAccountState | null; assetData: AssetData | null
  fees: { taker: number; maker: number }; prefill: { px: number; n: number } | null
  onFund: (t: 'deposit' | 'withdraw') => void; onEnable: () => void; onDone: () => void
}) {
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [lev, setLev] = useState(Math.min(DEFAULT_LEVERAGE, market.maxLeverage))
  const [cross, setCross] = useState(!market.onlyIsolated)
  const [levOpen, setLevOpen] = useState(false)
  const [size, setSize] = useState('')
  const [limitPx, setLimitPx] = useState('')
  const [postOnly, setPostOnly] = useState(false)
  const [reduce, setReduce] = useState(false)
  const [tpsl, setTpsl] = useState(false)
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  const [slip, setSlip] = useState(DEFAULT_SLIPPAGE)
  const [busy, setBusy] = useState<'long' | 'short' | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const touched = useRef(false)

  // A new market starts low: 3× (cross where allowed). With a position already open there, its own leverage (an order
  // can't change a position's margin type, and the venue's per-coin default, 20×, isn't a choice anyone made).
  // Whatever shows is set on Hyperliquid with the order (submit), so the screen is what applies.
  const position = account?.positions.find(p => p.coin === market.coin) ?? null
  useEffect(() => {
    touched.current = false
    setLev(Math.min(DEFAULT_LEVERAGE, market.maxLeverage)); setCross(!market.onlyIsolated)
    setSize(''); setLimitPx(''); setTp(''); setSl(''); setNote(null)
  }, [market.coin]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!position || touched.current) return
    setLev(Math.min(position.leverage.value, market.maxLeverage))
    setCross(position.leverage.type === 'cross' && !market.onlyIsolated)
  }, [position?.leverage.value, position?.leverage.type, market.maxLeverage, market.onlyIsolated]) // eslint-disable-line react-hooks/exhaustive-deps
  // A price picked in the book becomes a limit order's price.
  useEffect(() => { if (prefill) { setKind('limit'); setLimitPx(String(prefill.px)) } }, [prefill])

  const value = +size || 0
  const refPx = kind === 'limit' && +limitPx > 0 ? +limitPx : px
  const margin = value / Math.max(1, lev)
  const available = assetData ? assetData.availableToTrade[0] : account?.available ?? 0
  const maxValue = Math.max(0, available * lev * 0.98)
  const share = maxValue > 0 ? Math.min(100, Math.round((value / maxValue) * 100)) : 0
  const setShare = (p: number) => { if (maxValue > 0) setSize(String(Math.floor((maxValue * p) / 100 * 100) / 100)) }
  const builder = perpBuilder(gate.status)
  const feeRate = (kind === 'limit' && postOnly ? fees.maker : fees.taker) + (builder ? builder.f / 100_000 : 0)
  const coinSz = refPx > 0 ? roundSize(value / refPx, market.szDecimals) : 0
  const isolated = !cross || market.onlyIsolated
  const liq = (isLong: boolean) => (isolated ? estLiquidation(refPx, isLong, lev, market.maxLeverage) : null)
  const tpN = +tp, slN = +sl
  const badTpsl = (isLong: boolean) => tpsl && ((tp !== '' && (isLong ? tpN <= refPx : tpN >= refPx)) || (sl !== '' && (isLong ? slN >= refPx : slN <= refPx)))
  const tooSmall = value > 0 && value < MIN_ORDER_USD
  const ready = px > 0 && value >= MIN_ORDER_USD && coinSz > 0 && (kind === 'market' || +limitPx > 0)
  const note0 = regionNote(gate)

  async function submit(isBuy: boolean) {
    const a = gate.access
    if (!a) { openConnectModal(); return }
    const s = gate.status
    if (s?.needs.includes('deposit')) { onFund('deposit'); return }
    if (s && s.needs.some(n => n !== 'deposit')) { onEnable(); return }
    setBusy(isBuy ? 'long' : 'short'); setNote(null)
    try {
      const wantCross = cross && !market.onlyIsolated
      if (!reduce && (!assetData || assetData.leverage.value !== lev || (assetData.leverage.type === 'cross') !== wantCross)) {
        await setLeverage(a, market.asset, wantCross, lev)
      }
      const built = buildPerpOrders({
        market, isBuy, usd: value, kind, limitPx: +limitPx, postOnly, reduceOnly: reduce, slippage: slip, mid: px,
        tp: tpsl && tp ? tpN : null, sl: tpsl && sl ? slN : null,
      })
      if (!(built.sz > 0)) throw new Error(T('That size is under the smallest lot for this market.'))
      const res = await placeOrders(a, built.orders, { builder, grouping: built.grouping })
      const main = outcomeText(res[0], market.symbol)
      const extra = res.slice(1).filter(r => r.kind === 'error').map(r => (r as { message: string }).message)
      setNote(extra.length ? { ok: main.ok, text: `${main.text} · TP/SL: ${extra.join('; ')}` } : main)
      if (main.ok) setSize('')
      onDone()
    } catch (e) {
      if (e instanceof NeedsEnable) { gate.refresh(); onEnable() }
      else setNote({ ok: false, text: errText(e) })
    } finally { setBusy(null) }
  }

  let blocker: JSX.Element | null = null
  if (!HL_TRADING) blocker = <TradingSoon />
  else if (!gate.access) blocker = (
    <div className="hl-blocker">
      <button className="fx-go fx-go-primary" onClick={openConnectModal}>{T('Connect wallet to trade')}</button>
      <button className="link-btn" onClick={openTradingWallet}>{T('or use your trading wallet')}</button>
    </div>
  )
  else if (note0 && !reduce) blocker = <div className="hl-blocker"><div className="fx-hint-bad">{note0}</div></div>
  else if (!gate.status) blocker = <button className="fx-go" disabled>{T('Checking your account…')}</button>
  else if (gate.status.needs.includes('deposit')) blocker = <button className="fx-go fx-go-primary" onClick={() => onFund('deposit')}>{T('Deposit USDC to start')}</button>
  else if (gate.status.needs.length) blocker = <button className="fx-go fx-go-primary" onClick={onEnable}>{T('Enable trading')}</button>

  return (
    <div className="fx-order hl-order">
      <div className="fxb-mode">
        {market.onlyIsolated ? (
          <span className="fxb-chip" title={T('This market trades with isolated margin only.')}>{T('Isolated')}</span>
        ) : (
          <button className="fxb-chip fxb-chip-btn" onClick={() => { touched.current = true; setCross(c => !c) }} title={T('Cross uses your whole balance as margin; isolated limits a loss to this position’s margin.')}>{cross ? T('Cross') : T('Isolated')}</button>
        )}
        <button className="fxb-chip fxb-chip-btn" onClick={() => setLevOpen(true)}>{lev}×</button>
      </div>
      <div className="fxb-kinds">
        <button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>{T('Market')}</button>
        <button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>{T('Limit')}</button>
      </div>
      <div className="fxb-avbl"><span>{T('Avbl')}</span><b>{gate.access ? money(available) : '—'}</b></div>
      {kind === 'limit' ? (
        <div className="fxb-input">
          <span>{T('Price')}</span>
          <input inputMode="decimal" value={limitPx} placeholder={fmtPx(px)} onChange={e => setLimitPx(sanitize(e.target.value))} />
          <button className="fxb-last-btn" onClick={() => px && setLimitPx(String(roundPrice(px, market.szDecimals, true)))}>{T('Mid')}</button>
          <em>USD</em>
        </div>
      ) : (
        <div className="fxb-input fxb-input-ro"><span>{T('Price')}</span><input readOnly value={T('Market price')} /><em>USD</em></div>
      )}
      <div className="fxb-input">
        <span>{T('Size')}</span>
        <input inputMode="decimal" value={size} placeholder={`${MIN_ORDER_USD}+`} onChange={e => setSize(sanitize(e.target.value))} />
        <em>USD</em>
      </div>
      <div className="fxb-slider">
        <input type="range" min={0} max={100} step={1} value={share} onChange={e => setShare(+e.target.value)} disabled={maxValue <= 0} aria-label={T('Share of what you can trade')} />
        <div className="fxb-ticks">{[0, 25, 50, 75, 100].map(v => <button key={v} className={share >= v ? 'on' : ''} onClick={() => setShare(v)} disabled={maxValue <= 0}>{v}%</button>)}</div>
      </div>
      <div className="hl-checks">
        <label className="fxb-check"><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} /> {T('Reduce only')}</label>
        {kind === 'limit' && <label className="fxb-check"><input type="checkbox" checked={postOnly} onChange={e => setPostOnly(e.target.checked)} /> {T('Post only')}</label>}
        <label className="fxb-check"><input type="checkbox" checked={tpsl} onChange={e => setTpsl(e.target.checked)} /> {T('TP/SL')}</label>
      </div>
      {tpsl && (
        <div className="fx-tpsl">
          <div className="fxb-input"><span>{T('Take-profit')}</span><input inputMode="decimal" value={tp} onChange={e => setTp(sanitize(e.target.value))} /></div>
          <div className="fxb-input"><span>{T('Stop-loss')}</span><input inputMode="decimal" value={sl} onChange={e => setSl(sanitize(e.target.value))} /></div>
          <div className="fx-fine" style={{ gridColumn: '1 / -1' }}>{T('A long takes profit above the entry and stops below it; a short, the other way round.')}</div>
        </div>
      )}
      {blocker ?? (
        <div className="fxb-buttons">
          <button className="fx-go long" disabled={!ready || busy !== null || badTpsl(true)} onClick={() => void submit(true)}>{busy === 'long' ? T('Sending…') : T('Buy / Long')}</button>
          <button className="fx-go short" disabled={!ready || busy !== null || badTpsl(false)} onClick={() => void submit(false)}>{busy === 'short' ? T('Sending…') : T('Sell / Short')}</button>
        </div>
      )}
      {tooSmall && <div className="fx-fine">{T('Hyperliquid’s smallest order is ${n}.', { n: MIN_ORDER_USD })}</div>}
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      <div className="fxb-sides">
        <div><span>{T('Liq. price')}</span><b>{isolated ? `≈ ${fmtPx(liq(true))}` : T('Cross')}</b></div>
        <div><span>{T('Liq. price')}</span><b>{isolated ? `≈ ${fmtPx(liq(false))}` : T('Cross')}</b></div>
        <div><span>{T('Margin')}</span><b>{value ? money(margin) : '—'}</b></div>
        <div><span>{T('Margin')}</span><b>{value ? money(margin) : '—'}</b></div>
      </div>
      <div className="fx-summary">
        <div><span>{T('Order value')}</span><b>{value ? money(value) : '—'}{coinSz ? <small> · {fmtNum(coinSz, market.szDecimals)} {market.symbol}</small> : null}</b></div>
        <div><span>{T('Fees')}</span><b>{value ? money(value * feeRate, 4) : '—'} <small>{(feeRate * 100).toFixed(3)}%</small></b></div>
        {builder && <div><span>{T('incl. ARCDEX fee')}</span><b>{(builder.f / 1000).toFixed(3)}%</b></div>}
        {kind === 'market' && <div><span>{T('Max price move')}</span><b>{[0.01, 0.03, 0.05].map(v => <button key={v} className={`hl-slip${slip === v ? ' active' : ''}`} onClick={() => setSlip(v)}>{v * 100}%</button>)}</b></div>}
      </div>
      {cross && !market.onlyIsolated ? <div className="fx-fine">{T('Cross margin: the liquidation price depends on your whole account, and Hyperliquid shows it once the position is open.')}</div> : null}

      {levOpen && (
        <div className="modal-back" onClick={() => setLevOpen(false)}>
          <div className="modal-card fxb-lev" onClick={e => e.stopPropagation()}>
            <div className="fxb-lev-h"><b>{T('Adjust leverage')}</b><button className="fxb-x" onClick={() => setLevOpen(false)} aria-label={T('Close')}>✕</button></div>
            <div className="fxb-lev-val"><button onClick={() => { touched.current = true; setLev(l => Math.max(1, l - 1)) }}>−</button><b>{lev}×</b><button onClick={() => { touched.current = true; setLev(l => Math.min(market.maxLeverage, l + 1)) }}>＋</button></div>
            <input type="range" min={1} max={market.maxLeverage} step={1} value={lev} onChange={e => { touched.current = true; setLev(+e.target.value) }} />
            <div className="fxb-ticks">{[1, 2, 3, 5, 10, 20, 25, 40, 50].filter(v => v <= market.maxLeverage).map(v => <button key={v} className={lev === v ? 'on' : ''} onClick={() => { touched.current = true; setLev(v) }}>{v}×</button>)}</div>
            <p className="fx-fine">{T('Higher leverage means a bigger position for the same margin, and a liquidation price closer to the entry.')} {T('It is set on Hyperliquid with your next order.')}</p>
            <button className="btn-primary" onClick={() => setLevOpen(false)}>{T('Confirm')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── the account tabs ─────────────────────────────────────────────────────

const assetOfCoin = (coin: string, byCoin: Map<string, HlMarket>) => (coin.startsWith('#') ? 100_000_000 + Number(coin.slice(1)) : byCoin.get(coin)?.asset ?? -1)
const coinLabel = (coin: string) => (coin.startsWith('#') ? T('Prediction #{n}', { n: Math.floor(Number(coin.slice(1)) / 10) }) : coin.startsWith('@') ? T('Spot {c}', { c: coin }) : coin.includes(':') ? coin.split(':')[1] : coin)

function Positions({ positions, orders, byCoin, mids, gate, onSelect, onDone }: {
  positions: HlPosition[]; orders: HlOpenOrder[]; byCoin: Map<string, HlMarket>; mids: Readonly<Record<string, number>>
  gate: HlGate; onSelect: (coin: string) => void; onDone: (n: { ok: boolean; text: string }) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<HlPosition | null>(null)
  if (!positions.length) return <div className="fx-empty">{T('No open positions.')}</div>
  async function close(p: HlPosition) {
    const a = gate.access
    const m = byCoin.get(p.coin)
    if (!a || !m) return
    setBusy(p.coin)
    try {
      const isBuy = p.szi < 0
      const mid = mids[p.coin] ?? m.markPx
      const order: OrderRequest = { asset: m.asset, isBuy, px: marketPrice(mid, isBuy, 0.05, m.szDecimals, true), sz: Math.abs(p.szi), reduceOnly: true, type: { limit: { tif: 'Ioc' } } }
      const [r] = await placeOrders(a, [order], { builder: perpBuilder(gate.status) })
      onDone(outcomeText(r, m.symbol))
    } catch (e) { onDone({ ok: false, text: errText(e) }) }
    finally { setBusy(null) }
  }
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr>
          <th>{T('Market')}</th><th>{T('Size')}</th><th>{T('Value')}</th><th>{T('Entry')}</th><th>{T('Mark')}</th><th>{T('P&L (ROE)')}</th><th>{T('Liq. price')}</th><th>{T('Margin')}</th><th>{T('Funding')}</th><th>{T('TP / SL')}</th><th />
        </tr></thead>
        <tbody>
          {positions.map(p => {
            const m = byCoin.get(p.coin)
            const sym = m?.symbol ?? coinLabel(p.coin)
            const mark = mids[p.coin] ?? m?.markPx ?? 0
            const pnl = mark && p.entryPx ? (mark - p.entryPx) * p.szi : p.unrealizedPnl
            const roe = p.marginUsed > 0 ? (pnl / p.marginUsed) * 100 : p.returnOnEquity * 100
            const tpO = orders.find(o => o.coin === p.coin && o.isTrigger && /take profit/i.test(o.orderType))
            const slO = orders.find(o => o.coin === p.coin && o.isTrigger && /stop/i.test(o.orderType))
            return (
              <tr key={p.coin}>
                <td><button className="link-btn" onClick={() => onSelect(p.coin)}><b>{sym}</b></button> <span className={p.szi > 0 ? 'fx-up' : 'fx-down'}>{p.szi > 0 ? T('Long') : T('Short')}</span> <small>{p.leverage.value}× {p.leverage.type === 'cross' ? T('Cross') : T('Isolated')}</small></td>
                <td>{fmtNum(Math.abs(p.szi), m?.szDecimals ?? 4)}</td>
                <td>{money(Math.abs(p.szi) * (mark || p.entryPx))}</td>
                <td>{fmtPx(p.entryPx)}</td>
                <td>{fmtPx(mark)}</td>
                <td className={upDown(pnl)}>{signedUsd(pnl)}<small> {pct(roe)}</small></td>
                <td className="fx-down">{fmtPx(p.liquidationPx)}</td>
                <td>{money(p.marginUsed)}</td>
                <td className={upDown(p.cumFunding == null ? null : -p.cumFunding)}>{p.cumFunding == null ? '—' : signedUsd(-p.cumFunding)}</td>
                <td>{HL_TRADING ? <button className="link-btn" onClick={() => setEditing(p)}>{tpO?.triggerPx ? fmtPx(tpO.triggerPx) : '—'} / {slO?.triggerPx ? fmtPx(slO.triggerPx) : '—'} ✎</button> : <span>{tpO?.triggerPx ? fmtPx(tpO.triggerPx) : '—'} / {slO?.triggerPx ? fmtPx(slO.triggerPx) : '—'}</span>}</td>
                <td>{HL_TRADING && <button className="btn-ghost" disabled={busy !== null || !gate.access} onClick={() => void close(p)}>{busy === p.coin ? T('Closing…') : T('Close')}</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {editing && byCoin.get(editing.coin) && (
        <TpSlModal p={editing} m={byCoin.get(editing.coin)!} orders={orders} gate={gate} mark={mids[editing.coin] ?? byCoin.get(editing.coin)!.markPx} onClose={() => setEditing(null)} onDone={n => { setEditing(null); onDone(n) }} />
      )}
    </div>
  )
}

/** Take-profit and stop-loss on an open position (Hyperliquid's positionTpsl: they follow the position's size). */
function TpSlModal({ p, m, orders, gate, mark, onClose, onDone }: {
  p: HlPosition; m: HlMarket; orders: HlOpenOrder[]; gate: HlGate; mark: number; onClose: () => void; onDone: (n: { ok: boolean; text: string }) => void
}) {
  const old = orders.filter(o => o.coin === p.coin && o.isTrigger && o.isPositionTpsl)
  const [tp, setTp] = useState(() => { const o = old.find(x => /take profit/i.test(x.orderType)); return o?.triggerPx ? String(o.triggerPx) : '' })
  const [sl, setSl] = useState(() => { const o = old.find(x => /stop/i.test(x.orderType)); return o?.triggerPx ? String(o.triggerPx) : '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isLong = p.szi > 0
  const bad = (tp !== '' && (isLong ? +tp <= mark : +tp >= mark)) || (sl !== '' && (isLong ? +sl >= mark : +sl <= mark))
  async function save() {
    const a = gate.access
    if (!a) return
    setBusy(true); setErr(null)
    try {
      if (old.length) await cancelOrders(a, old.map(o => ({ asset: m.asset, oid: o.oid })))
      const sz = Math.abs(p.szi)
      const mk = (tpsl: 'tp' | 'sl', at: number): OrderRequest => {
        const triggerPx = roundPrice(at, m.szDecimals, true)
        return { asset: m.asset, isBuy: !isLong, sz, reduceOnly: true, px: marketPrice(triggerPx, !isLong, 0.05, m.szDecimals, true), type: { trigger: { triggerPx, isMarket: true, tpsl } } }
      }
      const list: OrderRequest[] = []
      if (tp) list.push(mk('tp', +tp))
      if (sl) list.push(mk('sl', +sl))
      if (list.length) {
        const res = await placeOrders(a, list, { builder: perpBuilder(gate.status), grouping: 'positionTpsl' })
        const errs = res.filter(r => r.kind === 'error').map(r => (r as { message: string }).message)
        if (errs.length) throw new Error(errs.join('; '))
      }
      onDone({ ok: true, text: T('Take-profit and stop-loss saved.') })
    } catch (e) { setErr(errText(e)) }
    finally { setBusy(false) }
  }
  return (
    <div className="modal-back" onClick={busy ? undefined : onClose}>
      <div className="modal-card hl-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('TP / SL for {sym} {side}', { sym: m.symbol, side: isLong ? T('Long') : T('Short') })}</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <div className="fx-summary"><div><span>{T('Entry')}</span><b>{fmtPx(p.entryPx)}</b></div><div><span>{T('Mark')}</span><b>{fmtPx(mark)}</b></div></div>
        <div className="fxb-input"><span>{T('Take-profit')}</span><input inputMode="decimal" value={tp} onChange={e => setTp(sanitize(e.target.value))} placeholder={T('None')} /></div>
        <div className="fxb-input"><span>{T('Stop-loss')}</span><input inputMode="decimal" value={sl} onChange={e => setSl(sanitize(e.target.value))} placeholder={T('None')} /></div>
        {bad && <div className="fx-hint-bad">{T('A long takes profit above the entry and stops below it; a short, the other way round.')}</div>}
        {err && <div className="fx-hint-bad">⚠ {err}</div>}
        <button className="btn-primary" disabled={busy || bad} onClick={() => void save()}>{busy ? T('Saving…') : T('Save')}</button>
      </div>
    </div>
  )
}

function OpenOrders({ orders, byCoin, gate, onDone }: { orders: HlOpenOrder[]; byCoin: Map<string, HlMarket>; gate: HlGate; onDone: (n: { ok: boolean; text: string }) => void }) {
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  if (!orders.length) return <div className="fx-empty">{T('No open orders.')}</div>
  async function cancel(list: HlOpenOrder[], key: number | 'all') {
    const a = gate.access
    if (!a) return
    setBusy(key)
    try {
      const res = await cancelOrders(a, list.map(o => ({ asset: assetOfCoin(o.coin, byCoin), oid: o.oid })).filter(x => x.asset >= 0))
      const errs = res.filter(r => r !== true)
      onDone(errs.length ? { ok: false, text: errs.join('; ') } : { ok: true, text: list.length > 1 ? T('Orders cancelled.') : T('Order cancelled.') })
    } catch (e) { onDone({ ok: false, text: errText(e) }) }
    finally { setBusy(null) }
  }
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Type')}</th><th>{T('Side')}</th><th>{T('Price')}</th><th>{T('Size')}</th><th>{T('Trigger')}</th><th>{HL_TRADING && <button className="link-btn" disabled={busy !== null} onClick={() => void cancel(orders, 'all')}>{T('Cancel all')}</button>}</th></tr></thead>
        <tbody>
          {orders.map(o => (
            <tr key={o.oid}>
              <td><small>{new Date(o.timestamp).toLocaleString()}</small></td>
              <td><b>{byCoin.get(o.coin)?.symbol ?? coinLabel(o.coin)}</b></td>
              <td>{o.orderType}{o.reduceOnly ? <small> · {T('Reduce only')}</small> : null}</td>
              <td className={o.side === 'B' ? 'fx-up' : 'fx-down'}>{o.side === 'B' ? T('Buy') : T('Sell')}</td>
              <td>{o.isTrigger && /market/i.test(o.orderType) ? T('Market') : fmtPx(o.limitPx)}</td>
              <td>{fmtNum(o.sz, 4)}{o.origSz !== o.sz ? <small> / {fmtNum(o.origSz, 4)}</small> : null}</td>
              <td>{o.triggerPx ? fmtPx(o.triggerPx) : '—'}</td>
              <td>{HL_TRADING && <button className="btn-ghost" disabled={busy !== null} onClick={() => void cancel([o], o.oid)}>{busy === o.oid ? '…' : T('Cancel')}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Fills({ fills, byCoin }: { fills: HlFill[]; byCoin: Map<string, HlMarket> }) {
  if (!fills.length) return <div className="fx-empty">{T('No trades yet.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Direction')}</th><th>{T('Price')}</th><th>{T('Size')}</th><th>{T('Value')}</th><th>{T('Fee')}</th><th>{T('Closed P&L')}</th><th /></tr></thead>
        <tbody>
          {fills.slice(0, 200).map(f => (
            <tr key={f.tid}>
              <td><small>{new Date(f.time).toLocaleString()}</small></td>
              <td><b>{byCoin.get(f.coin)?.symbol ?? coinLabel(f.coin)}</b></td>
              <td className={f.side === 'B' ? 'fx-up' : 'fx-down'}>{f.dir || (f.side === 'B' ? T('Buy') : T('Sell'))}</td>
              <td>{fmtPx(f.px)}</td>
              <td>{fmtNum(f.sz, 4)}</td>
              <td>{money(f.px * f.sz)}</td>
              <td>{money(f.fee + f.builderFee, 4)}{f.builderFee ? <small> · ARCDEX {money(f.builderFee, 4)}</small> : null}</td>
              <td className={f.closedPnl ? upDown(f.closedPnl) : ''}>{f.closedPnl ? signedUsd(f.closedPnl) : '—'}</td>
              <td>{f.hash && !/^0x0+$/.test(f.hash) ? <a href={`${HL_EXPLORER}/tx/${f.hash}`} target="_blank" rel="noreferrer">↗</a> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Balances({ account, onFund, navigate }: { account: HlAccountState; onFund: (t: 'deposit' | 'withdraw') => void; navigate: (p: Page) => void }) {
  const dexes = Object.entries(account.perDex).filter(([d, v]) => d === '' || v.accountValue > 0)
  return (
    <div className="hl-balances">
      <div className="fx-pool-stats">
        <div><span>{T('Account value')}</span><b>{money(account.accountValue)}</b></div>
        <div><span>{T('Available to trade')}</span><b>{money(account.available)}</b></div>
        <div><span>{T('Withdrawable')}</span><b>{money(account.withdrawable)}</b></div>
        <div><span>{T('USDC (spot)')}</span><b>{money(account.spotUsdc.total)}</b></div>
        {account.mode !== 'unifiedAccount' && account.mode !== 'portfolioMargin' && dexes.map(([d, v]) => (
          <div key={d || 'core'}><span>{T('Futures margin')} · {d || T('Crypto')}</span><b>{money(v.accountValue)}</b></div>
        ))}
        <div><span>{T('Predictions held')}</span><b>{account.outcomes.length ? <button className="link-btn" onClick={() => navigate({ name: 'predict' })}>{account.outcomes.length}</button> : 0}</b></div>
      </div>
      {HL_TRADING && (
        <div className="hl-bal-btns">
          <button className="btn-primary" onClick={() => onFund('deposit')}>＋ {T('Deposit')}</button>
          <button className="btn-ghost" onClick={() => onFund('withdraw')}>{T('Withdraw to Arc')}</button>
        </div>
      )}
    </div>
  )
}

type AcctTab = 'positions' | 'orders' | 'fills' | 'balances'

function AccountTabs({ acct, byCoin, mids, gate, coin, onSelect, onFund, navigate }: {
  acct: ReturnType<typeof useHlAccount>; byCoin: Map<string, HlMarket>; mids: Readonly<Record<string, number>>; gate: HlGate; coin: string
  onSelect: (coin: string) => void; onFund: (t: 'deposit' | 'withdraw') => void; navigate: (p: Page) => void
}) {
  const [tab, setTab] = useState<AcctTab>('positions')
  const [onlyThis, setOnlyThis] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const s = acct.state
  const positions = (s?.positions ?? []).filter(p => !onlyThis || p.coin === coin)
  const orders = (s?.orders ?? []).filter(o => !o.coin.startsWith('#') && (!onlyThis || o.coin === coin))
  const fills = acct.fills.filter(f => !f.coin.startsWith('#') && (!onlyThis || f.coin === coin))
  const done = (n: { ok: boolean; text: string }) => { setNote(n); acct.refresh() }
  return (
    <div className="hl-acct">
      <div className="fx-tabs hl-acct-tabs">
        {([
          ['positions', `${T('Positions')}${s?.positions.length ? ` (${s.positions.length})` : ''}`],
          ['orders', `${T('Open orders')}${orders.length ? ` (${orders.length})` : ''}`],
          ['fills', T('Trade history')],
          ['balances', T('Balances')],
        ] as [AcctTab, string][]).map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        <label className="fxb-check hl-only"><input type="checkbox" checked={onlyThis} onChange={e => setOnlyThis(e.target.checked)} /> {T('This market only')}</label>
      </div>
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      {!gate.access ? (
        <div className="fx-empty">
          {T('Connect a wallet or unlock your trading wallet to see your positions.')}{' '}
          <button className="link-btn" onClick={openConnectModal}>{T('Connect wallet')}</button> · <button className="link-btn" onClick={openTradingWallet}>{T('Trading wallet')}</button>
        </div>
      ) : !s ? (
        <div className="fx-empty">{acct.error ? `⚠ ${acct.error}` : T('Loading…')}</div>
      ) : tab === 'positions' ? (
        <Positions positions={positions} orders={s.orders} byCoin={byCoin} mids={mids} gate={gate} onSelect={onSelect} onDone={done} />
      ) : tab === 'orders' ? (
        <OpenOrders orders={orders} byCoin={byCoin} gate={gate} onDone={done} />
      ) : tab === 'fills' ? (
        <Fills fills={fills} byCoin={byCoin} />
      ) : (
        <Balances account={s} onFund={onFund} navigate={navigate} />
      )}
    </div>
  )
}

// ── the page ─────────────────────────────────────────────────────────────

export default function PerpsPage({ navigate, coin: coinProp }: { navigate: (p: Page) => void; coin?: string }) {
  const mobile = useIsMobile()
  const { markets, error } = useHlMarkets()
  const mids = useHlMids()
  const socketUp = useHlSocketUp()
  const asked = coinProp || 'BTC'
  // Links may use any case ("/futures/eth", "/futures/xyz:tsla"); Hyperliquid's names keep theirs ("kPEPE").
  const coin = markets?.find(m => m.coin === asked)?.coin ?? markets?.find(m => m.coin.toLowerCase() === asked.toLowerCase())?.coin ?? asked
  const market = markets?.find(m => m.coin === coin) ?? null
  const live = market ? coin : null
  const ctx = useAssetCtx(live)
  const gate = useHlGate()
  const user = gate.access?.user ?? null
  const acct = useHlAccount(user)
  const assetData = useAssetData(user, live)
  const fees = useUserFees(user)
  const trades = useHlTrades(live)
  const source = useHlCandles(live)
  const [sig, setSig] = useState<number | null>(null)
  useEffect(() => { setSig(null) }, [coin])
  const book = useL2Book(live, sig)
  const [favs, toggleFav] = useFavs()
  const [picker, setPicker] = useState(false)
  const [funding, setFunding] = useState<'deposit' | 'withdraw' | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [prefill, setPrefill] = useState<{ px: number; n: number } | null>(null)
  const [sheet, setSheet] = useState(false)
  const [mTab, setMTab] = useState<'book' | 'trades'>('book')

  const px = market ? (mids[coin] ?? ctx?.midPx ?? market.midPx ?? market.markPx) : 0
  const byCoin = useMemo(() => new Map((markets ?? []).map(m => [m.coin, m])), [markets])
  const pick = (c: string) => { setPicker(false); if (c !== coin) navigate({ name: 'perps', coin: c }) }

  useEffect(() => {
    if (market && px) document.title = `${fmtPx(px)} | ${market.symbol}-USD | ARCDEX`
  }, [market, px])

  // The chart: the venue's candles, the last point following each trade; big trades and your own fills pop.
  const ticks = useMemo<Tick[]>(() => (trades ?? []).slice(0, 200).map(t => ({ time: t.time, priceUsd: t.px, usd: t.px * t.sz })).reverse(), [trades])
  const popMin = market ? Math.min(50_000, Math.max(500, market.volume24h / 20_000)) : 1e9
  const myFills = useMemo(() => acct.fills.filter(f => f.coin === coin), [acct.fills, coin])
  const loadedAt = useRef(Date.now())
  useEffect(() => { loadedAt.current = Date.now() }, [coin])
  const chartTrades = useMemo<ChartTrade[]>(() => [
    ...(trades ?? []).filter(t => t.px * t.sz >= popMin).map(t => ({ id: `t${t.tid}`, time: t.time, priceUsd: t.px, usd: t.px * t.sz, kind: t.side === 'B' ? 'buy' as const : 'sell' as const, maker: null, live: t.live })),
    ...myFills.map(f => ({ id: `f${f.tid}`, time: f.time, priceUsd: f.px, usd: f.px * f.sz, kind: f.side === 'B' ? 'buy' as const : 'sell' as const, maker: null, mine: true, live: f.time > loadedAt.current })),
  ], [trades, myFills, popMin])

  const strip = useMemo(() => {
    if (!markets) return []
    // One per ticker: some stocks trade on two builder dexes (xyz:SNDK and io:SNDK); the strip shows the busier.
    const seen = new Set<string>()
    const top = [...markets].sort((a, b) => b.volume24h - a.volume24h).filter(m => (seen.has(m.symbol) ? false : (seen.add(m.symbol), true)))
    const out: HlMarket[] = []
    for (const cat of HL_CATEGORIES) out.push(...top.filter(m => m.category === cat).slice(0, cat === 'crypto' ? 6 : 3))
    return out
  }, [markets])

  if (!markets) {
    return <div className="fx-page fxb"><div className="fx-empty">{error ? `⚠ ${T('Hyperliquid didn’t answer: {e}', { e: error })}` : T('Loading markets…')}</div></div>
  }
  if (!market) {
    return (
      <div className="fx-page fxb">
        <div className="fx-empty">
          {T('{coin} isn’t a market here.', { coin })} <button className="link-btn" onClick={() => navigate({ name: 'perps', coin: 'BTC' })}>{T('Open BTC')}</button>
        </div>
      </div>
    )
  }

  const pickerPop = picker ? <MarketPicker markets={markets} mids={mids} coin={coin} favs={favs} toggleFav={toggleFav} onPick={pick} onClose={() => setPicker(false)} /> : null
  const panel = (
    <OrderPanel
      market={market} px={px} gate={gate} account={acct.state} assetData={assetData} fees={fees} prefill={prefill}
      onFund={t => { setSheet(false); setFunding(t) }} onEnable={() => { setSheet(false); setEnabling(true) }} onDone={() => { acct.refresh() }}
    />
  )
  const chart = (
    <PriceChart
      poolAddress={null} source={source} ticks={ticks} live={socketUp} trades={chartTrades}
      liveTitle={T('Live from Hyperliquid')} symbol={`${market.symbol}-USD`} height={mobile ? 300 : 470}
    />
  )
  const bookProps = { book, trades, symbol: market.symbol, px, sig, setSig, onPrice: (p: number) => { setPrefill({ px: p, n: Date.now() }); if (mobile) setSheet(true) }, rows: mobile ? 10 : 13 }

  return (
    <div className="fx-page fxb hl-page">
      {!mobile && (
        <div className="fxb-strip">
          {strip.map(m => {
            const p = liveOf(m, mids)
            return (
              <button key={m.coin} className={m.coin === coin ? 'active' : ''} onClick={() => pick(m.coin)}>
                <b>{m.symbol}</b> <span className={upDown(changeOf(m, p))}>{pct(changeOf(m, p))}</span>
              </button>
            )
          })}
        </div>
      )}

      <PairBar market={market} px={px} ctx={ctx} onPick={() => setPicker(o => !o)} picker={pickerPop} />

      {mobile ? (
        <>
          <div className="spot-panel hl-chart-m">{chart}</div>
          <div className="spot-panel hl-bt">
            <div className="hl-mini-tabs">
              <button className={mTab === 'book' ? 'active' : ''} onClick={() => setMTab('book')}>{T('Order book')}</button>
              <button className={mTab === 'trades' ? 'active' : ''} onClick={() => setMTab('trades')}>{T('Trades')}</button>
            </div>
            {mTab === 'book' ? <OrderBook {...bookProps} /> : <TradesList trades={trades} />}
          </div>
          <HlAccountBox account={acct.state} gate={gate} onFund={setFunding} />
          <div className="spot-panel"><AccountTabs acct={acct} byCoin={byCoin} mids={mids} gate={gate} coin={coin} onSelect={pick} onFund={setFunding} navigate={navigate} /></div>
          <div className="hl-mbar">
            <button className="trade-bar-buy" onClick={() => setSheet(true)}>{T('Buy / Long')}</button>
            <button className="trade-bar-sell" onClick={() => setSheet(true)}>{T('Sell / Short')}</button>
          </div>
          <Sheet open={sheet} onClose={() => setSheet(false)} title={`${market.symbol}-USD · ${fmtPx(px)}`}>
            <div className="fxb">{panel}</div>
          </Sheet>
        </>
      ) : (
        <div className="fxb-grid hl-grid">
          <div className="fxb-chart spot-panel">{chart}</div>
          <div className="fxb-trades hl-bt-wrap"><BookAndTrades {...bookProps} /></div>
          <div className="fxb-order">
            {panel}
            <HlAccountBox account={acct.state} gate={gate} onFund={setFunding} />
          </div>
          <div className="fxb-bottom spot-panel">
            <AccountTabs acct={acct} byCoin={byCoin} mids={mids} gate={gate} coin={coin} onSelect={pick} onFund={setFunding} navigate={navigate} />
          </div>
        </div>
      )}

      <div className="hl-foot fx-fine">
        {T('Markets, prices and orders are Hyperliquid’s: orders are signed in your browser and go straight to it. ARCDEX never holds your money.')}{' '}
        {BUILDER.perpF > 0 && T('ARCDEX’s fee is a Hyperliquid builder fee you approve once.')}{' '}
        <button className="link-btn" onClick={() => navigate({ name: 'futures' })}>{T('ARCDEX futures on Arc testnet')}</button>
      </div>

      {funding && <HlFundingModal gate={gate} account={acct.state} initial={funding} onClose={() => setFunding(null)} onDone={() => { acct.refresh(); gate.refresh() }} />}
      {enabling && <EnableTradingModal gate={gate} onClose={() => setEnabling(false)} onDone={() => { setEnabling(false); acct.refresh() }} />}
    </div>
  )
}
