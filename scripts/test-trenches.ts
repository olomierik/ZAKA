// Offline test of the Trenches' rules (src/arcdex/lib/trenches.ts, 2026-10-12): which coins the listing rules let into
// the lanes, which lane each coin lands in and in what order, the lane filters, the settings kept in the browser, and
// the numbers as the rows show them. localStorage and window are stubbed.
// Run: bun scripts/test-trenches.ts

const store = new Map<string, string>()
// Settings saved by an older build: missing fields come from the defaults, and a chain's presets merge with them.
store.set('arcdex:trenches:v1', JSON.stringify({ slip: 5, presets: { sol: [0.1, 0.5, 2] } }))
const g = globalThis as unknown as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = new EventTarget()

const tr = await import('../src/arcdex/lib/trenches')
type Coin = import('../src/arcdex/lib/trenches').TrenchCoin
type Facts = import('../src/arcdex/lib/trenches').ListingFacts
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const MIN = 60_000
let n = 0
const coin = (o: Partial<Coin>): Coin => ({
  key: `arc:${++n}`, chain: 'arc', address: `0x${String(n).padStart(40, '0')}`, pool: null, symbol: `C${n}`, name: `Coin ${n}`, image: null,
  launchpad: 'Argus', quote: 'USDC', createdAt: NOW - 30 * MIN, marketCap: 20_000, liquidity: 5_000, volume24h: 1_000, change24h: 0,
  change1h: null, buys24h: 10, sells24h: 5, holders: 50, traders24h: null, progress: null, onCurve: false, stage: 'graduated',
  safety: { level: 'safe', reasons: [], source: 'market' } as never, fee: null, twitter: null, page: { name: 'terminal' }, ...o,
})

console.log('the listing rules')
const base: Facts = { official: false, stage: 'graduated', rugged: false, danger: false, listable: true, standard: true }
const on = { showAll: false, freshNew: true }, off = { showAll: false, freshNew: false }, all = { showAll: true, freshNew: false }
ok(tr.shownInLanes(base, on), 'a listable coin up to the standard shows')
ok(!tr.shownInLanes({ ...base, listable: false }, on), 'under $15K or rugged (not listable): hidden')
ok(!tr.shownInLanes({ ...base, standard: false }, on), 'rated Danger or too thin (under the standard): hidden')
ok(tr.shownInLanes({ ...base, stage: 'new', listable: false, standard: false }, on), 'a coin under an hour old shows in New below $15K and before it is deep (Fresh launches in New)')
ok(!tr.shownInLanes({ ...base, stage: 'new', listable: false, standard: false }, off), '… not with that switch off')
ok(!tr.shownInLanes({ ...base, stage: 'new', rugged: true }, on) && !tr.shownInLanes({ ...base, stage: 'new', danger: true }, on), '… and never when rugged or rated Danger')
ok(!tr.shownInLanes({ ...base, stage: 'bonding', listable: false }, on), 'an older coin on its curve still needs $15K')
ok(tr.shownInLanes({ ...base, official: true, listable: false, standard: false, danger: true }, on), '$ARCDEX always shows')
ok(!tr.shownInLanes({ ...base, wash: true }, on) && !tr.shownInLanes({ ...base, stage: 'new', wash: true }, on), 'a wash-traded pool is hidden, fresh or not')
ok([{ ...base, listable: false }, { ...base, danger: true, standard: false }, { ...base, wash: true }, { ...base, stage: 'new', rugged: true } as Facts].every(f => tr.shownInLanes(f, all)), 'Show everything shows them all')

