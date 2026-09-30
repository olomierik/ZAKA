// Signal quality: the score, the 80/20 split between live-grade and paper-only,
// and the tiers that set how much of a bot's capital a trade takes.

import { describe, expect, test } from 'bun:test'
import type { SignalFeatures } from '../../api/_marketProtocol'
import { sizeFromCapital } from '../src/bot/sizing'
import { QUALITY, QualityRank, qualityScore } from '../src/signals/quality'

const f = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ ageSec: 60, liquidityUsd: 7_000, marketCapUsd: 30_000, buyers: 15, buySellRatio: null, runUp: 1.6, topBuyerPct: 20, score: 95, flags: [], roundTripPct: 4, ...o })

describe('the quality score', () => {
  test('a clean snipe still being bought outranks one already being sold into', () => {
    const snipes = { trades: 16, winRate: 0.85 }
    const taint = qualityScore(f({ buyers: 15, buySellRatio: null, topBuyerPct: 17, score: 95 }), snipes).score // won
    const bagey = qualityScore(f({ buyers: 31, buySellRatio: 1.59, topBuyerPct: 9.8, score: 100 }), snipes).score // dumped 32% 6s after the buy
    expect(taint).toBeGreaterThan(bagey + 10)
  })
  test('a losing rule scores lower; a new one counts as even', () => {
    const coin = f()
    expect(qualityScore(coin, { trades: 15, winRate: 0.33 }).score).toBeLessThan(qualityScore(coin, { trades: 16, winRate: 0.85 }).score)
    expect(qualityScore(coin, { trades: 2, winRate: 0 }).score).toBe(qualityScore(coin, { trades: 0, winRate: null }).score)
    expect(qualityScore(coin, { trades: 0, winRate: null }).parts[0]).toMatch(/new: counted as even/)
  })
  test('in 0–100, with its parts in words', () => {
    const best = qualityScore(f({ buyers: 40, topBuyerPct: 0, score: 100, roundTripPct: 0 }), { trades: 20, winRate: 1 })
    expect(best.score).toBe(100)
    const worst = qualityScore(f({ buyers: 0, buySellRatio: 0.5, topBuyerPct: 60, score: 0, roundTripPct: 12 }), { trades: 20, winRate: 0 })
    expect(worst.score).toBe(0)
    expect(best.parts).toHaveLength(6)
  })
})

describe('80% to live bots, 20% to paper bots', () => {
  test('before 8 signals: live-grade, tier A from a score of 80', () => {
    const r = new QualityRank()
    expect(r.grade(85)).toEqual({ grade: 'live', tier: 'A', rank: null })
    expect(r.grade(60)).toEqual({ grade: 'live', tier: 'B', rank: null })
  })
  test('then ranked against the last 50: the bottom 20% paper only, the top 40% tier A', () => {
    const r = new QualityRank()
    for (let s = 1; s <= 50; s++) r.add(s * 2) // 2, 4, … 100
    expect(r.grade(10, false).grade).toBe('paper') // at least as good as 5 of 50: 10%
    expect(r.grade(20, false)).toMatchObject({ grade: 'live', tier: 'B', rank: 0.2 })
    expect(r.grade(50, false)).toMatchObject({ grade: 'live', tier: 'B', rank: 0.5 })
    expect(r.grade(60, false)).toMatchObject({ grade: 'live', tier: 'A', rank: 0.6 })
    expect(r.grade(80, false)).toMatchObject({ grade: 'live', tier: 'A', rank: 0.8 })
    expect(r.size).toBe(QUALITY.window)
  })
  test('over many signals, about 80% are live-grade', () => {
    const r = new QualityRank()
    let live = 0
    for (let i = 0; i < 1_000; i++) if (r.grade(Math.round(40 + 60 * (((i * 7919) % 1_000) / 1_000))).grade === 'live') live++
    expect(live / 1_000).toBeGreaterThan(0.75)
    expect(live / 1_000).toBeLessThan(0.88)
  })
})

describe('trade size from the bot\'s capital', () => {
  const at = { takeProfit: 1.4, roundTripPct: 4, liquidityUsd: 7_000 }
  test('20% on tier A, 10% on tier B, at least $1: a $10 bot trades $2 or $1', () => {
    expect(sizeFromCapital({ capitalUsd: 10, tier: 'A', ...at })).toMatchObject({ sizeUsd: 2, share: 0.2 })
    expect(sizeFromCapital({ capitalUsd: 10, tier: 'B', ...at })).toMatchObject({ sizeUsd: 1, share: 0.1 })
    expect(sizeFromCapital({ capitalUsd: 7, tier: 'B', ...at })).toMatchObject({ sizeUsd: 1 }) // 10% is $0.70: the $1 minimum, within its 20%
    expect(sizeFromCapital({ capitalUsd: 4, tier: 'A', ...at })).toMatchObject({ key: 'small-balance' })
  })
  test('never over 1.5% of the pool, or the cap; never where the round trip eats the take-profit', () => {
    expect(sizeFromCapital({ capitalUsd: 10_000, tier: 'A', ...at })).toMatchObject({ sizeUsd: 105 })
    expect(sizeFromCapital({ capitalUsd: 1_000, tier: 'A', ...at, maxUsd: 50 })).toMatchObject({ sizeUsd: 50 })
    expect(sizeFromCapital({ capitalUsd: 100, tier: 'A', ...at, liquidityUsd: 50 })).toMatchObject({ key: 'too-thin' })
    expect(sizeFromCapital({ capitalUsd: 100, tier: 'A', takeProfit: 1.05, roundTripPct: 12, liquidityUsd: 7_000 })).toMatchObject({ key: 'costly' })
  })
})
