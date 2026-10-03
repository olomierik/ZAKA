// Signal grades, tiers and the crowd (2026-09-30): signals/grades.ts,
// bot/tiers.ts, bot/crowd.ts, and how visitors' bots use them
// (bot/paperAccounts.ts).
import { describe, expect, test } from 'bun:test'
import type { AccessView, SignalFeatures, SignalQuality } from '../../api/_marketProtocol'
import { CROWD, CrowdBook, crowdCap, crowdImpact, laddered } from '../src/bot/crowd'
import { toParams, defaultTuning } from '../src/bot/learner'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import { Tiers, TIERS } from '../src/bot/tiers'
import { GRADE_REVIEW, GradeBook, gradeOf, isEarlyCrowd } from '../src/signals/grades'
import { exitsAt, openPosition, STRATEGIES } from '../src/trading/paper'
import type { Rpc } from '../src/chain/http'

const now = Date.UTC(2026, 8, 30, 12)
const T = (n: number) => '0x' + n.toString(16).padStart(40, '0')

/** A Prime signal's numbers (FLOW, 2026-09-30: 44 buyers, the largest 8.4%, buys 8.3× sells, +7%, a 2% round trip). */
const PRIME: SignalFeatures = { ageSec: 38, liquidityUsd: 10_307, marketCapUsd: 20_000, buyers: 44, buySellRatio: 8.3, runUp: 1.07, topBuyerPct: 8.4, score: 60, flags: ['holders', 'serial'], roundTripPct: 2 }

describe('signal grades', () => {
  test('Prime: the market\'s own buying, spread wide and early, cheap to trade', () => {
    const g = gradeOf(PRIME, 'snipe')
    expect(g.grade).toBe('prime')
    expect(g.why.join(' · ')).toMatch(/largest buyer 8%/)
  })
  test('a risk flag doesn\'t stop a Prime grade (every Prime signal in the replays had one)', () => {
    expect(gradeOf({ ...PRIME, flags: ['holders', 'serial', 'copycat'] }, 'snipe').grade).toBe('prime')
  })
  test('early crowd: the serial launches with 22-27 buyers and the largest at 13-19% are Prime now (8 of 8 on unseen coins)', () => {
    const agi: SignalFeatures = { ...PRIME, ageSec: 30, buyers: 25, topBuyerPct: 16.2, buySellRatio: 9.9, runUp: 1.042, liquidityUsd: 10_167, roundTripPct: 1.99 }
    expect(gradeOf(agi, 'snipe').grade).toBe('prime')
    expect(gradeOf({ ...agi, ageSec: 300 }, 'snipe').grade).not.toBe('prime') // the late crowd was taken out (DEGEN, -94%)
    expect(gradeOf({ ...agi, ageSec: 300, runUp: 1.3 }, 'snipe').grade).not.toBe('prime') // already up 30%
    expect(gradeOf({ ...agi, ageSec: 700 }, 'snipe').grade).not.toBe('prime') // past the snipe window
    const g = gradeOf({ ...agi, topBuyerPct: 25 }, 'snipe')
    expect(g.grade).not.toBe('prime')
    expect(g.why).toContain('Prime needs largest buyer 25% (≤ 20%)')
  })
  test('crowd momentum: 12+ buyers in two minutes, no wallet over 20% since launch, not an early-crowd coin', () => {
    const burst: SignalFeatures = { ...PRIME, ageSec: 900, buyers: 15, buySellRatio: 3, runUp: 1.08, topBuyerPct: 30, launchTopBuyerPct: 12, earlyCrowd: false, liquidityUsd: 20_000 }
    expect(gradeOf(burst, 'momentum').grade).toBe('prime')
    expect(gradeOf({ ...burst, earlyCrowd: true }, 'momentum').grade).not.toBe('prime')
    expect(gradeOf({ ...burst, launchTopBuyerPct: 25 }, 'momentum').grade).not.toBe('prime')
    expect(gradeOf({ ...burst, runUp: 1.2 }, 'momentum').grade).not.toBe('prime')
    expect(gradeOf({ ...burst, launchTopBuyerPct: undefined }, 'momentum').grade).not.toBe('prime') // not measured: not Prime
    expect(gradeOf(burst).grade).not.toBe('prime') // a rule it doesn't belong to
  })
  test('the engine marks early crowds as it watches a coin', () => {
    expect(isEarlyCrowd({ buyers: 10, topBuyerPct: 20, buySellRatio: 2, runUp: 1.2 }, 25)).toBe(true)
    expect(isEarlyCrowd({ buyers: 9, topBuyerPct: 20, buySellRatio: 2, runUp: 1.2 }, 25)).toBe(false)
    expect(isEarlyCrowd({ buyers: 10, topBuyerPct: 20, buySellRatio: 2, runUp: 1.2 }, 15)).toBe(false) // too early to judge
    expect(isEarlyCrowd({ buyers: 10, topBuyerPct: 20, buySellRatio: 2, runUp: 1.2 }, 80)).toBe(false)
  })
  test('already up 30%, or few buyers: Standard', () => {
    expect(gradeOf({ ...PRIME, runUp: 1.3 }).grade).toBe('standard')
    expect(gradeOf({ ...PRIME, buyers: 9, topBuyerPct: 16.7 }).grade).toBe('standard')
    expect(gradeOf(undefined).grade).toBe('standard')
  })
  test('no sells yet counts as buying well ahead', () => {
    expect(gradeOf({ ...PRIME, buySellRatio: null }, 'snipe').grade).toBe('prime')
  })
  test('a grade whose replays fail is under review: its signals go out one grade lower until it recovers', () => {
    const book = new GradeBook()
    for (let i = 0; i < GRADE_REVIEW.minTrades; i++) book.add(`p${i}`, 'prime', now - i * 60_000, i < 4 ? 0.03 : -0.05)
    expect(book.record('prime', now)).toMatchObject({ trades: 10, wins: 4 })
    expect(book.record('prime', now).review).toMatch(/Prime signals won 4 of their last 10/)
    expect(book.effective('prime', now).grade).toBe('core')
    for (let i = 0; i < 10; i++) book.add(`q${i}`, 'prime', now + i, 0.03)
    expect(book.record('prime', now + 100).review).toBeNull() // the last 20: 14 of 20 won, a profit
    expect(book.effective('prime', now + 100).grade).toBe('prime')
    book.skip('x')
    expect(book.has('x')).toBe(true)
  })
})

