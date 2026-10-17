// Line or candlesticks, for every price chart (PriceChart).
// Every coin opens on Line (owner's choice): one price line with a soft
// fill, green while the chart's window is up and red while it's down, the
// way fomo draws it — with a pulsing dot on its last point and a dotted line
// from there to the price on the axis. A switch to candles holds while the
// coin is open.
import { AreaSeries, CandlestickSeries, LastPriceAnimationMode, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { Candle } from './candles'

export type ChartStyle = 'line' | 'candles'
export type MainSeries = ISeriesApi<'Area' | 'Candlestick'>

export const DEFAULT_CHART_STYLE: ChartStyle = 'line'
const EVENT = 'arcdex:chart-style'

/** Switches every chart on the page. */
export function setChartStyle(s: ChartStyle) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: s }))
}

export function onChartStyle(cb: (s: ChartStyle) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<ChartStyle>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

const UP = '#0ecb81', DOWN = '#f6465d'

/** The chart's own colours for the page's theme (lib/theme.ts): lightweight-charts draws on a canvas, so it can't
 * read the page's CSS variables. */
export function chartTheme(theme: 'light' | 'dark') {
  const t = theme === 'dark'
    ? { bg: '#101713', text: '#8a968f', grid: '#172019', cross: '#56625b', label: '#2b3831', border: '#1f2a24' }
    : { bg: '#ffffff', text: '#67726b', grid: '#eff1eb', cross: '#a3aba4', label: '#39443e', border: '#dadfd5' }
  return {
    layout: { background: { color: t.bg }, textColor: t.text },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    crosshair: { vertLine: { color: t.cross, labelBackgroundColor: t.label }, horzLine: { color: t.cross, labelBackgroundColor: t.label } },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border },
  }
}

/** Line colours for a chart that is up (or down) over its window. */
export const lineColors = (up: boolean) => ({
  lineColor: up ? UP : DOWN,
  topColor: up ? 'rgba(14,203,129,0.24)' : 'rgba(246,70,93,0.24)',
  bottomColor: up ? 'rgba(14,203,129,0)' : 'rgba(246,70,93,0)',
})

export function addMainSeries(chart: IChartApi, style: ChartStyle): MainSeries {
  if (style === 'candles') {
    return chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    }) as MainSeries
  }
  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return chart.addSeries(AreaSeries, {
    ...lineColors(true), lineWidth: 2, crosshairMarkerRadius: 4,
    lastPriceAnimation: still ? LastPriceAnimationMode.Disabled : LastPriceAnimationMode.Continuous,
    priceLineStyle: LineStyle.Dotted,
  }) as MainSeries
}

/** One bar in the series' own format: OHLC for candles, the close for a line. */
export function toPoint(c: Pick<Candle, 'time' | 'open' | 'high' | 'low' | 'close'>, style: ChartStyle, scale = 1) {
  return style === 'candles'
    ? { time: c.time as never, open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale }
    : { time: c.time as never, value: c.close * scale }
}
