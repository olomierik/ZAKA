// /futures — the futures trading screen, before trading opens (ARCSENSE,
// 2026-10-03, owner: "a futures page with trading parameters showing live
// prices, all pairs against USDC, real price movements and a chart; a button
// that says futures trading will be enabled soon; a coin listing button").
//
// Prices are real: Binance's public market data for each coin's USDC pair
// (data-api.binance.vision and data-stream.binance.vision: keyless, CORS
// open), candles from its REST API and live updates over its WebSocket. The
// order panel computes what a position would be (size, entry, estimated
// liquidation) but nothing can be sent: its button says trading opens soon.
// Pyth's public endpoints, tried first, now need an API key; Chainlink's
// feeds on Arc update only on 0.5% moves or daily, too slowly for a chart.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { sendSupport } from '../api/social'
import { useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'
import type { Page } from '../App'

const REST = 'https://data-api.binance.vision/api/v3'
const WS = 'wss://data-stream.binance.vision/stream?streams='

interface Market { sym: string; name: string; pair: string; dp: number }
/** Perpetual markets, each quoted in USDC. */
const MARKETS: Market[] = [
  { sym: 'BTC', name: 'Bitcoin', pair: 'BTCUSDC', dp: 2 },
  { sym: 'ETH', name: 'Ether', pair: 'ETHUSDC', dp: 2 },
  { sym: 'SOL', name: 'Solana', pair: 'SOLUSDC', dp: 2 },
  { sym: 'BNB', name: 'BNB', pair: 'BNBUSDC', dp: 2 },
  { sym: 'XRP', name: 'XRP', pair: 'XRPUSDC', dp: 4 },
  { sym: 'AVAX', name: 'Avalanche', pair: 'AVAXUSDC', dp: 3 },
  { sym: 'LINK', name: 'Chainlink', pair: 'LINKUSDC', dp: 3 },
  { sym: 'DOGE', name: 'Dogecoin', pair: 'DOGEUSDC', dp: 5 },
]
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
type Timeframe = (typeof TIMEFRAMES)[number]
const MAX_LEVERAGE = 10
/** Used only for the liquidation estimate; the real parameters are set at launch. */
const MAINTENANCE_MARGIN = 0.005

interface Ticker { last: number; open: number; high: number; low: number; quoteVolume: number }
type Tickers = Record<string, Ticker>

const fmt = (n: number | null | undefined, dp: number) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
const compactUsd = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const pct = (t: Ticker | undefined) => (t && t.open ? (t.last / t.open - 1) * 100 : null)

/** A WebSocket to Binance's public streams that reconnects (1s, 2s, … up to 15s) until closed. */
function openStream(streams: string[], onData: (stream: string, data: Record<string, unknown>) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let wait = 1_000
  const connect = () => {
    ws = new WebSocket(WS + streams.join('/'))
    ws.onopen = () => { wait = 1_000 }
    ws.onmessage = e => { try { const m = JSON.parse(String(e.data)) as { stream: string; data: Record<string, unknown> }; onData(m.stream, m.data) } catch { /* not ours */ } }
    ws.onclose = () => { if (!closed) setTimeout(connect, wait = Math.min(wait * 2, 15_000)) }
  }
  connect()
  return () => { closed = true; ws?.close() }
}

/** Every market's 24h numbers: REST once, then each one's mini ticker every second. */
function useTickers(): { tickers: Tickers; failed: boolean } {
  const [tickers, setTickers] = useState<Tickers>({})
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const syms = encodeURIComponent(JSON.stringify(MARKETS.map(m => m.pair)))
    fetch(`${REST}/ticker/24hr?symbols=${syms}`).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rows: { symbol: string; lastPrice: string; openPrice: string; highPrice: string; lowPrice: string; quoteVolume: string }[]) => {
        const next: Tickers = {}
        for (const r of rows) next[r.symbol] = { last: +r.lastPrice, open: +r.openPrice, high: +r.highPrice, low: +r.lowPrice, quoteVolume: +r.quoteVolume }
        setTickers(next)
      }).catch(() => setFailed(true))
    return openStream(MARKETS.map(m => `${m.pair.toLowerCase()}@miniTicker`), (_s, d) => {
      const pair = String(d.s)
      setTickers(prev => ({ ...prev, [pair]: { last: +String(d.c), open: +String(d.o), high: +String(d.h), low: +String(d.l), quoteVolume: +String(d.q) } }))
      setFailed(false)
    })
  }, [])
  return { tickers, failed }
}

