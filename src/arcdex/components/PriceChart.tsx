import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type SeriesType, type CandlestickData, type MouseEventParams, LineSeries, HistogramSeries, PriceScaleMode } from 'lightweight-charts'
import { addMainSeries, lineColors, loadChartStyle, onChartStyle, saveChartStyle, type ChartStyle, type MainSeries } from '../lib/chartStyle'
import { useIsMobile } from '../lib/useMobile'
import { getPoolOhlcv } from '../api/gecko'
import { candlesFromTicks, mergeCandles, type Candle, type Tick } from '../lib/candles'
import { engineEnabled, getEngineCandles, marketStream, useEngineStatus } from '../api/marketStream'
import type { WireCandle } from '../../../api/_marketProtocol'
import { INDICATORS, bollinger, ema, rsi, sma, vwap, type IndicatorId } from '../lib/indicators'
import { t as T } from '../lib/i18n'
import { flightOf } from '../lib/chartMotion'

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
const fromWireCandle = (c: WireCandle): Candle => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] })
/** History with live candles laid over it, by bucket. */
function overlay(history: Candle[], live: Candle[]): Candle[] {
  if (!live.length) return history
  const byT = new Map(history.map(c => [c.time, c]))
  for (const c of live) byT.set(c.time, c)
  return [...byT.values()].sort((a, b) => a.time - b.time)
}
const MIN_SIZES = [0, 10, 100, 1000] as const

/** A trade (or thesis) marked on the chart: "+$500" in green for a buy,
 * "-$250" in red for a sell, 💬 for a thesis. */
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
  /** Arrived live, after the page loaded — only these pop up (history never does). */
  live?: boolean
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

/** fx/fy: where a pop flies to (px from where it starts) as it fades. */
interface TradeLabel { t: ChartTrade; x: number; y: number; text: string; w: number; above: boolean; fx: number; fy: number }

/** $1,234 → "1.2K" — short enough to sit on a chart. */
const compactUsd = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : v >= 100 ? v.toFixed(0) : v >= 1 ? String(Number(v.toFixed(1))) : v.toFixed(2)
const labelText = (t: ChartTrade) => t.kind === 'thesis' ? '💬' : `${t.kind === 'buy' ? '+' : '-'}$${compactUsd(t.usd)}`
/** A swap pops up on the chart the moment it lands ("+$500" / "-$250"),
 * flies off upward as it fades, and is gone 2 seconds later: between
 * trades the chart stays clean. (arcdex.css .chart-trade.pop runs as long.) */
const POP_MS = 2_000
/** A live swap that reaches us later than this after it happened (a slow indexer) doesn't pop. */
const LIVE_WINDOW_MS = 60_000
/** The same swap from two sources (GeckoTerminal, the chain) pops once: by transaction and side. */
const popKey = (t: ChartTrade) => (/^0x[0-9a-fA-F]{64}/.test(t.id) ? `${t.id.slice(0, 66).toLowerCase()}:${t.kind}` : t.id)
/** Label height, and how far above (buys) or below (sells) the line it sits. */
const LABEL_H = 16
const LABEL_GAP = 11
/** Market caps on the legend: $563.2K, $1.25M. */
const compactValue = (x: number) => x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x.toFixed(x >= 1 ? 0 : 2)
const MODE_KEY = 'arcdex:chart-mode'
const SCALE_MODES = { normal: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, pct: PriceScaleMode.Percentage } as const

// Price axis: 2 decimals for $1+ coins, 4 significant digits for micro-caps.
const fmtPrice = (v: number) => v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v === 0 ? '0' : v.toPrecision(4)

