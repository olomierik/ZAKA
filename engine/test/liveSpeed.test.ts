// Paper at live speed, the replays on real trades, and the gate that keeps live
// bots to the kinds of signal that make money at live speed.

import { describe, expect, test } from 'bun:test'
import type { Signal } from '../src/bot/types'
import { Bot } from '../src/bot/bot'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import type { MarketEngine } from '../src/market/engine'
import { LIVE_GATE, LiveSpeedBook, replayAtLiveSpeed } from '../src/signals/liveSpeed'
import { closeNow, LIVE_SPEED, onPrice, openPosition, STRATEGIES } from '../src/trading/paper'

const T = '0x' + 'a7'.repeat(20)
const now = Date.UTC(2026, 8, 30, 17)
const snipe = { ...STRATEGIES.snipe, tp1Multiple: 1.4, tp1SellPct: 1, stopLoss: 0.8 }

describe('paper exits at live speed', () => {
  const pos = () => openPosition({ id: 'p', strategy: 'snipe', token: T, symbol: 'C', launchpad: 'A', signalId: 's', price: 1, cost: 0, now, params: { ...snipe, sizeUsd: 10 } })
  test('a take-profit touched in a spike fills at the price 2s later, not at the top', () => {
    const p = pos()
    expect(onPrice(p, 1.45, now + 1_000, snipe, 2_000)).toEqual([]) // triggered
    expect(p.pendingExit?.exits[0].reason).toBe('tp1')
    expect(onPrice(p, 1.3, now + 2_000, snipe, 2_000)).toEqual([]) // not yet 2s
    const f = onPrice(p, 0.9, now + 3_100, snipe, 2_000) // the spike is over by the time the sale lands
    expect(f).toHaveLength(1)
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(p.pnlUsd).toBeCloseTo(-1, 6) // sold at 0.9: a loss, where instant fills showed +40%
  })
  test('a rug close fills 2s later too; with no lag, at once', () => {
    const p = pos()
    expect(closeNow(p, 0.8, now, 'rug', 'Rug guard: x', 2_000)).toEqual([])
    expect(onPrice(p, 0.5, now + 2_500, snipe, 2_000)[0].reason).toBe('rug')
    expect(p.note).toBe('Rug guard: x')
    const q = pos()
    expect(closeNow(q, 0.8, now, 'rug')[0].price).toBeCloseTo(0.8, 9)
  })
})

describe('paper buys at live speed', () => {
  const setup = () => {
    const prices = new Map<string, number>()
    const accts = new PaperAccounts({ store: new MemoryBotStore(), priceOf: t => prices.get(t) ?? null, params: s => STRATEGIES[s] })
    const a = (accts.create(now, { name: 'Slowpoke', strategies: ['snipe'] }) as { account: PaperAccount }).account
    accts.act(a, { action: 'deposit', amount: 100 }, now); accts.act(a, { action: 'start' }, now)
    return { accts, a, prices }
  }
  const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000, ...o })
  test('fills at the first price 2.5s after the signal; the cash is set aside meanwhile', () => {
    const { accts, a } = setup()
    accts.onSignal(sig(), now)
    expect(a.positions).toHaveLength(0)
    expect(a.cash).toBe(80)
    expect(accts.equity(a).equity).toBe(100)
    expect(accts.holds(T)).toBe(true)
    accts.onPrice(T, 1.01, now + 1_000, false, true)
    expect(a.positions).toHaveLength(0) // not yet
    accts.onPrice(T, 1.03, now + 2_600, false, true)
    expect(a.positions[0]).toMatchObject({ status: 'open', marketEntry: 1.03, sizeUsd: 20 })
    expect(a.events[0].text).toMatch(/3\.0% from the signal's price after the 2\.5s a buy takes/)
  })
  test('not bought when the price moved more than 5% by then (as a live bot)', () => {
    const { accts, a } = setup()
    accts.onSignal(sig(), now)
    accts.onPrice(T, 0.85, now + 2_600, false, true)
    expect(a.positions).toHaveLength(0)
    expect(a.cash).toBe(100)
    expect(a.skips[0].text).toMatch(/not bought: the price moved -15\.0% in the 2\.5 seconds a buy takes/)
    expect(accts.outcomes.summary(now + 3_000).reasons.map(r => r.key)).toContain('drift')
  })
  test('a coin that doesn\'t trade again fills at its last price on the next tick', () => {
    const { accts, a, prices } = setup()
    accts.onSignal(sig(), now)
    prices.set(T, 1.02)
    accts.tick(now + LIVE_SPEED.entryMs + 100)
    expect(a.positions[0]?.marketEntry).toBe(1.02)
  })
})

describe('replays on real trades at live speed', () => {
  const at = now
  test('LUMOIN-style: the move is over in the seconds a buy and a sale take', () => {
    // A spike to +64% within 5s and back below the entry: +40% at instant fills.
    const rows = [
      { ts: at + 1_000, price: 1.1 }, { ts: at + 2_600, price: 1.04 }, { ts: at + 4_000, price: 1.5 },
      { ts: at + 5_000, price: 1.64 }, { ts: at + 6_500, price: 0.95 }, { ts: at + 9_000, price: 0.6 },
    ]
    const r = replayAtLiveSpeed(rows, { at, price: 1, roundTripPct: 2, exits: snipe, now: at + 3_600_000 })
    expect(r.final).toBe(true)
    expect(r.ret!).toBeLessThan(0) // bought at 1.04, the take-profit filled 2s after it triggered, at 0.95
  })
  test('skipped when the price moved more than 5% before the buy; a slow winner still wins', () => {
    expect(replayAtLiveSpeed([{ ts: at + 2_600, price: 0.85 }], { at, price: 1, roundTripPct: 2, exits: snipe, now: at + 60_000 })).toMatchObject({ ret: null, final: true })
    const slow = [{ ts: at + 3_000, price: 1.01 }, { ts: at + 60_000, price: 1.2 }, { ts: at + 120_000, price: 1.45 }, { ts: at + 124_000, price: 1.47 }]
    expect(replayAtLiveSpeed(slow, { at, price: 1, roundTripPct: 2, exits: snipe, now: at + 3_600_000 }).ret!).toBeGreaterThan(0.4)
  })
})

