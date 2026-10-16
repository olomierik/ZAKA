// Offline test of how PriceChart frames a coin (lib/chartFrame.ts): the timeframe a coin opens on,
// and the flat bars between trades that keep time even on the axis.
// Run: bun scripts/test-chart-frame.ts

const { pickOpenRes, fillGaps, FILL_MAX_BARS, FILL_CHUNK, OPEN_MIN_TRADES } = await import('../src/arcdex/lib/chartFrame')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const now = Date.UTC(2026, 9, 16, 12, 0, 0)
const every = (n: number, gapMs: number) => Array.from({ length: n }, (_, i) => now - i * gapMs)

console.log('opening timeframe')
ok(pickOpenRes([], now) === null, 'no trades read yet: no pick')
ok(pickOpenRes(every(200, 5_000), now) === '15s', 'a trade every 5s opens on 15s')
ok(pickOpenRes(every(200, 60_000), now) === '1m', 'a trade a minute opens on 1m')
ok(pickOpenRes(every(60, 10 * 60_000), now) === '5m', 'a trade every 10 minutes opens on 5m (a trade every two bars)')
ok(pickOpenRes(every(60, 2 * 3_600_000), now) === '1h', 'a trade every 2 hours opens on 1h')
ok(pickOpenRes(every(5, 86_400_000), now) === '4h', 'a few trades over days opens on the coarsest choice')
ok(pickOpenRes(every(OPEN_MIN_TRADES - 1, 1_000), now) !== '15s', `under ${OPEN_MIN_TRADES} trades never opens on 15s`)
ok(pickOpenRes(every(200, 5_000), now, ['1m', '5m']) === '1m', 'only offered timeframes are picked')
ok(pickOpenRes([...every(50, 1_000), now - 30 * 86_400_000], now) === '15s', 'old trades don\'t hold a busy coin back')

console.log('flat bars between trades')
const c = (time: number, close: number) => ({ time, open: close, high: close, low: close, close, volume: 1 })
const filled = fillGaps([c(0, 1), c(60, 2), c(75, 3)], 15)
ok(filled.map(x => x.time).join() === '0,15,30,45,60,75', 'every 15s bucket between trades is drawn')
ok(filled[1].close === 1 && filled[3].close === 1 && filled[1].volume === 0, 'gaps are flat at the last close, with no volume')
ok(filled[4].close === 2 && filled[4].volume === 1, 'real bars are kept as they were')
const toNow = fillGaps([c(0, 1), c(15, 2)], 15, 61)
ok(toNow.map(x => x.time).join() === '0,15,30,45,60' && toNow[4].close === 2, 'bars continue to now at the last price')
ok(fillGaps([c(0, 1)], 15, 14).length === 1, 'nothing added before the next bucket starts')
const step = 15
const long = fillGaps([c(0, 1), c(step * 100_000, 2)], step)
ok(long.length <= FILL_MAX_BARS + FILL_CHUNK && long.length >= FILL_MAX_BARS, `a long silence keeps the latest ${FILL_MAX_BARS}–${FILL_MAX_BARS + FILL_CHUNK} bars (${long.length})`)
ok(long[0].close === 1 && long[long.length - 1].close === 2, 'the window starts at the price before it')
const a = fillGaps([c(0, 1), c(step * 100_000, 2)], step, step * 100_001)
const b = fillGaps([c(0, 1), c(step * 100_000, 2)], step, step * 100_002)
ok(a[0].time === b[0].time && b.length === a.length + 1, 'a new bar only adds one bar: the first bar moves in steps, not every bar')
ok(fillGaps([], 15, 100).length === 0, 'no candles: nothing to draw')
const sorted = fillGaps([c(0, 1), c(45, 2), c(300, 3)], 15, 400)
ok(sorted.every((x, i) => i === 0 || x.time - sorted[i - 1].time === 15), 'evenly spaced throughout')
console.log('\nall chart-frame checks passed')
