// Offline test of the launchpad's Argus-style pieces: each coin's 24h change
// and trend line (api/_launchpadCore.ts trendOf), the search (lib/coinSearch),
// the trend line's drawing (lib/spark) and the create form's live preview
// (lib/launchPreview, the contract's own launch and buy math).
// Run: bun scripts/test-launch-cards.ts

import { OPENING_PRICE, SPARK_POINTS, priceAfter, spotPrice, statsOf, trendOf, type TradeRow } from '../api/_launchpadCore'
import { matchScore, normQuery, searchCoins } from '../src/arcdex/lib/coinSearch'
import { pctText, sparkGeometry } from '../src/arcdex/lib/spark'
import { openingCurve, previewToken } from '../src/arcdex/lib/launchPreview'

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const E18 = 10n ** 18n
const near = (a: number, b: number, rel = 1e-4) => Math.abs(a - b) <= Math.abs(b) * rel

// A trade that leaves the curve at rUsdc (USDC) — rToken from the constant product.
const K = 8_000n * 1_150_000_000n
const row = (ts: number, rUsdc: number, isBuy: 0 | 1 = 1, trader = '0xaa'): TradeRow => {
  const r = BigInt(Math.round(rUsdc * 1e6))
  const vToken = (K * E18 * 1_000_000n) / (8_000_000_000n + r) // whole-token precision is plenty here
  return ['0xt', trader, isBuy, '1000000', '0', '0', String(r), String(vToken - 200_000_000n * E18), 1, ts, '0x' + ts.toString(16), 0]
}

console.log('24h change and trend (from the index\'s trades)')
const now = 1_790_000_000, H = 3_600
ok(near(OPENING_PRICE, 8_000 / 1_150_000_000), `opening price: $8,000 over 1.15B virtual tokens ($${OPENING_PRICE.toExponential(3)}, MC $${(OPENING_PRICE * 1e9).toFixed(0)})`)
const none = trendOf([], now, now - 5 * H)
ok(none.change24 === 0 && none.spark.length === SPARK_POINTS + 1 && none.spark.every(p => near(p, OPENING_PRICE)), 'no trades: flat at the opening price, 0%')
const old = [row(now - 30 * H, 1_000), row(now - 20 * H, 4_000), row(now - 2 * H, 2_000, 0)]
const t1 = trendOf(old, now, now - 40 * H)
ok(near(t1.spark[0], priceAfter(old[0])), 'an older coin\'s window opens at its price 24h ago (the trade before it)')
ok(near(t1.change24, (priceAfter(old[2]) / priceAfter(old[0]) - 1) * 100), `its change runs from then to now (${pctText(t1.change24)})`)
ok(near(t1.spark[SPARK_POINTS], priceAfter(old[2])), 'the last point is the latest price')
ok(t1.spark.length === SPARK_POINTS + 1, `${SPARK_POINTS + 1} points, oldest first`)
const idx20h = Math.ceil(((now - 20 * H) - (now - 24 * H)) / (24 * H / SPARK_POINTS))
ok(near(t1.spark[idx20h - 1], priceAfter(old[0])) && near(t1.spark[idx20h], priceAfter(old[1])), 'each trade lands in its own hour')
const launched = now - 3 * H
const young = [row(launched, 500), row(launched + H, 1_500)]
const t2 = trendOf(young, now, launched)
ok(near(t2.spark[0], OPENING_PRICE), 'a coin under a day old runs from its opening price (its dev buy shows as the first move)')
ok(near(t2.change24, (priceAfter(young[1]) / OPENING_PRICE - 1) * 100) && t2.change24 > 0, `its change is since launch (${pctText(t2.change24)})`)
const dump = trendOf([row(now - 30 * H, 5_000), row(now - H, 1_000, 0)], now, now - 40 * H)
ok(dump.change24 < 0 && sparkGeometry(dump.spark)?.dir === 'down', `a dump is negative and draws red (${pctText(dump.change24)})`)
const s = statsOf(old, now, now - 40 * H)
ok(s.change24 === t1.change24 && s.spark?.length === SPARK_POINTS + 1 && s.trades === 3, 'the index\'s stats carry both')
ok(JSON.stringify(s.spark).length < 400, `small on the wire (${JSON.stringify(s.spark).length} bytes per coin)`)

