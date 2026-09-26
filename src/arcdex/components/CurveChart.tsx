import { useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi } from 'lightweight-charts'
import type { Address } from 'viem'
import { getCurveOhlcv, type CurveCandle } from '../api/launchpad'
import { addMainSeries, lineColors, loadChartStyle, onChartStyle, saveChartStyle, toPoint, type ChartStyle, type MainSeries } from '../lib/chartStyle'
import { t as T } from '../lib/i18n'

type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
const RESOLUTIONS: { label: string; value: Resolution }[] = [
  { label: '1m', value: '1m' }, { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }, { label: '1H', value: '1h' },
  { label: '4H', value: '4h' }, { label: '1D', value: '1d' },
]

interface Props { token: Address }

const pill = (active: boolean): React.CSSProperties => ({
  padding: '3px 10px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, border: '1px solid', cursor: 'pointer',
  borderColor: active ? 'var(--adx-accent)' : 'var(--adx-card-border)',
  background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
  color: active ? 'var(--adx-accent)' : 'var(--text-muted)',
})

export default function CurveChart({ token }: Props) {
  const [res, setRes] = useState<Resolution>('15m')
  const [candles, setCandles] = useState<CurveCandle[]>([])
  const [style, setStyle] = useState<ChartStyle>(loadChartStyle)
  useEffect(() => onChartStyle(setStyle), [])
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef  = useRef<IChartApi | null>(null)
  const seriesRef = useRef<MainSeries | null>(null)

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
    chartRef.current = chart
    const ro = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  // The price series — a line or candlesticks; swapped when the style changes.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = addMainSeries(chart, style)
    seriesRef.current = s
    return () => {
      try { chart.removeSeries(s) } catch { /* the chart itself is gone */ }
      if (seriesRef.current === s) seriesRef.current = null
    }
  }, [style])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || !candles.length) return
    series.setData(candles.map(c => toPoint(c, style)))
    if (style === 'line') series.applyOptions(lineColors(candles[candles.length - 1].close >= candles[0].close))
    chartRef.current?.timeScale().fitContent()
  }, [candles, style])

  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {RESOLUTIONS.map(r => (
          <button key={r.value} onClick={() => setRes(r.value)} style={pill(res === r.value)}>{r.label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <span title={T("Chart style")} style={{ display: 'inline-flex', border: '1px solid var(--adx-card-border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['line', 'candles'] as const).map(s => <button key={s} onClick={() => saveChartStyle(s)} style={{ ...pill(style === s), border: 'none', borderRadius: 0 }}>{s === 'line' ? T("Line") : T("Candles")}</button>)}
        </span>
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
