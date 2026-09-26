// Offline test of how the charts move on their own (lib/chartMotion.ts):
// where each trade's pop flies, and the GeckoTerminal embed's timeframe.
// Run: bun scripts/test-chart-motion.ts

const { flightOf, fitResolution } = await import('../src/arcdex/lib/chartMotion')
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

console.log('embed timeframe by the coin\'s age')
const now = Date.UTC(2026, 8, 26, 12)
const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
const cases: [number, string][] = [[0.5, '1m'], [1.9, '1m'], [3, '5m'], [9, '5m'], [20, '15m'], [48, '1h'], [4 * 24, '1h'], [10 * 24, '4h'], [40 * 24, '12h'], [200 * 24, '1d']]
for (const [h, r] of cases) ok(fitResolution(at(h), now) === r, `${h < 24 ? h + 'h' : h / 24 + 'd'} old → ${r}`)
ok(fitResolution(null, now) === '15m' && fitResolution('not a date', now) === '15m', 'age unknown → 15m')
console.log('ALL CHART MOTION CHECKS PASSED')