console.log('the lanes')
const fresh1 = coin({ stage: 'new', createdAt: NOW - 2 * MIN })
const fresh2 = coin({ stage: 'new', createdAt: NOW - 40 * MIN })
const near80 = coin({ stage: 'near', onCurve: true, progress: 80 })
const near95 = coin({ stage: 'near', onCurve: true, progress: 95 })
const bond30 = coin({ stage: 'bonding', onCurve: true, progress: 30, volume24h: 10 })
const bondNull = coin({ stage: 'bonding', onCurve: true, progress: null, volume24h: 999 })
const bond30b = coin({ stage: 'bonding', onCurve: true, progress: 30, volume24h: 500 })
const gradOld = coin({ stage: 'graduated', createdAt: NOW - 3 * 86_400_000 })
const gradYoung = coin({ stage: 'graduated', createdAt: NOW - 2 * 3_600_000 })
const est = coin({ stage: 'established', createdAt: NOW - 30 * 86_400_000 })
const coins = [gradOld, fresh2, near80, bond30, est, fresh1, bondNull, near95, gradYoung, bond30b]
const keys = (cs: Coin[]) => cs.map(c => c.key).join()
ok(keys(tr.laneCoins(coins, 'new')) === keys([fresh1, fresh2]), 'New: launched in the last hour, newest first')
ok(keys(tr.laneCoins(coins, 'near')) === keys([near95, near80, bond30b, bond30, bondNull]), 'Almost bonded: near bond closest first, then the rest on their curve (ties by volume, unknown progress last)')
ok(keys(tr.laneCoins(coins, 'migrated')) === keys([gradYoung, gradOld, est]), 'Migrated: off the curve or established, youngest first')
ok(tr.LANES.flatMap(l => tr.laneCoins(coins, l)).length === coins.length, 'every coin lands in exactly one lane')

console.log('the lane filters')
const F = tr.EMPTY_FILTER
const pepe = coin({ symbol: 'PEPE', name: 'Pepe the Frog', marketCap: 50_000, liquidity: 8_000, buys24h: 30, sells24h: 20, createdAt: NOW - 90 * MIN, progress: 60, launchpad: 'Mercuri' })
ok(tr.passesFilter(pepe, F, NOW) && !tr.filterOn(F), 'no filter: every coin passes, and the filter reads as off')
ok(tr.passesFilter(pepe, { ...F, include: 'dog, frog' }, NOW) && !tr.passesFilter(pepe, { ...F, include: 'dog, cat' }, NOW), 'search keywords: any one of them, in the ticker or name, case-blind')
ok(!tr.passesFilter(pepe, { ...F, exclude: ' FROG ' }, NOW) && tr.passesFilter(pepe, { ...F, exclude: 'cat' }, NOW), 'exclude keywords')
ok(tr.passesFilter(pepe, { ...F, launchpads: ['Mercuri'] }, NOW) && !tr.passesFilter(pepe, { ...F, launchpads: ['Argus'] }, NOW), 'launchpads')
ok(tr.passesFilter(pepe, { ...F, minMc: 50_000, maxMc: 50_000 }, NOW) && !tr.passesFilter(pepe, { ...F, minMc: 50_001 }, NOW) && !tr.passesFilter(pepe, { ...F, maxMc: 49_999 }, NOW), 'market cap range (inclusive)')
ok(!tr.passesFilter(pepe, { ...F, minLiq: 8_001 }, NOW) && tr.passesFilter(pepe, { ...F, minTx: 50 }, NOW) && !tr.passesFilter(pepe, { ...F, minTx: 51 }, NOW), 'liquidity and 24h trades (buys and sells)')
ok(tr.passesFilter(pepe, { ...F, maxAgeMin: 90 }, NOW) && !tr.passesFilter(pepe, { ...F, maxAgeMin: 89 }, NOW) && tr.passesFilter(coin({ createdAt: 0 }), { ...F, maxAgeMin: 1 }, NOW), 'age (a coin of unknown age is not left out)')
ok(tr.passesFilter(pepe, { ...F, minProgress: 60 }, NOW) && !tr.passesFilter(coin({ progress: null }), { ...F, minProgress: 0 }, NOW), 'bonding progress (off the curve never passes a minimum)')
ok(tr.filterOn({ ...F, minLiq: 1 }), 'a filter with anything set reads as on')

