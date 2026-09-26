// Line or candlesticks, for every price chart (PriceChart).
// Line is the default: one price line with a soft fill, green while the
// chart's window is up and red while it's down, the way fomo draws it.
// The choice is remembered per browser.
import { AreaSeries, CandlestickSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { Candle } from './candles'

export type ChartStyle = 'line' | 'candles'
export type MainSeries = ISeriesApi<'Area' | 'Candlestick'>

const KEY = 'arcdex:chart-style'
const EVENT = 'arcdex:chart-style'

export function loadChartStyle(): ChartStyle {
  try { return localStorage.getItem(KEY) === 'candles' ? 'candles' : 'line' } catch { return 'line' }
}

/** Saves the choice and tells every chart on the page. */
export function saveChartStyle(s: ChartStyle) {
  try { localStorage.setItem(KEY, s) } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: s }))
}

export function onChartStyle(cb: (s: ChartStyle) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<ChartStyle>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

const UP = '#22c55e', DOWN = '#ef4444'

/** Line colours for a chart that is up (or down) over its window. */
export const lineColors = (up: boolean) => ({
  lineColor: up ? UP : DOWN,
  topColor: up ? 'rgba(34,197,94,0.28)' : 'rgba(239,68,68,0.28)',
  bottomColor: up ? 'rgba(34,197,94,0)' : 'rgba(239,68,68,0)',
})

export function addMainSeries(chart: IChartApi, style: ChartStyle): MainSeries {
  if (style === 'candles') {
    return chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    }) as MainSeries
  }
  return chart.addSeries(AreaSeries, { ...lineColors(true), lineWidth: 2, crosshairMarkerRadius: 4 }) as MainSeries
}

/** One bar in the series' own format: OHLC for candles, the close for a line. */
export function toPoint(c: Pick<Candle, 'time' | 'open' | 'high' | 'low' | 'close'>, style: ChartStyle, scale = 1) {
  return style === 'candles'
    ? { time: c.time as never, open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale }
    : { time: c.time as never, value: c.close * scale }
}
