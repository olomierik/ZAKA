// Why signals were produced but bots didn't trade them (owner, 2026-09-30),
// and the fixes: every strategy has a longest hold (open snipes and second
// legs used to fill every slot for good); a trade that can't net its target
// in a thin pool is sized for $1, the low end of its range, instead of
// skipped; and every signal a bot passes over says why, counted for
// GET /v1/bot/rejections.
import { describe, expect, test } from 'bun:test'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { OutcomeTally } from '../src/bot/scanFeed'
import { netAtTakeProfit, sizeForTarget, sizeForTrade, sizeFromCapital, TARGETS } from '../src/bot/sizing'
import { MemoryBotStore } from '../src/bot/store'
import { canOpen, exitsAt, openPosition, RISK, STRATEGIES } from '../src/trading/paper'

const now = Date.UTC(2026, 8, 30, 12)
const T = (n: number) => '0x' + n.toString(16).padStart(40, '0')

describe('the engine\'s own book: no position stays open for good', () => {
  const open = (s: 'snipe' | 'second-leg', i = 0) => openPosition({ id: `p${i}`, strategy: s, token: T(i), symbol: 'C', launchpad: 'Argus', signalId: 's', price: 1, cost: 0.02, now })
  test('a snipe up 5% whose coin stopped trading closes at its longest hold (an hour)', () => {
    const p = open('snipe')
    expect(exitsAt(p, 1.05, now + 59 * 60_000, STRATEGIES.snipe)).toEqual([])
    expect(exitsAt(p, 1.05, now + 60 * 60_000, STRATEGIES.snipe)).toEqual([{ qty: p.remaining, reason: 'time' }])
  })
  test('a second leg up 30%: at 12 hours', () => {
    const p = open('second-leg')
    expect(exitsAt(p, 1.3, now + 719 * 60_000, STRATEGIES['second-leg'])).toEqual([])
    expect(exitsAt(p, 1.3, now + 720 * 60_000, STRATEGIES['second-leg'])[0]?.reason).toBe('time')
  })
  test('the rule that stops a new position is named, for the counts', () => {
    const five = [0, 1, 2, 3, 4].map(i => open('snipe', i))
    expect(canOpen(five, T(9), now, RISK, 'scalp')).toMatchObject({ ok: false, key: 'max-open' })
    expect(canOpen([open('snipe', 1)], T(1), now, RISK, 'snipe')).toMatchObject({ ok: false, key: 'cooldown' })
  })
})

describe('sizing: a thin pool gets the size for $1, not a skip', () => {
  const scalp = { strategy: 'scalp' as const, targetUsd: TARGETS.scalp.target, takeProfit: 1.15, roundTripPct: 4 }
  test('where the $1.50 target is reachable, nothing changes', () => {
    const s = sizeForTrade({ ...scalp, liquidityUsd: 20_000 })!
    expect(s).toMatchObject({ targetUsd: 1.5, sizeUsd: sizeForTarget({ ...scalp, liquidityUsd: 20_000 })!.sizeUsd })
  })
  test('a $2,000 pool (the momentum rule\'s minimum) at a 4% round trip: the target can\'t be netted, $1 can', () => {
    expect(sizeForTarget({ ...scalp, liquidityUsd: 2_000 })).toBeNull() // what bots did: skip
    const s = sizeForTrade({ ...scalp, liquidityUsd: 2_000 })!
    expect(s.targetUsd).toBe(1)
    expect(s.profitUsd).toBeGreaterThanOrEqual(1)
  })
  test('a coin too costly to net even $1 is still skipped', () => {
    expect(sizeForTrade({ ...scalp, roundTripPct: 14, liquidityUsd: 50_000 })).toBeNull()
  })
})

