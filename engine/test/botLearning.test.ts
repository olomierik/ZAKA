// Visitors' bots that size their own trades, get out of rugs and learn from
// their losses: bot/sizing.ts, bot/rugGuard.ts, bot/learner.ts, the momentum
// scalp rule, and how bot/paperAccounts.ts puts them together.
import { describe, expect, test } from 'bun:test'
import type { SignalFeatures, SignalRule } from '../../api/_marketProtocol'
import { admits, defaultTuning, learn, LEARN, migrateTuning, OPEN_FILTERS, relax, toParams, type Tuning } from '../src/bot/learner'
import { PaperAccounts, PROTECT, riskFor, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { RugWatch } from '../src/bot/rugGuard'
import { netAtTakeProfit, sizeForTarget, TARGETS } from '../src/bot/sizing'
import { MemoryBotStore } from '../src/bot/store'
import { RecentTapes, windowOf, type TapeTrade } from '../src/intel/flow'
import { scalpReady } from '../src/signals/rules'
import { openPosition, recordSell, STRATEGIES, type ExitReason, type Position, type Strategy } from '../src/trading/paper'

const now = Date.UTC(2026, 8, 30, 12)
const T = '0x' + 'b1'.repeat(20)

describe('trade size: the smallest that secures the profit target', () => {
  test('sold in full at the take-profit, it nets the target after costs both ways', () => {
    const s = sizeForTarget({ targetUsd: 1.5, takeProfit: 1.15, roundTripPct: 4, liquidityUsd: 20_000 })!
    expect(s.profitUsd).toBeGreaterThanOrEqual(1.5)
    expect(netAtTakeProfit(s.sizeUsd - 0.5, 1.15, 4, 20_000)).toBeLessThan(1.5) // and no smaller size would
    expect(s.sizeUsd).toBeGreaterThan(10)
    expect(s.sizeUsd).toBeLessThan(20)
  })
  test('a thinner pool costs more to trade, so the size grows; one too thin is skipped', () => {
    const deep = sizeForTarget({ targetUsd: 1.5, takeProfit: 1.15, roundTripPct: 4, liquidityUsd: 50_000 })!
    const thin = sizeForTarget({ targetUsd: 1.5, takeProfit: 1.15, roundTripPct: 4, liquidityUsd: 3_000 })!
    expect(thin.sizeUsd).toBeGreaterThan(deep.sizeUsd)
    expect(sizeForTarget({ targetUsd: 1.5, takeProfit: 1.15, roundTripPct: 4, liquidityUsd: 400 })).toBeNull()
    expect(sizeForTarget({ targetUsd: 3, takeProfit: 1.02, roundTripPct: 4, liquidityUsd: 50_000 })).toBeNull() // costs eat a 2% move
  })
  test('scalps aim at $1–2, the others at $1–4', () => {
    expect(TARGETS.scalp.range).toEqual([1, 2])
    for (const s of ['snipe', 'second-leg', 'scalp'] as const) {
      const [lo, hi] = TARGETS[s].range
      expect(TARGETS[s].target).toBeGreaterThanOrEqual(lo)
      expect(TARGETS[s].target).toBeLessThanOrEqual(hi)
    }
  })
})

const trade = (o: Partial<TapeTrade> & { ts: number }): TapeTrade => ({ block: 1, wallet: '0xw', side: 'BUY', usd: 10, tokens: 10, price: 1, ...o })

describe('the rug guard', () => {
  const setup = () => { const tapes = new RecentTapes(); return { tapes, rug: new RugWatch(tapes) } }
  const feed = (w: ReturnType<typeof setup>, t: TapeTrade, liq: number | null, priced = true) => { w.tapes.add(T, t); return w.rug.onTrade(T, t, liq, priced, t.ts) }

  test('normal trading raises nothing', () => {
    const w = setup()
    for (let i = 0; i < 20; i++) expect(feed(w, trade({ ts: now + i * 5_000, side: i % 3 ? 'BUY' : 'SELL', price: 1 + i * 0.01, usd: 50 }), 20_000 + i * 100)).toBeNull()
  })
  test('liquidity pulled: 35% below its recent high', () => {
    const w = setup()
    feed(w, trade({ ts: now }), 20_000)
    expect(feed(w, trade({ ts: now + 5_000 }), 15_000)).toBeNull()
    const a = feed(w, trade({ ts: now + 10_000, side: 'SELL', usd: 5 }), 12_000)
    expect(a?.text).toMatch(/liquidity fell 40%/)
    expect(w.rug.recentAlarm(T, now + 60_000)).not.toBeNull()
    expect(w.rug.recentAlarm(T, now + 31 * 60_000)).toBeNull() // quarantine over
  })
  test('a whale dumping 12% of the pool; an insider dumping 4%', () => {
    const w = setup()
    feed(w, trade({ ts: now }), 10_000)
    expect(feed(w, trade({ ts: now + 1_000, side: 'SELL', usd: 500, wallet: '0xa' }), 10_000)).toBeNull()
    expect(feed(w, trade({ ts: now + 2_000, side: 'SELL', usd: 1_300, wallet: '0xb' }), 10_000)?.text).toMatch(/one wallet sold \$1,300 \(13% of the pool\)/)
    const v = setup()
    v.rug.setInsiders(T, ['0xINSIDER'])
    feed(v, trade({ ts: now }), 10_000)
    expect(feed(v, trade({ ts: now + 1_000, side: 'SELL', usd: 450, wallet: '0xinsider' }), 10_000)?.text).toMatch(/early insider sold/)
  })
  test('a crash: 20% under the minute\'s high on heavy selling (not on a dip with buyers)', () => {
    const w = setup()
    feed(w, trade({ ts: now, price: 1, usd: 20 }), null)
    expect(feed(w, trade({ ts: now + 10_000, side: 'SELL', price: 0.85, usd: 30 }), null)).toBeNull()
    expect(feed(w, trade({ ts: now + 20_000, side: 'SELL', price: 0.75, usd: 40 }), null)?.text).toMatch(/price −25% in a minute/)
    const v = setup()
    feed(v, trade({ ts: now, price: 1, usd: 500 }), null)
    expect(feed(v, trade({ ts: now + 20_000, side: 'SELL', price: 0.75, usd: 40 }), null)).toBeNull() // sells don't outweigh the buys
  })
})

describe('the momentum scalp rule', () => {
  const burst = (n: number, o: (i: number) => Partial<TapeTrade> = () => ({})) => Array.from({ length: n }, (_, i) => trade({ ts: now - 100_000 + i * 10_000, wallet: `0x${i}`, usd: 60, price: 1 + i * 0.012, ...o(i) }))
  test('a burst of buying from several wallets, still near its high, in a deep enough pool', () => {
    const r = scalpReady(windowOf(burst(8)), 600, 10_000, windowOf(burst(8).slice(-3)))
    expect(r.reasons.filter(x => x.startsWith('✗'))).toEqual([])
    expect(r.ok).toBe(true)
  })
  test('not a spike, not sell-heavy, not one buyer, not a thin pool, not a brand-new coin', () => {
    expect(scalpReady(windowOf(burst(8, i => ({ price: 1 + i * 0.1 }))), 600, 10_000, windowOf(burst(8, i => ({ price: 1 + i * 0.1 })).slice(-3))).reasons.join()).toMatch(/a spike/)
    expect(scalpReady(windowOf(burst(8, i => ({ side: i % 2 ? 'SELL' : 'BUY' }))), 600, 10_000, windowOf(burst(8, i => ({ side: i % 2 ? 'SELL' : 'BUY' })).slice(-3))).ok).toBe(false)
    expect(scalpReady(windowOf(burst(8, () => ({ wallet: '0xone' }))), 600, 10_000, windowOf(burst(8, () => ({ wallet: '0xone' })).slice(-3))).ok).toBe(false)
    expect(scalpReady(windowOf(burst(8)), 600, 1_000, windowOf(burst(8).slice(-3))).reasons.join()).toMatch(/need \$2,000 for a scalp/)
    expect(scalpReady(windowOf(burst(8)), 30, 10_000, windowOf(burst(8).slice(-3))).ok).toBe(false)
  })
})

/** A closed position of `s` with the given outcome. */
function closed(s: Strategy, o: { pnl: 'win' | 'loss'; reason?: ExitReason; heldMs?: number; peak?: number; features?: Partial<SignalFeatures>; version?: number; i?: number; tp?: number; rule?: SignalRule; signal?: string }): Position {
  const t = defaultTuning(s)
  const params = toParams({ ...t, takeProfit: o.tp ?? t.takeProfit }, 10)
  const p = openPosition({ id: `p${o.i ?? Math.random()}`, strategy: s, token: T, symbol: 'C', launchpad: 'ARGUS', signalId: o.signal ?? 'x', price: 1, cost: 0.01, now: now + (o.i ?? 0) * 60_000, params })
  p.exits = params
  p.rule = o.rule ?? (s === 'scalp' ? 'momentum' : s)
  p.tuningVersion = o.version ?? 1
  p.features = { ageSec: 300, liquidityUsd: 10_000, marketCapUsd: 50_000, buyers: 10, buySellRatio: 2, runUp: 1.1, topBuyerPct: 15, score: 80, flags: [], roundTripPct: 3, ...o.features }
  p.peak = o.peak ?? (o.pnl === 'win' ? params.tp1Multiple : 1.02)
  const exit = o.pnl === 'win' ? params.tp1Multiple : 0.88
  recordSell(p, p.qty, p.qty * exit * 0.99, p.openedAt + (o.heldMs ?? 120_000), o.reason ?? (o.pnl === 'win' ? 'tp1' : 'stop'))
  return p
}

describe('the learner reads the losing trades', () => {
  const s: Strategy = 'scalp'
  test('nothing to learn from a few trades, or from wins', () => {
    const t = defaultTuning(s)
    expect(learn(t, s, [closed(s, { pnl: 'loss', i: 1 }), closed(s, { pnl: 'loss', i: 2 })], now)).toBeNull()
    expect(learn(t, s, Array.from({ length: 12 }, (_, i) => closed(s, { pnl: 'win', i })), now)).toBeNull()
  })
  test('near misses bring the take-profit closer', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => closed(s, { pnl: 'win', i })),
      ...Array.from({ length: 4 }, (_, i) => closed(s, { pnl: 'loss', i: 10 + i, peak: 1.12, heldMs: 400_000, reason: 'time' })),
    ]
    const r = learn(t, s, trades, now)!
    expect(r.tuning.takeProfit).toBeLessThan(t.takeProfit)
    expect(r.tuning.takeProfit).toBeGreaterThanOrEqual(1.06)
    expect(r.tuning.version).toBe(2)
    expect(r.notes.map(n => n.text).join(' ')).toMatch(/rose most of the way to \+15%.*takes profit at \+13%/)
    expect(r.tuning.prev?.takeProfit).toBe(t.takeProfit)
  })
  test('rugs: more liquidity and safety needed, and the flag the rugged coins shared is skipped', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => closed(s, { pnl: 'win', i })),
      ...Array.from({ length: 3 }, (_, i) => closed(s, { pnl: 'loss', i: 10 + i, reason: 'rug', features: { flags: ['holders'] } })),
    ]
    const r = learn(t, s, trades, now)!
    const f = r.tuning.rules!.momentum!
    expect(f.minLiquidityUsd).toBe(1_500)
    expect(f.minScore).toBe(5)
    expect(f.avoidFlags).toEqual(['holders'])
    expect(admits(r.tuning, { ...closed(s, { pnl: 'win' }).features!, flags: ['holders'] }, 'momentum')).toMatch(/learned to skip/)
    // Learned on momentum bursts: a snipe's signals aren't held to it.
    expect(admits(r.tuning, { ...closed(s, { pnl: 'win' }).features!, flags: ['holders'] }, 'snipe')).toBeNull()
  })
  test('fast stop-outs: buys must outweigh sells more, late entries are skipped', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => closed(s, { pnl: 'win', i, features: { runUp: 1.05 } })),
      ...Array.from({ length: 4 }, (_, i) => closed(s, { pnl: 'loss', i: 10 + i, heldMs: 40_000, features: { runUp: 1.25 + i * 0.02 } })),
    ]
    const r = learn(t, s, trades, now)!
    const f = r.tuning.rules!.momentum!
    expect(f.minBuySellRatio).toBe(1.25)
    expect(f.maxRunUp).toBeLessThan(1.3)
    expect(f.maxRunUp).toBeGreaterThan(1.05) // the winners' entries still pass
    expect(admits(r.tuning, { ...trades[0].features! }, 'momentum')).toBeNull()
  })
  test('one number that separates losses from wins becomes a filter', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 7 }, (_, i) => closed(s, { pnl: 'win', i, features: { liquidityUsd: 8_000 + i * 1_000 } })),
      ...Array.from({ length: 4 }, (_, i) => closed(s, { pnl: 'loss', i: 20 + i, heldMs: 400_000, peak: 1.01, features: { liquidityUsd: 2_000 + i * 300 } })),
    ]
    const r = learn(t, s, trades, now)!
    expect(r.tuning.rules!.momentum!.minLiquidityUsd).toBe(8_000)
    expect(r.tuning.filters).toEqual(OPEN_FILTERS)
    expect(r.notes.map(n => n.text).join(' ')).toMatch(/momentum bursts: 4 of 4 losses had liquidity under \$8,000, only 0 of 7 wins did/)
    expect(r.notes.every(n => n.rule === 'momentum')).toBe(true)
  })
  test('each kind of signal learns apart: buyers since launch (snipes) never block momentum bursts (buyers in 2 minutes)', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 7 }, (_, i) => closed(s, { pnl: 'win', i, rule: 'snipe', features: { buyers: 300 + i * 20 } })),
      ...Array.from({ length: 4 }, (_, i) => closed(s, { pnl: 'loss', i: 20 + i, rule: 'snipe', heldMs: 400_000, peak: 1.01, features: { buyers: 40 + i } })),
    ]
    const r = learn(t, s, trades, now)!
    expect(r.tuning.rules!.snipe!.minBuyers).toBe(40) // capped (FILTER_CAPS)
    expect(r.tuning.rules!.momentum).toBeUndefined()
    expect(admits(r.tuning, { ...trades[0].features!, buyers: 12 }, 'momentum')).toBeNull()
    expect(admits(r.tuning, { ...trades[0].features!, buyers: 12 }, 'snipe')).toMatch(/12 buyers, it now needs 40/)
  })
  test('a new bot learns from other bots’ trades on the same kind of signal', () => {
    const t = defaultTuning(s)
    const own = Array.from({ length: 3 }, (_, i) => closed(s, { pnl: 'win', i, signal: `own${i}`, features: { liquidityUsd: 9_000 } }))
    const others = [
      ...Array.from({ length: 6 }, (_, i) => closed(s, { pnl: 'win', i: 5 + i, signal: `w${i}`, features: { liquidityUsd: 8_000 + i * 1_000 } })),
      ...Array.from({ length: 5 }, (_, i) => closed(s, { pnl: 'loss', i: 20 + i, signal: `l${i}`, heldMs: 400_000, peak: 1.01, features: { liquidityUsd: 2_000 + i * 300 } })),
    ]
    expect(learn(t, s, own, now)).toBeNull()
    const r = learn(t, s, own, now, others)!
    expect(r.tuning.rules!.momentum!.minLiquidityUsd).toBe(8_000)
    expect(r.notes[0].text).toMatch(/read from its 3 trades and 11 of the team's/)
  })
  test('a kind of signal that keeps losing is skipped, then tried again 12 hours later', () => {
    const t = defaultTuning(s)
    const trades = [
      ...Array.from({ length: 2 }, (_, i) => closed(s, { pnl: 'win', i, rule: 'snipe' })),
      closed(s, { pnl: 'win', i: 5 }),
      ...Array.from({ length: 4 }, (_, i) => closed(s, { pnl: 'loss', i: 10 + i })),
    ]
    const r = learn(t, s, trades, now)!
    expect(r.tuning.rules!.momentum!.skip).toBe(true)
    expect(admits(r.tuning, trades[0].features, 'momentum')).toMatch(/learned to skip momentum bursts/)
    expect(admits(r.tuning, trades[0].features, 'snipe')).toBeNull()
    expect(relax(r.tuning, s, 1, now, now + 3_600_000)).toBeNull()
    const back = relax(r.tuning, s, 1, now, now + LEARN.retryRuleAfterMs)!
    expect(back.tuning.rules!.momentum!.skip).toBe(false)
    expect(back.notes[0]).toMatchObject({ kind: 'loosen', rule: 'momentum' })
  })
  test('an older bot’s one set of filters moves to the kind of signal it was learned on', () => {
    const old: Tuning = { ...defaultTuning(s), version: 6, filters: { ...OPEN_FILTERS, minBuyers: 40, avoidFlags: [] } }
    delete old.rules
    const m = migrateTuning(old, s)
    expect(m.filters).toEqual(OPEN_FILTERS)
    expect(m.rules!.snipe!.minBuyers).toBe(40)
    expect(m.version).toBe(6)
    expect(migrateTuning(m, s)).toBe(m)
    const fresh = defaultTuning('second-leg'); delete fresh.rules
    expect(migrateTuning(fresh, 'second-leg').rules).toEqual({})
  })
  test('a version that wins clearly less often than the one before it is rolled back', () => {
    const base = defaultTuning(s)
    const t: Tuning = { ...base, version: 2, takeProfit: 1.1, changedAt: now, basis: { trades: 10, wins: 7 }, prev: { ...base, prev: undefined } as never }
    const trades = [
      ...Array.from({ length: 3 }, (_, i) => closed(s, { pnl: 'win', i, version: 2 })),
      ...Array.from({ length: 6 }, (_, i) => closed(s, { pnl: 'loss', i: 10 + i, version: 2 })),
    ]
    const r = learn(t, s, trades, now)!
    expect(r.notes[0]).toMatchObject({ kind: 'revert', version: 3 })
    expect(r.tuning.takeProfit).toBe(base.takeProfit)
    expect(r.tuning.version).toBe(3)
  })
  test('filters that keep it from trading at all are loosened partway back', () => {
    const t: Tuning = { ...defaultTuning(s), version: 4, changedAt: now - 5 * 3_600_000, filters: { ...defaultTuning(s).filters, minLiquidityUsd: 10_000, minBuyers: 10, avoidFlags: ['holders'] } }
    expect(relax(t, s, LEARN.relaxAfterSkips - 1, null, now)).toBeNull()
    const r = relax(t, s, 20, null, now)!
    expect(r.tuning.filters.minLiquidityUsd).toBe(6_400)
    expect(r.tuning.filters.minBuyers).toBe(6)
    expect(r.tuning.filters.avoidFlags).toEqual([])
    expect(r.notes[0].kind).toBe('loosen')
  })
})

