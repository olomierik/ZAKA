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
/** A young coin (every trade read falls inside the window) needs fewer: OPEN_MIN_YOUNG trades, and one every three
 * bars since its first. Before (2026-10-17), a coin a few minutes old with 20 trades opened on 4H: one or two huge
 * candles. */
export const OPEN_MIN_YOUNG = 5

/** The finest of `choices` (finest first) that the coin's trades (times in ms) fill, else the last
 * choice; null with no trades read yet. `launchedAt` (ms), when known: the finest timeframe whose window holds the
 * coin's whole life will do too, so a coin minutes old with a trade or two opens on 15s, not 4H. */
export function pickOpenRes(tradeTimes: number[], now: number, choices: FrameRes[] = OPEN_CHOICES, launchedAt?: number): FrameRes | null {
  if (!choices.length) return null
  if (!tradeTimes.length) return null
  const first = Math.min(...tradeTimes)
  const born = launchedAt && launchedAt > 0 && launchedAt <= now ? launchedAt : 0
  for (const r of choices) {
    const ms = FRAME_SECONDS[r] * 1000
    const since = now - ms * OPEN_WINDOW_BARS
    let n = 0
    for (const t of tradeTimes) if (t >= since) n++
    if (n >= OPEN_MIN_TRADES) return r
    if (first >= since && n >= OPEN_MIN_YOUNG && n * 3 >= Math.ceil((now - first) / ms)) return r
    if (born && born >= since) return r
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

/** A bar no one traded in, drawn flat at the last price (a line runs through it; candles leave it empty). */
const flat = (time: number, price: number): Candle => ({ time, open: price, high: price, low: price, close: price, volume: 0, fill: true })

/** A close this many times off both bars beside it, while they agree with each other, is a bad print (one swap at
 * a silly price, a pool's first tick at its opening price): it's drawn at the bar before it. */
export const SPIKE_X = 5
/** Leading bars this many times off the series' median are a pool's opening tick, not trading: they're dropped. */
export const LEAD_X = 100
/** A wick reaching past this many times the bar's body is cut there. */
export const WICK_X = 3

const near = (a: number, b: number, x: number) => a > 0 && b > 0 && a <= b * x && b <= a * x

/** Candles (sorted) with bad prints taken out, so one silly swap can't squash a low-cap coin's chart into a flat
 * line (owner, 2026-10-17: "on coins that have low market cap the chart, either line or candles, is messy"). A real
 * move stays: a pump or a dump moves the bars after it too, and the last bar is never touched. */
export function cleanCandles(input: Candle[]): Candle[] {
  let cs = input.filter(c => c.close > 0 && Number.isFinite(c.close))
  if (cs.length >= 10) {
    const sorted = cs.map(c => c.close).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    let drop = 0
    while (drop < 3 && drop < cs.length - 1 && !near(cs[drop].close, median, LEAD_X)) drop++
    if (drop) cs = cs.slice(drop)
  }
  const out = cs.map(c => ({ ...c }))
  for (let i = 0; i < out.length - 1; i++) {
    const c = out[i], next = out[i + 1]
    const prev = i > 0 ? out[i - 1] : null
    const after = i + 2 < out.length ? out[i + 2] : null
    const bad = prev
      ? near(prev.close, next.close, 2) && !near(c.close, prev.close, SPIKE_X) && !near(c.close, next.close, SPIKE_X)
      : !!after && near(next.close, after.close, 2) && !near(c.close, next.close, SPIKE_X)
    if (bad) {
      const p = prev ? prev.close : next.open > 0 && near(next.open, next.close, SPIKE_X) ? next.open : next.close
      Object.assign(c, { open: p, high: p, low: p, close: p })
      if (!near(next.open, c.close, SPIKE_X)) { next.open = c.close; next.high = Math.max(next.open, next.close); next.low = Math.min(next.open, next.close) }
    }
  }
  for (const c of out) {
    const top = Math.max(c.open, c.close), bottom = Math.min(c.open, c.close)
    if (c.high > top * WICK_X) c.high = top * WICK_X
    if (c.low < bottom / WICK_X) c.low = bottom / WICK_X
    if (c.high < top) c.high = top
    if (c.low > bottom) c.low = bottom
  }
  return out
}