describe('Precision: Prime signals, all of it sold at +10%', () => {
  test('the strategy and a bot\'s tuning of it', () => {
    expect(STRATEGIES.precision).toMatchObject({ tp1Multiple: 1.1, tp1SellPct: 1, stopLoss: 0.9, maxHoldMin: 10, exitOnCreatorSell: true })
    expect(toParams(defaultTuning('precision'), 10, 'precision')).toMatchObject({ tp1Multiple: 1.1, tp1SellPct: 1, stopLoss: 0.9, maxHoldMin: 10 })
    expect(toParams(defaultTuning('precision'), 10, 'precision').timeStopMinGain).toBeCloseTo(1.0333, 3)
    expect(toParams(defaultTuning('precision'), 10, 'precision').breakevenAfterTp1).toBeUndefined()
  })
  test('sells everything at +10% and closes', () => {
    const p = openPosition({ id: 'p', strategy: 'precision', token: T(1), symbol: 'C', launchpad: 'ARGUS', signalId: 's', price: 1, cost: 0.01, now })
    expect(exitsAt(p, 1.099, now + 1_000)).toEqual([])
    expect(exitsAt(p, 1.101, now + 2_000)).toEqual([{ qty: p.qty, reason: 'tp1' }])
    expect(exitsAt(p, 0.899, now + 3_000)).toEqual([{ qty: p.qty, reason: 'stop' }])
    expect(exitsAt(p, 1.01, now + 3 * 60_000 + 1)).toEqual([{ qty: p.qty, reason: 'time' }]) // not up 2% after 3 minutes
  })
})

