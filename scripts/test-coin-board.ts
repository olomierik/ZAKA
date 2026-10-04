// The coin board's rules, offline: each coin's stage (lib/coinStage.ts), its safety rating from the engine's scan and its
// market data (lib/safety.ts), and the listing standard the default lists follow.
// Run: bun scripts/test-coin-board.ts

const { stageOf, rhStage, arcStage, STAGE } = await import('../src/arcdex/lib/coinStage')
const { arcSafety, rhSafety, meetsStandard, launcherRate, LISTING, isListable, isRugged } = await import('../src/arcdex/lib/safety')
const { markDupes, tickerKey } = await import('../src/arcdex/lib/dupes')
const { ponsProgress, ponsTargets } = await import('../api/rhmarket')
const { riskOf } = await import('../src/arcdex/lib/risk')
import type { CoinSafety } from '../api/_marketProtocol'
import type { ArcToken } from '../src/arcdex/api/radardex'
import type { RhCoin } from '../src/arcdex/api/robinhoodMarket'

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const H = 3_600_000

console.log('stages')
const pool = { onCurve: false, progress: null, liquidityUsd: 20_000, holders: 150 }
ok(stageOf({ ...pool, ageMs: 10 * 60_000 }) === 'new', 'a pool coin 10 minutes old: New')
ok(stageOf({ ...pool, ageMs: 3 * H }) === 'graduated', 'three hours old: Graduated')
ok(stageOf({ ...pool, ageMs: 2 * 24 * H }) === 'established', 'two days, $20K, 150 holders: Established')
ok(stageOf({ ...pool, ageMs: 2 * 24 * H, holders: 40 }) === 'graduated', '…but 40 holders: not yet')
ok(stageOf({ ...pool, ageMs: 2 * 24 * H, holders: null, traders24h: 80 }) === 'established' && stageOf({ ...pool, ageMs: 2 * 24 * H, holders: null, traders24h: 10 }) === 'graduated', 'holders unknown: its traders stand in (80 yes, 10 no)')
const curve = { onCurve: true, liquidityUsd: 3_000, holders: null }
ok(stageOf({ ...curve, ageMs: 2 * H, progress: STAGE.nearPct + 5 }) === 'near', `on its curve, ${STAGE.nearPct + 5}%: Near bond`)
ok(stageOf({ ...curve, ageMs: 10 * 60_000, progress: 85 }) === 'near', 'Near bond wins over New: about to graduate is the news')
ok(stageOf({ ...curve, ageMs: 2 * H, progress: 40 }) === 'bonding' && stageOf({ ...curve, ageMs: 10 * 60_000, progress: 40 }) === 'new', '40%: Bonding, or New in its first hour')

const arc = (o: Partial<ArcToken>): ArcToken => ({
  address: '0x' + '11'.repeat(20), symbol: 'COIN', name: 'Coin', decimals: 18, logoUrl: '', price: 1, priceChange5m: 0, priceChange1h: 0, priceChange24h: 5,
  volume24h: 50_000, marketCap: 200_000, liquidity: 30_000, ageMs: 3 * 24 * H, launchpad: 'Argus', poolAddress: '0x' + '22'.repeat(32), txCount24h: 900,
  holderCount: 400, buys24h: 500, sells24h: 400, verified: true, graduated: true, bondingProgress: 100, spark: [], quoteSymbol: 'USDC', ...o,
})
ok(arcStage(arc({ graduated: false, bondingProgress: 72, ageMs: 2 * H })) === 'near' && arcStage(arc({})) === 'established', 'Arc rows: an Argus launch 72% along is Near bond; a graduated, busy one Established')
ok(arcStage(arc({ graduated: false, bondingProgress: null, ageMs: 2 * H, holderCount: 0 })) === 'graduated', 'no curve known (another launchpad’s pool coin): off the curve')

