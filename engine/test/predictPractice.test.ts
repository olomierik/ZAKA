// Practice predictions (practice/predict.ts): fills at the mid the engine reads, the limits, sells, Hyperliquid's
// settlement, the leaderboard, a restart, and the routes.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { MemoryPracticeStore, PredictPractice, practiceKeyHash, type HlInfo } from '../src/practice/predict'
import { PRACTICE, practiceEndsAt, sideMid } from '../../api/_practiceProtocol'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
const T0 = Date.UTC(2026, 9, 17, 12)

/** A stand-in Hyperliquid: two live markets (one in a question), one past its end, mids and settlements to set. */
function fakeHl() {
  const state = {
    outcomes: [
      { outcome: 13000, name: 'template:binaryPrice', description: 'perp:BTC|threshold:82016|time:20261020-0400', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }] },
      { outcome: 2001, name: 'Recurring Named Outcome', description: 'index:1', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] },
      { outcome: 5000, name: 'template:binaryPrice', description: 'perp:BTC|threshold:86775|time:20261017-1100', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }] },
    ],
    questions: [{ question: 227, name: 'Recurring', description: 'class:priceBucket|underlying:BTC|expiry:20261021-0600', fallbackOutcome: 2002, namedOutcomes: [2000, 2001], settledNamedOutcomes: [] }],
    mids: { '#130000': '0.40', '#130001': '0.61', '#20010': '0.25', '#50000': '0.97' } as Record<string, string>,
    settled: {} as Record<number, string>,
    calls: [] as string[],
  }
  const info: HlInfo = async body => {
    state.calls.push(String(body.type))
    if (body.type === 'outcomeMeta') return { outcomes: state.outcomes, questions: state.questions }
    if (body.type === 'allMids') return state.mids
    if (body.type === 'settledOutcome') {
      const f = state.settled[Number(body.outcome)]
      return f === undefined ? null : { spec: {}, settleFraction: f, details: '' }
    }
    throw new Error('unexpected')
  }
  return { state, info }
}

const ok = <T,>(r: T | { error: string }): T => {
  if (r && typeof r === 'object' && 'error' in (r as object)) throw new Error((r as { error: string }).error)
  return r as T
}

