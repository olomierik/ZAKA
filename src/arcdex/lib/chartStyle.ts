// Line or candlesticks, for every price chart (PriceChart).
// DexScreener's chart (owner, 2026-10-17: "make the app chart like the ones on DexScreener"): TradingView's candles, in
// TradingView's own colours, with volume bars under them. Line is one click away: one price line with a soft fill, green
// while the chart's window is up and red while it's down, a pulsing dot on its last point and a dotted line from there
// to the price on the axis. A switch holds while the coin is open.
import { AreaSeries, CandlestickSeries, LastPriceAnimationMode, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { Candle } from './candles'

export type ChartStyle = 'line' | 'candles'
export type MainSeries = ISeriesApi<'Area' | 'Candlestick'>

export const DEFAULT_CHART_STYLE: ChartStyle = 'candles'
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

// TradingView's (and DexScreener's) candle colours.
const UP = '#26a69a', DOWN = '#ef5350'
/** Volume bars, as TradingView draws them under the candles. */
export const volumeColor = (up: boolean) => (up ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)')

/** The chart's own colours for the page's theme (lib/theme.ts): lightweight-charts draws on a canvas, so it can't
 * read the page's CSS variables. */
export function chartTheme(theme: 'light' | 'dark') {
  const t = theme === 'dark'
    // TradingView's dark and light palettes, which DexScreener's chart uses.
    ? { bg: '#131722', text: '#b2b5be', grid: 'rgba(42,46,57,0.6)', cross: '#9598a1', label: '#363a45', border: '#2a2e39' }
    : { bg: '#ffffff', text: '#131722', grid: 'rgba(42,46,57,0.06)', cross: '#9598a1', label: '#131722', border: '#e0e3eb' }
  return {
    layout: { background: { color: t.bg }, textColor: t.text },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    // A free crosshair with dashed lines, as on TradingView (lightweight-charts snaps to the close by default).
    crosshair: { mode: 0, vertLine: { color: t.cross, labelBackgroundColor: t.label, style: 2 }, horzLine: { color: t.cross, labelBackgroundColor: t.label, style: 2 } },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border },
  }
}

/** Line colours for a chart that is up (or down) over its window. */
export const lineColors = (up: boolean) => ({
  lineColor: up ? UP : DOWN,
  topColor: up ? 'rgba(38,166,154,0.24)' : 'rgba(239,83,80,0.24)',
  bottomColor: up ? 'rgba(38,166,154,0)' : 'rgba(239,83,80,0)',
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