console.log('the settings')
const s = tr.getTrench()
ok(s.slip === 5 && s.presets.sol.join() === '0.1,0.5,2' && s.presets.arc.join() === '5,25,100' && s.freshNew === true && s.showAll === false, 'saved settings load over the defaults; Fresh launches in New and the listing rules are on by default')
let heard = 0
const f = () => { heard++ }
;(g.window as EventTarget).addEventListener('arcdex:trenches', f)
tr.setTrench({ lanePreset: { 'arc:near': 2 } })
tr.setTrench(x => ({ filters: { ...x.filters, 'sol:new': { ...F, minMc: 1_000 } } }))
;(g.window as EventTarget).removeEventListener('arcdex:trenches', f)
const now = tr.getTrench()
ok(heard === 2 && tr.presetOf(now, 'arc', 'near') === 2 && tr.presetOf(now, 'arc', 'new') === 0, 'each lane keeps its own quick-buy preset (P1 by default)')
ok(tr.filterOf(now, 'sol', 'new').minMc === 1_000 && tr.filterOf(now, 'arc', 'new') === tr.EMPTY_FILTER, 'and its own filter, per chain')
ok(JSON.parse(store.get('arcdex:trenches:v1')!).lanePreset['arc:near'] === 2, 'kept in this browser')
tr.setTrench({ imageShape: 'circle', ring: false, pctMc: true, slip: 10 })
tr.resetTrenchDisplay()
ok(tr.getTrench().imageShape === 'square' && tr.getTrench().ring && !tr.getTrench().pctMc && tr.getTrench().slip === 10, 'Reset display resets the look, not the trading settings')

console.log('the numbers')
ok([tr.usd(0), tr.usd(-5), tr.usd(NaN), tr.usd(null), tr.usd(0.42), tr.usd(7.6), tr.usd(4_160), tr.usd(2_030_000), tr.usd(1.2e9)].join(' ') === '$0 $0 $0 $0 $0.42 $8 $4.2K $2.03M $1.20B', 'dollars')
ok([tr.count(7.4), tr.count(1_234), tr.count(2_500_000)].join(' ') === '7 1.2K 2.5M', 'counts')
ok([tr.ageOf(0, NOW), tr.ageOf(NOW + 5_000, NOW), tr.ageOf(NOW - 42_000, NOW), tr.ageOf(NOW - 9 * MIN, NOW), tr.ageOf(NOW - 5 * 3_600_000, NOW), tr.ageOf(NOW - 3 * 86_400_000, NOW)].join(' ') === '— 0s 42s 9m 5h 3d', 'ages (a clock ahead reads 0s)')
ok([tr.amountText(5, 'USDC'), tr.amountText(150, 'USDC'), tr.amountText(0.05, 'SOL'), tr.amountText(0.012345, 'BNB'), tr.amountText(2.5, 'SOL')].join(' ') === '$5 $150 0.05 0.0123 2.5', 'quick-buy amounts on the button')

console.log('the 1h window and the latest thesis')
ok(tr.getTrench().window === '24h', 'the window opens on 24h (saved settings from before it keep the default)')
const { latestByToken } = await import('../src/arcdex/lib/latestTheses')
const th = latestByToken([
  { token: '0xAA', body: 'older  call', author: '0xA1', created_at: '2026-10-16T10:00:00Z' },
  { token: '0xaa', body: ' newest\n call ', author: '0xB2', created_at: '2026-10-16T12:00:00Z' },
  { token: '0xbb', body: 'only one', author: '0xC3', created_at: '2026-10-16T11:00:00Z' },
  { token: '', body: 'no coin', author: '0xD4', created_at: '2026-10-16T13:00:00Z' },
])
ok(th.get('0xaa')?.body === 'newest call' && th.get('0xaa')?.author === '0xb2', 'each coin keeps its newest thesis, by address in any case, on one line')
ok(th.get('0xbb')?.body === 'only one' && th.size === 2, 'a thesis with no coin is left out')

console.log('\nall Trenches checks passed')
