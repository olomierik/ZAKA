// The BTC Up/Down autotrader learning from its record (engine/src/updown/learn.ts): trust in its model against the
// market, kinds of trade it skips (and lets back in), shadow trades, and each trade's lesson.
// The fixture is the engine's own 45 paper trades of 2026-11-01 (GET /v1/updown/trades), the day it lost $112.66.

import { describe, expect, test } from 'bun:test'
import type { UpdownTrade } from '../../api/_updownProtocol'
import { LEARN, Learner, PATTERNS, bandOf, lessonOf } from '../src/updown/learn'
import { PaperBook, freshPaper } from '../src/updown/paper'
import real from './fixtures/updown-trades-2026-11-01.json'

const day0 = Date.UTC(2026, 10, 1, 12)
let seq = 0
function trade(o: Partial<UpdownTrade> & { won: boolean }): UpdownTrade {
  const price = o.price ?? 0.4, cost = o.cost ?? 25, shares = cost / price
  const pnl = o.won ? shares - cost : -cost
  return {
    id: `t${seq++}`, slug: o.slug ?? `btc-updown-5m-${1_900_000_000 + seq * 300}`, dur: o.dur ?? '5m', lane: o.lane ?? 'A', side: o.side ?? 'up',
    at: o.filledAt ?? day0, filledAt: o.filledAt ?? day0, shares, price, fee: 0.5, cost, model: o.model ?? price + 0.15, edge: o.edge ?? 0.13,
    secondsLeft: o.secondsLeft ?? 200, result: o.won ? 'won' : 'lost', pnl, ...(o.shadow ? { shadow: o.shadow } : {}),
  }
}

describe('trust in the model', () => {
  test('starts halfway between the market and the model', () => {
    const L = new Learner(undefined, () => day0)
    expect(L.weight('5m', 'mid')).toBe(LEARN.prior)
    expect(L.blend(0.8, 0.5, '5m', 200)).toBeCloseTo(0.65, 9)
    expect(L.blend(0.8, null, '5m', 200)).toBe(0.8)
    expect(bandOf(59)).toBe('end'); expect(bandOf(60)).toBe('mid')
  })

  test('falls when the market is right and the model overconfident, rises when the model is right', () => {
    const L = new Learner(undefined, () => day0)
    // Market 60%, model 85%: Up wins 60% of the time, as the market said.
    for (let i = 0; i < 400; i++) L.observe('5m', Array.from({ length: 10 }, () => ({ p: 0.85, market: 0.6, left: 150 })), i % 5 < 3)
    expect(L.weight('5m', 'mid')).toBeLessThan(0.15)
    expect(L.blend(0.85, 0.6, '5m', 150)).toBeLessThan(0.63)
    // Untouched: other lengths and the last minute keep the start.
    expect(L.weight('15m', 'mid')).toBe(LEARN.prior)
    expect(L.weight('5m', 'end')).toBe(LEARN.prior)
    // The model at 85% when the market says 60%, and Up wins 85%: it learns to trust the model.
    const M = new Learner(undefined, () => day0)
    for (let i = 0; i < 400; i++) M.observe('15m', Array.from({ length: 10 }, () => ({ p: 0.85, market: 0.6, left: 30 })), i % 20 < 17)
    expect(M.weight('15m', 'end')).toBeGreaterThan(0.85)
    expect(L.s.notes.some(n => n.kind === 'trust' && n.v?.d === '5m')).toBe(true)
    expect(M.s.notes.some(n => n.kind === 'trust' && n.k.startsWith('Trusts its model more'))).toBe(true)
  })

  test('snapshots where model and market agree teach nothing', () => {
    const L = new Learner(undefined, () => day0)
    for (let i = 0; i < 400; i++) L.observe('5m', [{ p: 0.51, market: 0.5, left: 150 }], i % 2 === 0)
    expect(L.weight('5m', 'mid')).toBe(LEARN.prior)
  })

  test('the day it lost $112.66: its closed trades seed the trust, and the journal says why', () => {
    const now = Math.max(...(real as UpdownTrade[]).map(t => t.filledAt)) + 60_000
    const L = new Learner(undefined, () => now)
    L.seed(real as UpdownTrade[])
    const start = L.s.notes.find(n => n.kind === 'start')!
    expect(start.v).toEqual({ n: '45', e: '26.3', m: '19.2', w: '20' })
    // 5-minute windows (33 of the trades, −$85.28): it trusts its model less there than at the start.
    expect(L.weight('5m', 'mid')).toBeLessThan(0.45)
    L.seed(real as UpdownTrade[]) // once only
    expect(L.s.notes.filter(n => n.kind === 'start').length).toBe(1)
  })
})

