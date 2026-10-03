// ARCSENSE futures on the engine (engine/src/perps): RedStone's signed prices checked as the
// contract checks them (a real gateway snapshot), the chart's candles, the keeper's decisions
// (first price after a request; liquidations with the contract's own math), and the routes.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryCandleStore, PriceCandles } from '../src/perps/candles'
import { codeMatches, initialMarkets } from '../src/perps/deploy'
import { firstFresh, KIND, plan, positionAt, pricesArg, type MarketOnChain, type Pos, type Req } from '../src/perps/keeper'
import { median, RedstoneFeed, toUnits8, verifyFeed, type Snapshot } from '../src/perps/redstone'
import { PerpsService } from '../src/perps/service'
import { FEEDS, REDSTONE, feedIdOf, symbolOf } from '../src/perps/shared'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const raw = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'redstone-snapshot.json'), 'utf8'))
const TS = 1791029540000

describe('RedStone prices', () => {
  test('gateway values become exact 8-decimal integers', () => {
    expect(toUnits8(84679.90298849)).toBe(8467990298849n)
    expect(toUnits8(0.09290288)).toBe(9290288n)
    expect(toUnits8(119.42)).toBe(11942000000n)
    expect(toUnits8(1.5)).toBe(150000000n)
    expect(toUnits8('2683.453202')).toBe(268345320200n)
    expect(toUnits8('1.000000001')).toBeNull() // more precision than a package carries
  })

  test('a real snapshot checks out: five signers, their median', async () => {
    const btc = await verifyFeed('BTC', raw.BTC, REDSTONE.signers, REDSTONE.threshold)
    expect(btc?.pkgs.length).toBe(5)
    expect(btc?.median).toBe(8467960701255n)
    expect(btc?.ts).toBe(TS)
    expect(new Set(btc!.pkgs.map(p => p.signer))).toEqual(new Set(REDSTONE.signers.map(s => s.toLowerCase())))
    for (const f of FEEDS) expect((await verifyFeed(f, raw[f], REDSTONE.signers, 3))?.pkgs.length).toBe(5)
  })

  test('altered, foreign and duplicate packages are dropped', async () => {
    const pk = structuredClone(raw.BTC)
    pk[0].dataPoints[0].value = 99999 // signed for another value
    pk[1].signerAddress = '0x0000000000000000000000000000000000000001' // claims another signer
    pk[2] = structuredClone(pk[3]) // the same signer twice
    const v = await verifyFeed('BTC', pk, REDSTONE.signers, 3)
    expect(v).toBeNull() // only two good ones left
    const two = await verifyFeed('BTC', raw.BTC.slice(0, 2), REDSTONE.signers, 3)
    expect(two).toBeNull()
    const other = await verifyFeed('BTC', raw.BTC, ['0x1111111111111111111111111111111111111111'], 1)
    expect(other).toBeNull()
  })

  test('median as the contract takes it', () => {
    expect(median([5n, 1n, 3n])).toBe(3n)
    expect(median([4n, 1n, 3n, 2n])).toBe(2n) // (2 + 3) / 2, rounded down
  })

  test('snapshots: one per new timestamp, the first after a time', async () => {
    const f = new RedstoneFeed({ feeds: FEEDS, signers: REDSTONE.signers, threshold: 3, gateways: [], dataService: 'x' })
    const seen: Snapshot[] = []
    f.onSnapshot(s => seen.push(s))
    const s1 = await f.ingest(raw, TS + 15_000)
    expect(s1?.ts).toBe(TS)
    expect(Object.keys(s1!.feeds).sort()).toEqual([...FEEDS].sort())
    expect(await f.ingest(raw, TS + 18_000)).toBeNull() // same timestamp again
    expect(seen.length).toBe(1)
    expect(f.firstFrom(TS - 5_000, ['BTC'])?.ts).toBe(TS)
    expect(f.firstFrom(TS + 1, ['BTC'])).toBeNull()
  })
})

