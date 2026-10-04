// Offline test of how the charts move on their own (lib/chartMotion.ts):
// where each trade's pop flies, and the live end of the line.
// Run: bun scripts/test-chart-motion.ts

const { flightOf, followAfterRedraw, RIGHT_OFFSET_BARS } = await import('../src/arcdex/lib/chartMotion')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

console.log('pop flights')
const keys = Array.from({ length: 200 }, (_, i) => `0x${(i * 7919).toString(16).padStart(64, '0')}:${i % 2 ? 'buy' : 'sell'}`)
const flights = keys.map(k => flightOf(k))
ok(flights.every(f => f.fy < 0), 'every pop flies upward (buys and sells)')
ok(flights.every(f => Math.abs(Math.atan2(f.fx, -f.fy)) <= Math.PI / 4 + 0.01), 'within 45° either side of straight up')
ok(flights.every(f => { const d = Math.hypot(f.fx, f.fy); return d >= 79 && d <= 151 }), '80–150px away')
ok(flights.filter(f => f.fx < -20).length > 40 && flights.filter(f => f.fx > 20).length > 40, `scattered: ${flights.filter(f => f.fx < -20).length} fly left, ${flights.filter(f => f.fx > 20).length} right`)
ok(JSON.stringify(flightOf(keys[3])) === JSON.stringify(flightOf(keys[3])), 'the same trade always takes the same course (re-renders never change it)')
const small = flightOf(keys[3], 0.5), full = flightOf(keys[3])
ok(Math.abs(Math.hypot(small.fx, small.fy) - Math.hypot(full.fx, full.fy) / 2) <= 1.5, 'a smaller chart flies them half as far')
const pairs = keys.slice(0, 50).map((k, i) => [flightOf(k), flightOf(keys[i + 1])])
ok(pairs.filter(([a, b]) => Math.sign(a.fx) !== Math.sign(b.fx)).length >= 15, 'back-to-back trades often go different ways')

console.log('the live end of the line, as on fomo: 10 bars of room, the chart slides with each new bar')
ok(RIGHT_OFFSET_BARS === 10, 'the latest bar sits 10 bars short of the price axis (fomo’s TradingView rightOffset)')
ok(followAfterRedraw(300, 300) === 'follow' && followAfterRedraw(300, 301) === 'follow' && followAfterRedraw(300, 302) === 'follow', 'a history refresh (same bars, or a bar or two more) keeps following the latest bar at the same spacing')
ok(followAfterRedraw(12, 300) === 'fit', 'a backfill (the chain’s first bars, then the whole history) fits every bar again')
ok(followAfterRedraw(300, 120) === 'fit', 'far fewer bars (a reload) fits again')
ok(followAfterRedraw(0, 50) === 'fit' && followAfterRedraw(1, 2) === 'fit', 'nothing (or one bar) before: fit')
console.log('ALL CHART MOTION CHECKS PASSED')
