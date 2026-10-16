// How PriceChart frames a coin's history (owner, 2026-10-16: "the chart for my app is messy").
//
// Two things made it messy: every coin opened on 15s bars, even one that trades a few times a day,
// and the chart library squeezes out time that has no bar, so days of silence collapsed into a
// jagged line whose time labels jumped about (4:45, 18:52, 18:50, 5, 6, 10…). Now a coin opens on
// the finest timeframe its own trading fills (pickOpenRes), and the bars between trades are drawn
// flat at the last price, up to now (fillGaps), so time runs evenly and the line moves with the
// clock, as on fomo and GMGN.
import type { Candle } from './candles'

export type FrameRes = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const FRAME_SECONDS: Record<FrameRes, number> = { '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }

/** The timeframes a coin may open on, finest first. */
export const OPEN_CHOICES: FrameRes[] = ['15s', '1m', '5m', '15m', '1h', '4h']
/** A timeframe is fine enough when the last OPEN_WINDOW_BARS of its bars hold at least OPEN_MIN_TRADES
 * trades: about one trade every three bars, so the line bends rather than sits flat. */
export const OPEN_WINDOW_BARS = 120
export const OPEN_MIN_TRADES = 40

/** The finest of `choices` (finest first) that the coin's trades (times in ms) fill, else the last
 * choice; null with no trades read yet. */
export function pickOpenRes(tradeTimes: number[], now: number, choices: FrameRes[] = OPEN_CHOICES): FrameRes | null {
  if (!choices.length) return null
  if (!tradeTimes.length) return null
  for (const r of choices) {
    const since = now - FRAME_SECONDS[r] * OPEN_WINDOW_BARS * 1000
    let n = 0
    for (const t of tradeTimes) if (t >= since && ++n >= OPEN_MIN_TRADES) return r
  }
  return choices[choices.length - 1]
}

/** Most bars drawn at once; older history is dropped in FILL_CHUNK-bar steps, so the first bar
 * moves only now and then (a moving first bar would redraw the whole chart on every new bar). */
export const FILL_MAX_BARS = 3000
export const FILL_CHUNK = 500

/** Candles (sorted by time, seconds) with every missing `step` bucket filled by a flat candle at the
 * previous close (volume 0), through `nowSec`'s bucket when given. Keeps at most about
 * FILL_MAX_BARS + FILL_CHUNK bars, the latest ones. */
export function fillGaps(candles: Candle[], step: number, nowSec?: number): Candle[] {
  if (!candles.length || !(step > 0)) return candles
  const lastReal = candles[candles.length - 1].time
  const nowBucket = nowSec !== undefined ? Math.floor(nowSec / step) * step : lastReal
  const end = Math.max(lastReal, nowBucket)
  // Where the drawn window starts: aligned to FILL_CHUNK bars, so it moves in steps.
  const span = FILL_CHUNK * step
  const windowStart = Math.floor((end - (FILL_MAX_BARS - 1) * step) / span) * span
  const out: Candle[] = []
  let prev: Candle | null = null
  for (const c of candles) {
    if (c.time < windowStart) { prev = c; continue }
    if (prev) {
      const from = Math.max(prev.time + step, windowStart)
      for (let t = from; t < c.time; t += step) out.push(flat(t, prev.close))
    }
    out.push(c)
    prev = c
  }
  if (!out.length && prev) out.push(flat(windowStart, prev.close))
  const tail = out[out.length - 1]
  for (let t = tail.time + step; t <= end; t += step) out.push(flat(t, tail.close))
  return out
}

const flat = (time: number, price: number): Candle => ({ time, open: price, high: price, low: price, close: price, volume: 0 })
