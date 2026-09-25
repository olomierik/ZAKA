import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type SeriesType, type CandlestickData, CandlestickSeries, LineSeries, HistogramSeries } from 'lightweight-charts'
import { getPoolOhlcv, type OhlcvCandle } from '../api/gecko'
import { identiconUrl } from './Avatar'
import { INDICATORS, bollinger, ema, rsi, sma, vwap, type IndicatorId } from '../lib/indicators'
import { t as T } from '../lib/i18n'

const IND_KEY = 'arcdex:chart-indicators'
const RSI_PANE = 110
function loadIndicators(): Set<IndicatorId> {
  try { return new Set(JSON.parse(localStorage.getItem(IND_KEY) ?? '["volume"]') as IndicatorId[]) } catch { return new Set(['volume']) }
}

type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]
const RES_SECONDS: Record<Resolution, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }
const MIN_SIZES = [0, 10, 100, 1000] as const

/** A trade (or thesis) drawn on the chart as the trader's avatar (fomo-style). */
export interface ChartTrade {
  id: string
  time: number // ms
  priceUsd: number
  usd: number
  kind: 'buy' | 'sell' | 'thesis'
  maker: string | null
  avatarUrl?: string | null
  label?: string // tooltip, e.g. "@name bought $120"
  mine?: boolean
}

// `poolAddress` is the pair/pool contract, not the token — GeckoTerminal's
// OHLCV API is keyed by pool. Pass null while it's still resolving.
interface Props {
  poolAddress: string | null
  trades?: ChartTrade[]
  thesisMarks?: ChartTrade[]
  friends?: Set<string>
  supply?: number | null // tokens in circulation, for the Price ⇄ MCap switch
  symbol?: string
  onTraderClick?: (address: string) => void
}

interface Bubble { t: ChartTrade; x: number; y: number; size: number }

// Price axis: 2 decimals for $1+ coins, 4 significant digits for micro-caps.
const fmtPrice = (v: number) => v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v === 0 ? '0' : v.toPrecision(4)