describe('tiers', () => {
  const rpc = (balances: Record<string, bigint>): Rpc => ({
    call: async <R>(_m: string, params: unknown[]) => {
      const data = (params[0] as { data: string }).data
      const who = '0x' + data.slice(-40)
      return ('0x' + (balances[who] ?? 0n).toString(16)) as R
    },
    batch: async () => [],
  })
  const E18 = 10n ** 18n
  const W1 = '0x' + '1a'.repeat(20), W2 = '0x' + '2b'.repeat(20)

  test('the table: what each tier holds and gets', () => {
    expect(TIERS.map(t => [t.id, t.minArcd, t.grades.join('+'), t.live, t.maxBots, t.profitFeePct])).toEqual([
      ['free', 0, 'standard', false, 1, 15],
      ['t1', 5_000_000, 'standard', true, 3, 15],
      ['t2', 20_000_000, 'core+standard', true, 5, 15],
      ['t3', 50_000_000, 'prime+core+standard', true, 5, 7.5],
    ])
    expect(Tiers.tierFor('prime').id).toBe('t3')
    expect(Tiers.tierForStrategy('precision').id).toBe('t3')
  })
  test('until tiers are enforced, everyone gets everything, at the standard fee, no one ahead', async () => {
    const tiers = new Tiers({ enforced: false, rpc: rpc({ [W1]: 6_000_000n * E18 }) })
    await tiers.read(W1)
    const a = tiers.access({ wallets: [{ address: W1, at: now }] }, now)
    expect(a).toMatchObject({ enforced: false, entitled: 't1', via: 'arcd', arcdHeld: 6_000_000, grades: ['prime', 'core', 'standard'], live: true, maxBots: 5, profitFeePct: 15, priority: 0 })
    expect(a.strategies).toContain('precision')
    expect(a.next).toEqual({ tier: 't2', needArcd: 14_000_000 })
  })
  test('enforced: $ARCD across linked wallets sets the tier', async () => {
    const tiers = new Tiers({ enforced: true, rpc: rpc({ [W1]: 30_000_000n * E18, [W2]: 25_000_000n * E18 }) })
    await tiers.read(W1); await tiers.read(W2)
    const both = tiers.access({ wallets: [{ address: W1, at: now }, { address: W2, at: now }] }, now)
    expect(both).toMatchObject({ entitled: 't3', grades: ['prime', 'core', 'standard'], profitFeePct: 7.5, priority: 3, next: null })
    const one = tiers.access({ wallets: [{ address: W1, at: now }] }, now)
    expect(one).toMatchObject({ entitled: 't2', grades: ['core', 'standard'], priority: 2, live: true })
    expect(one.strategies).not.toContain('precision')
    expect(tiers.access(null, now)).toMatchObject({ entitled: 'free', via: 'none', live: false, maxBots: 1, grades: ['standard'] })
  })
  test('enforced: the owner\'s grant counts until it ends, when it beats the $ARCD', () => {
    const tiers = new Tiers({ enforced: true, rpc: null })
    const u = { wallets: [], grant: { tier: 't3' as const, until: now + 86_400_000 } }
    expect(tiers.access(u, now)).toMatchObject({ entitled: 't3', via: 'grant', grant: u.grant })
    expect(tiers.access(u, now + 2 * 86_400_000)).toMatchObject({ entitled: 'free', grant: null })
  })
})

describe('the crowd: many bots, one signal', () => {
  test('the cap: a quarter of the take-profit in price impact, 2% of the pool at most, half when the creator holds a lot', () => {
    expect(crowdCap({ liquidityUsd: 10_000, takeProfit: 1.06 })).toBe(75) // 0.25 × 6% × $5,000
    expect(crowdCap({ liquidityUsd: 10_000, takeProfit: 1.1 })).toBe(125)
    expect(crowdCap({ liquidityUsd: 10_000, takeProfit: 1.5 })).toBe(200) // 2% of the pool
    expect(crowdCap({ liquidityUsd: 10_000, takeProfit: 1.06, flags: ['holders'] })).toBe(37.5)
    expect(crowdCap({ liquidityUsd: null, takeProfit: 1.1 })).toBe(CROWD.unknownPoolUsd)
    expect(crowdImpact(75, 10_000)).toBeCloseTo(0.015, 9) // the last one in pays 1.5% more
  })
  test('seats: higher tiers first, then whoever waited longest; a bot left out is ahead next time', () => {
    const book = new CrowdBook()
    const want = (ids: string[], priority = 0) => ids.map(id => ({ id, priority, wantUsd: 10 }))
    const r1 = book.allocate('s1', [...want(['a', 'b', 'c', 'd']), ...want(['vip'], 3)], 30, now)
    expect(r1.seats.map(s => s.id)[0]).toBe('vip') // Tier 3 first
    expect(r1.seats).toHaveLength(3)
    expect(r1.usedUsd).toBe(30)
    const left = r1.left.map(l => l.id)
    expect(left).toHaveLength(2)
    expect(r1.left[0].why).toMatch(/bots already bought \$30\.00 of this coin, its cap \(\$30\.00/)
    // Next signal, same bots and tiers equal: the two left out go first.
    const r2 = book.allocate('s2', want(['a', 'b', 'c', 'd', 'vip']), 20, now + 1_000)
    expect(r2.seats.map(s => s.id).sort()).toEqual([...left].sort())
  })
  test('a last seat smaller than the bot wanted, if at least $1; at most 25 bots', () => {
    const book = new CrowdBook()
    const r = book.allocate('s1', [{ id: 'a', priority: 0, wantUsd: 10 }, { id: 'b', priority: 0, wantUsd: 10 }], 14.5, now)
    expect(r.seats.map(s => s.sizeUsd).sort((x, y) => x - y)).toEqual([4.5, 10])
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, priority: 0, wantUsd: 1 }))
    expect(book.allocate('s2', many, 1_000, now).seats).toHaveLength(CROWD.maxBots)
  })
  test('the platform\'s bot gets what is left', () => {
    const book = new CrowdBook()
    book.allocate('s1', [{ id: 'a', priority: 0, wantUsd: 20 }], 30, now)
    expect(book.leftover('s1', 30)).toBe(10)
    book.take('s1', 30, 10, now)
    expect(book.leftover('s1', 30)).toBe(0)
    expect(book.leftover('other', 30)).toBe(30)
  })
  test('the take-profit ladder: each seat a notch higher, 1.5% at most', () => {
    expect(laddered(1.06, 0)).toBe(1.06)
    expect(laddered(1.06, 1)).toBeCloseTo(1.06 * 1.0025, 4)
    expect(laddered(1.06, 40)).toBeCloseTo(1.06 * 1.015, 4)
  })
})