console.log('trend line drawing')
const up = sparkGeometry([1, 2, 1.5, 3])
ok(up?.dir === 'up' && up.lastY < 15 && up.line.startsWith('M0.00,') && up.line.includes('L100.00,'), 'rising: green, ends high, spans the width')
ok(sparkGeometry([2, 2, 2])?.dir === 'flat' && sparkGeometry([2, 2, 2])?.lastY === 15, 'flat: a level line through the middle')
ok(sparkGeometry([1]) === null && sparkGeometry(undefined) === null && sparkGeometry([0, Number.NaN]) === null, 'nothing to draw: no line')
ok(pctText(12.345) === '+12.3%' && pctText(-3.06) === '-3.1%' && pctText(1234.5) === '+1,235%' && pctText(-0.01) === '0.0%', 'change text: +12.3%, -3.1%, +1,235%, 0.0%')

console.log('search (Argus: name, ticker with or without $, or address)')
const coins = [
  { address: '0x1111aaaa00000000000000000000000000000001', name: 'Moon Dog', symbol: 'MOON', mc: 5 },
  { address: '0x2222bbbb00000000000000000000000000000002', name: 'Blue Moon', symbol: 'BMOON', mc: 50 },
  { address: '0x3333cccc00000000000000000000000000000003', name: 'Harvest', symbol: 'CORN', mc: 9 },
  { address: '0x4444dddd00000000000000000000000000000004', name: 'Moonshot', symbol: 'SHOT', mc: 99 },
]
const find = (q: string) => searchCoins(coins, q, c => c.mc).map(c => c.symbol)
ok(normQuery('  $Moon ') === 'moon', 'the $ and spaces are ignored')
ok(find('$moon')[0] === 'MOON' && find('moon')[0] === 'MOON', '"$moon" and "moon" both put $MOON first (exact ticker)')
ok(JSON.stringify(find('moon')) === JSON.stringify(['MOON', 'SHOT', 'BMOON']), `then name matches, the bigger coin first: ${find('moon').join(', ')}`)
ok(find('blue')[0] === 'BMOON' && find('dog')[0] === 'MOON', 'any word of the name')
ok(JSON.stringify(find(coins[2].address)) === '["CORN"]', 'the full contract address finds exactly that coin')
ok(JSON.stringify(find('0x3333')) === '["CORN"]' && JSON.stringify(find('cccc0000')) === '["CORN"]', 'part of the address: its start, or a pasted piece')
ok(find('0x').length === 0 && find('00').length === 0, 'a bare "0x" or a couple of digits matches nothing')
ok(find('zzz').length === 0 && find('   ').length === 0, 'no match, or an empty box: nothing')
ok(matchScore(coins[0], 'moon') > matchScore(coins[3], 'moon'), 'ticker beats name')

console.log('create form preview (the contract\'s math)')
const me = '0x9999999999999999999999999999999999999999' as const
const bare = openingCurve(me, 300, 1, 0n)
ok(near(spotPrice(bare.rUsdc, bare.rToken), OPENING_PRICE) && bare.rUsdc === 0n && !bare.graduated, 'no first buy: the opening curve')
const c100 = openingCurve(me, 300, 1, 100_000_000n) // $100 with a 3% tax: 1% + 3% in fees
ok(c100.rUsdc === 96_000_000n, 'a $100 first buy puts $96 in the curve (1% platform fee + 3% tax out)')
ok(near(Number(c100.vUsdc) / 1e6 / (Number(c100.vToken) / 1e18), spotPrice(c100.rUsdc, c100.rToken), 1e-9), 'its price matches what the index will compute from the Trade event')
const p = previewToken({ name: 'Moon Dog', symbol: 'MOON', meta: { image: 'blob:x' }, creator: me, taxBps: 300, buyUsdc: 100_000_000n, launchedAt: 1 })
ok(near(p.bondingProgress, (96 / 25_000) * 100) && p.metadata?.image === 'blob:x' && p.curve.creator === me, `the card shows ${p.bondingProgress.toFixed(2)}% progress and MC $${(p.priceUsd * 1e9).toFixed(0)}`)
ok(previewToken({ name: 'Moon Dog', symbol: 'MOON', meta: {}, creator: null, taxBps: 0, buyUsdc: 0n, launchedAt: 0 }).address === p.address, 'its colors hold still while other fields change')
ok(openingCurve(me, 0, 1, 30_000_000_000n).graduated, 'a first buy past $25K graduates it at once (as the contract does)')
console.log('ALL LAUNCH CARD CHECKS PASSED')