describe('the gate', () => {
  test('live bots trade a kind with 10+ replays averaging +0.5% or more', () => {
    const b = new LiveSpeedBook()
    for (let i = 0; i < 9; i++) b.add({ signalId: `w${i}`, key: 'snipe/snipe', at: now - i * 60_000, ret: 0.05 })
    expect(b.record('snipe/snipe', now)).toMatchObject({ trades: 9, ok: false })
    b.add({ signalId: 'w9', key: 'snipe/snipe', at: now, ret: 0.05 })
    expect(b.record('snipe/snipe', now)).toMatchObject({ trades: 10, wins: 10, ok: true })
    for (let i = 0; i < 12; i++) b.add({ signalId: `m${i}`, key: 'momentum/scalp', at: now - i * 60_000, ret: i % 3 ? 0.13 : -0.3 })
    expect(b.record('momentum/scalp', now)).toMatchObject({ trades: 12, wins: 8, ok: false }) // 2 in 3 win, but the losses are bigger
    expect(b.record('snipe/snipe', now + (LIVE_GATE.days + 1) * 86_400_000).trades).toBe(0) // too old
  })
  test('the engine replays its stored signals on the coins\' stored trades', async () => {
    const store = new MemoryBotStore()
    const trades = (price: (i: number) => number, t0: number) => Array.from({ length: 30 }, (_, i) => ({ timestamp: t0 + 3_000 + i * 10_000, priceUsd: price(i) }))
    const mk = (i: number, win: boolean): Signal => ({ id: `sig${i}`, strategy: 'snipe', rule: 'snipe', token: `0x${String(i).padStart(40, '0')}`, symbol: `C${i}`, name: 'C', launchpad: 'ARGUS', at: now - 3 * 3_600_000 + i * 60_000, price: 1, marketCapUsd: null, liquidityUsd: 7_000, ageSec: 60, reasons: [], safety: { verdict: 'pass', score: 95, checks: [] }, executable: true, features: { ageSec: 60, liquidityUsd: 7_000, marketCapUsd: null, buyers: 15, buySellRatio: null, runUp: 1.5, topBuyerPct: 20, score: 95, flags: [], roundTripPct: 2 } } as unknown as Signal)
    const sigs = Array.from({ length: 12 }, (_, i) => mk(i, i % 4 !== 0))
    for (const s of sigs) store.saveSignal(s)
    const history = {
      trades: async (token: string) => {
        const s = sigs.find(x => x.token === token)!
        const win = Number(s.id.slice(3)) % 4 !== 0
        return trades(i => (win ? 1 + i * 0.02 : 1 - i * 0.02), s.at).reverse() as never
      },
    }
    const engine = { metas: new Map(), tokens: new Map() } as unknown as MarketEngine
    const bot = new Bot({ rpc: {} as Rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store, publish: () => {}, mode: 'paper', history })
    await bot.start()
    for (let i = 0; i < 3; i++) await bot.replayDue(now, 8)
    const rec = bot.liveSpeed.record('snipe/snipe', now)
    expect(rec.trades).toBe(12)
    expect(rec.wins).toBe(9)
    expect(bot.stats().liveSpeed).toEqual([rec])
  })
})

describe('where signals go (the owner\'s settings)', () => {
  test('live bots only: a paper bot passes, says why; a live bot still takes the signal', () => {
    const accts = new PaperAccounts({ speed: null, paperSignals: false, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    const paper = (accts.create(now, { name: 'Paper One', strategies: ['snipe'] }) as { account: PaperAccount }).account
    accts.act(paper, { action: 'deposit', amount: 100 }, now); accts.act(paper, { action: 'start' }, now)
    accts.onSignal({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000 }, now)
    expect(paper.positions).toHaveLength(0)
    expect(paper.skips[0].text).toMatch(/signals go to live bots only for now/)
    expect(accts.outcomes.summary(now).reasons.map(r => r.key)).toEqual(['live-only'])
  })
  test('while paper bots get no signals, the team\'s record is enough to go live', () => {
    const on = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    const off = new PaperAccounts({ speed: null, paperSignals: false, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    for (const accts of [on, off]) {
      for (let i = 0; i < 20; i++) {
        const p = openPosition({ id: `t${i}`, strategy: 'snipe', token: `0x${String(i + 1).padStart(40, '0')}`, symbol: 'X', launchpad: 'A', signalId: `sg${i}`, price: 1, cost: 0, now: now - 3_600_000 + i, params: { ...snipe, sizeUsd: 10 } })
        p.features = { ageSec: 60, liquidityUsd: 7_000, marketCapUsd: null, buyers: 15, buySellRatio: null, runUp: 1.5, topBuyerPct: 20, score: 95, flags: [], roundTripPct: 2 }
        onPrice(p, i % 4 ? 1.5 : 0.7, now - 3_000_000 + i, snipe)
        accts.observe(p)
      }
    }
    const fresh = (accts: PaperAccounts) => (accts.create(now, { name: 'Fresh', strategies: ['snipe'] }) as { account: PaperAccount }).account
    expect(on.readinessOf(fresh(on), now).ok).toBe(false) // needs 5 of its own
    expect(off.readinessOf(fresh(off), now)).toMatchObject({ ok: true, via: 'team' })
  })
})
