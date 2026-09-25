// bun scripts/test-candles.ts
import { candlesFromTicks, mergeCandles, type Candle } from '../src/arcdex/lib/candles'

let fails = 0
const eq = (a: unknown, b: unknown, msg: string) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)
}

// 3 swaps in minute 0, none in minute 1, 1 in minute 2 (times in ms, out of order)
const ticks = [
  { time: 30_000, priceUsd: 1.2, usd: 5 },
  { time: 1_000, priceUsd: 1.0, usd: 10 },
  { time: 59_000, priceUsd: 1.1, usd: 1 },
  { time: 125_000, priceUsd: 0.9, usd: 2 },
]
const c = candlesFromTicks(ticks, 60)
eq(c.map(x => x.time), [0, 120], 'buckets only where swaps happened')
eq([c[0].open, c[0].high, c[0].low, c[0].close, c[0].volume], [1.0, 1.2, 1.0, 1.1, 16], 'first candle OHLCV')
eq([c[1].open, c[1].high, c[1].low, c[1].close], [1.1, 1.1, 0.9, 0.9], 'next candle opens at previous close')
eq(candlesFromTicks(ticks, 1).length, 4, '1s candles: one per swap second')
eq(candlesFromTicks([{ time: 0, priceUsd: 0, usd: 1 }, { time: 1, priceUsd: NaN, usd: 1 }], 60), [], 'zero/NaN prices ignored')

const hist: Candle[] = [
  { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { time: 60, open: 1, high: 2, low: 1, close: 2, volume: 1 },
  { time: 120, open: 2, high: 2, low: 2, close: 2, volume: 1 },
]
const recent: Candle[] = [
  { time: 120, open: 5, high: 5, low: 5, close: 5, volume: 9 },   // partial bucket: history wins
  { time: 180, open: 3, high: 3.5, low: 3, close: 3.2, volume: 4 },
]
const m = mergeCandles(hist, recent)
eq(m.map(x => x.time), [0, 60, 120, 180], 'merged times')
eq(m[2], hist[2], 'history keeps the overlapping (partial) bucket')
eq([m[3].open, m[3].high, m[3].low, m[3].close], [2, 3.5, 2, 3.2], 'first on-chain candle re-opened at previous close')
eq(mergeCandles([], recent), recent, 'no history → on-chain only')
eq(mergeCandles(hist, []), hist, 'no swaps → history only')
const later = mergeCandles(hist, [{ time: 600, open: 9, high: 9, low: 9, close: 9, volume: 1 }])
eq(later.map(x => [x.time, x.open]), [[0, 1], [60, 1], [120, 2], [600, 2]], 'gap after stale history still joins at last close')

if (fails) { console.log(`${fails} failed`); process.exit(1) }
console.log('all candle checks passed')
