// Autotrade for visitors: paper accounts with virtual USDC (bot/paperAccounts.ts)
// and the live scanner's feed (bot/scanFeed.ts).
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo } from '../../api/_marketProtocol'
import { MemoryBotStore } from '../src/bot/store'
import { defaultTuning } from '../src/bot/learner'
import { keyHash, PaperAccounts, PAPER_LIMITS, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { GRADE_SHARE } from '../src/bot/sizing'
import { failing, ScanFeed } from '../src/bot/scanFeed'
import { STRATEGIES } from '../src/trading/paper'

const T = '0x' + 'b1'.repeat(20)
const now = Date.UTC(2026, 8, 30, 12)

describe('paper accounts', () => {
  const setup = (price: () => number | null = () => 1) => {
    const store = new MemoryBotStore()
    const accts = new PaperAccounts({ speed: null, store, priceOf: price, params: s => STRATEGIES[s] })
    const { key, account } = accts.create(now, { name: 'Hunter 1', strategies: ['snipe', 'scalp'] }) as { key: string; account: PaperAccount }
    return { store, accts, key, a: account }
  }
  const signal = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000, ...o })
  /** A trade from `capital`: 20% on a Prime signal, 15% Core, 10% Standard (a signal without a grade counts as Standard; bot/sizing.ts). */
  const sizeOf = (capital: number, grade: 'prime' | 'core' | 'standard' = 'standard') => Math.floor(capital * GRADE_SHARE[grade] * 10 + 1e-9) / 10
  const quality = (grade: 'live' | 'paper', tier: 'A' | 'B', level?: 'prime' | 'core' | 'standard') => ({ score: grade === 'live' ? 85 : 55, grade, tier, rank: null, parts: [], ...(level ? { level } : {}) })
  /** A coin's numbers at the signal; `flags` are the risk checks it didn't pass. */
  const features = (flags: string[] = []) => ({ ageSec: 120, liquidityUsd: 100_000, marketCapUsd: 200_000, buyers: 20, buySellRatio: 3, runUp: 1.1, topBuyerPct: 10, score: 90, flags, roundTripPct: 2 })

  test('a key opens its account; the engine keeps only its hash', () => {
    const { accts, key, a } = setup()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(a.id).toBe(keyHash(key))
    expect(accts.byKey(key)).toBe(a)
    expect(accts.byKey('ab'.repeat(32))).toBeNull()
    expect(accts.byKey(null)).toBeNull()
    expect(accts.view(a).id).toBe(a.id.slice(0, 8)) // never the whole hash
    expect(accts.view(a).name).toBe('Hunter 1')
  })
  test('deposits, strategies and start are checked; the amount per trade is not the visitor\'s', () => {
    const { accts, a } = setup()
    expect(accts.act(a, { action: 'start' }, now)).toMatch(/deposit/)
    expect(accts.act(a, { action: 'deposit', amount: -5 }, now)).toMatch(/above/)
    expect(accts.act(a, { action: 'deposit', amount: PAPER_LIMITS.maxDeposit + 1 }, now)).toMatch(/at most/)
    expect(accts.act(a, { action: 'deposit', amount: 1_000 }, now)).toBeNull()
    expect(accts.act(a, { action: 'strategies', strategies: [] }, now)).toMatch(/at least one/)
    expect(accts.act(a, { action: 'strategies', strategies: ['snipe', 'bogus' as never, 'second-leg'] }, now)).toBeNull()
    expect(a.strategies).toEqual(['snipe', 'second-leg'])
    expect(accts.act(a, { action: 'size', usd: 50 }, now)).toMatch(/automatically/)
    expect(accts.act(a, { action: 'start' }, now)).toBeNull()
    expect(a).toMatchObject({ running: true, cash: 1_000, startedAt: now })
  })
  test('a running account buys the signals of the strategies it follows, each sized from its capital', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now)
    accts.onSignal(signal(), now) // not started yet
    expect(a.positions).toEqual([])
    accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ id: 's2', strategy: 'second-leg' }), now) // not followed
    expect(a.positions).toEqual([])
    accts.onSignal(signal({ id: 's3' }), now)
    expect(a.positions).toHaveLength(1)
    expect(a.positions[0].sizeUsd).toBe(sizeOf(100)) // 10% of $100: a signal without a grade is Standard
    accts.onSignal(signal({ id: 's4', token: '0x' + 'c2'.repeat(20), strategy: 'scalp', quality: quality('live', 'A', 'prime') }), now)
    expect(a.positions[1].sizeUsd).toBeGreaterThanOrEqual(19.8) // 20% of what it's worth now on a Prime signal: $90 cash and the open trade
    expect(a.positions[1].sizeUsd).toBeLessThanOrEqual(20)
    expect(a.positions[1].targetUsd).toBeGreaterThan(0) // what it makes at the take-profit
    expect(a.positions[1].tuningVersion).toBe(1)
    expect(a.positions[1].grade).toBe('prime')
    expect(a.events[0].text).toMatch(/20% of its \$\d+\.\d\d, a Prime signal/)
  })
  test('the signal\'s grade sets the share: 20% Prime, 15% Core, 10% Standard, whatever its risk flags', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ id: 'p1', quality: quality('live', 'B', 'prime'), features: features(['holders']) }), now)
    expect(a.positions[0].sizeUsd).toBe(sizeOf(100, 'prime')) // a coin with a risk flag, a Prime signal: 20%
    expect(a.events[0].text).toMatch(/a Prime signal/)
    accts.onSignal(signal({ id: 'c1', token: '0x' + 'c6'.repeat(20), quality: quality('live', 'A', 'core'), features: features() }), now)
    expect(a.positions[1].sizeUsd).toBeGreaterThanOrEqual(14.8) // 15% of what it's worth now
    expect(a.positions[1].sizeUsd).toBeLessThanOrEqual(15)
    accts.onSignal(signal({ id: 's1b', token: '0x' + 'c7'.repeat(20), quality: quality('live', 'A', 'standard'), features: features() }), now)
    expect(a.positions[2].sizeUsd).toBeGreaterThanOrEqual(9.8)
    expect(a.positions[2].sizeUsd).toBeLessThanOrEqual(10)
    expect(accts.view(a).byGrade).toEqual({}) // nothing closed yet
    expect(accts.view(a).protections.gradeSharePct).toEqual({ prime: 20, core: 15, standard: 10 })
  })
  test('a live bot passes over paper-only signals', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ id: 'b1', quality: quality('live', 'B') }), now)
    accts.onSignal(signal({ id: 'p1', token: '0x' + 'c3'.repeat(20), quality: quality('paper', 'B') }), now)
    expect(a.positions).toHaveLength(2) // a paper bot takes a paper-only signal
    a.mode = 'live'
    accts.onSignal(signal({ id: 'p2', token: '0x' + 'c4'.repeat(20), quality: quality('paper', 'B') }), now)
    expect(accts.view(a).skips[0].text).toMatch(/not traded live: in the lowest 20% of recent signals by quality \(score 55\)/)
  })
  test('a $10 bot trades: $2 on a Prime signal, $1 on a Standard one; the same coin once per 6 hours', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 10 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ features: features(), quality: quality('live', 'A', 'prime') }), now)
    expect(a.positions[0].sizeUsd).toBe(2)
    accts.onSignal(signal({ id: 's2' }), now) // same coin
    expect(a.positions).toHaveLength(1)
    accts.onSignal(signal({ id: 's3', token: '0x' + 'c5'.repeat(20), features: features(['serial']) }), now)
    expect(a.positions[1].sizeUsd).toBe(1)
    expect(accts.view(a).protections).toMatchObject({ maxTradeSharePct: 20, tradeSharePct: { a: 20, b: 10 }, minTradeUsd: 1 })
  })
  test('a bot too small for even a $1 trade waits, and says why', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 4 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal(), now)
    expect(a.positions).toEqual([])
    expect(accts.view(a).skips[0].text).toMatch(/the bot is worth \$4\.00: even 20% of it is under the \$1 minimum trade/)
  })
  test('exits pay back into cash; the creator selling closes a position at once', () => {
    const { accts, a } = setup()
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal({ strategy: 'scalp' }), now)
    const p = a.positions[0]
    accts.onPrice(T, 1.05, now + 1_000, false, true) // +5%: short of the take-profit
    expect(p.status).toBe('open')
    accts.onPrice(T, 1.04, now + 2_000, true, true) // the creator sells
    expect(p).toMatchObject({ status: 'closed', exitReason: 'creator', note: 'The creator sold: out at once' })
    expect(accts.view(a).stats).toMatchObject({ closed: 1 })
  })
  test('equity counts open positions at the current price; reset empties it', () => {
    let price = 1
    const { accts, a } = setup(() => price)
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal(), now)
    price = 0.9
    const v = accts.view(a)
    expect(v.cash).toBeCloseTo(100 - sizeOf(100), 6)
    expect(v.openValue).toBeGreaterThan(sizeOf(100) * 0.85)
    expect(v.openValue).toBeLessThan(sizeOf(100) * 0.9)
    expect(accts.act(a, { action: 'reset' }, now)).toBeNull()
    expect(a).toMatchObject({ cash: 0, deposited: 0, positions: [], running: false, name: 'Hunter 1' })
  })
  test('accounts are saved and loaded back; rows from before named bots get a name and settings', async () => {
    const { store, accts, a, key } = setup()
    accts.act(a, { action: 'deposit', amount: 42 }, now)
    accts.flush()
    const old = { id: keyHash('cd'.repeat(32)), createdAt: now, running: false, startedAt: null, strategies: ['snipe'], tradeUsd: 25, cash: 10, deposited: 10, positions: [], updatedAt: now }
    store.savePaperAccount(old as never)
    const again = new PaperAccounts({ speed: null, store, priceOf: () => 1, params: s => STRATEGIES[s] })
    await again.load()
    expect(again.byKey(key)?.cash).toBe(42)
    const migrated = again.byKey('cd'.repeat(32))!
    expect(migrated.name).toMatch(/^Bot [0-9A-F]{4}$/)
    expect(migrated.tuning.scalp.takeProfit).toBe(defaultTuning('scalp').takeProfit)
    expect(again.view(migrated).tuning.snipe.sizeUsd).toBeGreaterThan(0)
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

describe('the scan feed after a restart', () => {
  test('"signals in 24h" counts the last day\'s stored signals, not only those since the restart', () => {
    const f = new ScanFeed()
    f.seedSignals([now - 30 * 60_000, now - 5 * 3_600_000, now - 30 * 3_600_000], now)
    expect(f.stats(now).signals24h).toBe(2)
  })
})