const rh = (o: Partial<RhCoin>): RhCoin => ({
  address: '0x' + '33'.repeat(20), symbol: 'RH', name: 'Rh', image: null, decimals: 18, stock: false, pool: '0x' + '44'.repeat(32), dex: 'bankr-robinhood',
  quote: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', quoteSymbol: 'WETH', priceUsd: 1, change5m: 0, change1h: 0, change24h: 3, volume24h: 40_000, liquidity: 25_000,
  marketCap: 300_000, buys24h: 300, sells24h: 250, traders24h: 120, createdAt: Date.now() - 3 * 24 * H, feePct: 1, launchpad: 'Bankr', ...o,
})
ok(rhStage(rh({ dex: 'pons-v2', createdAt: Date.now() - 3 * H })) === 'bonding', 'Robinhood: a coin on Pons’s curve is Bonding')
ok(rhStage(rh({ dex: 'pons-dot-family', createdAt: Date.now() - 3 * H, curveProgress: 77.8, graduated: false })) === 'near', 'Robinhood: Pons says 3.27 of 4.2 ETH raised (77.8%): Near bond')
ok(rhStage(rh({ dex: 'pons-dot-family', createdAt: Date.now() - 3 * 24 * H, curveProgress: 100, graduated: true })) === 'established', 'Robinhood: GeckoTerminal still lists it on Pons’s curve venue, Pons says graduated: off the curve')
ok(ponsProgress(3_268_400_000_000_000_000n, 4_200_000_000_000_000_000n) === 77.81 && ponsProgress(91n * 10n ** 18n, 42n * 10n ** 17n) === 100 && ponsProgress(1n, 0n) === 0, 'Pons progress: ETH raised over the threshold, capped at 100')
{
  const t = ponsTargets([rh({ address: '0xaa', dex: 'pons-dot-family' }), rh({ address: '0xbb', dex: 'pons-v2', pool: '0x' + '55'.repeat(20) }), rh({ address: '0xcc', dex: 'pons-v2-dex' }), rh({ address: '0xdd' })])
  ok(t.get('0xaa')?.via === 'factory' && t.get('0xbb')?.curve === '0x' + '55'.repeat(20) && !t.has('0xcc') && !t.has('0xdd'), 'Pons reads: its factory for pons-dot-family, the curve itself for pons-v2, none once graduated or elsewhere')
}
ok(rhStage(rh({})) === 'established' && rhStage(rh({ createdAt: Date.now() - 20 * 60_000 })) === 'new', 'a busy Bankr coin is Established; one 20 minutes old New')
ok(rhStage(rh({ stock: true, launchpad: null })) === 'established', 'a Robinhood stock token: Established')

console.log('safety: the engine’s scan with the market data')
const low = riskOf({ liquidityUsd: 50_000, marketCapUsd: 300_000, ageMs: 5 * 24 * H, holders: 900, txns24h: 900 })
const high = riskOf({ liquidityUsd: 400, marketCapUsd: 300_000, ageMs: 10 * 60_000, holders: 8, txns24h: 3, change24h: -85 })
ok(low.level === 'low' && high.level === 'high', 'the market scores used below: one low, one high')
const scan = (o: Partial<CoinSafety>): CoinSafety => ({ at: Date.now(), fails: [], risks: [], sellable: true, launcher: { coins: 0, dumps: 0 }, deep: true, ...o })
const t = arc({})
ok(arcSafety(t, low, undefined, false).level === 'checking', 'waiting for the engine’s first answer: Checking')
ok(arcSafety(t, low, scan({}), false).level === 'safe' && arcSafety(t, low, scan({}), false).source === 'chain', 'sold back fine, no failed check: Safe, from the chain')
ok(arcSafety(t, low, scan({ sellable: null }), false).level === 'checking', 'the sell test not run yet: Checking, never Safe')
ok(arcSafety(t, low, scan({ sellable: null }), true).level === 'safe', 'on its curve there’s no sell test to wait for')
ok(arcSafety(t, low, scan({ at: 0, sellable: null }), false).level === 'checking', 'not scanned yet: Checking')
const hp = arcSafety(t, low, scan({ fails: [{ id: 'honeypot', detail: '' }], sellable: false }), false)
ok(hp.level === 'danger' && /sold back/i.test(hp.reasons[0]), `can't sell: Danger ("${hp.reasons[0]}")`)
for (const id of ['hook', 'contract', 'proxy', 'creator', 'launchpad']) ok(arcSafety(t, low, scan({ fails: [{ id, detail: '' }] }), false).level === 'danger', `a failed ${id} check: Danger`)
for (const id of ['bundle', 'clusters', 'wash', 'liquidity']) ok(arcSafety(t, low, scan({ fails: [{ id, detail: '' }] }), false).level === 'risky', `a failed ${id} check: Risky`)
ok(arcSafety(t, low, scan({ risks: [{ id: 'holders', detail: '' }] }), false).level === 'risky', 'a few wallets holding most of it: Risky')
const dumper = arcSafety(t, low, scan({ launcher: { coins: 7, dumps: 5 } }), false)
ok(dumper.level === 'danger' && /5 of their last 7/.test(dumper.reasons[0]), `a launcher that dumped 5 of its last 7: Danger ("${dumper.reasons[0]}")`)
ok(arcSafety(t, low, scan({ launcher: { coins: 1, dumps: 1 } }), false).level === 'risky', 'one dump out of one coin: Risky (rate 40%, but a single dump)')
ok(arcSafety(t, low, scan({ launcher: { coins: 10, dumps: 1 } }), false).level === 'safe' && launcherRate(1, 10) < 0.25, 'one dump in its last 10: no flag')
ok(arcSafety(t, high, scan({}), false).level === 'risky', 'sold back fine, but a high market risk: Risky')
ok(arcSafety(t, low, null, false).level === 'safe' && arcSafety(t, low, null, false).source === 'market', 'a coin the engine doesn’t track: rated from its market data, and says so')
ok(arcSafety(arc({ symbol: 'EURC' }), low, null, false).level === 'danger', 'a fake EURC: Danger, scan or not')
ok(arcSafety(t, high, null, false).level === 'risky', 'untracked with a high market risk: Risky')
const medium = riskOf({ liquidityUsd: 4_000, marketCapUsd: 60_000, ageMs: 2 * H, holders: 60, txns24h: 40 })
ok(medium.level === 'medium' && arcSafety(t, medium, null, false).level === 'risky', 'untracked with a medium market risk: Risky (market data alone can’t vouch for it)')