describe('practice predictions', () => {
  test('a buy fills at the side’s mid, with no fee; a second buy adds to the position', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const { key, account } = ok(p.create('Alice', '1.1.1.1', T0))
    expect(account).toMatchObject({ name: 'Alice', cash: PRACTICE.startUsd, equity: PRACTICE.startUsd, pnl: 0 })
    const b = ok(await p.buy(key, 13000, 0, 100, T0))
    expect(b.fill).toMatchObject({ outcome: 13000, side: 0, buy: true, px: 0.4, usd: 100, contracts: 250 })
    expect(b.account.cash).toBe(9_900)
    ok(await p.buy(key, 13000, 0, 60, T0 + 2_000))
    const v = (await p.account(key, T0 + 2_000))!
    expect(v.positions).toHaveLength(1)
    expect(v.positions[0]).toMatchObject({ contracts: 400, cost: 160, px: 0.4, value: 160 })
    expect(v.equity).toBe(PRACTICE.startUsd)
  })

  test('a side with no book of its own is priced as the other side’s complement', () => {
    expect(sideMid({ '#130001': 0.61 }, 13000, 0)).toBeCloseTo(0.39, 9)
    expect(sideMid({ '#130000': 0.4, '#130001': 0.61 }, 13000, 1)).toBe(0.61)
    expect(sideMid({}, 13000, 0)).toBeNull()
    expect(sideMid({ '#130000': 1 }, 13000, 0)).toBeNull() // a mid of 1 isn't a price to trade at
  })

  test('the limits: amount, cash, unknown and ended markets, decided sides, open positions, orders a minute', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const { key } = ok(p.create(null, '1.1.1.1', T0))
    expect(await p.buy(key, 13000, 0, 0.5, T0)).toEqual({ error: 'the smallest order is $1' })
    expect(await p.buy(key, 13000, 0, 10_001, T0)).toEqual({ error: 'not enough practice USDC' })
    expect(await p.buy(key, 99999, 0, 10, T0)).toEqual({ error: 'this market isn’t open' })
    expect(await p.buy(key, 13000, 2, 10, T0)).toEqual({ error: 'unknown market' })
    expect(await p.buy(key, 5000, 0, 10, T0)).toEqual({ error: 'this market has ended and settles soon' })
    hl.state.mids['#20010'] = '0.995'
    expect(await p.buy(key, 2001, 0, 10, T0)).toEqual({ error: 'this side is all but decided: no buys under 1¢ or over 99¢' })
    expect(await p.buy('not-a-key', 13000, 0, 10, T0)).toEqual({ error: 'no such practice account' })
    // The question's member is open, priced from its own book.
    hl.state.mids['#20010'] = '0.25'
    expect(ok(await p.buy(key, 2001, 0, 10, T0 + 2_000)).fill.px).toBe(0.25)
    // 120 orders a minute per account (a fresh one, so the tries above don't count).
    const busy = ok(p.create(null, '2.2.2.2', T0)).key
    for (let i = 0; i < PRACTICE.ordersPerMinute; i++) ok(await p.buy(busy, 13000, 1, 1, T0 + 3_000))
    expect(await p.buy(busy, 13000, 1, 1, T0 + 4_000)).toEqual({ error: 'too many orders, slow down' })
    expect('fill' in (await p.buy(busy, 13000, 1, 1, T0 + 64_000) as object)).toBe(true)
  })

  test('a sale at the mid realizes its share of the cost; selling all closes the position', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const { key } = ok(p.create('Bob', 'ip', T0))
    ok(await p.buy(key, 13000, 0, 100, T0)) // 250 contracts at 40¢
    hl.state.mids['#130000'] = '0.50'
    const half = ok(await p.sell(key, 13000, 0, 0.5, T0 + 5_000))
    expect(half.fill).toMatchObject({ buy: false, contracts: 125, px: 0.5, usd: 62.5, pnl: 12.5 })
    expect(half.account.positions[0]).toMatchObject({ contracts: 125, cost: 50 })
    hl.state.mids['#130000'] = '0.30'
    const rest = ok(await p.sell(key, 13000, 0, 1, T0 + 10_000))
    expect(rest.fill).toMatchObject({ contracts: 125, usd: 37.5, pnl: -12.5 })
    expect(rest.account).toMatchObject({ positions: [], cash: 10_000, realized: 0, trades: 2, wins: 1 })
    expect(rest.account.history.map(t => t.how)).toEqual(['sold', 'sold'])
    expect(await p.sell(key, 13000, 0, 1, T0 + 11_000)).toEqual({ error: 'you don’t hold this side' })
    ok(await p.buy(key, 13000, 0, 10, T0 + 12_000))
    expect(await p.sell(key, 13000, 0, 0, T0 + 12_000)).toEqual({ error: 'bad amount' })
    expect(await p.sell(key, 13000, 0, 1.5, T0 + 12_000)).toEqual({ error: 'bad amount' })
  })

  test('settlement is Hyperliquid’s: the first side gets settleFraction a contract, the second 1 − it, once', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const a = ok(p.create('Yes', 'ip1', T0)).key
    const b = ok(p.create('No', 'ip2', T0)).key
    ok(await p.buy(a, 13000, 0, 40, T0)) // 100 contracts of Yes at 40¢
    ok(await p.buy(b, 13000, 1, 61, T0)) // 100 contracts of No at 61¢
    // Still listed and not ended: nobody asks.
    expect(await p.settleTick(T0 + 60_000)).toBe(0)
    expect(hl.state.calls.filter(c => c === 'settledOutcome')).toHaveLength(0)
    // Delisted but not settled yet: asked, nothing paid; not asked again within the minute.
    hl.state.outcomes = hl.state.outcomes.filter(o => o.outcome !== 13000)
    expect(await p.settleTick(T0 + 120_000)).toBe(0)
    expect(await p.settleTick(T0 + 130_000)).toBe(0)
    expect(hl.state.calls.filter(c => c === 'settledOutcome')).toHaveLength(1)
    // Yes won.
    hl.state.settled[13000] = '1.0'
    expect(await p.settleTick(T0 + 200_000)).toBe(2)
    const va = (await p.account(a, T0 + 200_000))!, vb = (await p.account(b, T0 + 200_000))!
    expect(va).toMatchObject({ positions: [], cash: 10_060, realized: 60, wins: 1 })
    expect(va.history[0]).toMatchObject({ how: 'settled', exitPx: 1, proceeds: 100, pnl: 60 })
    expect(vb).toMatchObject({ positions: [], cash: 9_939, realized: -61, wins: 0 })
    expect(vb.history[0]).toMatchObject({ how: 'settled', exitPx: 0, proceeds: 0, pnl: -61 })
    expect(await p.settleTick(T0 + 400_000)).toBe(0)
  })

  test('a market past its end is asked about while still listed, and a split result pays both sides', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const { key } = ok(p.create('Split', 'ip', T0))
    ok(await p.buy(key, 13000, 0, 40, T0))
    hl.state.settled[13000] = '0.25'
    const after = Date.UTC(2026, 9, 20, 4, 1)
    expect(await p.settleTick(after)).toBe(1)
    expect((await p.account(key, after))!.history[0]).toMatchObject({ exitPx: 0.25, proceeds: 25, pnl: -15 })
  })

  test('the leaderboard: realized P&L in the window, 3 trades to be ranked, best trades and the ticker', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const pro = ok(p.create('Pro', 'a', T0)).key
    const one = ok(p.create('OneShot', 'b', T0)).key
    for (let i = 0; i < 3; i++) {
      hl.state.mids['#130000'] = '0.40'
      ok(await p.buy(pro, 13000, 0, 40, T0 + i * 10_000))
      hl.state.mids['#130000'] = '0.50'
      ok(await p.sell(pro, 13000, 0, 1, T0 + i * 10_000 + 5_000))
    }
    hl.state.mids['#130000'] = '0.40'
    ok(await p.buy(one, 13000, 0, 400, T0 + 30_000))
    hl.state.mids['#130000'] = '0.80'
    ok(await p.sell(one, 13000, 0, 1, T0 + 40_000))
    const b = p.board('24h', T0 + 60_000)
    expect(b.traders.map(t => t.name)).toEqual(['Pro']) // OneShot has 1 trade
    expect(b.traders[0]).toMatchObject({ pnl: 30, trades: 3, wins: 3, best: 10 })
    expect(b.trades[0]).toMatchObject({ name: 'OneShot', pnl: 400, entryPx: 0.4, exitPx: 0.8 })
    expect(b.recent[0]).toMatchObject({ name: 'OneShot', buy: false })
    expect(b.accounts).toBe(2)
    expect(JSON.stringify(b)).not.toContain(practiceKeyHash(pro)) // no account id or key on the board
    // A day later, the 24h board is empty; the all-time one isn't.
    expect(p.board('24h', T0 + 2 * 86_400_000).traders).toHaveLength(0)
    expect(p.board('all', T0 + 2 * 86_400_000).traders).toHaveLength(1)
  })

  test('names, resets, five new accounts an hour per IP, and a restart keeps everything', async () => {
    const hl = fakeHl()
    const store = new MemoryPracticeStore()
    const p = new PredictPractice({ store, info: hl.info })
    const { key, account } = ok(p.create('<script>', 'ip', T0))
    expect(account.name).toMatch(/^Trader [0-9A-F]{4}$/)
    expect(p.rename(key, 'x')).toEqual({ error: 'a name is 2–24 letters, digits, spaces or . _ \' -' })
    expect(ok(p.rename(key, '  Night  Owl ')).name).toBe('Night Owl')
    ok(await p.buy(key, 13000, 0, 100, T0))
    expect(p.reset(key, 5)).toEqual({ error: 'bad starting balance' })
    expect(ok(p.reset(key, 1_000, T0 + 1))).toMatchObject({ cash: 1_000, start: 1_000, positions: [], trades: 0, resets: 1 })
    for (let i = 1; i < PRACTICE.newPerIpHour; i++) ok(p.create(null, 'ip', T0))
    expect(p.create(null, 'ip', T0)).toEqual({ error: 'too many new accounts from here, try again later' })
    expect('key' in (p.create(null, 'ip', T0 + 3_600_001) as object)).toBe(true)
    const again = new PredictPractice({ store, info: hl.info })
    await again.load()
    expect((await again.account(key, T0 + 5))!).toMatchObject({ name: 'Night Owl', cash: 1_000, resets: 1 })
  })

  test('when a market stops trading comes from its terms', () => {
    expect(practiceEndsAt({ o: { outcome: 1, name: 'x', description: 'time:20261020-0400', sideSpecs: [] }, q: null })).toBe(Date.UTC(2026, 9, 20, 4))
    expect(practiceEndsAt({ o: { outcome: 1, name: 'x', description: 'index:1', sideSpecs: [] }, q: { question: 1, name: 'q', description: 'expiry:20261021-0600', fallbackOutcome: 2, namedOutcomes: [1], settledNamedOutcomes: [] } })).toBe(Date.UTC(2026, 9, 21, 6))
    expect(practiceEndsAt({ o: { outcome: 1, name: 'x', description: 'participantA:A', sideSpecs: [] }, q: null })).toBeNull()
  })
})