/** The selected market's candles (REST, the last 500) kept live by its kline stream, and its last trade price. */
function CandleChart({ market, timeframe, onPrice }: { market: Market; timeframe: Timeframe; onPrice: (p: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null)
  const priceCb = useRef(onPrice)
  priceCb.current = onPrice

  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8ca3c0', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    candles.current = c.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    chart.current = c
    return () => { c.remove(); chart.current = null; candles.current = null; volume.current = null }
  }, [])

  useEffect(() => {
    const s = candles.current, v = volume.current
    if (!s || !v) return
    let alive = true
    s.applyOptions({ priceFormat: { type: 'price', precision: market.dp, minMove: 10 ** -market.dp } })
    s.setData([]); v.setData([])
    const bar = (k: (string | number)[]) => ({ time: Math.floor(Number(k[0]) / 1000) as UTCTimestamp, open: +k[1], high: +k[2], low: +k[3], close: +k[4] })
    const vol = (k: (string | number)[]) => ({ time: Math.floor(Number(k[0]) / 1000) as UTCTimestamp, value: +k[7], color: +k[4] >= +k[1] ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' })
    fetch(`${REST}/klines?symbol=${market.pair}&interval=${timeframe}&limit=500`).then(r => r.json()).then((rows: (string | number)[][]) => {
      if (!alive || !Array.isArray(rows)) return
      s.setData(rows.map(bar)); v.setData(rows.map(vol))
      chart.current?.timeScale().fitContent()
      const last = rows[rows.length - 1]
      if (last) priceCb.current(+last[4])
    }).catch(() => {})
    const pair = market.pair.toLowerCase()
    const close = openStream([`${pair}@kline_${timeframe}`, `${pair}@aggTrade`], (stream, d) => {
      if (!alive) return
      if (stream.endsWith('@aggTrade')) { priceCb.current(+String(d.p)); return }
      const k = d.k as Record<string, unknown>
      const row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q] as (string | number)[]
      try { s.update(bar(row)); v.update(vol(row)) } catch { /* an older bar than the last */ }
    })
    return () => { alive = false; close() }
  }, [market, timeframe])

  return <div ref={box} className="fx-chart" />
}

/** "List your coin": a request to the team, sent as a support ticket (topic other) from the signed-in wallet. */
function ListingModal({ onClose }: { onClose: () => void }) {
  const trader = useTrader()
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [site, setSite] = useState('')
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [state, setState] = useState<'' | 'sending' | 'sent' | { error: string }>('')
  const validToken = /^0x[0-9a-fA-F]{40}$/.test(token.trim())
  const ready = name.trim().length >= 2 && validToken && contact.trim().length >= 3
  async function send() {
    setState('sending')
    const message = ['Coin listing request', `Project: ${name.trim()}`, `Token: ${token.trim()}`, site.trim() && `Website or X: ${site.trim()}`, notes.trim() && `Notes: ${notes.trim()}`].filter(Boolean).join('\n')
    try { await sendSupport(trader, { category: 'other', message: message.slice(0, 2000), contact: contact.trim() }); setState('sent') }
    catch (e) { setState({ error: e instanceof Error ? e.message : T('Could not send — try again') }) }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{T('List your coin')}</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        {state === 'sent' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: '2rem' }}>✓</div>
            <b>{T('Request sent')}</b>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('The ARCSENSE team reviews every request. If it fits, we will reach out.')}</div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={onClose}>{T('Done')}</button>
          </div>
        ) : !trader.address ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('Connect or unlock a wallet first, so we can reach you about your coin.')}</div>
        ) : (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('Want your coin listed on ARCSENSE? Tell us about it and the team will review it.')}</div>
            <label className="field-label">{T('Project name')}<input className="field" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
            <label className="field-label">{T('Token contract address')}<input className="field" value={token} onChange={e => setToken(e.target.value)} placeholder="0x…" style={{ fontFamily: 'var(--mono)' }} /></label>
            {token.trim() && !validToken && <div className="fx-hint-bad">{T('That address looks wrong.')}</div>}
            <label className="field-label">{T('Website or X (optional)')}<input className="field" value={site} maxLength={200} onChange={e => setSite(e.target.value)} placeholder="https://…" /></label>
            <label className="field-label">{T('How can we reach you?')}<input className="field" value={contact} maxLength={120} onChange={e => setContact(e.target.value)} placeholder={T('X, Telegram or email')} /></label>
            <label className="field-label">{T('Anything else? (optional)')}<textarea className="field" rows={3} maxLength={800} value={notes} onChange={e => setNotes(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} /></label>
            {typeof state === 'object' && <div className="fx-hint-bad">⚠ {state.error}</div>}
            <button className="btn-primary" disabled={!ready || state === 'sending'} onClick={() => void send()}>{state === 'sending' ? T('Sending…') : T('Send request')}</button>
          </>
        )}
      </div>
    </div>
  )
}

