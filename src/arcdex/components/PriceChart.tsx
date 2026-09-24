import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, CandlestickSeries } from 'lightweight-charts'
import { getPoolOhlcv, type OhlcvCandle } from '../api/gecko'
import { identiconUrl } from './Avatar'

type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]
const RES_SECONDS: Record<Resolution, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }
const MIN_SIZES = [0, 10, 100] as const

/** A trade drawn on the chart as its trader's avatar (fomo-style). */
export interface ChartTrade {
  id: string
  time: number // ms
  priceUsd: number
  usd: number
  kind: 'buy' | 'sell'
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
  onTraderClick?: (address: string) => void
}

interface Bubble { t: ChartTrade; x: number; y: number; size: number }

export default function PriceChart({ poolAddress, trades, onTraderClick }: Props) {
  const [res, setRes] = useState<Resolution>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [showBubbles, setShowBubbles] = useState(true)
  const [minSize, setMinSize] = useState<(typeof MIN_SIZES)[number]>(0)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const needsFit = useRef(true)

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
      if (!chart || !series || !el || !trades?.length || !showBubbles || !candles.length) { setBubbles([]); return }
      const step = RES_SECONDS[res]
      const first = candles[0].time, last = candles[candles.length - 1].time
      const paneW = el.clientWidth - chart.priceScale('right').width()
      const paneH = 340 - chart.timeScale().height()
      const out: Bubble[] = []
      for (const t of trades) {
        if (t.usd < minSize || !t.priceUsd) continue
        const bucket = Math.floor(t.time / 1000 / step) * step
        if (bucket < first || bucket > last) continue
        const x = chart.timeScale().timeToCoordinate(bucket as never)
        const y = series.priceToCoordinate(t.priceUsd)
        if (x === null || y === null || x < 0 || x > paneW || y < 0 || y > paneH) continue
        const size = Math.max(16, Math.min(34, 12 + Math.log10(Math.max(1, t.usd)) * 6))
        out.push({ t, x, y, size })
      }
      // Big trades on top; cap the count so a busy coin stays readable.
      setBubbles(out.sort((a, b) => a.t.usd - b.t.usd).slice(-160))
    })
  }, [trades, showBubbles, minSize, candles, res])

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
      height: 340,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    chartRef.current  = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

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
      time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    seriesRef.current.setData(data)
    // Fit once per pool/resolution, not on every live refresh — otherwise
    // the user's zoom/scroll would snap back every 20s.
    if (needsFit.current) { chartRef.current?.timeScale().fitContent(); needsFit.current = false }
    layout()
  }, [candles, layout])

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, border: '1px solid', cursor: 'pointer',
    borderColor: active ? 'var(--adx-accent)' : 'var(--adx-card-border)',
    background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
    color: active ? 'var(--adx-accent)' : 'var(--text-muted)',
  })

  return (
    <>
    <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {RESOLUTIONS.map(r => (
        <button key={r.value} onClick={() => setRes(r.value)} style={pill(res === r.value)}>{r.label}</button>
      ))}
      {trades && (
        <>
          <span style={{ flex: 1 }} />
          <button onClick={() => setShowBubbles(s => !s)} style={pill(showBubbles)} title="Show each trade as the trader's avatar">Traders</button>
          {showBubbles && MIN_SIZES.map(m => (
            <button key={m} onClick={() => setMinSize(m)} style={pill(minSize === m)}>{m === 0 ? 'All' : `>$${m}`}</button>
          ))}
        </>
      )}
    </div>
    <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden' }}>
      <div ref={containerRef} />
      {bubbles.length > 0 && (
        // zIndex: the chart library layers its canvases with z-index 1–2,
        // which would otherwise paint over these avatars.
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
          {bubbles.map(({ t, x, y, size }) => (
            <img
              key={t.id}
              src={t.avatarUrl || (t.maker ? identiconUrl(t.maker) : identiconUrl(t.id))}
              alt=""
              title={t.label}
              onClick={() => t.maker && onTraderClick?.(t.maker)}
              style={{
                position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size,
                borderRadius: '50%', objectFit: 'cover', pointerEvents: 'auto', cursor: t.maker && onTraderClick ? 'pointer' : 'default',
                border: `2px solid ${t.mine ? '#facc15' : t.kind === 'buy' ? '#22c55e' : '#ef4444'}`,
                boxShadow: t.mine ? '0 0 0 3px rgba(250,204,21,0.35)' : '0 1px 4px rgba(0,0,0,0.5)',
                background: '#0b1628',
              }}
            />
          ))}
        </div>
      )}
      {!candles.length && (
        <div style={{ position: 'absolute', inset: 0, height: 340,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(11,22,40,0.7)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Loading chart…
        </div>
      )}
    </div>
    </>
  )
}