describe('kinds of trade it skips', () => {
  test('a kind that clearly loses is skipped; a kind that only looks bad on few trades is not', () => {
    const L = new Learner(undefined, () => day0)
    const t: UpdownTrade[] = []
    // Underdogs at 30¢ win 1 in 10, favourites at 55¢ win 7 in 10.
    for (let i = 0; i < 20; i++) t.push(trade({ price: 0.3, won: i % 10 === 0, filledAt: day0 - i * 60_000 }))
    for (let i = 0; i < 20; i++) t.push(trade({ price: 0.55, won: i % 10 < 7, filledAt: day0 - i * 60_000 }))
    // Only 6 trades in 15-minute windows, all lost: too few to say.
    for (let i = 0; i < 6; i++) t.push(trade({ dur: '15m', price: 0.55, won: false, secondsLeft: 600, filledAt: day0 - i * 60_000 }))
    L.review(t)
    expect(L.s.blocked.dog).toBeDefined()
    expect(L.s.blocked.fav).toBeUndefined()
    expect(L.s.blocked['dur-15m']).toBeUndefined()
    expect(L.skipFor({ dur: '5m', lane: 'A', price: 0.3, model: 0.45, edge: 0.13, secondsLeft: 200 })).not.toBeNull()
    expect(L.skipFor({ dur: '5m', lane: 'A', price: 0.55, model: 0.7, edge: 0.13, secondsLeft: 200 })).toBeNull()
    const note = L.s.notes.find(n => n.kind === 'skip' && n.v?.p === 'underdogs (under 50¢)')!
    expect(note.v!.n).toBe('20')
    expect(L.view(t).kinds[0].skipped).toBe(true)
  })

  test('trades older than 7 days don’t count', () => {
    const L = new Learner(undefined, () => day0)
    const t = Array.from({ length: 30 }, (_, i) => trade({ price: 0.3, won: false, filledAt: day0 - 8 * 86_400_000 - i }))
    L.review(t)
    expect(Object.keys(L.s.blocked)).toEqual([])
  })

  test('let back in once its shadow trades stop losing', () => {
    let now = day0
    const L = new Learner(undefined, () => now)
    const t: UpdownTrade[] = []
    for (let i = 0; i < 20; i++) t.push(trade({ price: 0.3, won: i % 10 === 0, filledAt: now - i * 60_000 }))
    for (let i = 0; i < 20; i++) t.push(trade({ price: 0.55, won: i % 10 < 7, filledAt: now - i * 60_000 }))
    L.review(t)
    expect(L.s.blocked.dog).toBeDefined()
    // A week on, the old losers have aged out, and its shadow underdogs win 4 in 10 at 30¢ (+33% a trade).
    now = day0 + 8 * 86_400_000
    for (let i = 0; i < 20; i++) t.push(trade({ price: 0.3, won: i % 10 < 4, shadow: 'dog', filledAt: now - i * 60_000 }))
    L.review(t)
    expect(L.s.blocked.dog).toBeUndefined()
    expect(L.s.notes.some(n => n.kind === 'lift' && n.v?.p === 'underdogs (under 50¢)')).toBe(true)
  })

  test('on the day it lost $112.66 it learns to skip thin edges and 5-minute windows’ middle', () => {
    const tr = real as UpdownTrade[]
    const L = new Learner(undefined, () => Math.max(...tr.map(t => t.filledAt)) + 60_000)
    L.review(tr)
    expect(Object.keys(L.s.blocked).sort()).toEqual(['5m-left-2-4', 'edge-12', 'left-2-4'])
    // Its best kinds stay open.
    expect(L.s.blocked['edge-12-20']).toBeUndefined()
    expect(L.s.blocked['left-4-8']).toBeUndefined()
  })

  test('direction is never a kind it learns', () => {
    expect(PATTERNS.some(p => /up|down/i.test(p.id))).toBe(false)
  })
})

