import { useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, CandlestickSeries } from 'lightweight-charts'
import { getPoolOhlcv, type OhlcvCandle } from '../api/gecko'

type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]

// `poolAddress` is the pair/pool contract, not the token — GeckoTerminal's
// OHLCV API is keyed by pool. Pass null while it's still resolving.
interface Props { poolAddress: string | null }

export default function PriceChart({ poolAddress }: Props) {
  const [res, setRes] = useState<Resolution>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
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
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    seriesRef.current.setData(data)
    // Fit once per pool/resolution, not on every live refresh — otherwise
    // the user's zoom/scroll would snap back every 20s.
    if (needsFit.current) { chartRef.current?.timeScale().fitContent(); needsFit.current = false }
  }, [candles])

  return (
    <>
    <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
      {RESOLUTIONS.map(r => (
        <button key={r.value} onClick={() => setRes(r.value)}
          style={{ padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600,
            border: '1px solid', cursor: 'pointer',
            borderColor: res === r.value ? 'var(--adx-accent)' : 'var(--adx-card-border)',
            background: res === r.value ? 'rgba(59,130,246,0.15)' : 'transparent',
            color: res === r.value ? 'var(--adx-accent)' : 'var(--text-muted)' }}>
          {r.label}
        </button>
      ))}
    </div>
    <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden' }}>
      <div ref={containerRef} />
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
