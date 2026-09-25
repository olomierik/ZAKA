// PostgresHistoryStore against a real Postgres wire connection.
// Needs a scratch database: PG_TEST_URL=postgres://… bun test engine/test/postgres.test.ts
// (skipped otherwise — never point it at a database with data you care about).
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, Trade } from '../../api/_marketProtocol'
import { setLogLevel } from '../src/log'
import { PostgresHistoryStore } from '../src/store/postgresHistory'

setLogLevel('error')
const URL = process.env.PG_TEST_URL
const T = '0x' + 'e'.repeat(40)

const trade = (i: number, over: Partial<Trade> = {}): Trade => ({
  tradeId: `0xtx${i}:0`, chain: 'ARC', token: T, pair: `${T}/q`, pool: 'pool', quote: 'q', side: i % 2 ? 'SELL' : 'BUY',
  baseAmount: 10, quoteAmount: 1, tokenAmount: 10, price: 0.1 + i / 100, priceUsd: 0.1 + i / 100, usdValue: 1,
  wallet: null, txHash: `0xtx${i}`, blockNumber: 1_000 + i, logIndex: 0, timestamp: Date.now() - (100 - i) * 1_000,
  dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 5_000, ...over,
})

describe.skipIf(!URL)('PostgresHistoryStore', () => {
  test('creates its schema, writes batches idempotently and reads them back', async () => {
    const store = new PostgresHistoryStore(URL!)
    await store.whenReady()
    for (let i = 0; i < 1_200; i++) store.trade(trade(i))           // > 2 chunks of 500
    store.trade(trade(5))                                           // duplicate id — ignored
    store.candle(T, '1m', { t: 1_790_000_040, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, n: 3, ord: 1 })
    store.candle(T, '1m', { t: 1_790_000_040, o: 1, h: 3, l: 0.5, c: 2.5, v: 12, n: 4, ord: 2 }) // same bucket — updated
    const l: LaunchInfo = { token: T, name: "O'Brien 🚀", symbol: 'OB', decimals: 18, creator: null, txHash: '0xl', blockNumber: 1, timestamp: Date.now(), pool: 'pool', quote: 'q', launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE', portal: 7 }
    store.launch(l)
    store.liquidity({ pool: 'pool', token: T, block: 1, ts: Date.now(), usd: 5_000 })
    await store.flush()
    expect(store.status().lastError).toBeNull()

    const got = await store.trades(T, 500)
    expect(got.length).toBe(500)
    expect(got[0].tradeId).toBe('0xtx1199:0')                      // newest first
    expect(got[0].priceUsd).toBeCloseTo(0.1 + 11.99, 6)
    const c = await store.candles(T, '1m', 10)
    expect(c).toEqual([[1_790_000_040, 1, 3, 0.5, 2.5, 12, 4]])
    expect((await store.token(T))?.name).toBe("O'Brien 🚀")        // quotes/emoji survive (bound params)
    expect((await store.launches(5)).map(x => x.symbol)).toContain('OB')

    await store.setCursor(123)
    await store.setCursor(456)
    expect(await store.getCursor()).toBe(456)

    // Re-writing the same rows is a no-op, not an error.
    for (let i = 0; i < 10; i++) store.trade(trade(i))
    await store.flush()
    expect(store.status().lastError).toBeNull()

    // A late-trade repair rebuilds a bucket from the stored trades.
    store.repair(T, '1d', Math.floor(Date.now() / 86_400_000) * 86_400)
    await store.flush()
    const day = await store.candles(T, '1d', 5)
    expect(day[day.length - 1][6]).toBeGreaterThan(0)
    store.close()
  })

  test('a second start on the same database is fine (schema is idempotent)', async () => {
    const again = new PostgresHistoryStore(URL!)
    await again.whenReady()
    expect(await again.getCursor()).toBe(456)
    again.close()
  })
})