describe('a visitor\'s bot, all together', () => {
  const setup = (price: () => number = () => 1) => {
    const store = new MemoryBotStore()
    const accts = new PaperAccounts({ speed: null, store, priceOf: price, params: st => STRATEGIES[st] })
    const made = accts.create(now, { name: 'Scalper', strategies: ['scalp'] }) as { key: string; account: PaperAccount }
    accts.act(made.account, { action: 'deposit', amount: 1_000 }, now)
    accts.act(made.account, { action: 'start' }, now)
    return { store, accts, a: made.account }
  }
  const sig = (i: number, o: Partial<PaperSignal> = {}): PaperSignal => ({ id: `s${i}`, token: `0x${String(i).padStart(40, '0')}`, symbol: `C${i}`, launchpad: 'ARGUS', price: 1, strategy: 'scalp', roundTripPct: 3, liquidityUsd: 30_000, ...o })

  test('names are checked; a bot is created with its name and strategies', () => {
    const accts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: st => STRATEGIES[st] })
    expect(accts.create(now, { name: 'x', strategies: ['scalp'] })).toEqual({ error: expect.stringMatching(/name your bot/) })
    expect(accts.create(now, { name: 'Ok bot', strategies: [] })).toEqual({ error: 'choose at least one strategy' })
    const made = accts.create(now, { name: '  Moon   Hunter ', strategies: ['second-leg'] }) as { account: PaperAccount }
    expect(made.account).toMatchObject({ name: 'Moon Hunter', strategies: ['second-leg'] })
    expect(accts.act(made.account, { action: 'rename', name: '<script>' }, now)).toMatch(/2–24/)
    expect(accts.act(made.account, { action: 'rename', name: 'Night Owl' }, now)).toBeNull()
  })
  test('a take-profit sells everything, for about what its size makes there', () => {
    const { accts, a } = setup()
    accts.onSignal(sig(1), now)
    const p = a.positions[0]
    accts.onPrice(p.token, 1.2, now + 30_000, false, true)
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(p.pnlUsd!).toBeGreaterThan(p.targetUsd! * 0.9) // sold at or above the take-profit, less the 2% fee
    expect(p.pnlUsd!).toBeLessThan(p.sizeUsd * 0.2)
    expect(p.note).toMatch(/Took the profit/)
  })
  test('a rug alarm closes the position at once; every closed trade is in the log', async () => {
    const { store, accts, a } = setup()
    accts.onSignal(sig(1), now)
    const p = a.positions[0]
    accts.onPrice(p.token, 0.97, now + 5_000, false, true, { at: now + 5_000, text: 'liquidity fell 50%' })
    expect(p).toMatchObject({ status: 'closed', exitReason: 'rug', note: 'Rug guard: liquidity fell 50%' })
    expect(a.events[0]).toMatchObject({ kind: 'rug' })
    const log = await store.paperTrades(a.id, 10)
    expect(log.map(x => x.id)).toEqual([p.id])
    expect(accts.view(a).tradesLogged).toBe(1)
  })
  test('4 losses in a row pause new trades for 30 minutes', () => {
    const { accts, a } = setup()
    for (let i = 1; i <= 4; i++) {
      accts.onSignal(sig(i), now + i)
      accts.onPrice(sig(i).token, 0.89, now + i + 1, false, true) // stopped out (under the day's loss limit: 20% trades lose about $23 each)
    }
    expect(a.lossStreak).toBe(4)
    expect(a.pausedUntil).toBe(now + 4 + 1 + PROTECT.pauseMin * 60_000)
    accts.onSignal(sig(9), now + 60_000)
    expect(a.positions.filter(p => p.status === 'open')).toHaveLength(0)
    expect(a.skips[0].text).toMatch(/paused/)
  })
  test('the daily loss limit follows the deposits; an account down 50% stops', () => {
    expect(riskFor({ deposited: 50 }).dailyLossUsd).toBe(10)
    expect(riskFor({ deposited: 500 }).dailyLossUsd).toBe(50)
    expect(riskFor({ deposited: 50_000 }).dailyLossUsd).toBe(100)
    const { accts, a } = setup()
    a.cash = 400 // as if most of it was lost already
    accts.onSignal(sig(1), now)
    accts.onPrice(sig(1).token, 0.8, now + 1_000, false, true)
    expect(a.running).toBe(false)
    expect(a.events[0].text).toMatch(/Stopped: the account is down/)
  })
  test('learned filters skip signals, and say why', () => {
    const { accts, a } = setup()
    a.tuning.scalp.filters.minLiquidityUsd = 50_000
    accts.onSignal(sig(1, { features: closed('scalp', { pnl: 'win', features: { liquidityUsd: 30_000 } }).features }), now)
    expect(a.positions).toHaveLength(0)
    expect(a.skips[0].text).toMatch(/liquidity \$30,000 is under its learned minimum \$50,000/)
    expect(a.filterSkips.scalp).toBe(1)
  })
  test('losing trades teach it: the tuning changes and the log says so', () => {
    const { accts, a } = setup()
    // Near misses: rise to +12% (short of +15%), then time out below the entry.
    let t = now
    for (let i = 1; i <= 9; i++) {
      accts.onSignal(sig(i), t)
      const token = sig(i).token
      if (i % 3 === 0) accts.onPrice(token, 1.2, t + 1_000, false, true) // a win
      else { accts.onPrice(token, 1.12, t + 1_000, false, true); accts.onPrice(token, 0.99, t + 11 * 60_000, false, true) }
      t += 12 * 60_000
      a.pausedUntil = null // not what this test is about
    }
    expect(a.tuning.scalp.version).toBeGreaterThan(1)
    expect(a.tuning.scalp.takeProfit).toBeLessThan(1.15)
    expect(a.learnLog[0].text).toMatch(/takes profit/)
    expect(accts.view(a).learnLog.length).toBeGreaterThan(0)
  })
})
