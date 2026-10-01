// 2026-10-01 (owner: "the bot checks its balance and doesn't use a high
// amount per trade on a small-capital bot"; "refine the signals so they're
// the cleanest"): a trade is at most 20% of what the bot is worth
// (bot/sizing.ts), a momentum scalp needs a crowd and no spike, and no fast
// scalp on a coin that costs over 5% to buy and sell back (signals/rules.ts).
import { describe, expect, test } from 'bun:test'
import type { Window } from '../src/intel/flow'
import { maxTradeFor, noSizeWhy, SIZE_LIMITS, sizeForTarget, sizeForTrade, TARGETS } from '../src/bot/sizing'
import { MAX_ROUND_TRIP_PCT, RULES, scalpReady, tooCostly } from '../src/signals/rules'

const scalp = { strategy: 'scalp' as const, targetUsd: TARGETS.scalp.target, takeProfit: 1.15, roundTripPct: 2, liquidityUsd: 50_000 }

describe('trade size and the bot\'s balance', () => {
  test('a trade is at most 20% of what the bot is worth, in $0.50 steps, up to the $250 cap', () => {
    expect(maxTradeFor(100)).toBe(20)
    expect(maxTradeFor(33)).toBe(6.5)
    expect(maxTradeFor(9)).toBe(1.5)
    expect(maxTradeFor(10_000)).toBe(SIZE_LIMITS.maxUsd)
    expect(maxTradeFor(-5)).toBe(0)
  })
  test('a big bot sizes for its target as before: the balance doesn\'t change it', () => {
    const plain = sizeForTrade(scalp)!
    expect(sizeForTrade({ ...scalp, balanceUsd: 5_000 })).toEqual(plain)
    expect(plain.targetUsd).toBe(TARGETS.scalp.target)
  })
  test('a small bot: the smallest size within its 20% that nets $1, else the 20% for what it nets', () => {
    const need = sizeForTarget(scalp)!.sizeUsd
    expect(need).toBe(12) // a $1.50 scalp needs $12 here
    expect(sizeForTrade({ ...scalp, balanceUsd: 60 })).toMatchObject({ sizeUsd: 12, targetUsd: 1.5 }) // 20% = $12: the full target fits
    const mid = sizeForTrade({ ...scalp, balanceUsd: 50 })! // 20% = $10: $1 fits
    expect(mid.sizeUsd).toBeLessThanOrEqual(10)
    expect(mid).toMatchObject({ targetUsd: 1, small: true })
    const tiny = sizeForTrade({ ...scalp, balanceUsd: 25 })! // 20% = $5: not even $1
    expect(tiny).toMatchObject({ sizeUsd: 5, small: true })
    expect(tiny.targetUsd).toBeLessThan(1)
    expect(tiny.targetUsd).toBeGreaterThanOrEqual(SIZE_LIMITS.minNetUsd)
  })
  test('too small for a $2 trade, or one that nets under $0.25: no trade, and the reason names the balance', () => {
    expect(sizeForTrade({ ...scalp, balanceUsd: 9 })).toBeNull()
    expect(noSizeWhy({ ...scalp, balanceUsd: 9 })).toMatchObject({ key: 'small-balance' })
    expect(sizeForTrade({ ...scalp, balanceUsd: 12 })).toMatchObject({ sizeUsd: 2, small: true }) // $2 nets $0.25 at a 2% round trip
    expect(sizeForTrade({ ...scalp, roundTripPct: 4, balanceUsd: 12 })).toBeNull() // at 4%, $2 nets about $0.21
    expect(noSizeWhy({ ...scalp, roundTripPct: 4, balanceUsd: 12 }).key).toBe('small-balance')
  })
  test('a thin pool never gets a bigger trade because the bot is rich: that stays "too thin"', () => {
    const thin = { ...scalp, liquidityUsd: 300, roundTripPct: 4 }
    expect(sizeForTrade({ ...thin, balanceUsd: 100_000 })).toBeNull()
    expect(noSizeWhy({ ...thin, balanceUsd: 100_000 }).key).toBe('too-thin')
  })
})

describe('the cleanest signals', () => {
  const w = (o: Partial<Window> = {}): Window => ({ trades: 14, buyers: 12, sellers: 2, buyUsd: 400, sellUsd: 100, firstPrice: 1, lastPrice: 1.08, high: 1.09, low: 1, topBuyerPct: 20, ...o })
  /** The last 30 seconds: still being bought. */
  const last = (o: Partial<Window> = {}): Window => ({ trades: 3, buyers: 3, sellers: 0, buyUsd: 120, sellUsd: 0, firstPrice: 1.07, lastPrice: 1.08, high: 1.08, low: 1.07, topBuyerPct: 40, ...o })
  test('a momentum scalp needs 6 buyers in its two minutes (the afternoon of 30 September, back on 2026-10-01)', () => {
    expect(RULES.scalp).toMatchObject({ minBuyers: 6, minBuySellRatio: 1.6, maxMove: 1.2, minLiquidityUsd: 2_000 })
    expect(scalpReady(w({ buyers: 6 }), 600, 20_000, last()).ok).toBe(true)
    const few = scalpReady(w({ buyers: 5 }), 600, 20_000, last())
    expect(few.ok).toBe(false)
    expect(few.failed).toEqual(['buyers'])
  })
  test('"still bought in its last 30 seconds" is off, as that afternoon; the check itself still works when set', () => {
    expect(RULES.scalp.minRecentBuyers).toBe(0)
    expect(scalpReady(w(), 600, 20_000, last({ buyUsd: 40, sellUsd: 90, sellers: 2 })).ok).toBe(true)
    const strict = { ...RULES.scalp, minRecentBuyers: 2 }
    const over = scalpReady(w(), 600, 20_000, last({ buyUsd: 40, sellUsd: 90, sellers: 2 }), strict)
    expect(over.failed).toEqual(['now'])
    expect(over.reasons.join(' ')).toMatch(/the burst is over/)
    expect(scalpReady(w(), 600, 20_000, last({ buyers: 1 }), strict).failed).toEqual(['now'])
  })
  test('and no spike: a coin already up over 20% in the window is late', () => {
    expect(scalpReady(w({ lastPrice: 1.18, high: 1.18 }), 600, 20_000, last()).ok).toBe(true)
    const late = scalpReady(w({ lastPrice: 1.22, high: 1.23 }), 600, 20_000, last())
    expect(late.failed).toEqual(['move'])
    expect(late.reasons.join(' ')).toMatch(/a spike, too late/)
  })
  test('a fast scalp only where buying and selling back costs 5% or less; a snipe or rebound 12%', () => {
    expect(MAX_ROUND_TRIP_PCT).toEqual({ scalp: 5, other: 12 })
    expect(tooCostly('scalp', 2)).toBeNull()
    expect(tooCostly('scalp', null)).toBeNull() // not probed (a curve): the safety scan decides
    expect(tooCostly('scalp', 7.84)).toMatch(/costs 7\.84%, over the 5% a fast scalp allows/)
    expect(tooCostly('snipe', 7.84)).toBeNull()
    expect(tooCostly('second-leg', 13)).toMatch(/over the 12% a dip rebound allows/)
  })
})