describe('candles', () => {
  test('ticks build 1m and 1h candles; 5m and 1d are built from them', () => {
    const c = new PriceCandles(null, ['BTC'])
    const t0 = Date.UTC(2026, 9, 3, 12, 0, 0)
    const prices = [100, 102, 99, 101, 105, 104]
    prices.forEach((p, i) => c.tick('BTC', p, t0 + i * 30_000)) // every 30s for 3 minutes
    const m1 = c.candles('BTC', '1m')
    expect(m1.length).toBe(3)
    expect(m1[0]).toEqual([t0, 100, 102, 100, 102])
    expect(m1[1]).toEqual([t0 + 60_000, 102, 102, 99, 101]) // opens at the last close
    expect(c.candles('BTC', '5m')).toEqual([[t0, 100, 105, 99, 104]])
    expect(c.candles('BTC', '1h')[0][4]).toBe(104)
    expect(c.candles('BTC', '1d').length).toBe(1)
    c.tick('BTC', 50, t0) // older than the last: ignored
    expect(c.candles('BTC', '1m').at(-1)![4]).toBe(104)
  })

  test('24-hour stats need a day of history for the change', () => {
    const c = new PriceCandles(null, ['ETH'])
    const now = Date.UTC(2026, 9, 3, 12, 0, 0)
    c.tick('ETH', 4000, now - 2 * 3_600_000)
    c.tick('ETH', 4100, now - 60_000)
    let s = c.stats('ETH', now)!
    expect(s.price).toBe(4100)
    expect(s.change24h).toBeNull() // only two hours recorded
    expect(s.high24h).toBe(4100)
    const d = new PriceCandles(null, ['ETH'])
    d.tick('ETH', 4000, now - 86_400_000 + 60_000)
    d.tick('ETH', 4400, now - 1_000)
    s = d.stats('ETH', now)!
    expect(s.change24h).toBeCloseTo(10, 6)
  })

  test('candles survive a restart through the store', async () => {
    const store = new MemoryCandleStore()
    const a = new PriceCandles(store, ['SOL'])
    const t0 = Date.now() - 10 * 60_000
    a.tick('SOL', 120, t0)
    a.tick('SOL', 121, t0 + 70_000)
    const b = new PriceCandles(store, ['SOL'])
    await b.load()
    expect(b.candles('SOL', '1m').map(x => x[4])).toEqual([120, 121])
    expect(b.stats('SOL')?.price).toBe(121)
  })
})

// ─── the keeper ──────────────────────────────────────────────────────────────

const snap = (ts: number, prices: Record<string, number>): Snapshot => ({
  ts, fetchedAt: ts + 15_000,
  feeds: Object.fromEntries(Object.entries(prices).map(([f, p]) => [f, {
    feed: f, ts, median: BigInt(Math.round(p * 1e8)), price: p,
    pkgs: [0, 1, 2].map(i => ({ feedId: feedIdOf(f), value: BigInt(Math.round(p * 1e8)), timestampMs: BigInt(ts), signature: `0x${'ab'.repeat(65)}` as `0x${string}`, signer: REDSTONE.signers[i].toLowerCase() })),
  }])),
})
const feedOf = (snaps: Snapshot[]) => ({ history: () => snaps, latest: () => snaps[snaps.length - 1] ?? null })

const side = (oi = 0n) => ({ oi, sizeOverEntry: 0n, collateral: 0n, reserved: 0n })
const market = (feed: string, over: Partial<MarketOnChain> = {}): MarketOnChain => ({
  p: { feedId: feedIdOf(feed), enabled: true, maxLeverage: 10, openFeeBps: 8, closeFeeBps: 8, liquidationBps: 100, borrowRatePerHour: 25_000_000_000_000n, maxOiLong: 10n ** 12n, maxOiShort: 10n ** 12n },
  borrowIndex: 0n, lastBorrowUpdate: 1_800_000_000n, long_: side(), short_: side(), ...over,
})
const req = (o: Partial<Req>): Req => ({
  kind: KIND.Open, isLong: true, marketId: 0, createdAt: 0n, account: '0x00000000000000000000000000000000000000a1', amount: 1_000_000_000n,
  size: 10_000_000_000n, acceptablePrice: 10n ** 20n, triggerPrice: 0n, positionId: 0n, tp: 0n, sl: 0n, execFee: 20_000n, ...o,
})
const pos = (o: Partial<Pos>): Pos => ({
  trader: '0x00000000000000000000000000000000000000a1', marketId: 0, isLong: true, openedAt: 0n, tpSlSetAt: 0n,
  size: 10_000_000_000n, collateral: 992_000_000n, entryPrice: 100_000n * 10n ** 8n, borrowIndex: 0n, maxProfit: 8_928_000_000n, tp: 0n, sl: 0n, ...o,
})

