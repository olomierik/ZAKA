// Autotrade for visitors: paper accounts with virtual USDC (bot/paperAccounts.ts)
// and the live scanner's feed (bot/scanFeed.ts).
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo } from '../../api/_marketProtocol'
import { MemoryBotStore } from '../src/bot/store'
import { keyHash, PaperAccounts, PAPER_LIMITS, sizeFor, type PaperSignal } from '../src/bot/paperAccounts'
import { failing, ScanFeed } from '../src/bot/scanFeed'
import { STRATEGIES } from '../src/trading/paper'

const T = '0x' + 'b1'.repeat(20)
const now = Date.UTC(2026, 8, 30, 12)

describe('paper accounts', () => {
  const setup = (price: () => number | null = () => 1) => {
    const store = new MemoryBotStore()
    const accts = new PaperAccounts({ store, priceOf: price, params: s => STRATEGIES[s] })
    const { key, account } = accts.create(now)!
    return { store, accts, key, a: account }
  }
  const signal = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000, ...o })

  test('a key opens its account; the engine keeps only its hash', () => {
    const { accts, key, a } = setup()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(a.id).toBe(keyHash(key))
    expect(accts.byKey(key)).toBe(a)
    expect(accts.byKey('ab'.repeat(32))).toBeNull()
    expect(accts.byKey(null)).toBeNull()
    expect(accts.view(a).id).toBe(a.id.slice(0, 8)) // never the whole hash
  })
  test('deposits, strategies, size and start are checked', () => {
    const { accts, a } = setup()
    expect(accts.act(a, { action: 'start' }, now)).toMatch(/deposit/)
    expect(accts.act(a, { action: 'deposit', amount: -5 }, now)).toMatch(/above/)
    expect(accts.act(a, { action: 'deposit', amount: PAPER_LIMITS.maxDeposit + 1 }, now)).toMatch(/at most/)
    expect(accts.act(a, { action: 'deposit', amount: 1_000 }, now)).toBeNull()
    expect(accts.act(a, { action: 'strategies', strategies: [] }, now)).toMatch(/at least one/)
    expect(accts.act(a, { action: 'strategies', strategies: ['snipe', 'bogus' as never, 'second-leg'] }, now)).toBeNull()
    expect(a.strategies).toEqual(['snipe', 'second-leg'])
    expect(accts.act(a, { action: 'size', usd: 0 }, now)).toMatch(/\$1/)
    expect(accts.act(a, { action: 'size', usd: 50 }, now)).toBeNull()
    expect(accts.act(a, { action: 'start' }, now)).toBeNull()
    expect(a).toMatchObject({ running: true, cash: 1_000, tradeUsd: 50, startedAt: now })
  })
  test('a running account buys the signals of the strategies it follows', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now)
    accts.onSignal(signal(), now) // not started yet
    expect(a.positions).toEqual([])
    accts.act(a, { action: 'start' }, now) // follows snipe and scalp by default
    accts.onSignal(signal({ id: 's2', strategy: 'second-leg' }), now) // not followed
    expect(a.positions).toEqual([])
    accts.onSignal(signal({ id: 's3' }), now)
    expect(a.positions).toHaveLength(1)
    expect(a.cash).toBe(75) // $25 a trade
    accts.onSignal(signal({ id: 's4', token: '0x' + 'c2'.repeat(20), strategy: 'scalp' }), now)
    expect(a.cash).toBe(70) // a scalp is a fifth: $5
    expect(sizeFor(a, 'scalp')).toBe(5)
  })
  test('no cash, no trade; the same coin once per 6 hours', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 30 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal(), now)
    accts.onSignal(signal({ id: 's2' }), now) // same coin
    accts.onSignal(signal({ id: 's3', token: '0x' + 'c2'.repeat(20) }), now) // $5 left, needs $25
    expect(a.positions).toHaveLength(1)
  })
  test('exits pay back into cash; the creator selling closes a scalp', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ strategy: 'scalp' }), now)
    const p = a.positions[0]
    accts.onPrice(T, 1.4, now + 1_000, false, true) // +40%: 75% taken
    expect(p.tp1Done).toBe(true)
    expect(a.cash).toBeGreaterThan(95)
    accts.onPrice(T, 1.2, now + 2_000, true, true) // the creator sells
    expect(p).toMatchObject({ status: 'closed', exitReason: 'creator' })
    expect(a.cash).toBeGreaterThan(100) // a small win on $5
    expect(accts.view(a).stats).toMatchObject({ closed: 1, wins: 1 })
  })
  test('equity counts open positions at the current price; reset empties it', () => {
    let price = 1
    const { accts, a } = setup(() => price)
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal(), now)
    price = 0.5
    const v = accts.view(a)
    expect(v.cash).toBe(75)
    expect(v.openValue).toBeGreaterThan(11)
    expect(v.openValue).toBeLessThan(12.5)
    expect(accts.act(a, { action: 'reset' }, now)).toBeNull()
    expect(a).toMatchObject({ cash: 0, deposited: 0, positions: [], running: false })
  })
  test('accounts are saved and loaded back', async () => {
    const { store, accts, a, key } = setup()
    accts.act(a, { action: 'deposit', amount: 42 }, now)
    accts.flush()
    const again = new PaperAccounts({ store, priceOf: () => 1, params: s => STRATEGIES[s] })
    await again.load()
    expect(again.byKey(key)?.cash).toBe(42)
  })
})