describe('every signal a bot passes over says why, and is counted', () => {
  const setup = () => {
    const accts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    const make = (name: string, strategies: ('snipe' | 'scalp' | 'second-leg')[]) => (accts.create(now, { name, strategies }) as { account: PaperAccount }).account
    return { accts, make }
  }
  const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T(1), symbol: 'C', launchpad: 'Argus', price: 1, strategy: 'scalp', roundTripPct: 4, liquidityUsd: 2_000, ...o })

  test('a thin-pool scalp is bought, at the bot\'s share (the pool caps it at 1.5% of its liquidity)', () => {
    const { accts, make } = setup()
    const a = make('Thin Pool', ['scalp'])
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    accts.onSignal(sig(), now)
    expect(a.positions).toHaveLength(1)
    expect(a.positions[0].sizeUsd).toBe(10) // 10% of $100 (a Standard signal); the $2,000 pool would take up to $30
    expect(a.positions[0].targetUsd).toBeGreaterThan(0)
    const big = make('Big Bot', ['scalp'])
    accts.act(big, { action: 'deposit', amount: 10_000 }, now); accts.act(big, { action: 'start' }, now)
    accts.onSignal(sig({ id: 's9', token: T(9) }), now)
    // Not $2,000: 1.5% of the pool is $30, and at +10% a $30 trade's price impact in a $2,000 pool eats the
    // take-profit, so it comes down to the most that still nets something.
    const size = big.positions[0].sizeUsd
    expect(size).toBeLessThan(30)
    expect(size).toBeGreaterThan(20)
    expect(netAtTakeProfit(size, 1.1, 4, 2_000)).toBeGreaterThan(0)
    expect(netAtTakeProfit(size + 0.1, 1.1, 4, 2_000)).toBeLessThanOrEqual(0)
  })
  test('sized from capital: a size whose costs eat the take-profit comes down to one that nets something, else it\'s skipped', () => {
    const s = sizeFromCapital({ capitalUsd: 10_000, tier: 'A', takeProfit: 1.1, roundTripPct: 4, liquidityUsd: 2_000 })
    expect('sizeUsd' in s && s.sizeUsd < 30 && s.profitUsd >= 0).toBe(true)
    expect(sizeFromCapital({ capitalUsd: 100, tier: 'A', takeProfit: 1.1, roundTripPct: 20, liquidityUsd: 50_000 })).toMatchObject({ key: 'costly' })
  })
  test('a funded bot that isn\'t started, and one that doesn\'t follow the strategy, say so', () => {
    const { accts, make } = setup()
    const stopped = make('Stopped', ['scalp'])
    accts.act(stopped, { action: 'deposit', amount: 100 }, now)
    const snipesOnly = make('Snipes Only', ['snipe'])
    accts.act(snipesOnly, { action: 'deposit', amount: 100 }, now); accts.act(snipesOnly, { action: 'start' }, now)
    const abandoned = make('Never Funded', ['scalp'])
    accts.onSignal(sig(), now)
    expect(stopped.skips[0].text).toBe('fast scalp: not traded: the bot is stopped (press Start)')
    expect(snipesOnly.skips[0].text).toBe('fast scalp: not traded: this bot follows snipe')
    expect(abandoned.skips).toEqual([])
    expect(accts.outcomes.summary(now)).toEqual({ signals: 1, traded: 0, reasons: [
      { key: 'not-running', label: 'bot funded but not started (press Start)', count: 1 },
      { key: 'strategy', label: 'bot doesn\'t follow that strategy', count: 1 },
    ] })
  })
  test('the counts: traded by at least one bot, and each bot\'s reason', () => {
    const { accts, make } = setup()
    const rich = make('Rich', ['scalp']), poor = make('Poor', ['scalp'])
    accts.act(rich, { action: 'deposit', amount: 100 }, now); accts.act(rich, { action: 'start' }, now)
    accts.act(poor, { action: 'deposit', amount: 4 }, now); accts.act(poor, { action: 'start' }, now)
    accts.onSignal(sig(), now)
    accts.onSignal(sig({ id: 's2' }), now + 1_000) // the same coin again: the rich bot's cooldown; the poor bot is too small either time
    const o = accts.outcomes.summary(now + 1_000)
    expect(o).toMatchObject({ signals: 2, traded: 1 })
    expect(Object.fromEntries(o.reasons.map(r => [r.key, r.count]))).toEqual({ 'small-balance': 2, cooldown: 1 })
    expect(poor.skips[0].text).toMatch(/^fast scalp: the bot is worth \$4\.00: even 20% of it is under the \$1 minimum trade/)
  })
  test('the counts cover the last 24 hours', () => {
    const t = new OutcomeTally()
    t.add('a', 'cash', now)
    t.add('b', 'traded', now + 3_600_000)
    expect(t.summary(now + 3_600_000)).toMatchObject({ signals: 2, traded: 1 })
    expect(t.summary(now + 26 * 3_600_000)).toEqual({ signals: 0, traded: 0, reasons: [] })
  })
})