describe('keeper decisions', () => {
  const NOW = 1_800_000_100_000
  const T = 1_800_000_000 // a request's time (seconds)
  const markets = [market('BTC'), market('ETH'), market('SOL')]

  test('a market order runs on the first price signed after it, not a later one', () => {
    const f = feedOf([snap(T * 1000 - 10_000, { BTC: 99_000 }), snap(T * 1000 + 10_000, { BTC: 100_000 }), snap(T * 1000 + 20_000, { BTC: 101_000 })])
    const a = plan({ nowMs: T * 1000 + 25_000, requests: [[1n, req({ createdAt: BigInt(T) })]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: f })
    expect(a.length).toBe(1)
    expect(a[0].snap.ts).toBe(T * 1000 + 10_000)
    expect(a[0].feeds).toEqual(['BTC'])
  })

  test('nothing to do before a price signed after the request, or once it expired', () => {
    const f = feedOf([snap(T * 1000 - 10_000, { BTC: 99_000 })])
    expect(plan({ nowMs: T * 1000 + 5_000, requests: [[1n, req({ createdAt: BigInt(T) })]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: f })).toEqual([])
    const g = feedOf([snap(T * 1000 + 200_000, { BTC: 99_000 })])
    expect(plan({ nowMs: T * 1000 + 205_000, requests: [[1n, req({ createdAt: BigInt(T) })]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: g })).toEqual([])
  })

  test('a stale first price is skipped for the first fresh one after the request', () => {
    const f = feedOf([snap(T * 1000 + 10_000, { BTC: 99_000 }), snap(T * 1000 + 300_000, { BTC: 98_000 })])
    const s = firstFresh(f, T * 1000, ['BTC'], T * 1000 + 310_000, 50_000)
    expect(s?.ts).toBe(T * 1000 + 300_000)
  })

  test('limit orders wait for their price', () => {
    const limit = req({ createdAt: BigInt(T), triggerPrice: 98_000n * 10n ** 8n })
    const above = feedOf([snap(T * 1000 + 600_000, { BTC: 99_000 })])
    expect(plan({ nowMs: T * 1000 + 605_000, requests: [[2n, limit]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: above })).toEqual([])
    const below = feedOf([snap(T * 1000 + 600_000, { BTC: 97_900 })])
    expect(plan({ nowMs: T * 1000 + 605_000, requests: [[2n, limit]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: below })[0].why).toBe('limit reached')
  })

  test('deposits and withdrawals: no prices needed with no open interest, every active market otherwise', () => {
    const f = feedOf([snap(T * 1000 + 10_000, { BTC: 100_000, ETH: 4_000, SOL: 120 })])
    const dep = req({ kind: KIND.Deposit, createdAt: BigInt(T) })
    expect(plan({ nowMs: T * 1000 + 12_000, requests: [[3n, dep]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: f })[0].feeds).toEqual([])
    const busy = [market('BTC', { long_: side(1n) }), market('ETH'), market('SOL', { short_: side(1n) })]
    const w = req({ kind: KIND.Withdraw, createdAt: BigInt(T) })
    expect(plan({ nowMs: T * 1000 + 12_000, requests: [[4n, w]], positions: [], markets: busy, maxPriceAge: 60, requestTimeout: 120, feed: f })[0].feeds).toEqual(['BTC', 'SOL'])
  })

  test('liquidation math matches the contract (10x long at $100,000)', () => {
    const m = market('BTC', { lastBorrowUpdate: 0n })
    expect(positionAt(pos({}), m, 92_000n * 10n ** 8n, 0).liquidatable).toBe(false) // equity $192
    const r = positionAt(pos({}), m, 91_000n * 10n ** 8n, 0)
    expect(r.liquidatable).toBe(true) // equity $92 < $108
    expect(r.equity).toBe(92_000_000n)
    // Borrow fee: 100 hours at 0.0025% of $10,000 = $25.
    expect(positionAt(pos({}), m, 100_000n * 10n ** 8n, 100 * 3600).borrowFee).toBe(25_000_000n)
    // Profit capped at what was reserved.
    expect(positionAt(pos({}), m, 300_000n * 10n ** 8n, 0).pnl).toBe(8_928_000_000n)
  })

  test('liquidations and take-profit / stop-loss on the latest price', () => {
    const f = feedOf([snap(NOW - 5_000, { BTC: 91_000 })])
    const a = plan({ nowMs: NOW, requests: [], positions: [[7n, pos({})]], markets, maxPriceAge: 60, requestTimeout: 120, feed: f })
    expect(a.map(x => [x.type, x.id])).toEqual([['liquidate', 7n]])
    const g = feedOf([snap(NOW - 5_000, { BTC: 111_000 })])
    const tp = plan({ nowMs: NOW, requests: [], positions: [[8n, pos({ tp: 110_000n * 10n ** 8n })]], markets, maxPriceAge: 60, requestTimeout: 120, feed: g })
    expect(tp.map(x => [x.type, x.why])).toEqual([['tpsl', 'take-profit']])
    // A stop set after the latest price was signed waits for the next one.
    const late = plan({ nowMs: NOW, requests: [], positions: [[9n, pos({ sl: 112_000n * 10n ** 8n, tpSlSetAt: BigInt(Math.floor(NOW / 1000)) })]], markets, maxPriceAge: 60, requestTimeout: 120, feed: g })
    expect(late).toEqual([])
    // A stale latest price: nothing.
    expect(plan({ nowMs: NOW + 120_000, requests: [], positions: [[7n, pos({})]], markets, maxPriceAge: 60, requestTimeout: 120, feed: f })).toEqual([])
  })

  test('a request that failed waits before it is tried again', () => {
    const f = feedOf([snap(T * 1000 + 10_000, { BTC: 100_000 })])
    expect(plan({ nowMs: T * 1000 + 12_000, requests: [[1n, req({ createdAt: BigInt(T) })]], positions: [], markets, maxPriceAge: 60, requestTimeout: 120, feed: f, skip: k => k === 'r1' })).toEqual([])
  })

  test('the signed packages go to the contract as they were signed', () => {
    const s = snap(TS, { BTC: 100_000, ETH: 4_000 })
    const arg = pricesArg(s, ['ETH'])
    expect(arg.length).toBe(3)
    expect(arg[0]).toEqual({ feedId: feedIdOf('ETH'), value: 400_000_000_000n, timestampMs: BigInt(TS), signature: `0x${'ab'.repeat(65)}` })
  })
})

describe('deployment', () => {
  test('feed ids and the markets deployed', () => {
    expect(feedIdOf('BTC')).toBe('0x4254430000000000000000000000000000000000000000000000000000000000')
    expect(symbolOf(feedIdOf('DOGE'))).toBe('DOGE')
    expect(initialMarkets().map(m => symbolOf(m.feedId))).toEqual(['BTC', 'ETH', 'SOL'])
    expect(initialMarkets()[0]).toMatchObject({ maxLeverage: 10, openFeeBps: 8, closeFeeBps: 8, liquidationBps: 100 })
  })

  test('deployed code is compared apart from its immutables', () => {
    const runtime = '0x6001aaaaaaaa6002'
    expect(codeMatches('0x6001bbbbbbbb6002', runtime, [[2, 4]])).toBe(true)
    expect(codeMatches('0x6001bbbbbbbb6003', runtime, [[2, 4]])).toBe(false)
    expect(codeMatches('0x6001aaaa', runtime, [])).toBe(false)
    expect(codeMatches(undefined, runtime, [])).toBe(false)
  })
})

describe('the service', () => {
  test('serves prices, candles and status without a keeper wallet', async () => {
    const settings = new Map<string, string>()
    const svc = new PerpsService({
      settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } },
      candleStore: null, vault: null, env: {},
      fetch: (async () => new Response(JSON.stringify(raw))) as unknown as typeof fetch,
    })
    await svc.start()
    for (let i = 0; i < 50 && !svc.feed.latest(); i++) await Bun.sleep(20)
    svc.stop()
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const prices = await svc.handle(new URL('http://e/v1/perps/prices'), json)!.json() as { ts: number; feeds: Record<string, { price: number }> }
    expect(prices.ts).toBe(TS)
    expect(prices.feeds.BTC.price).toBe(84679.60701255)
    expect(Object.keys(prices.feeds).length).toBe(8)
    const candles = await svc.handle(new URL('http://e/v1/perps/candles?feed=eth&tf=1m'), json)!.json() as { bars: number[][] }
    expect(candles.bars.length).toBe(1)
    expect(candles.bars[0][4]).toBe(2683.453202)
    expect(svc.handle(new URL('http://e/v1/perps/candles?feed=PEPE'), json)!.status).toBe(400)
    expect(svc.handle(new URL('http://e/v1/perps/candles?feed=BTC&tf=7m'), json)!.status).toBe(400)
    const status = await svc.handle(new URL('http://e/v1/perps/status'), json)!.json() as { waiting: string; keeper: { address: string | null } }
    expect(status.keeper.address).toBeNull()
    expect(status.waiting).toContain('BOT_WALLET_SECRET')
    expect(svc.handle(new URL('http://e/v1/perps/nope'), json)).toBeNull()
  })
})
