import { describe, expect, test } from 'bun:test'
import { parseClientMessage, topicOf, fromWire, toWire, type Trade } from '../../api/_marketProtocol'
import { CandleEngine } from '../src/market/candles'
import { TokenState } from '../src/market/tokenState'

const T = '0x' + 'a'.repeat(40)
const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 'tx:1', chain: 'ARC', token: T, pair: `${T}/q`, pool: 'pool', quote: 'q', side: 'BUY',
  baseAmount: 10, quoteAmount: 1, tokenAmount: 10, price: 0.1, priceUsd: 0.1, usdValue: 1,
  wallet: null, txHash: 'tx', blockNumber: 100, logIndex: 1, timestamp: Date.now(), dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 1000,
  ...over,
})

describe('CandleEngine', () => {
  test('first trade opens at the pool price before it; later trades update high/low/close/volume', () => {
    const c = new CandleEngine()
    const t0 = 1_790_000_000_000 // on a 1d boundary? doesn't matter: same bucket for all below
    c.apply(T, 1.0, 5, t0, 1, 0.9)
    c.apply(T, 1.2, 3, t0 + 100, 2, 1.0)
    const r = c.apply(T, 0.95, 2, t0 + 200, 3, 1.2)
    const m = c.current(T, '1m')!
    expect([m.o, m.h, m.l, m.c, m.v, m.n]).toEqual([0.9, 1.2, 0.9, 0.95, 10, 3])
    expect(r.updated.map(u => u.interval)).toEqual(['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h', '1d'])
    expect(r.completed).toEqual([])
  })

  test('a trade in a new bucket completes the previous candle and opens at its close', () => {
    const c = new CandleEngine()
    const t0 = 1_790_000_040_000
    c.apply(T, 1.0, 1, t0, 1, null)
    c.apply(T, 2.0, 1, t0 + 500, 2, 1.0)
    const r = c.apply(T, 1.5, 1, t0 + 60_000, 3, 2.0)
    const done = r.completed.find(x => x.interval === '1m')!.candle
    expect([done.o, done.h, done.c, done.n]).toEqual([1.0, 2.0, 2.0, 2])
    const now = c.current(T, '1m')!
    expect([now.o, now.h, now.l, now.c]).toEqual([2.0, 2.0, 1.5, 1.5]) // continuous: opens at previous close
  })

  test('a late trade lands in its own (recent) bucket and never overwrites a newer close', () => {
    const c = new CandleEngine()
    const t0 = 1_790_000_100_000
    c.apply(T, 1.0, 1, t0, 10, null)
    c.apply(T, 3.0, 1, t0 + 61_000, 20, 1.0)             // next minute
    const r = c.apply(T, 5.0, 4, t0 + 1_000, 5, null)      // late, older chain order, first minute
    const first = c.recent(T, '1m')[0]
    expect([first.h, first.c, first.v, first.n]).toEqual([5.0, 1.0, 5, 2])
    expect(r.completed.some(x => x.interval === '1m' && x.candle === first)).toBe(true) // re-persist
    expect(c.current(T, '1m')!.c).toBe(3.0)
  })

  test('a trade older than the in-memory window asks for a database repair', () => {
    const c = new CandleEngine(2)
    const t0 = 1_790_000_200_000
    for (let i = 0; i < 4; i++) c.apply(T, 1 + i, 1, t0 + i * 1_000, i + 1, null)
    const r = c.apply(T, 9, 1, t0 - 10_000, 0, null)
    expect(r.repair.some(x => x.interval === '1s')).toBe(true)
  })
})

describe('TokenState', () => {
  test('24h totals, buys/sells and price move incrementally', () => {
    const s = new TokenState(T)
    const now = Date.now()
    s.add(trade({ side: 'BUY', usdValue: 10, priceUsd: 1, timestamp: now - 10 * 60_000 }), 1, now)
    s.add(trade({ side: 'SELL', usdValue: 4, priceUsd: 1.5, timestamp: now - 5 * 60_000 }), 2, now)
    s.add(trade({ side: 'BUY', usdValue: 6, priceUsd: 2, timestamp: now }), 3, now)
    const st = s.stats(now)
    expect([st.vol24, st.buyVol24, st.sellVol24, st.buys24, st.sells24, st.trades24]).toEqual([20, 16, 4, 2, 1, 3])
    expect(st.priceUsd).toBe(2)
    expect(Math.round(st.chg.m5!)).toBe(33) // 1.5 → 2
    expect(Math.round(st.chg.h24!)).toBe(100) // from its first trade
  })

  test('a late trade counts in the totals but does not replace the latest price', () => {
    const s = new TokenState(T)
    const now = Date.now()
    s.add(trade({ priceUsd: 2, usdValue: 1 }), 50, now)
    expect(s.add(trade({ priceUsd: 9, usdValue: 1 }), 10, now)).toBe(false)
    expect(s.stats(now).priceUsd).toBe(2)
    expect(s.stats(now).trades24).toBe(2)
  })

  test('trades roll out of the 24h window', () => {
    const s = new TokenState(T)
    const t0 = Date.now()
    s.add(trade({ usdValue: 7, timestamp: t0 }), 1, t0)
    expect(s.stats(t0).vol24).toBe(7)
    expect(s.stats(t0 + 23 * 3_600_000).vol24).toBe(7)
    expect(s.stats(t0 + 24 * 3_600_000 + 120_000).vol24).toBe(0)
  })

  test('serialize/restore keeps 24h stats across a restart', () => {
    const s = new TokenState(T)
    const now = Date.now()
    s.add(trade({ side: 'BUY', usdValue: 3, timestamp: now - 3_600_000 }), 1, now)
    s.add(trade({ side: 'SELL', usdValue: 2, timestamp: now }), 2, now)
    const r = TokenState.restore(T, JSON.parse(JSON.stringify(s.serialize())))
    const a = s.stats(now), b = r.stats(now)
    expect([b.vol24, b.buys24, b.sells24, b.priceUsd]).toEqual([a.vol24, a.buys24, a.sells24, a.priceUsd])
  })
})

describe('protocol', () => {
  test('valid subscriptions parse and map to topics', () => {
    const m = parseClientMessage(JSON.stringify({ action: 'subscribe', channel: 'candles', token: '0x' + 'AB'.repeat(20), interval: '1m' }))
    expect('error' in m).toBe(false)
    expect(topicOf(m as never)).toBe(`candles:0x${'ab'.repeat(20)}:1m`)
    expect(topicOf(parseClientMessage('{"action":"subscribe","channel":"new_tokens"}') as never)).toBe('new_tokens')
  })

  test('bad input is rejected with a reason', () => {
    const e = (raw: unknown) => (parseClientMessage(raw) as { error?: string }).error
    expect(e('not json')).toBe('bad_json')
    expect(e('[]')).toBe('bad_message')
    expect(e('{"action":"drop"}')).toBe('bad_action')
    expect(e('{"action":"subscribe","channel":"admin"}')).toBe('bad_channel')
    expect(e('{"action":"subscribe","channel":"token","token":"0x123"}')).toBe('bad_token')
    expect(e('{"action":"subscribe","channel":"token","token":"<script>"}')).toBe('bad_token')
    expect(e(`{"action":"subscribe","channel":"candles","token":"0x${'a'.repeat(40)}","interval":"2m"}`)).toBe('bad_interval')
    expect(e('x'.repeat(2_000))).toBe('too_large')
  })

  test('wire form round-trips', () => {
    const t = trade({ side: 'SELL', wallet: '0x' + 'b'.repeat(40) })
    expect(fromWire(toWire(t))).toEqual(t)
  })
})
