// How the charts move on their own: where a trade's pop flies (PriceChart)
// and which timeframe fits a coin's whole life (the GeckoTerminal embed).

/** A pop's flight: upward, anywhere from 45° left to 45° right of straight
 * up, 80–150px (times `scale`) — fixed per trade (from its key), so pops
 * landing together scatter different ways and a re-render never changes
 * their course. */
export function flightOf(key: string, scale = 1): { fx: number; fy: number } {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  h >>>= 0
  const angle = ((h % 1000) / 999 - 0.5) * (Math.PI / 2)
  const dist = (80 + ((h >>> 10) % 71)) * scale
  return { fx: Math.round(Math.sin(angle) * dist), fy: -Math.round(Math.cos(angle) * dist) }
}

/** The timeframe that fits a coin's whole life in the chart window: about
 * 60–120 candles (a 1-hour-old coin on 15m candles was four fat bars; a
 * month-old one, a sliver of its history). */
export function fitResolution(createdAt: string | null | undefined, now = Date.now()): string {
  const born = createdAt ? Date.parse(createdAt) : NaN
  if (!Number.isFinite(born)) return '15m'
  const hours = Math.max(0, now - born) / 3_600_000
  return hours < 2 ? '1m' : hours < 10 ? '5m' : hours < 30 ? '15m' : hours < 5 * 24 ? '1h' : hours < 20 * 24 ? '4h' : hours < 60 * 24 ? '12h' : '1d'
}

// ── the live end of the line (PriceChart) ─────────────────────────────
// As on fomo, the line stops short of the price axis: its last point floats
// with room on its right to move up and down in, and new bars walk into that
// room. Once the last one gets within LIVE_GAP_MIN of the axis, the view
// glides back to a fit (every bar in the window, the whole gap free again),
// so the line never touches the axis.

/** px kept free right of the last point after a fit. */
export const LIVE_GAP = { desktop: 64, phone: 40 } as const
/** px it may shrink to as new bars walk in, before the view re-fits. */
export const LIVE_GAP_MIN = 14

/** The visible logical range a fit gives (lightweight-charts' fitContent
 * with rightOffsetPixels = `gap`): the first bar at the left edge, the last
 * `gap` px short of the right one. */
export function fitRange(bars: number, width: number, gap: number): { from: number; to: number } {
  const spacing = (width - gap) / Math.max(1, bars)
  return { from: 0, to: bars - 1 + gap / spacing }
}

/** Free px right of the last bar: `lastX` is its centre (null when it's off
 * screen), and the library draws bar i at width − (offset + ½)·spacing − 1. */
export function roomRight(range: { from: number; to: number }, width: number, lastX: number): number {
  const spacing = width / (range.to - range.from + 1)
  return width - lastX - spacing / 2 - 1
}

/** Whether the view has to re-fit: the last bar off screen or within
 * `minGap` of the axis, far more room than a fit leaves, or bars hidden off
 * the left (history grew). */
export function needsRefit(range: { from: number; to: number } | null, width: number, lastX: number | null, gap: number, minGap: number): boolean {
  if (!range || lastX === null || !(width > 0)) return true
  const spacing = width / (range.to - range.from + 1)
  const room = roomRight(range, width, lastX)
  return room < minGap || room > gap + spacing + 1 || range.from > 0.5 || range.from < -1.5
}

/** Ease-out (cubic): fast, then settling. */
export const easeOut = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3)