export default function PriceChart({ poolAddress, ticks, live, engineToken, trades, thesisMarks, friends, supply, symbol, onTraderClick }: Props) {
  const mobile = useIsMobile()
  const engineStatus = useEngineStatus()
  const engineMode = engineEnabled && !!engineToken && engineStatus === 'open'
  const hasTicks = ticks !== undefined || engineMode
  const [res, setResState] = useState<Resolution>(() => loadRes(hasTicks))
  const setRes = (r: Resolution) => { setResState(r); try { localStorage.setItem(RES_KEY, r) } catch { /* storage blocked */ } }
  const [history, setHistory] = useState<Candle[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [engineHistory, setEngineHistory] = useState(false)
  const [liveCandles, setLiveCandles] = useState<Candle[]>([])
  // Market cap by default, like fomo; the choice is remembered per browser.
  const [mode, setModeState] = useState<'price' | 'mcap'>(() => { try { return localStorage.getItem(MODE_KEY) === 'price' ? 'price' : 'mcap' } catch { return 'mcap' } })
  const setMode = (m: 'price' | 'mcap') => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* storage blocked */ } }
  const [style, setStyle] = useState<ChartStyle>(loadChartStyle)
  useEffect(() => onChartStyle(setStyle), [])
  const styleRef = useRef(style)
  styleRef.current = style
  const [showBubbles, setShowBubbles] = useState(true)
  const [showMine, setShowMine] = useState(true)
  // Theses stay on the chart when this is on; off by default, so the chart
  // shows nothing but the price (and each trade's pop) until asked.
  const [showThesis, setShowThesis] = useState(false)
  const [friendsOnly, setFriendsOnly] = useState(false)
  const [minSize, setMinSize] = useState<(typeof MIN_SIZES)[number]>(0)
  const [labels, setLabels] = useState<TradeLabel[]>([])
  // Which trades have been seen, and until when a new live one shows.
  const seenTrades = useRef(new Set<string>())
  const popUntil = useRef(new Map<string, number>())
  const popEnd = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (popEnd.current) clearTimeout(popEnd.current) }, [])
  const [scaleMode, setScaleMode] = useState<keyof typeof SCALE_MODES>('normal')
  const [autoScale, setAutoScale] = useState(true)
  const legendRef = useRef<HTMLSpanElement>(null)
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
  // Set when someone drags, pinches or wheel-zooms the chart: their view is
  // kept (no re-fitting) until the timeframe changes or they double-click.
  const userMoved = useRef(false)
  const scale = mode === 'mcap' && supply ? supply : 1

  // History from GeckoTerminal (through /api/gecko, on the paid CoinGecko
  // key). With on-chain swaps driving the recent candles it's refreshed every
  // 30s; without them (non-Argus pages) it's the whole chart, every 15s.
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
      return setInterval(() => { if (!document.hidden) void load() }, hasTicks ? 30_000 : 15_000)
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
  // A new coin, timeframe, Price/MCap view or chart style starts fitted:
  // every candle in the window and the price axis on auto. Changing the
  // timeframe is all anyone needs to do.
  useEffect(() => { needsFit.current = true; userMoved.current = false; setAutoScale(true) }, [poolAddress, res, mode, style])
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

  // Each new swap pops up at its candle and price the moment it lands —
  // buys just above the line, sells just below — then flies off upward as
  // it fades, gone 2 seconds later. Re-run whenever the chart pans, zooms
  // or resizes, the data changes, or a pop ends.
  const layout = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const chart = chartRef.current, series = seriesRef.current, el = containerRef.current
      const now = Date.now()
      // Every swap is marked seen as it arrives (Trades off too, so turning
      // them back on doesn't replay what came in meanwhile); only new live ones pop.
      for (const t of trades ?? []) {
        const k = popKey(t)
        if (seenTrades.current.has(k)) continue
        seenTrades.current.add(k)
        if (showBubbles && t.live && now - t.time < LIVE_WINDOW_MS) popUntil.current.set(k, now + POP_MS)
      }
      for (const [k, until] of popUntil.current) if (until <= now) popUntil.current.delete(k)
      // One label per swap, even while the chain's copy replaces GeckoTerminal's.
      const popping: ChartTrade[] = []
      if (showBubbles && popUntil.current.size) {
        const shown = new Set<string>()
        for (const t of trades ?? []) {
          const k = popKey(t)
          if (popUntil.current.has(k) && !shown.has(k)) { shown.add(k); popping.push(t) }
        }
      }
      // Clear each pop the moment its second is up.
      if (popEnd.current) { clearTimeout(popEnd.current); popEnd.current = null }
      if (popping.length) {
        const end = Math.min(...popping.map(t => popUntil.current.get(popKey(t))!))
        popEnd.current = setTimeout(() => layoutRef.current(), Math.max(0, end - now) + 30)
      }
      const all = [...popping, ...(showThesis ? thesisMarks ?? [] : [])]
      if (!chart || !series || !el || !all.length || !candles.length) { setLabels([]); return }
      const step = RES_SECONDS[res]
      const first = candles[0].time, last = candles[candles.length - 1].time
      const paneW = el.clientWidth - chart.priceScale('right').width()
      const paneH = chart.panes()[0]?.getHeight() ?? el.clientHeight - chart.timeScale().height()
      const cands: TradeLabel[] = []
      for (const t of all) {
        if (t.kind !== 'thesis' && t.usd < minSize) continue
        if (friendsOnly && t.kind !== 'thesis' && !(t.mine || (t.maker && friends?.has(t.maker.toLowerCase())))) continue
        if (!t.priceUsd) continue
        const bucket = Math.floor(t.time / 1000 / step) * step
        if (bucket < first || bucket > last) continue
        const x = chart.timeScale().timeToCoordinate(bucket as never)
        const y = series.priceToCoordinate(t.priceUsd * scale)
        if (x === null || y === null || x < 0 || x > paneW || y < 0 || y > paneH) continue
        const text = labelText(t)
        const w = t.kind === 'thesis' ? 18 : text.length * 6.6 + 8
        const above = t.kind !== 'sell'
        cands.push({
          t, text, w, above,
          x: Math.min(paneW - w / 2 - 1, Math.max(w / 2 + 1, x)),
          y: Math.min(paneH - LABEL_H / 2, Math.max(LABEL_H / 2, above ? y - LABEL_GAP : y + LABEL_GAP)),
          ...(t.kind === 'thesis' ? { fx: 0, fy: 0 } : flightOf(popKey(t), Math.min(1, paneH / 320))),
        })
      }
      const rank = (l: TradeLabel) => (l.t.mine ? 2e12 : 0) + (l.t.kind === 'thesis' ? 1e12 : 0) + l.t.usd
      cands.sort((a, b) => rank(b) - rank(a))
      const placed: TradeLabel[] = []
      const max = mobile ? 28 : 70
      // Every pop shows (they fly apart); a thesis mark that would overlap a
      // label already placed is skipped.
      for (const c of cands) {
        if (c.t.kind === 'thesis' && placed.some(p => Math.abs(p.x - c.x) * 2 < p.w + c.w + 2 && Math.abs(p.y - c.y) < LABEL_H + 1)) continue
        placed.push(c)
        if (placed.length >= max) break
      }
      setLabels(placed)
    })
  }, [trades, thesisMarks, showBubbles, showThesis, friendsOnly, friends, minSize, candles, res, scale, mobile])

  // fomo-style readout, top left: the value under the crosshair (or the
  // latest), and its change from the bar before. Written straight to the
  // DOM — crosshair moves come too fast to re-render the chart for each.
  const legendVal = useRef<HTMLSpanElement>(null)
  const legendChg = useRef<HTMLSpanElement>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const writeLegend = (time?: number) => {
    const v = legendVal.current, c = legendChg.current, data = applied.current.data
    if (!v || !c) return
    if (!data.length) { v.textContent = ''; c.textContent = ''; return }
    let i = data.length - 1
    if (time !== undefined) {
      let lo = 0, hi = data.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if ((data[mid].time as number) < time) lo = mid + 1; else hi = mid }
      if ((data[lo].time as number) === time) i = lo
    }
    const cur = data[i].close, prev = i > 0 ? data[i - 1].close : data[i].open
    const ch = cur - prev, pct = prev ? (ch / prev) * 100 : 0
    const fmt = (x: number) => scaleRef.current > 1 ? '$' + compactValue(x) : '$' + fmtPrice(x)
    v.textContent = fmt(cur)
    c.textContent = `${ch >= 0 ? '+' : '-'}${fmt(Math.abs(ch))} (${ch >= 0 ? '+' : ''}${pct.toFixed(2)}%)`
    c.style.color = ch >= 0 ? 'var(--green)' : 'var(--red)'
  }
  const writeLegendRef = useRef(writeLegend)
  writeLegendRef.current = writeLegend

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
      // Every candle fits the window (fitContent on each new candle, below):
      // no scrolling past the first or last one, and a resize keeps the fit.
      timeScale: { borderColor: '#1e3050', timeVisible: true, secondsVisible: true, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
      // The page has to scroll past the chart: a wheel or a vertical swipe
      // over it scrolls the page. Zoom with a pinch, a drag on the time
      // axis, or the wheel in fullscreen.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 340,
    })
    chartRef.current = chart
    // The legend follows the crosshair, and returns to the latest value when it leaves.
    chart.subscribeCrosshairMove((p: MouseEventParams) => writeLegendRef.current(p.time === undefined ? undefined : Number(p.time)))

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
      // A new candle: every candle stays in the window.
      if (data.length !== n && !userMoved.current) chartRef.current?.timeScale().fitContent()
    } else {
      // Market caps under $100K in full dollars ($7,001): a new coin's moves are
      // a few dollars wide, and "$7.0K" on every gridline says nothing.
      series.applyOptions({ priceFormat: scale > 1 ? { type: 'custom', formatter: (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e5 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v).toLocaleString('en-US')}`, minMove: 1 } : { type: 'custom', formatter: fmtPrice, minMove: 1e-12 } })
      series.setData(data.map(point))
      // Fit every candle in the window — on a new timeframe always, and on a
      // refresh unless someone zoomed or scrolled (their view is kept).
      if (data.length && (needsFit.current || !userMoved.current)) {
        chartRef.current?.timeScale().fitContent()
        needsFit.current = false
      }
    }
    applied.current = { key, data }
    writeLegendRef.current()
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

  // % / log / auto, like fomo's (and TradingView's) price-axis buttons.
  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: SCALE_MODES[scaleMode], autoScale })
  }, [scaleMode, autoScale])
  // Dragging the price axis turns auto-scaling off in the chart; the button follows.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const off = () => { if (chartRef.current?.priceScale('right').options().autoScale === false) setAutoScale(false) }
    el.addEventListener('pointerup', off)
    return () => el.removeEventListener('pointerup', off)
  }, [])
  // Someone zooming or scrolling the chart (a sideways drag, a pinch, the
  // wheel in fullscreen) keeps their view; a double-click fits it again.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let x0: number | null = null
    const down = (e: PointerEvent) => { x0 = e.clientX }
    const move = (e: PointerEvent) => { if (x0 !== null && e.buttons && Math.abs(e.clientX - x0) > 6) userMoved.current = true }
    const up = () => { x0 = null }
    const wheel = () => { if (document.fullscreenElement) userMoved.current = true }
    const pinch = (e: TouchEvent) => { if (e.touches.length > 1) userMoved.current = true }
    const refit = () => { userMoved.current = false; chartRef.current?.timeScale().fitContent(); setAutoScale(true) }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('touchmove', pinch, { passive: true })
    el.addEventListener('dblclick', refit)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('touchmove', pinch)
      el.removeEventListener('dblclick', refit)
    }
  }, [])
  // The UTC clock under the chart (fomo shows one too).
  const clockRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = () => { if (clockRef.current) clockRef.current.textContent = new Date().toISOString().slice(11, 19) + ' UTC' }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

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
    <div ref={wrapRef} className="price-chart" style={{ background: isFull ? '#0b1628' : undefined, display: 'flex', flexDirection: 'column', height: isFull ? '100%' : undefined, padding: isFull ? 16 : 0 }}>
    <div className="chart-controls" style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
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
      <div ref={containerRef} style={{ height: isFull ? 'calc(100vh - 150px)' : (mobile ? 300 : 340) + (withRsi ? RSI_PANE : 0) }} />
      {/* fomo-style legend: coin · timeframe, then the value under the crosshair and its change. */}
      <div className="chart-legend">
        {symbol && <b>{symbol}</b>}
        <span className="chart-legend-res">{RESOLUTIONS.find(r => r.value === res)?.label}</span>
        <span ref={legendVal} className="chart-legend-val" />
        <span ref={legendChg} />
      </div>
      {labels.length > 0 && (
        // zIndex: the chart library layers its canvases with z-index 1–2,
        // which would otherwise paint over these labels.
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
          {labels.map(({ t, x, y, text, fx, fy }) => (
            <span key={popKey(t)} title={t.label} onClick={() => t.maker && onTraderClick?.(t.maker)}
              className={`chart-trade ${t.kind}${t.mine && showMine ? ' mine' : ''}${t.kind !== 'thesis' ? ' pop' : ''}`}
              style={{ left: x, top: y, cursor: t.maker && onTraderClick ? 'pointer' : 'default', '--fly-x': `${fx}px`, '--fly-y': `${fy}px` } as React.CSSProperties}>{text}</span>
          ))}
        </div>
      )}
      {!candles.length && (
        <div style={{ position: 'absolute', inset: 0, height: 340,
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16,
          background: 'rgba(11,22,40,0.7)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{loading ? T("Loading chart…") : onChainOnly(res) ? T("No trades in the last few hours — try a longer timeframe.") : T("No chart data yet.")}</div>
      )}
    </div>
    <div className="chart-footer">
      <span ref={clockRef} className="chart-clock" />
      <span style={{ flex: 1 }} />
      <button className={scaleMode === 'pct' ? 'on' : ''} onClick={() => setScaleMode(m => (m === 'pct' ? 'normal' : 'pct'))} title={T("Percentage scale")}>%</button>
      <button className={scaleMode === 'log' ? 'on' : ''} onClick={() => setScaleMode(m => (m === 'log' ? 'normal' : 'log'))} title={T("Logarithmic scale")}>log</button>
      <button className={autoScale ? 'on' : ''} onClick={() => setAutoScale(a => !a)} title={T("Auto-fit the price scale")}>auto</button>
    </div>
    {(trades || thesisMarks) && (
      <div className="chart-overlays" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
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
