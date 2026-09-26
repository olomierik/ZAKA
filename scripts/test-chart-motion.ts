// Offline test of how the charts move on their own (lib/chartMotion.ts):
// where each trade's pop flies, and the GeckoTerminal embed's timeframe.
// Run: bun scripts/test-chart-motion.ts

const { flightOf, fitResolution, fitRange, roomRight, needsRefit, easeOut, LIVE_GAP, LIVE_GAP_MIN } = await import('../src/arcdex/lib/chartMotion')
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
console.log('the live end of the line: room on the right, walking in, re-fit')
// lightweight-charts draws bar i at x = width − (offset + ½)·spacing − 1, where
// offset = range.to − i and spacing = width ÷ (range.to − range.from + 1).
const W = 800, G = LIVE_GAP.desktop
const xOf = (r: { from: number; to: number }, i: number) => { const b = W / (r.to - r.from + 1); return W - (r.to - i + 0.5) * b - 1 }
for (const bars of [3, 40, 300]) {
  const r = fitRange(bars, W, G)
  const b = W / (r.to - r.from + 1)
  ok(r.from === 0 && Math.abs(b - (W - G) / bars) < 1e-9, `${bars} bars: every bar in the window, the first at the left edge`)
  ok(Math.abs(roomRight(r, W, xOf(r, bars - 1)) - G) < 1e-9, `${bars} bars: the last point sits ${G}px short of the price axis`)
  ok(!needsRefit(r, W, xOf(r, bars - 1), G, LIVE_GAP_MIN), `${bars} bars: a fresh fit needs no re-fit`)
}
// New bars walk into the room (the view holds still) until the last is within LIVE_GAP_MIN.
const r300 = fitRange(300, W, G), b300 = W / (r300.to - r300.from + 1)
let walked = 0
while (!needsRefit(r300, W, xOf(r300, 300 + walked), G, LIVE_GAP_MIN)) walked++
ok(walked === Math.floor((G - LIVE_GAP_MIN) / b300) && walked > 10, `300 bars: the next ${walked} bars walk right into the room (${b300.toFixed(2)}px each) before the view re-fits`)
ok(roomRight(r300, W, xOf(r300, 300 + walked)) < LIVE_GAP_MIN && roomRight(r300, W, xOf(r300, 300 + walked - 1)) >= LIVE_GAP_MIN, 're-fits the moment one would come within 14px — the line never touches the axis')
const r3 = fitRange(3, W, G)
ok(needsRefit(r3, W, xOf(r3, 3), G, LIVE_GAP_MIN), '3 fat bars: a 4th would land past the axis, so the view re-fits at once')
ok(needsRefit({ from: 5, to: r300.to + 5 }, W, xOf(r300, 299), G, LIVE_GAP_MIN), 'history grew at the left (bars hidden off the edge): re-fit')
ok(needsRefit(r300, W, null, G, LIVE_GAP_MIN) && needsRefit(null, W, 10, G, LIVE_GAP_MIN), 'nothing known about the view: re-fit')
const wide = { from: 0, to: 299 + 3 * G / b300 }
ok(needsRefit(wide, W, xOf(wide, 299), G, LIVE_GAP_MIN), 'far more room than a fit leaves (bars removed): re-fit')
ok(easeOut(0) === 0 && easeOut(1) === 1 && easeOut(0.5) > 0.8 && easeOut(2) === 1, 'glides ease out: most of the move early, settling at the end')
console.log('ALL CHART MOTION CHECKS PASSED')
