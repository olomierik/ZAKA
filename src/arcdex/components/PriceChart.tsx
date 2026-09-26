import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type SeriesType, type CandlestickData, LineSeries, HistogramSeries } from 'lightweight-charts'
import { addMainSeries, lineColors, loadChartStyle, onChartStyle, saveChartStyle, type ChartStyle, type MainSeries } from '../lib/chartStyle'
import { getPoolOhlcv } from '../api/gecko'
import { candlesFromTicks, mergeCandles, type Candle, type Tick } from '../lib/candles'
import { engineEnabled, getEngineCandles, marketStream, useEngineStatus } from '../api/marketStream'
import type { WireCandle } from '../../../api/_marketProtocol'
import { identiconUrl } from './Avatar'
import { INDICATORS, bollinger, ema, rsi, sma, vwap, type IndicatorId } from '../lib/indicators'
import { t as T } from '../lib/i18n'

const IND_KEY = 'arcdex:chart-indicators'
const RSI_PANE = 110
function loadIndicators(): Set<IndicatorId> {
  try { return new Set(JSON.parse(localStorage.getItem(IND_KEY) ?? '["volume"]') as IndicatorId[]) } catch { return new Set(['volume']) }
}

type Resolution = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1s', value: '1s' }, { label: '5s', value: '5s' }, { label: '15s', value: '15s' },
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]
const RES_SECONDS: Record<Resolution, number> = { '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }
/** Sub-minute candles exist only on-chain (GeckoTerminal's finest is 1m). */
const onChainOnly = (r: Resolution) => RES_SECONDS[r] < 60
const RES_KEY = 'arcdex:chart-res'
function loadRes(hasTicks: boolean): Resolution {
  try {
    const r = localStorage.getItem(RES_KEY) as Resolution | null
    if (r && r in RES_SECONDS && (hasTicks || !onChainOnly(r))) return r
  } catch { /* storage blocked */ }
  return hasTicks ? '1m' : '1h'
}
/** Bars shown when a chart opens — recent action, not the whole history squeezed in. */
const VISIBLE_BARS = 140
const fromWireCandle = (c: WireCandle): Candle => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] })
/** History with live candles laid over it, by bucket. */
function overlay(history: Candle[], live: Candle[]): Candle[] {
  if (!live.length) return history
  const byT = new Map(history.map(c => [c.time, c]))
  for (const c of live) byT.set(c.time, c)
  return [...byT.values()].sort((a, b) => a.time - b.time)
}
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
// `ticks` are the pool's on-chain swaps (null while loading): they draw the
// recent candles and move the last one on every new swap; GeckoTerminal's
// candles fill in the history before them.
interface Props {
  poolAddress: string | null
  ticks?: Tick[] | null
  /** Swaps are streaming in live right now. */
  live?: boolean
  /** With the market engine connected: its stored candles for history and
   * its CANDLE_UPDATE events live (each one updates just that candle). */
  engineToken?: string
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

export default function PriceChart({ poolAddress, ticks, live, engineToken, trades, thesisMarks, friends, supply, symbol, onTraderClick }: Props) {
  const engineStatus = useEngineStatus()
  const engineMode = engineEnabled && !!engineToken && engineStatus === 'open'
  const hasTicks = ticks !== undefined || engineMode
  const [res, setResState] = useState<Resolution>(() => loadRes(hasTicks))
  const setRes = (r: Resolution) => { setResState(r); try { localStorage.setItem(RES_KEY, r) } catch { /* storage blocked */ } }
  const [history, setHistory] = useState<Candle[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [engineHistory, setEngineHistory] = useState(false)
  const [liveCandles, setLiveCandles] = useState<Candle[]>([])
  const [mode, setMode] = useState<'price' | 'mcap'>('price')
  const [style, setStyle] = useState<ChartStyle>(loadChartStyle)
  useEffect(() => onChartStyle(setStyle), [])
  const styleRef = useRef(style)
  styleRef.current = style
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

  // History from GeckoTerminal. With on-chain swaps driving the recent
  // candles it only needs an occasional refresh; without them (non-Argus
  // pages) it's the whole chart, refreshed every 20s.
  // (With the engine: its stored candles first — every timeframe — and
  // GeckoTerminal only if the engine has too little history for this coin.)
  useEffect(() => {
    needsFit.current = true
    setHistory([]); setHistoryLoaded(false); setEngineHistory(false)
    let cancelled = false
    const fromGecko = () => {
      if (!poolAddress || onChainOnly(res)) { setHistoryLoaded(true); return null }
      const load = () => getPoolOhlcv(poolAddress, res as Exclude<Resolution, '1s' | '5s' | '15s'>, 300)
        .then(c => { if (!cancelled) setHistory(c) })
        // A failed refresh keeps the candles already drawn.
        .catch(() => {})
        .finally(() => { if (!cancelled) setHistoryLoaded(true) })
      void load()
      return setInterval(() => { if (!document.hidden) void load() }, hasTicks ? 90_000 : 20_000)
    }
    let id: ReturnType<typeof setInterval> | null = null
    if (engineMode && engineToken) {
      getEngineCandles(engineToken, res, 500)
        .then(c => {
          if (cancelled) return
          if (c.length >= 20) { setHistory(c.map(fromWireCandle)); setEngineHistory(true); setHistoryLoaded(true) }
          else id = fromGecko()
        })
        .catch(() => { if (!cancelled) id = fromGecko() })
    } else id = fromGecko()
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [poolAddress, res, hasTicks, engineMode, engineToken])

  // Engine live candles: each CANDLE_UPDATE replaces its bucket.
  useEffect(() => {
    setLiveCandles([])
    if (!engineMode || !engineToken) return
    return marketStream.subscribe({ channel: 'candles', token: engineToken, interval: res }, m => {
      if (m.t !== 'CANDLE_UPDATE' || m.i !== res) return
      const c = fromWireCandle(m.d)
      setLiveCandles(prev => [...prev.filter(x => x.time !== c.time), c].sort((a, b) => a.time - b.time).slice(-200))
    })
  }, [engineMode, engineToken, res])

  const step = RES_SECONDS[res]
  const recent = useMemo(() => candlesFromTicks(ticks ?? [], step), [ticks, step])
  const candles = useMemo(() => {
    if (engineMode && engineHistory) return overlay(history, liveCandles)
    const base = mergeCandles(onChainOnly(res) ? [] : history, recent)
    return engineMode ? overlay(base, liveCandles) : base
  }, [engineMode, engineHistory, history, liveCandles, recent, res])
  const loading = candles.length === 0 && (!historyLoaded || (hasTicks && ticks === null))
  useEffect(() => { needsFit.current = true }, [mode])
  // Without on-chain swaps there are no sub-minute candles.
  useEffect(() => { if (!hasTicks && onChainOnly(res)) setResState('1h') }, [hasTicks, res])
  // 5s candles exist only in the engine.
  useEffect(() => { if (!engineMode && res === '5s') setResState('15s') }, [engineMode, res])
  // Wheel zoom only in fullscreen, where there's no page to scroll.
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: isFull }, handleScale: { mouseWheel: isFull } })
  }, [isFull])
  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement && document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const wrapRef      = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const seriesRef    = useRef<MainSeries | null>(null)
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null)
  const applied      = useRef<{ key: string; data: CandlestickData[] }>({ key: '', data: [] })
  const lineUp       = useRef(true)
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
      timeScale: { borderColor: '#1e3050', timeVisible: true, secondsVisible: true },
      // The page has to scroll past the chart: a wheel or a vertical swipe
      // over it scrolls the page. Zoom with a pinch, a drag on the time
      // axis, or the wheel in fullscreen.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 340,
    })
    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight || 340 })
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  // The price series — a line or candlesticks. Changing the style swaps it
  // (the draw effect below then redraws everything into the new one).
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = addMainSeries(chart, style)
    seriesRef.current = s
    lineUp.current = true
    applied.current = { key: '', data: [] }
    return () => {
      try { chart.removeSeries(s) } catch { /* the chart itself is gone */ }
      if (seriesRef.current === s) seriesRef.current = null
    }
  }, [style])

  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // The line is green while what's on screen is up (first visible bar to
  // last), red while it's down — it follows pans and zooms. Refs only, so
  // any render's copy of this function behaves the same.
  const recolor = () => {
    const series = seriesRef.current, chart = chartRef.current, data = applied.current.data
    if (styleRef.current !== 'line' || !series || !chart || !data.length) return
    const r = chart.timeScale().getVisibleLogicalRange()
    const last = data.length - 1
    const i0 = r ? Math.min(last, Math.max(0, Math.ceil(r.from))) : 0
    const i1 = r ? Math.min(last, Math.max(i0, Math.floor(r.to))) : last
    const up = data[i1].close >= data[i0].close
    if (up !== lineUp.current) { series.applyOptions(lineColors(up)); lineUp.current = up }
  }
  const recolorRef = useRef(recolor)
  recolorRef.current = recolor

  // Pan/zoom/resize → re-place bubbles, re-colour the line.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const onRange = () => { layout(); recolorRef.current() }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    chart.timeScale().subscribeSizeChange(onRange)
    layout()
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.timeScale().unsubscribeSizeChange(onRange)
    }
  }, [layout])

  // Draw. A new swap usually only changes the last candle (or starts a new
  // one): that's a cheap update() and the chart ticks in place. Anything
  // else — new timeframe, history refresh, backfill — redraws it all.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as never, open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale,
    }))
    const key = `${poolAddress}|${res}|${scale}|${style}`
    const prev = applied.current
    const n = prev.data.length
    const same = (a: CandlestickData | undefined, b: CandlestickData | undefined) => !!a && !!b && a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close
    const tailOnly = prev.key === key && n > 1 && data.length >= n && data.length - n <= 2 && data[0].time === prev.data[0].time && same(data[n - 2], prev.data[n - 2])
    // A line only needs each bar's close.
    const point = (d: CandlestickData) => (style === 'candles' ? d : { time: d.time, value: d.close })
    if (tailOnly) {
      for (let i = n - 1; i < data.length; i++) series.update(point(data[i]))
      const vol = volRef.current
      if (vol) for (let i = n - 1; i < candles.length; i++) {
        const c = candles[i]
        vol.update({ time: c.time as never, value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' })
      }
    } else {
      series.applyOptions({ priceFormat: scale > 1 ? { type: 'custom', formatter: (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`, minMove: 1 } : { type: 'custom', formatter: fmtPrice, minMove: 1e-12 } })
      series.setData(data.map(point))
      // Frame once per pool/timeframe/mode, not on every refresh — otherwise
      // the user's zoom/scroll would snap back.
      if (needsFit.current && data.length) {
        const ts = chartRef.current?.timeScale()
        if (data.length > VISIBLE_BARS) ts?.setVisibleLogicalRange({ from: data.length - VISIBLE_BARS, to: data.length + 4 })
        else ts?.fitContent()
        needsFit.current = false
      }
    }
    applied.current = { key, data }
    recolorRef.current()
    layoutRef.current()
  }, [candles, scale, res, poolAddress, style])

  // Indicators: rebuilt when a bar is added, or the Price/MCap scale or
  // the selection changes — not on every tick (the draw effect keeps the
  // volume bar live; the lines catch up on the next bar).
  const candlesRef = useRef(candles)
  candlesRef.current = candles
  const barsKey = `${candles.length}|${candles[0]?.time ?? 0}`
  useEffect(() => {
    const chart = chartRef.current
    const candles = candlesRef.current
    if (!chart) return
    indSeries.current.forEach(x => { try { chart.removeSeries(x) } catch { /* already gone */ } })
    indSeries.current = []
    volRef.current = null
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
      volRef.current = v
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
    // (style: a swapped price series is added last; re-adding keeps the indicator lines above it)
  }, [barsKey, scale, ind, res, style])

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
      {RESOLUTIONS.filter(r => (hasTicks || !onChainOnly(r.value)) && (r.value !== '5s' || engineMode)).map(r => (
        <button key={r.value} onClick={() => setRes(r.value)} style={pill(res === r.value)}>{r.label}</button>
      ))}
      {live && <span title={T("Every swap appears the moment its block lands")} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6, fontSize: '0.68rem', fontWeight: 800, color: 'var(--green)', letterSpacing: '0.05em' }}><span className="pulse-dot" />{T("LIVE")}</span>}
      <span style={{ flex: 1 }} />
      <span title={T("Chart style")} style={{ display: 'inline-flex', border: '1px solid var(--adx-card-border)', borderRadius: 6, overflow: 'hidden' }}>
        {(['line', 'candles'] as const).map(s => <button key={s} onClick={() => saveChartStyle(s)} style={{ ...pill(style === s), border: 'none', borderRadius: 0 }}>{s === 'line' ? T("Line") : T("Candles")}</button>)}
      </span>
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
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16,
          background: 'rgba(11,22,40,0.7)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{loading ? T("Loading chart…") : onChainOnly(res) ? T("No trades in the last few hours — try a longer timeframe.") : T("No chart data yet.")}</div>
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
