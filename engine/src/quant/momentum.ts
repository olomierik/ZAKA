// The momentum engine: how the price has moved over each window (5s … 1h),
// its structure (higher highs and lows on 30-second bars, a range and a
// breakout from it), whether the move is speeding up or rolling over, and its
// volatility (short against long: expansion or collapse). A rising price
// alone is never a reason: the strategies read these with the flow, volume
// and exhaustion numbers.

import type { TokenTape } from './tape'
import { change, ratio, stdev } from './util'

export const WINDOWS = { s5: 5_000, s15: 15_000, s30: 30_000, m1: 60_000, m3: 180_000, m5: 300_000, m15: 900_000, h1: 3_600_000 } as const

export interface MomentumFeatures {
  price_change_5s: number | null
  price_change_15s: number | null
  price_change_30s: number | null
  price_change_1m: number | null
  price_change_3m: number | null
  price_change_5m: number | null
  price_change_15m: number | null
  price_change_1h: number | null
  /** Of the last 3 steps between 4 thirty-second bars, how many made a higher high / a higher low. */
  higher_highs: number
  higher_lows: number
  /** The range over 15 minutes before the last minute: its high, low and width (%). */
  range_high: number | null
  range_low: number | null
  range_15m_pct: number | null
  /** How far the price is over the range's high (%; negative: under it). */
  break_pct: number | null
  /** The last minute's move over the 5-minute average move a minute (> 1: speeding up). */
  acceleration: number | null
  /** Up on 1m, 5m and 15m with higher lows: the trend continues. */
  continuation: boolean
  /** Falling on 30s and 1m after rising over 5m: rolling over. */
  rolling_over: boolean
  /** Standard deviation of 15-second log returns over 15 minutes, per minute (%), and over the last 3 minutes. */
  volatility: number | null
  volatility_short: number | null
  volatility_ratio: number | null
  vol_expansion: boolean
  vol_collapse: boolean
  vwap_5m: number | null
  /** The price over the 5-minute VWAP (%). */
  dist_from_vwap_5m: number | null
  /** Buys in a row, each at a higher price, up to the latest trade. */
  consecutive_up: number
}

function returnsStdevPerMin(tape: TokenTape, now: number, minutes: number): number | null {
  const bars = tape.buckets(now, 15_000, minutes * 4)
  if (bars.length < 4) return null
  const r: number[] = []
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0 && bars[i].c > 0) r.push(Math.log(bars[i].c / bars[i - 1].c))
  if (r.length < 3) return null
  return stdev(r) * 2 * 100 // four 15-second steps a minute: × √4
}

export function momentumFeatures(tape: TokenTape, now: number, vwap5m: number | null): MomentumFeatures {
  const price = tape.priceAt(now)
  const pc = (ms: number) => {
    const then = tape.priceAt(now - ms)
    // A coin younger than the window: its move since its first price.
    return change(price, then ?? (now - tape.launchedAt <= ms ? tape.firstPrice : null))
  }
  const p = { s5: pc(WINDOWS.s5), s15: pc(WINDOWS.s15), s30: pc(WINDOWS.s30), m1: pc(WINDOWS.m1), m3: pc(WINDOWS.m3), m5: pc(WINDOWS.m5), m15: pc(WINDOWS.m15), h1: pc(WINDOWS.h1) }
  const bars = tape.buckets(now, 30_000, 4)
  let hh = 0, hl = 0
  for (let i = 1; i < bars.length; i++) { if (bars[i].h > bars[i - 1].h) hh++; if (bars[i].l > bars[i - 1].l) hl++ }
  const range = tape.buckets(now - 60_000, 60_000, 15)
  const rangeHigh = range.length >= 3 ? Math.max(...range.map(b => b.h)) : null
  const rangeLow = range.length >= 3 ? Math.min(...range.map(b => b.l)) : null
  const vol = returnsStdevPerMin(tape, now, 15)
  const volShort = returnsStdevPerMin(tape, now, 3)
  const volRatio = ratio(volShort, vol)
  // Buys in a row at rising prices, up to now.
  let run = 0, last: number | null = null
  for (let i = tape.trades.length - 1; i >= 0 && run < 200; i--) {
    const t = tape.trades[i]
    if (t.ts > now) continue
    if (t.side !== 'BUY') break
    if (t.price !== null) { if (last !== null && t.price > last) break; last = t.price }
    run++
  }
  const accel = p.m1 === null || p.m5 === null ? null : p.m5 > 0 ? p.m1 / Math.max(p.m5 / 5, 1e-4) : p.m1 > 0 ? 5 : 0
  return {
    price_change_5s: p.s5, price_change_15s: p.s15, price_change_30s: p.s30, price_change_1m: p.m1, price_change_3m: p.m3,
    price_change_5m: p.m5, price_change_15m: p.m15, price_change_1h: p.h1,
    higher_highs: hh, higher_lows: hl,
    range_high: rangeHigh, range_low: rangeLow,
    range_15m_pct: rangeHigh !== null && rangeLow ? (rangeHigh / rangeLow - 1) * 100 : null,
    break_pct: rangeHigh && price ? (price / rangeHigh - 1) * 100 : null,
    acceleration: accel === null ? null : Math.max(-5, Math.min(5, accel)),
    continuation: (p.m1 ?? 0) > 0 && (p.m5 ?? 0) > 0 && (p.m15 ?? 0) > 0 && hl >= 2,
    rolling_over: (p.s30 ?? 0) < 0 && (p.m1 ?? 0) <= 0 && (p.m5 ?? 0) > 0,
    volatility: vol, volatility_short: volShort, volatility_ratio: volRatio,
    vol_expansion: volRatio !== null && volRatio >= 1.8, vol_collapse: volRatio !== null && volRatio <= 0.5,
    vwap_5m: vwap5m, dist_from_vwap_5m: price && vwap5m ? (price / vwap5m - 1) * 100 : null,
    consecutive_up: run,
  }
}
