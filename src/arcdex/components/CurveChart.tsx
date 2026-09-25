import { useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, CandlestickSeries } from 'lightweight-charts'
import type { Address } from 'viem'
import { getCurveOhlcv, type CurveCandle } from '../api/launchpad'
import { t as T } from '../lib/i18n'

type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]

interface Props { token: Address }

export default function CurveChart({ token }: Props) {
  const [res, setRes] = useState<Resolution>('15m')
  const [candles, setCandles] = useState<CurveCandle[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef  = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => getCurveOhlcv(token, res).then(c => { if (!cancelled) setCandles(c) }).catch(() => {})
    load()
    const iv = setInterval(load, 8000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [token, res])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0b1628' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#1e3050' }, horzLines: { color: '#1e3050' } },
      crosshair: { vertLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' }, horzLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' } },
      rightPriceScale: { borderColor: '#1e3050' },
      timeScale: { borderColor: '#1e3050', timeVisible: true },
      width: containerRef.current.clientWidth, height: 300,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    chartRef.current = chart; seriesRef.current = series
    const ro = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    const data: CandlestickData[] = candles.map(c => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close }))
    seriesRef.current.setData(data)
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {RESOLUTIONS.map(r => (
          <button key={r.value} onClick={() => setRes(r.value)} style={{
            padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, border: '1px solid', cursor: 'pointer',
            borderColor: res === r.value ? 'var(--adx-accent)' : 'var(--adx-card-border)',
            background: res === r.value ? 'rgba(59,130,246,0.15)' : 'transparent',
            color: res === r.value ? 'var(--adx-accent)' : 'var(--text-muted)',
          }}>{r.label}</button>
        ))}
      </div>
      <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden' }}>
        <div ref={containerRef} />
        {!candles.length && (
          <div style={{ position: 'absolute', inset: 0, height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(11,22,40,0.7)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{T("No trades yet on this resolution")}</div>
        )}
      </div>
    </>
  )
}
