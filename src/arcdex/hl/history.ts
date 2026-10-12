// What Hyperliquid's prices did while nobody was looking: candles and hourly funding rates over a gap, for the paper
// account's catch-up (hl/paper.ts) and price alerts (hl/alerts.ts).

import { hlInfo } from './client'

const HOUR = 3_600_000

/** One candle of one market. */
export interface Bar { coin: string; t: number; ms: number; o: number; h: number; l: number; c: number }
export interface FundingEntry { coin: string; time: number; rate: number }

const INTERVALS: [string, number][] = [['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', HOUR], ['4h', 4 * HOUR], ['1d', 24 * HOUR]]
/** The finest candles that cover a gap in one request (Hyperliquid answers up to 5,000). */
export const intervalFor = (gapMs: number) => INTERVALS.find(([, ms]) => gapMs / ms <= 4_800) ?? INTERVALS[INTERVALS.length - 1]

interface RawCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string }

/** A market's candles from `from` (the one it falls in included) to `to`. */
export async function barsFor(coin: string, from: number, to: number): Promise<Bar[]> {
  const [interval, ms] = intervalFor(to - from)
  const raw = await hlInfo<RawCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(from / ms) * ms, endTime: to } })
  return (Array.isArray(raw) ? raw : []).map(c => ({ coin, t: c.t, ms, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) }))
}

/** A market's hourly funding rates after `from`, up to `to`. */
export async function fundingFor(coin: string, from: number, to: number): Promise<FundingEntry[]> {
  const out: FundingEntry[] = []
  let start = from + 1
  // 500 an answer; ten pages is over 200 days.
  for (let page = 0; page < 10 && start <= to; page++) {
    const raw = await hlInfo<{ coin: string; fundingRate: string; time: number }[]>({ type: 'fundingHistory', coin, startTime: start, endTime: to })
    if (!Array.isArray(raw) || !raw.length) break
    for (const r of raw) out.push({ coin, time: r.time, rate: Number(r.fundingRate) })
    if (raw.length < 500) break
    start = raw[raw.length - 1].time + 1
  }
  return out
}
