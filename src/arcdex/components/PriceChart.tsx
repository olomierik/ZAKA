import { useEffect, useRef } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, CandlestickSeries } from 'lightweight-charts'
import type { OhlcvCandle } from '../api/radardex'

interface Props {
  tokenAddress: string
  candles:      OhlcvCandle[]
}

export default function PriceChart({ candles }: Props) {
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
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  return (
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
  )
}