describe('visitors\' bots with grades, Precision and tiers', () => {
  const quality = (level: 'prime' | 'core' | 'standard'): SignalQuality => ({ score: 80, grade: 'live', tier: 'A', rank: null, parts: [], level })
  const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T(1), symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000, features: PRIME, rule: 'snipe', ...o })
  const setup = (access?: (owner: string | null) => AccessView) => {
    const accts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], access })
    const make = (name: string, strategies: ('snipe' | 'scalp' | 'second-leg' | 'precision')[], owner: string | null = 'u1') => {
      const a = (accts.create(now, { name, strategies }, owner) as { account: PaperAccount }).account
      accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
      return a
    }
    return { accts, make }
  }
  const enforced = (tier: 'free' | 't1' | 't2' | 't3') => {
    const tiers = new Tiers({ enforced: true, rpc: null })
    return () => tiers.access({ wallets: [], grant: tier === 'free' ? null : { tier, until: now + 86_400_000 * 30 } }, now)
  }

  test('a bot following Precision trades a Prime signal with it: all of it at +10%', () => {
    const { accts, make } = setup()
    const a = make('Sharp', ['precision', 'snipe'])
    accts.onSignal(sig({ quality: quality('prime') }), now)
    expect(a.positions[0]).toMatchObject({ strategy: 'precision', grade: 'prime', sizeUsd: 20 })
    expect(a.positions[0].exits).toMatchObject({ tp1Multiple: 1.1, tp1SellPct: 1 })
    expect(a.events[0].text).toMatch(/precision; 20% of its \$100\.00, a Prime signal.*sells all of it at \+10%/)
    // A Core signal goes to its snipe strategy.
    accts.onSignal(sig({ id: 's2', token: T(2), quality: quality('core') }), now)
    expect(a.positions[1]).toMatchObject({ strategy: 'snipe', grade: 'core' })
  })
  test('a Precision-only bot passes over other grades, and says so', () => {
    const { accts, make } = setup()
    const a = make('Only Prime', ['precision'])
    accts.onSignal(sig({ quality: quality('standard') }), now)
    expect(a.positions).toHaveLength(0)
    expect(a.skips[0].text).toMatch(/Precision takes Prime signals only \(this one is Standard\)/)
  })
  test('free for now: every grade and strategy for everyone (tiers not enforced)', () => {
    const { accts, make } = setup()
    const a = make('Anyone', ['precision'], null)
    accts.onSignal(sig({ quality: quality('prime') }), now)
    expect(a.positions).toHaveLength(1)
  })
  test('enforced: a lower tier passes over a grade above it, and is told which tier gets it', () => {
    const { accts, make } = setup(enforced('t1'))
    const a = make('Tier One', ['snipe'])
    accts.onSignal(sig({ quality: quality('core') }), now)
    expect(a.positions).toHaveLength(0)
    expect(a.skips[0].text).toMatch(/Core signals are for Tier 2 and up/)
    accts.onSignal(sig({ id: 's2', token: T(2), quality: quality('standard') }), now)
    expect(a.positions).toHaveLength(1)
  })
  test('enforced: Precision, and the number of bots, follow the tier', () => {
    const { accts } = setup(enforced('t2'))
    expect(accts.create(now, { name: 'Sharp', strategies: ['precision'] }, 'u1')).toEqual({ error: 'precision is for Tier 3' })
    const free = setup(enforced('free'))
    expect('account' in free.accts.create(now, { name: 'One', strategies: ['scalp'] }, 'u1')!).toBe(true)
    expect(free.accts.create(now, { name: 'Two', strategies: ['scalp'] }, 'u1')).toEqual({ error: 'your tier has 1 bot: hold more $ARCD for more' })
  })
  test('enforced: a Free account cannot switch a bot to live or add Precision', async () => {
    const { accts, make } = setup(enforced('free'))
    const a = make('Freebie', ['snipe'])
    expect(await accts.setMode(a, 'live', { verified: true }, now)).toMatch(/live trading is for Tier 1 and up/)
    expect(accts.act(a, { action: 'strategies', strategies: ['snipe', 'precision'] }, now)).toBe('precision is for Tier 3')
    a.mode = 'live' // switched before tiers were enforced
    accts.onSignal(sig({ quality: quality('standard') }), now)
    expect(a.skips[0].text).toMatch(/not traded live: live trading is for Tier 1 and up/)
  })
  test('enforced: Tier 3 pays half the profit fee', () => {
    const { accts, make } = setup(enforced('t3'))
    const a = make('Top', ['precision'])
    const prices = new Map<string, number>()
    ;(accts as unknown as { o: { priceOf: (t: string) => number } }).o.priceOf = t => prices.get(t) ?? 1
    accts.onSignal(sig({ quality: quality('prime') }), now)
    const p = a.positions[0]
    accts.onPrice(p.token, 1.1, now + 1_000, false, true)
    expect(p.status).toBe('closed')
    const gross = (p.pnlUsd ?? 0) + (p.feeUsd ?? 0)
    expect(p.feeUsd).toBeCloseTo(gross * 0.075, 4)
  })
  test('a paper fill pays the live crowd\'s price impact on top of its own', () => {
    const { accts, make } = setup()
    const a = make('Late', ['snipe'])
    accts.crowd.allocate('s1', [{ id: 'x', priority: 0, wantUsd: 500 }], 500, now) // live bots already bought $500 of it
    accts.onSignal(sig({ liquidityUsd: 10_000, quality: quality('standard') }), now)
    const p = a.positions[0]
    expect(p.cost).toBeCloseTo(0.01 + 10 / 5_000 + 500 / 5_000, 6) // its own costs, and the crowd's 10%
    expect(p.crowd).toMatchObject({ usd: 500 })
  })
})