describe('the scan feed', () => {
  const launch = (token: string): LaunchInfo => ({ token, name: 'C', symbol: 'C', decimals: 18, creator: null, txHash: '0x', blockNumber: 1, timestamp: now, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' })
  const base = (token: string) => ({ token, symbol: 'C', launchpad: 'ARGUS', launchedAt: now, priceUsd: 1, marketCapUsd: 10_000, liquidityUsd: 5_000 })

  test('a launch is listed before its first trade', () => {
    const f = new ScanFeed()
    f.launch(launch(T))
    expect(f.get(T)).toMatchObject({ status: 'new', reasons: ['waiting for the first trade'] })
  })
  test('why a coin is waiting, then why it was rejected; a rejection stays the verdict', () => {
    const f = new ScanFeed()
    f.record(base(T), { status: 'watching', stage: 'snipe', reasons: failing(['✓ 12 buyers', '✗ $120 bought (needs $300)']) }, now)
    expect(f.get(T)!.reasons).toEqual(['✗ $120 bought (needs $300)'])
    f.record(base(T), { status: 'rejected', stage: 'safety', reasons: ['✗ honeypot: a holder can\'t sell'] }, now + 1)
    f.record(base(T), { status: 'watching', stage: 'second-leg', reasons: ['✗ ran 2×'] }, now + 2)
    expect(f.get(T)).toMatchObject({ status: 'rejected', stage: 'safety', evals: 3, at: now + 2 })
  })
  test('the numbers: coins, evaluations a minute, signals and rejections a day', () => {
    const f = new ScanFeed()
    f.launch(launch('0x1'))
    f.record(base('0x2'), { status: 'signal', stage: 'snipe', reasons: [], strategy: 'snipe' }, now)
    f.record(base('0x3'), { status: 'rejected', stage: 'safety', reasons: [] }, now)
    f.record(base('0x3'), { status: 'rejected', stage: 'safety', reasons: [] }, now + 1) // counted once
    const s = f.stats(now + 10)
    expect(s).toMatchObject({ watching: 3, evalsPerMin: 3, signals24h: 1, rejected24h: 1, lastEvalAt: now + 1 })
    expect(s.byStatus).toEqual({ new: 1, watching: 0, checking: 0, rejected: 1, signal: 1 })
    expect(f.stats(now + 61_000).evalsPerMin).toBe(0)
  })
  test('the push sends what changed since the last one, newest first', () => {
    const f = new ScanFeed()
    f.record(base('0x2'), { status: 'watching', stage: 'snipe', reasons: [] }, now)
    f.record(base('0x3'), { status: 'watching', stage: 'snipe', reasons: [] }, now + 5)
    expect(f.drainChanged(10).map(r => r.token)).toEqual(['0x3', '0x2'])
    expect(f.drainChanged(10)).toEqual([])
  })
})
