// How the charts move on their own (PriceChart): where a trade's pop flies,
// and the live end of the line.

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

// ── the live end of the line (PriceChart) ─────────────────────────────
// As on fomo (its TradingView chart, read 2026-10-04: line chart, 15s bars,
// right offset 10 bars, the visible range moving 15s with every new bar):
// each trade moves the last point at once, so every buy and sell is a bend
// in the line; the latest bar sits RIGHT_OFFSET_BARS bars short of the price
// axis; and each new bar slides the whole chart one bar left while the price
// axis re-fits to what's on screen. (Until then the chart held still, new bars
// walked into a gap on the right, and prices glided: the owner wanted fomo's.)

/** Bars of room kept right of the latest one (fomo's TradingView: 10). */
export const RIGHT_OFFSET_BARS = 10

/** After a history refresh redrew the chart (not just its last bars): keep
 * following the latest bar at the same bar spacing ('follow'), or fit every
 * bar again ('fit') when the bar count jumped (a backfill or a reload: more
 * than 2 bars more or fewer), so a first sliver of bars doesn't leave the view
 * zoomed in on it. */
export function followAfterRedraw(prevBars: number, bars: number): 'fit' | 'follow' {
  return prevBars < 2 || Math.abs(bars - prevBars) > 2 ? 'fit' : 'follow'
}

/** The narrowest bars a fit draws, px: with more bars than fit at this
 * (hours of 15s bars), a fit shows the latest ones that do, so each bar's bend
 * and each step left still show (fomo's 15s chart drew them 4.7px wide). */
export const MIN_FIT_SPACING = 3

/** The visible logical range for a fit of `bars` bars in `width` px: null when
 * every bar fits at MIN_FIT_SPACING or wider (fitContent then), else the
 * latest bars that do, with RIGHT_OFFSET_BARS of room on the right. */
export function fitWindow(bars: number, width: number): { from: number; to: number } | null {
  if (!(width > 0) || bars < 2) return null
  const to = bars - 1 + RIGHT_OFFSET_BARS
  const from = to - width / MIN_FIT_SPACING
  return from > 0 ? { from, to } : null
}