describe('shadow trades and the paper book', () => {
  test('outside the balance, the caps and the loss stop, but settled with a lesson', () => {
    const now = day0
    const b = new PaperBook(freshPaper(now))
    const base = { slug: 'btc-updown-5m-1900000200', dur: '5m' as const, lane: 'A' as const, side: 'up' as const, at: now, filledAt: now, shares: 100, price: 0.25, fee: 1.3, cost: 26.3, model: 0.4, edge: 0.13, secondsLeft: 200 }
    expect(b.shadowRoom(base.slug, 'up')).toBe(true)
    for (let i = 0; i < LEARN.shadowPerWindow; i++) b.record({ ...base, filledAt: now + i, shadow: 'dog' })
    expect(b.shadowRoom(base.slug, 'up')).toBe(false)
    expect(b.shadowRoom(base.slug, 'down')).toBe(true)
    expect(b.s.bankroll).toBe(1_000)
    expect(b.windowLeft(base.slug)).toBe(100)
    b.record({ ...base, filledAt: now + 9 })
    expect(b.s.bankroll).toBeCloseTo(1_000 - 26.3, 6)
    let heard = 0
    b.onResolved = (_slug, rows) => { heard = rows.length }
    b.snapshot(base.slug, 0.4, 0.25, 0.32, 200)
    const out = b.settle(base.slug, false)
    expect(heard).toBe(1)
    expect(out.length).toBe(3)
    expect(b.s.bankroll).toBeCloseTo(1_000 - 26.3, 6) // the real trade lost; the shadows changed nothing
    const st = b.stats(now)
    expect(st.trades).toBe(1); expect(st.lost).toBe(1)
    expect(st.shadow).toEqual({ trades: 2, won: 0, pnl: -52.6 })
    expect(st.todayPnl).toBeCloseTo(-26.3, 6)
    expect(st.brier.used).toBeCloseTo(0.32 ** 2, 9)
    expect(out.find(t => t.shadow)!.lesson!.k).toContain('the lesson saved it')
    expect(out.find(t => !t.shadow)!.lesson).toBeDefined()
    expect(b.shadowRoom(base.slug, 'up')).toBe(true) // the window's count goes with it
  })

  test('the bid while held is recorded', () => {
    const b = new PaperBook(freshPaper(day0))
    const t = b.record({ slug: 's', dur: '5m', lane: 'A', side: 'up', at: day0, filledAt: day0, shares: 50, price: 0.4, fee: 0.5, cost: 20.5, model: 0.6, edge: 0.13, secondsLeft: 200 })
    b.mark(t, 0.45); b.mark(t, 0.52); b.mark(t, 0.3)
    expect([t.hi, t.lo]).toEqual([0.52, 0.3])
  })
})

describe('lessons', () => {
  const lost = (o: Partial<UpdownTrade> = {}) => ({ ...trade({ won: false, price: 0.36, model: 0.49 }), market: 0.62, side: 'up' as const, raw: 0.55, ...o })
  test('overconfidence, a reversal, the last minute, a scalp, a stop', () => {
    expect(lessonOf(lost())).toEqual({ k: 'Lost: the market’s {m}¢ was closer than the model’s {p}%. The model was overconfident.', v: { m: '62', p: '55' } })
    expect(lessonOf(lost({ side: 'down', market: 0.62 })).v!.m).toBe('38')
    expect(lessonOf(lost({ hi: 0.47 })).v).toEqual({ n: '11' })
    expect(lessonOf(lost({ secondsLeft: 40 })).k).toContain('last minute')
    expect(lessonOf({ ...trade({ won: true }), exit: 'scalp' }).k).toContain('sold at the bid')
    expect(lessonOf({ ...trade({ won: false }), exit: 'stop' }).k).toContain('Cut early')
    expect(lessonOf(trade({ won: true })).k).toBe('Won: held to the result.')
    const old = trade({ won: false, price: 0.36, model: 0.49 }) // a trade from before the log kept the market
    expect(lessonOf(old).v).toEqual({ m: '36', p: '49' })
  })
})