describe('practice routes', () => {
  test('create, buy, read, the board; orders only from the site; a wrong key is a 404', async () => {
    const hl = fakeHl()
    const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
    api.practice = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    const cfg = { role: 'all', port: 0, allowedOrigins: ['https://arcsense.site'], metricsToken: 'secret', maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50 } as unknown as Config
    const srv = startServer({ cfg, api, health: () => ({ status: 'ok' }) })
    const base = `http://127.0.0.1:${srv.server.port}/v1/practice/predict`
    const site = { origin: 'https://arcsense.site', 'content-type': 'text/plain' }
    try {
      expect((await fetch(`${base}/accounts`, { method: 'POST', body: '{}' })).status).toBe(403)
      const made = await fetch(`${base}/accounts`, { method: 'POST', headers: site, body: JSON.stringify({ name: 'Route' }) })
      expect(made.status).toBe(200)
      const { key } = await made.json() as { key: string }
      const buy = await fetch(`${base}/account`, { method: 'POST', headers: { ...site, 'x-practice-key': key }, body: JSON.stringify({ action: 'buy', outcome: 13000, side: 1, usd: 61 }) })
      expect(buy.status).toBe(200)
      expect((await buy.json() as { fill: { contracts: number } }).fill.contracts).toBe(100)
      const bad = await fetch(`${base}/account`, { method: 'POST', headers: { ...site, 'x-practice-key': key }, body: JSON.stringify({ action: 'buy', outcome: 13000, side: 1, usd: 0 }) })
      expect(bad.status).toBe(400)
      const read = await fetch(`${base}/account`, { headers: { 'x-practice-key': key } })
      expect((await read.json() as { positions: unknown[] }).positions).toHaveLength(1)
      expect((await fetch(`${base}/account`, { headers: { 'x-practice-key': 'x'.repeat(40) } })).status).toBe(404)
      const board = await fetch(`${base}/board?period=24h`)
      expect(board.status).toBe(200)
      expect(board.headers.get('cache-control')).toBe('public, max-age=5')
      const pre = await fetch(`${base}/account`, { method: 'OPTIONS', headers: { origin: 'https://arcsense.site' } })
      expect(pre.headers.get('access-control-allow-headers')).toContain('X-Practice-Key')
    } finally { srv.stop() }
  })
})