export default function FuturesPage({ navigate }: { navigate: (p: Page) => void }) {
  const { tickers, failed } = useTickers()
  const [market, setMarket] = useState<Market>(MARKETS[0])
  const [timeframe, setTimeframe] = useState<Timeframe>('15m')
  const [trade, setTrade] = useState<{ price: number; dir: 'up' | 'down' | '' }>({ price: 0, dir: '' })
  const [listing, setListing] = useState(false)
  // The order panel: what a position would be. Nothing is sent.
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [margin, setMargin] = useState('100')
  const [leverage, setLeverage] = useState(5)
  const [limitPrice, setLimitPrice] = useState('')

  const tk = tickers[market.pair]
  const last = trade.price || tk?.last || 0
  const change = pct(tk)
  useEffect(() => { setTrade({ price: 0, dir: '' }); setLimitPrice('') }, [market])
  const onPrice = useMemo(() => (p: number) => setTrade(prev => ({ price: p, dir: prev.price ? (p > prev.price ? 'up' : p < prev.price ? 'down' : prev.dir) : '' })), [])

  const entry = kind === 'limit' && +limitPrice > 0 ? +limitPrice : last
  const m = Math.max(0, +margin || 0)
  const notional = m * leverage
  const qty = entry ? notional / entry : 0
  const liq = entry ? (side === 'long' ? entry * (1 - 1 / leverage + MAINTENANCE_MARGIN) : entry * (1 + 1 / leverage - MAINTENANCE_MARGIN)) : null

  return (
    <div className="fx-page">
      <div className="fx-top">
        <div className="fx-title">
          <h2 className="page-h">📊 {T('Perpetual futures')}</h2>
          <span className="soon-badge">{T('Coming soon')}</span>
        </div>
        <button className="btn-ghost fx-list-btn" onClick={() => setListing(true)}>＋ {T('List your coin')}</button>
      </div>

      <div className="fx-markets" role="tablist">
        {MARKETS.map(mk => {
          const t = tickers[mk.pair], c = pct(t)
          return (
            <button key={mk.pair} role="tab" aria-selected={mk.pair === market.pair} className={`fx-market${mk.pair === market.pair ? ' active' : ''}`} onClick={() => setMarket(mk)}>
              <b>{mk.sym}-USDC</b>
              <span>{fmt(t?.last, mk.dp)}</span>
              <span className={c == null ? '' : c >= 0 ? 'fx-up' : 'fx-down'}>{c == null ? '—' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`}</span>
            </button>
          )
        })}
      </div>

      <div className="fx-stats">
        <div className="fx-stat-main">
          <span className="fx-pair">{market.sym}-USDC <small>{T('Perp')}</small></span>
          <span className={`fx-last ${trade.dir === 'up' ? 'fx-up' : trade.dir === 'down' ? 'fx-down' : ''}`}>{fmt(last || null, market.dp)}</span>
        </div>
        <div><span>{T('24h change')}</span><b className={change == null ? '' : change >= 0 ? 'fx-up' : 'fx-down'}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</b></div>
        <div><span>{T('24h high')}</span><b>{fmt(tk?.high, market.dp)}</b></div>
        <div><span>{T('24h low')}</span><b>{fmt(tk?.low, market.dp)}</b></div>
        <div><span>{T('24h volume')}</span><b>{tk ? compactUsd(tk.quoteVolume) : '—'}</b></div>
        <div><span>{T('Max leverage')}</span><b>{MAX_LEVERAGE}×</b></div>
      </div>

      <div className="fx-main">
        <div className="fx-chart-card">
          <div className="fx-tf">
            {TIMEFRAMES.map(tf => <button key={tf} className={tf === timeframe ? 'active' : ''} onClick={() => setTimeframe(tf)}>{tf === '1d' ? '1D' : tf}</button>)}
          </div>
          <CandleChart market={market} timeframe={timeframe} onPrice={onPrice} />
          <div className="fx-source">{failed ? T('Live prices unavailable right now.') : T('Live USDC market prices from Binance. Nothing is traded here yet.')}</div>
        </div>

        <div className="fx-order">
          <div className="fx-side">
            <button className={side === 'long' ? 'long active' : 'long'} onClick={() => setSide('long')}>{T('Long')}</button>
            <button className={side === 'short' ? 'short active' : 'short'} onClick={() => setSide('short')}>{T('Short')}</button>
          </div>
          <div className="fx-kind">
            <button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>{T('Market')}</button>
            <button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>{T('Limit')}</button>
          </div>
          {kind === 'limit' && (
            <label className="field-label">{T('Limit price')}
              <input className="field" inputMode="decimal" value={limitPrice} placeholder={fmt(last || null, market.dp)} onChange={e => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ''))} />
            </label>
          )}
          <label className="field-label">{T('Margin (USDC)')}
            <input className="field" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value.replace(/[^0-9.]/g, ''))} />
          </label>
          <div className="fx-presets">{[10, 50, 100, 500].map(v => <button key={v} onClick={() => setMargin(String(v))}>${v}</button>)}</div>
          <label className="field-label">{T('Leverage')} <b className="fx-lev">{leverage}×</b>
            <input type="range" min={1} max={MAX_LEVERAGE} step={1} value={leverage} onChange={e => setLeverage(+e.target.value)} />
          </label>
          <div className="fx-ticks">{[1, 2, 5, 10].map(v => <button key={v} className={v === leverage ? 'active' : ''} onClick={() => setLeverage(v)}>{v}×</button>)}</div>
          <div className="fx-summary">
            <div><span>{T('Entry price')}</span><b>{fmt(entry || null, market.dp)}</b></div>
            <div><span>{T('Position size')}</span><b>{notional ? `$${fmt(notional, 2)}` : '—'}{qty ? <small> · {fmt(qty, qty >= 1 ? 4 : 6)} {market.sym}</small> : null}</b></div>
            <div><span>{T('Est. liquidation')}</span><b className="fx-down">{fmt(liq, market.dp)}</b></div>
          </div>
          <button className="fx-go" disabled>🔒 {T('Futures trading will be enabled soon')}</button>
          <div className="fx-fine">{T('Estimates assume a 0.5% maintenance margin. Final parameters are announced at launch.')}</div>
        </div>
      </div>

      <div className="soon-points">
        {([
          [T('USDC in, USDC out'), T('Margin, profits and fees are all in USDC, the currency Arc runs on.')],
          [T('Testnet first'), T('Futures open on Arc testnet first, then on mainnet after an independent audit.')],
          [T('Fees fund the pool'), T('Fees from $SENSE trading are added as liquidity for futures trading.')],
        ] as [string, string][]).map(([title, body]) => <div key={title} className="soon-point"><b>{title}</b><span>{body}</span></div>)}
      </div>
      <div className="soon-cta"><button className="btn-ghost" onClick={() => navigate({ name: 'terminal' })}>{T('Trade spot now')} →</button></div>

      {listing && <ListingModal onClose={() => setListing(false)} />}
    </div>
  )
}