console.log('safety on Robinhood Chain (market data)')
ok(rhSafety(rh({})).level === 'safe' && rhSafety(rh({})).source === 'market', 'a healthy coin: Safe, from market data')
ok(rhSafety(rh({ volume24h: 90_000, traders24h: 2, createdAt: Date.now() - 2 * 24 * H })).level === 'danger', 'wash trading ($90K from 2 wallets): Danger')
ok(rhSafety(rh({ stock: true, launchpad: null })).level === 'safe', 'a Robinhood stock token: Safe')
ok(rhSafety(rh({ liquidity: 300, marketCap: 400_000, createdAt: Date.now() - 10 * 60_000, buys24h: 1, sells24h: 1, change24h: -90 })).level === 'risky', 'thin, crashing and new: Risky')

console.log('the listing standard')
const base = { level: 'safe' as const, stage: 'graduated' as const, onCurve: false, liquidityUsd: 5_000, holders: 60 }
ok(meetsStandard(base), 'safe, $5K liquidity, 60 holders: listed')
ok(!meetsStandard({ ...base, level: 'danger' }), 'danger: never in the default lists')
ok(!meetsStandard({ ...base, liquidityUsd: LISTING.minLiquidityUsd - 1 }), `under $${LISTING.minLiquidityUsd} of liquidity: not listed`)
ok(!meetsStandard({ ...base, holders: LISTING.minHolders - 1 }) && meetsStandard({ ...base, holders: null }), `under ${LISTING.minHolders} holders: not listed; holders unknown: listed`)
ok(meetsStandard({ ...base, stage: 'new', liquidityUsd: 300, holders: 4 }) && !meetsStandard({ ...base, stage: 'new', liquidityUsd: 300, level: 'danger' }), 'a new coin is listed however thin, unless it’s in danger')
ok(meetsStandard({ ...base, stage: 'bonding', onCurve: true, liquidityUsd: 900, holders: 9 }), 'a curve coin is listed however thin: its liquidity can’t be pulled')
ok(meetsStandard({ ...base, level: 'risky' }) && meetsStandard({ ...base, level: 'checking' }), 'risky and checking coins are listed, with their badge')

console.log('listed at all: $15K and not rugged (owner, 2026-10-04)')
ok(LISTING.minMarketCapUsd === 15_000, 'the floor is $15K of market cap')
ok(isListable({ official: false, marketCapUsd: 20_000, rugged: false }) && !isListable({ official: false, marketCapUsd: 14_999, rugged: false }), '$20K listed, $14,999 not')
ok(!isListable({ official: false, marketCapUsd: 900_000, rugged: true }), 'rugged: not listed whatever its market cap')
ok(isListable({ official: true, marketCapUsd: 0, rugged: true }), '$ARCDEX is always listed')
const live = { change24h: 3, liquidityUsd: 8_000, onCurve: false, chain: null }
ok(!isRugged(live), 'trading normally: not rugged')
ok(isRugged({ ...live, change24h: -92 }), 'down 92% in a day: rugged')
ok(isRugged({ ...live, liquidityUsd: 300 }) && !isRugged({ ...live, liquidityUsd: 300, onCurve: true }), 'a pool drained to $300: rugged; a curve coin that thin: not (its curve can’t be pulled)')
ok(isRugged({ ...live, chain: { at: 1, fails: [{ id: 'creator', detail: 'sold 90%' }], risks: [], sellable: true, launcher: null, deep: true } }), 'the creator dumped (the scan’s hard check): rugged')

console.log('same tickers: the OG and its duplicates')
ok(tickerKey('$Pepe ') === 'pepe' && tickerKey('P.E.P.E') === 'pepe', 'tickers compare without $, case or punctuation')
{
  type R = { a: string; s: string; at: number; by: string | null }
  const rows: R[] = [
    { a: 'copy1', s: 'DOG', at: 3_000, by: '0xdev' },
    { a: 'og', s: '$dog', at: 1_000, by: '0xDEV' },
    { a: 'copy2', s: 'DOG', at: 2_000, by: '0xother' },
    { a: 'unknown', s: 'DOG', at: 0, by: null },
    { a: 'solo', s: 'CAT', at: 500, by: '0xdev' },
  ]
  const d = markDupes(rows, { key: r => r.a, symbol: r => r.s, launchedAt: r => r.at, creator: r => r.by })
  ok(d.get('og')?.og === true && !d.get('og')?.dup, 'the earliest launched is the OG')
  ok(d.get('copy1')?.dup && d.get('copy1')?.sameCreator, 'a later one by the OG’s creator: duplicate, same creator')
  ok(d.get('copy2')?.dup && !d.get('copy2')?.sameCreator, 'a later one by someone else: duplicate')
  ok(d.get('unknown')?.dup === true, 'a launch time unknown can’t make it the OG')
  ok(!d.has('solo'), 'a ticker with one coin is neither')
}

console.log('\nall coin board checks passed')