export default function PriceChart({ poolAddress, trades, thesisMarks, friends, supply, symbol, onTraderClick }: Props) {
  const [res, setRes] = useState<Resolution>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [mode, setMode] = useState<'price' | 'mcap'>('price')
  const [showBubbles, setShowBubbles] = useState(true)
  const [showMine, setShowMine] = useState(true)
  const [showThesis, setShowThesis] = useState(true)
  const [friendsOnly, setFriendsOnly] = useState(false)
  const [minSize, setMinSize] = useState<(typeof MIN_SIZES)[number]>(0)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [isFull, setIsFull] = useState(false)
  const [ind, setInd] = useState<Set<IndicatorId>>(loadIndicators)
  const [indOpen, setIndOpen] = useState(false)
  const indSeries = useRef<ISeriesApi<SeriesType>[]>([])
  const toggleInd = (id: IndicatorId) => setInd(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    try { localStorage.setItem(IND_KEY, JSON.stringify([...n])) } catch { /* storage blocked */ }
    return n
  })
  const withRsi = ind.has('rsi')
  const needsFit = useRef(true)
  const scale = mode === 'mcap' && supply ? supply : 1

  useEffect(() => {
    needsFit.current = true
    if (!poolAddress) { setCandles([]); return }
    let cancelled = false
    const load = (initial: boolean) => getPoolOhlcv(poolAddress, res)
      .then(c => { if (!cancelled) setCandles(c) })
      // A failed refresh keeps the candles already drawn; only a failed
      // first load clears them.
      .catch(() => { if (!cancelled && initial) setCandles([]) })
    void load(true)
    // Keep the last candle moving — the gecko proxy caches for 10s, so this
    // costs at most one upstream call per pool per 20s across all viewers.
    const id = setInterval(() => { if (!document.hidden) void load(false) }, 20_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [poolAddress, res])
  useEffect(() => { needsFit.current = true }, [mode])
  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement && document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const wrapRef      = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const frame        = useRef(0)

  // Positions every bubble at its trade's candle and price. Re-run whenever
  // the chart pans/zooms/resizes or the data changes.
  const layout = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const chart = chartRef.current, series = seriesRef.current, el = containerRef.current
      const all = [...(showBubbles ? trades ?? [] : []), ...(showThesis ? thesisMarks ?? [] : [])]
      if (!chart || !series || !el || !all.length || !candles.length) { setBubbles([]); return }
      const step = RES_SECONDS[res]
      const first = candles[0].time, last = candles[candles.length - 1].time
      const paneW = el.clientWidth - chart.priceScale('right').width()
      const paneH = chart.panes()[0]?.getHeight() ?? el.clientHeight - chart.timeScale().height()
      const out: Bubble[] = []
      for (const t of all) {
        if (t.kind !== 'thesis' && t.usd < minSize) continue
        if (friendsOnly && t.kind !== 'thesis' && !(t.mine || (t.maker && friends?.has(t.maker.toLowerCase())))) continue
        if (!t.priceUsd) continue
        const bucket = Math.floor(t.time / 1000 / step) * step
        if (bucket < first || bucket > last) continue
        const x = chart.timeScale().timeToCoordinate(bucket as never)
        const y = series.priceToCoordinate(t.priceUsd * scale)
        if (x === null || y === null || x < 0 || x > paneW || y < 0 || y > paneH) continue
        const size = t.kind === 'thesis' ? 26 : Math.max(16, Math.min(34, 12 + Math.log10(Math.max(1, t.usd)) * 6))
        out.push({ t, x, y, size })
      }
      // Big trades on top; cap the count so a busy coin stays readable.
      setBubbles(out.sort((a, b) => a.t.usd - b.t.usd).slice(-180))
    })
  }, [trades, thesisMarks, showBubbles, showThesis, friendsOnly, friends, minSize, candles, res, scale])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0b1628' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#1e3050' }, horzLines: { color: '#1e3050' } },
      crosshair: {
        vertLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
        horzLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
      },
      rightPriceScale: { borderColor: '#1e3050' },
      timeScale: { borderColor: '#1e3050', timeVisible: true },
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 340,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    chartRef.current  = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight || 340 })
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // Pan/zoom/resize → re-place bubbles.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const onRange = () => layout()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    chart.timeScale().subscribeSizeChange(onRange)
    layout()
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.timeScale().unsubscribeSizeChange(onRange)
    }
  }, [layout])

  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as never, open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale,
    }))
    seriesRef.current.applyOptions({ priceFormat: scale > 1 ? { type: 'custom', formatter: (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`, minMove: 1 } : { type: 'custom', formatter: fmtPrice, minMove: 1e-12 } })
    seriesRef.current.setData(data)
    // Fit once per pool/resolution/mode, not on every live refresh —
    // otherwise the user's zoom/scroll would snap back every 20s.
    if (needsFit.current) { chartRef.current?.timeScale().fitContent(); needsFit.current = false }
    layout()
  }, [candles, layout, scale])

  // Indicators: rebuilt whenever the data, the Price/MCap scale or the
  // selection changes (cheap — a few hundred points each).
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    indSeries.current.forEach(x => { try { chart.removeSeries(x) } catch { /* already gone */ } })
    indSeries.current = []
    while (chart.panes().length > 1) { try { chart.removePane(chart.panes().length - 1) } catch { break } }
    if (!candles.length || !ind.size) return
    const times = candles.map(c => c.time as never)
    const closes = candles.map(c => c.close * scale)
    const line = (vals: (number | null)[], color: string, pane = 0, opts: Record<string, unknown> = {}) => {
      const x = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts }, pane)
      x.setData(vals.map((v, i) => (v === null ? { time: times[i] } : { time: times[i], value: v })))
      indSeries.current.push(x as ISeriesApi<SeriesType>)
      return x
    }
    const color = (id: IndicatorId) => INDICATORS.find(i => i.id === id)!.color
    if (ind.has('volume')) {
      const v = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
      v.setData(candles.map(c => ({ time: c.time as never, value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' })))
      indSeries.current.push(v as ISeriesApi<SeriesType>)
    }
    if (ind.has('ma7')) line(sma(closes, 7), color('ma7'))
    if (ind.has('ma25')) line(sma(closes, 25), color('ma25'))
    if (ind.has('ma99')) line(sma(closes, 99), color('ma99'))
    if (ind.has('ema20')) line(ema(closes, 20), color('ema20'))
    if (ind.has('bb')) {
      const b = bollinger(closes, 20, 2)
      line(b.upper, color('bb'), 0, { lineStyle: 2 }); line(b.mid, color('bb')); line(b.lower, color('bb'), 0, { lineStyle: 2 })
    }
    if (ind.has('vwap')) line(vwap(candles.map(c => ({ ...c, high: c.high * scale, low: c.low * scale, close: c.close * scale }))), color('vwap'), 0, { lineWidth: 2 })
    if (ind.has('rsi')) {
      const r = line(rsi(closes, 14), color('rsi'), 1, { lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } })
      r.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' })
      r.createPriceLine({ price: 30, color: 'rgba(34,197,94,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' })
      chart.panes()[1]?.setHeight(RSI_PANE)
    }
    layoutRef.current()
    // layout via ref: new trades arrive every few seconds and must not rebuild the indicators
  }, [candles, scale, ind])

  function screenshot() {
    const chart = chartRef.current
    if (!chart) return
    const canvas = chart.takeScreenshot()
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${symbol ?? 'chart'}-${res}-${mode}.png`
    a.click()
  }
  function fullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, border: '1px solid', cursor: 'pointer',
    borderColor: active ? 'var(--adx-accent)' : 'var(--adx-card-border)',
    background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
    color: active ? 'var(--adx-accent)' : 'var(--text-muted)',
  })
  const check = (on: boolean, set: (v: boolean) => void, label: string) => (
    <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={on} onChange={e => set(e.target.checked)} />{label}</label>
  )

  return (
    <div ref={wrapRef} style={{ background: isFull ? '#0b1628' : undefined, display: 'flex', flexDirection: 'column', height: isFull ? '100%' : undefined, padding: isFull ? 16 : 0 }}>
    <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {RESOLUTIONS.map(r => (
        <button key={r.value} onClick={() => setRes(r.value)} style={pill(res === r.value)}>{r.label}</button>
      ))}
      <span style={{ flex: 1 }} />
      {supply ? (
        <span style={{ display: 'inline-flex', border: '1px solid var(--adx-card-border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['price', 'mcap'] as const).map(m => <button key={m} onClick={() => setMode(m)} style={{ ...pill(mode === m), border: 'none', borderRadius: 0 }}>{m === 'price' ? T("Price") : T("MCap")}</button>)}
        </span>
      ) : null}
      <span style={{ position: 'relative' }}>
        <button onClick={() => setIndOpen(o => !o)} style={pill(ind.size > 0)} title={T("Indicators")}>ƒx {T("Indicators")}{ind.size ? ` (${ind.size})` : ''}</button>
        {indOpen && (
          <div className="menu-pop" style={{ top: 30, right: 0, minWidth: 220, zIndex: 20 }} onMouseLeave={() => setIndOpen(false)}>
            {INDICATORS.map(i => (
              <label key={i.id} className="menu-item" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={ind.has(i.id)} onChange={() => toggleInd(i.id)} />
                <span style={{ width: 10, height: 3, borderRadius: 2, background: i.color, display: 'inline-block' }} />
                {T(i.label)}
              </label>
            ))}
          </div>
        )}
      </span>
      <button onClick={screenshot} style={pill(false)} title={T("Save chart image")}>📷</button>
      <button onClick={fullscreen} style={pill(false)} title={T("Fullscreen")}>⛶</button>
    </div>
    <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', flex: 1 }}>
      <div ref={containerRef} style={{ height: isFull ? 'calc(100vh - 120px)' : 340 + (withRsi ? RSI_PANE : 0) }} />
      {bubbles.length > 0 && (
        // zIndex: the chart library layers its canvases with z-index 1–2,
        // which would otherwise paint over these avatars.
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
          {bubbles.map(({ t, x, y, size }) => (
            <div key={t.id} title={t.label} onClick={() => t.maker && onTraderClick?.(t.maker)}
              style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, pointerEvents: 'auto', cursor: t.maker && onTraderClick ? 'pointer' : 'default' }}>
              <img src={t.avatarUrl || (t.maker ? identiconUrl(t.maker) : identiconUrl(t.id))} alt=""
                style={{
                  width: size, height: size, borderRadius: '50%', objectFit: 'cover', background: '#0b1628',
                  border: `2px solid ${t.kind === 'thesis' ? '#60a5fa' : t.mine && showMine ? '#facc15' : t.kind === 'buy' ? '#22c55e' : '#ef4444'}`,
                  boxShadow: t.mine && showMine ? '0 0 0 3px rgba(250,204,21,0.35)' : '0 1px 4px rgba(0,0,0,0.5)',
                }} />
              {t.kind === 'thesis' && <span style={{ position: 'absolute', right: -6, top: -8, fontSize: 12 }}>💬</span>}
            </div>
          ))}
        </div>
      )}
      {!candles.length && (
        <div style={{ position: 'absolute', inset: 0, height: 340,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(11,22,40,0.7)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{T("Loading chart…")}</div>
      )}
    </div>
    {(trades || thesisMarks) && (
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text)' }}>{T("Chart overlays")}</b>
        {check(showBubbles, setShowBubbles, T('Trades'))}
        {check(showMine, setShowMine, T('My swaps'))}
        {thesisMarks && check(showThesis, setShowThesis, T('Thesis'))}
        {friends && check(friendsOnly, setFriendsOnly, T('Friends only'))}
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{T("Min size")}<select value={minSize} onChange={e => setMinSize(Number(e.target.value) as (typeof MIN_SIZES)[number])} className="disc-select">
            {MIN_SIZES.map(m => <option key={m} value={m}>{m === 0 ? T("All") : `>$${m >= 1000 ? '1K' : m}`}</option>)}
          </select>
        </span>
      </div>
    )}
    </div>
  )
}
