// What each launcher did with its last coins (2026-10-02): an early dump (the creator's first sale, 80%+ of its first
// buy, within 5 minutes of the launch) counts against the launcher; live bots skip a snipe whose launcher's rate over
// its last 10 coins, (dumps + 1) / (coins + 4), is over 25%.
import { describe, expect, test } from 'bun:test'
import { CREATOR_MEMORY, CreatorMemory, launcherRate } from '../src/bot/creatorMemory'
import { planBlocks } from '../src/bot/dollarPlan'
import type { SignalFeatures } from '../../api/_marketProtocol'

const L = 1_790_000_000_000
const C = '0xAbC0000000000000000000000000000000000001'
const f = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ ageSec: 30, liquidityUsd: 10_000, marketCapUsd: 10_000, buyers: 20, buySellRatio: 5, runUp: 1.05, topBuyerPct: 10, score: 80, flags: [], roundTripPct: 2, ...o })

describe('the launcher memory', () => {
  test('an early dump: the creator\'s first sale, 80%+ of its first buy, within 5 minutes', () => {
    const m = new CreatorMemory()
    expect(m.noteSale({ creator: C, token: 't1', launchedAt: L, at: L + 30_000, saleUsd: 2_510, buyUsd: 2_500 })).toBe(true)
    expect(m.record(C.toLowerCase(), L + 60_000)).toEqual({ coins: 1, dumps: 1 })
    // Only the first sale is judged: a small first sale, then the rest, isn't an early dump.
    expect(m.noteSale({ creator: C, token: 't2', launchedAt: L, at: L + 60_000, saleUsd: 300, buyUsd: 2_500 })).toBe(false)
    expect(m.noteSale({ creator: C, token: 't2', launchedAt: L, at: L + 70_000, saleUsd: 2_400, buyUsd: 2_500 })).toBe(false)
    // After 5 minutes it's not early; and with no launch buy seen it isn't judged at all.
    expect(m.noteSale({ creator: C, token: 't3', launchedAt: L, at: L + 301_000, saleUsd: 2_500, buyUsd: 2_500 })).toBe(false)
    expect(m.noteSale({ creator: C, token: 't4', launchedAt: L, at: L + 30_000, saleUsd: 2_500, buyUsd: null })).toBe(false)
    expect(m.record(C, L + 600_000)).toEqual({ coins: 1, dumps: 1 })
  })
  test('a clean coin: 5 minutes, 40+ trades and the launch buy seen, with no early dump', () => {
    const m = new CreatorMemory()
    const s = (token: string, o: Partial<{ now: number; trades: number; creatorBought: boolean }> = {}) => m.settle({ creator: C, token, launchedAt: L, now: L + 300_000, trades: 40, creatorBought: true, ...o })
    expect(s('a', { now: L + 299_000 })).toBe(false) // too young
    expect(s('a', { trades: 39 })).toBe(false) // never really traded
    expect(s('a', { creatorBought: false })).toBe(false) // launch not seen (a tape seeded after a restart)
    expect(s('a')).toBe(true)
    expect(s('a')).toBe(false) // once
    m.noteSale({ creator: C, token: 'b', launchedAt: L, at: L + 20_000, saleUsd: 2_500, buyUsd: 2_500 })
    expect(s('b')).toBe(false) // already a dump
    expect(m.record(C, L + 400_000)).toEqual({ coins: 2, dumps: 1 })
  })
  test('the rate: a new launcher passes, one dump keeps it out, three clean coins bring it back; the last 10 coins', () => {
    expect(launcherRate(0, 0)).toBe(0.25)
    expect(launcherRate(1, 1)).toBeCloseTo(0.4, 6)
    expect(launcherRate(1, 4)).toBe(0.25)
    expect(launcherRate(3, 10)).toBeGreaterThan(CREATOR_MEMORY.maxRate)
    const m = new CreatorMemory()
    for (let i = 0; i < 12; i++) m.settle({ creator: C, token: `c${i}`, launchedAt: L + i, now: L + 400_000, trades: 50, creatorBought: true })
    expect(m.record(C, L + 400_000)).toEqual({ coins: 10, dumps: 0 })
  })
  test('saved and loaded (the settings\' creator-memory); a bad save starts empty', () => {
    const m = new CreatorMemory()
    m.noteSale({ creator: C, token: 'x', launchedAt: L, at: L + 30_000, saleUsd: 2_500, buyUsd: 2_500 })
    const back = new CreatorMemory()
    back.load(JSON.stringify(m))
    expect(back.record(C, L + 60_000)).toEqual({ coins: 1, dumps: 1 })
    // The coin is decided: its later sales aren't judged again.
    expect(back.noteSale({ creator: C, token: 'x', launchedAt: L, at: L + 40_000, saleUsd: 2_500, buyUsd: 2_500 })).toBe(false)
    const bad = new CreatorMemory()
    bad.load('{nope')
    expect(bad.size).toBe(0)
  })
})

describe('live bots skip a snipe whose launcher dumps early (a plan limit)', () => {
  test('over 25%: skipped with why; a new launcher, other kinds of signal, and older signals aren\'t', () => {
    expect(planBlocks(f({ launcherCoins: 1, launcherDumps: 1 }), 'snipe')).toMatchObject({ key: 'dumper', why: expect.stringMatching(/^its launcher dumped 1 of its last 1 coin within 5 minutes/) })
    expect(planBlocks(f({ launcherCoins: 7, launcherDumps: 5 }), 'snipe')?.label).toBe('its launcher dumped 5 of its last 7 coins within 5 minutes')
    expect(planBlocks(f({ launcherCoins: 0, launcherDumps: 0 }), 'snipe')).toBeNull()
    expect(planBlocks(f({ launcherCoins: 4, launcherDumps: 1 }), 'snipe')).toBeNull() // three clean coins after a dump
    expect(planBlocks(f({ launcherCoins: 1, launcherDumps: 1 }), 'momentum')).toBeNull()
    expect(planBlocks(f(), 'snipe')).toBeNull() // a signal from before carries no launcher numbers
  })
})