describe('the owner\'s grants and linked wallets', () => {
  test('a grant-tier control is parsed and checked', async () => {
    const { parseControl } = await import('../src/bot/control')
    const sig = '0x' + 'ab'.repeat(65)
    expect(parseControl({ action: 'grant-tier', email: ' A@B.co ', tier: 't3', days: 30, at: now, signature: sig })).toMatchObject({ control: { action: 'grant-tier', email: 'a@b.co', tier: 't3', days: 30 } })
    expect(parseControl({ action: 'grant-tier', email: 'a@b.co', tier: 't9', days: 30, at: now, signature: sig })).toBe('unknown tier')
    expect(parseControl({ action: 'grant-tier', email: 'a@b.co', tier: 't1', days: -1, at: now, signature: sig })).toMatch(/whole number/)
  })
  test('users: a grant for some days, taken back with 0; a wallet links to one account only', async () => {
    const { Users } = await import('../src/bot/users')
    const { NoMailer } = await import('../src/bot/mailer')
    const store = new MemoryBotStore()
    const users = new Users({ store, mailer: new NoMailer(), secret: 'ab'.repeat(16) })
    const a = await users.signup('one@example.test', 'Ab12', '127.0.0.1', now)
    const b = await users.signup('two@example.test', 'Cd34', '127.0.0.2', now)
    if ('error' in a || 'error' in b) throw new Error('signup failed')
    const g = users.grantTier('ONE@example.test', 't2', 30, now)
    expect(typeof g === 'string' ? g : g.grant).toEqual({ tier: 't2', until: now + 30 * 86_400_000 })
    expect(users.grantTier('nobody@example.test', 't2', 30, now)).toBe('no account has that email')
    expect((users.grantTier('one@example.test', 't2', 0, now) as { grant: unknown }).grant).toBeNull()
    const W = '0x' + '1a'.repeat(20)
    expect(users.linkWallet(a.user, W.toUpperCase().replace('0X', '0x'), now)).toBeNull()
    expect(users.linkWallet(b.user, W, now)).toMatch(/linked to another account/)
    expect(users.linkedWallets()).toEqual([W])
    users.unlinkWallet(a.user, W)
    expect(users.linkWallet(b.user, W, now)).toBeNull()
  })
})

