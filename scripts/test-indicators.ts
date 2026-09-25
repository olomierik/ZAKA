// Checks the chart indicator math against hand-computed values.
// Run: bun scripts/test-indicators.ts
import { bollinger, ema, rsi, sma, vwap } from '../src/arcdex/lib/indicators'

const near = (a: number | null, b: number, m: string, eps = 1e-6) => {
  if (a === null || Math.abs(a - b) > eps) throw new Error(`FAIL ${m}: got ${a} want ${b}`)
  console.log('  ✓', m)
}
const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

const s = sma(v, 3)
if (s[0] !== null || s[1] !== null) throw new Error('SMA warm-up should be null')
near(s[2], 2, 'SMA(3) first value'); near(s[9], 9, 'SMA(3) last value')

const e = ema(v, 3)
near(e[2], 2, 'EMA(3) seeded with SMA'); near(e[3], 4 * 0.5 + 2 * 0.5, 'EMA(3) next = 3'); near(e[9], 9, 'EMA(3) on a straight line tracks price - 1')

const bb = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2)
near(bb.mid[7], 5, 'Bollinger mid = mean'); near(bb.upper[7], 9, 'Bollinger upper = mean + 2σ (σ=2)'); near(bb.lower[7], 1, 'Bollinger lower')

const vw = vwap([{ time: 0, open: 1, high: 3, low: 1, close: 2, volume: 10 }, { time: 1, open: 2, high: 6, low: 3, close: 3, volume: 30 }])
near(vw[0], 2, 'VWAP first bar = typical price'); near(vw[1], (2 * 10 + 4 * 30) / 40, 'VWAP volume-weighted')

const up = rsi(Array.from({ length: 20 }, (_, i) => i), 14)
near(up[14], 100, 'RSI of a steady rise = 100')
const flat = rsi([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2], 14)
near(flat[14], 50, 'RSI of equal ups and downs = 50', 1e-9)
if (up[13] !== null) throw new Error('RSI warm-up should be null')
console.log('ALL INDICATOR CHECKS PASSED')