describe('free live trading until the deadline, then tiers (owner, 2026-09-30)', () => {
  const at = Date.parse('2026-10-03T00:00:00Z')
  test('before 3 October 00:00 UTC everyone trades live without $ARCD; from then, tiers', () => {
    const tiers = new Tiers({ enforced: false, rpc: null, enforceAt: at })
    expect(tiers.access(null, at - 1)).toMatchObject({ enforced: false, enforceAt: at, live: true, grades: ['prime', 'core', 'standard'], entitled: 'free' })
    expect(tiers.access(null, at)).toMatchObject({ enforced: true, live: false, grades: ['standard'], maxBots: 1 })
    expect(new Tiers({ enforced: true, rpc: null, enforceAt: at }).enforceAt).toBeNull() // already on
  })
  test('off until further notice since 2026-10-03: no deadline by default; TIERS_ENFORCE_AT or TIERS_ENFORCED still start them', async () => {
    const { loadConfig } = await import('../src/config')
    const saved = { at: process.env.TIERS_ENFORCE_AT, on: process.env.TIERS_ENFORCED }
    try {
      delete process.env.TIERS_ENFORCE_AT; delete process.env.TIERS_ENFORCED
      const c = loadConfig()
      expect(c.tiersEnforceAt).toBeNull()
      expect(c.tiersEnforced).toBe(false)
      const tiers = new Tiers({ enforced: c.tiersEnforced, rpc: null, enforceAt: c.tiersEnforceAt })
      expect(tiers.access(null, at + 365 * 86_400_000)).toMatchObject({ enforced: false, enforceAt: null, live: true, grades: ['prime', 'core', 'standard'], maxBots: 5 })
      process.env.TIERS_ENFORCE_AT = '2026-12-01T00:00:00Z'
      expect(loadConfig().tiersEnforceAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
      process.env.TIERS_ENFORCE_AT = 'never'
      expect(loadConfig().tiersEnforceAt).toBeNull()
    } finally {
      if (saved.at === undefined) delete process.env.TIERS_ENFORCE_AT; else process.env.TIERS_ENFORCE_AT = saved.at
      if (saved.on === undefined) delete process.env.TIERS_ENFORCED; else process.env.TIERS_ENFORCED = saved.on
    }
  })
})

describe('which grades live bots trade', () => {
  test('Prime, unless under review; another grade once proven at live speed', async () => {
    const { liveGrade } = await import('../src/signals/grades')
    const book = new GradeBook()
    expect(liveGrade(book, 'prime', now)).toEqual({ ok: true, why: null })
    for (let i = 0; i < 12; i++) book.add(`s${i}`, 'standard', now - i * 60_000, i === 0 ? 0.1 : -0.15)
    const std = liveGrade(book, 'standard', now)
    expect(std.ok).toBe(false)
    expect(std.why).toMatch(/Standard signals won 1 of their last 12 at live speed \(-12\.9% a trade\)/)
    for (let i = 0; i < 20; i++) book.add(`g${i}`, 'core', now - i * 60_000, i % 4 ? 0.04 : -0.02)
    expect(liveGrade(book, 'core', now).ok).toBe(true) // 15 of 20 won, a profit
    for (let i = 0; i < 10; i++) book.add(`p${i}`, 'prime', now - i * 60_000, -0.05)
    expect(liveGrade(book, 'prime', now).ok).toBe(false) // under review
  })
  test('Core too since 2026-10-01 (regular trades), with no record yet; under review it is handed out as Standard and live bots stop', async () => {
    const { liveGrade } = await import('../src/signals/grades')
    const book = new GradeBook()
    expect(liveGrade(book, 'core', now)).toEqual({ ok: true, why: null })
    for (let i = 0; i < 10; i++) book.add(`c${i}`, 'core', now - i * 60_000, i < 4 ? 0.04 : -0.07)
    expect(book.effective('core', now).grade).toBe('standard') // 4 of 10 won: under review
    expect(liveGrade(book, 'core', now).ok).toBe(false)
    expect(liveGrade(book, 'standard', now).why).toMatch(/live bots trade Prime and Core signals, and Standard once proven/)
  })
})
