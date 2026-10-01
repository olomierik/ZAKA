// What kinds of coin lose, and bots that learn it (owner, 2026-10-01: "read the trade logs and let each bot learn from
// its mistakes; find the reasons and patterns that make certain kinds of coins unprofitable; monitor certain coins to
// see whether the opportunity comes back"): a coin's crowd and creator measured at the signal, the losing patterns
// found in the replays, live bots sitting them out (paper bots still measure them), each bot's learner learning the
// same numbers, and the comeback watch.
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, SignalFeatures, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { dollarParams, QUICK_LEARN } from '../src/bot/dollarPlan'
import { admits, defaultTuning, learn } from '../src/bot/learner'
import { PaperAccounts, type PaperAccount } from '../src/bot/paperAccounts'
import { findPatterns, PatternBook, patternWhy, PATTERNS, type Outcome } from '../src/bot/patterns'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import { crowdFeatures, type TapeTrade } from '../src/intel/flow'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { openPosition, recordSell, STRATEGIES, type Position } from '../src/trading/paper'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const DEV = A(0xde5)
const now = Date.now()
const f = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ ageSec: 40, liquidityUsd: 10_000, marketCapUsd: 30_000, buyers: 20, buySellRatio: 3, runUp: 1.1, topBuyerPct: 12, score: 80, flags: [], roundTripPct: 2, ...o })

describe('a coin\'s crowd and creator, at the signal', () => {
  test('buyers since launch (not the creator, not the launch blocks), selling, the creator\'s bag, a launcher\'s own wallets', () => {
    const tape: TapeTrade[] = [
      { block: 100, ts: 0, wallet: DEV, side: 'BUY', usd: 2_500, tokens: 250_000_000, price: 0.00001 },
      { block: 101, ts: 1_000, wallet: A(50), side: 'BUY', usd: 900, tokens: 80_000_000, price: 0.0000112 }, // a launch-block sniper
      ...Array.from({ length: 10 }, (_, i) => ({ block: 110 + i, ts: 20_000 + i * 1_000, wallet: A(i + 1), side: 'BUY' as const, usd: 2, tokens: 180_000, price: 0.000011 })),
      { block: 130, ts: 40_000, wallet: A(3), side: 'SELL', usd: 1.5, tokens: 120_000, price: 0.0000125 },
      { block: 131, ts: 41_000, wallet: DEV, side: 'SELL', usd: 500, tokens: 50_000_000, price: 0.00001 },
      { block: 200, ts: 90_000, wallet: A(99), side: 'BUY', usd: 50, tokens: 1, price: 0.00002 }, // after `at`: not counted
    ]
    const farm = new Set([A(1), A(2), A(3), A(4), A(5), A(6)]) // they bought the creator's other coins
    const c = crowdFeatures(tape, { launchBlock: 100, creator: DEV, at: 60_000, liquidityUsd: 10_000, priceUsd: 0.000012, otherBuyers: farm, creatorLaunches: 3 })
    expect(c).toEqual({ totalBuyers: 10, sellUsd: 1.5, overhang: 0.24, farmShare: 0.6, creatorLaunches: 3 })
    // An unknown creator: no bag, no farm share.
    expect(crowdFeatures(tape, { launchBlock: 100, creator: null, at: 60_000, liquidityUsd: 10_000, priceUsd: 0.000012, otherBuyers: null, creatorLaunches: 0 })).not.toHaveProperty('farmShare')
  })
})

/** n outcomes on the plan: the crowded ones lose 60%, the rest make 30%. */
function outcomes(n: number, crowded: (i: number) => boolean, extra: Partial<SignalFeatures> = {}): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({ signalId: `s${i}`, at: now - (n - i) * 60_000, rule: 'snipe' as const, features: f({ totalBuyers: crowded(i) ? 130 : 30, ...extra }), ret: crowded(i) ? -0.6 : 0.3 }))
}

describe('the losing patterns', () => {
  test('crowded coins that keep losing are found, at the threshold that lost the most', () => {
    const rows = outcomes(40, i => i % 2 === 0)
    const p = findPatterns(rows, now).find(x => x.id === 'crowded')!
    expect(p).toMatchObject({ trades: 20, wins: 0, avgPct: -60, restAvgPct: 30, pnlUsd: -24 })
    expect(p.label).toMatch(/^(60|80|100|120)\+ buyers already in$/)
    expect(patternWhy(p)).toMatch(/buyers already in: coins like this won 0 of their last 20 on the \$2 plan \(-60% a trade, −\$24\.00; other coins \+30%\)/)
  })
  test('none from too few trades, from a kind that makes money, or from signals that don\'t carry the number', () => {
    expect(findPatterns(outcomes(20, i => i < PATTERNS.minTrades - 1), now).some(x => x.id === 'crowded')).toBe(false) // 11 crowded trades
    const winning = outcomes(40, i => i % 2 === 0).map(o => ({ ...o, ret: 0.2 }))
    expect(findPatterns(winning, now)).toEqual([])
    const old = outcomes(40, i => i % 2 === 0).map(o => ({ ...o, features: { ...o.features!, totalBuyers: undefined } }))
    expect(findPatterns(old, now).some(x => x.id === 'crowded')).toBe(false)
    const stale = outcomes(40, i => i % 2 === 0).map(o => ({ ...o, at: o.at - 8 * 86_400_000 }))
    expect(findPatterns(stale, now)).toEqual([]) // only the last 7 days count
  })
  test('the book matches a signal against the patterns in force, and finds them again each minute', () => {
    const book = new PatternBook()
    let rows = outcomes(40, i => i % 2 === 0)
    book.refresh(() => rows, now)
    expect(book.match(f({ totalBuyers: 150 }), 'snipe')?.id).toBe('crowded')
    expect(book.match(f({ totalBuyers: 25 }), 'snipe')).toBeNull()
    expect(book.match(f(), 'snipe')).toBeNull() // no crowd number: not matched
    rows = rows.map(o => ({ ...o, ret: 0.2 })) // crowded coins start making money
    book.refresh(() => rows, now + 1_000)
    expect(book.match(f({ totalBuyers: 150 }), 'snipe')?.id).toBe('crowded') // within the minute: as it was
    book.refresh(() => rows, now + PATTERNS.everyMs + 1)
    expect(book.match(f({ totalBuyers: 150 }), 'snipe')).toBeNull() // lifted by itself
  })
  test('a momentum burst carried by the creator\'s own wallets is its own pattern', () => {
    // 15 momentum bursts on a launcher's own wallets lost; everything else (snipes and organic bursts) made money.
    const rows: Outcome[] = Array.from({ length: 60 }, (_, i) => ({ signalId: `m${i}`, at: now - i * 60_000, rule: i % 2 ? 'momentum' : 'snipe', features: f({ farmShare: i % 4 === 1 ? 0.9 : 0.1 }), ret: i % 4 === 1 ? -0.5 : 0.25 }))
    const found = findPatterns(rows, now)
    expect(found.map(p => p.id)).toEqual(expect.arrayContaining(['farm', 'farm-momentum']))
    expect(found.find(p => p.id === 'farm-momentum')).toMatchObject({ trades: 15, wins: 0, label: "a momentum burst carried by the creator's own wallets" })
  })
})

describe('each bot learns the same numbers from its own and the team\'s trades', () => {
  /** A closed $2 trade on the plan (a replay or a live trade) on a coin with `buyers` already in. */
  const trade = (i: number, buyers: number, won: boolean): Position => {
    const params = dollarParams('snipe', { costIn: 0.01, costOut: 0.01 })
    const p = openPosition({ id: `t${i}`, strategy: 'snipe', token: A(500 + i), symbol: 'C', launchpad: 'A', signalId: `x${i}`, price: 1, cost: 0.01, now: now - 3_600_000 + i * 60_000, params })
    Object.assign(p, { plan: 'dollar', mode: 'paper', rule: 'snipe', exits: params, features: f({ totalBuyers: buyers, liquidityUsd: 12_000 }) })
    recordSell(p, p.qty, won ? 3 : 1.2, p.openedAt + 240_000, won ? 'tp1' : 'time')
    return p
  }
  test('crowded coins kept losing: it learns to skip them, and says why', () => {
    const team = Array.from({ length: 20 }, (_, i) => (i % 2 ? trade(i, 30 + i, true) : trade(i, 120 + i, false)))
    const r = learn(defaultTuning('snipe'), 'snipe', [], now, team, true, QUICK_LEARN)!
    const learned = r.tuning.rules!.snipe!
    expect(learned.maxTotalBuyers).toBeLessThanOrEqual(118)
    expect(learned.maxTotalBuyers).toBeGreaterThanOrEqual(49)
    expect(r.notes.map(n => n.text).join(' ')).toMatch(/snipes: \d+ of 10 losses had buyers already in over \d+, only 0 of 10 wins did: it now needs buyers already in of at most \d+/)
    expect(admits(r.tuning, f({ totalBuyers: 140 }), 'snipe')).toMatch(/140 buyers already in, it skips coins with more than \d+ \(late: the crowd has bought\)/)
    expect(admits(r.tuning, f({ totalBuyers: 40 }), 'snipe')).toBeNull()
    expect(admits(r.tuning, f(), 'snipe')).toBeNull() // a signal without the number isn't held back
    expect(r.tuning.takeProfit).toBe(defaultTuning('snipe').takeProfit)
  })
  test('older tunings, without the crowd filters, admit everything they admitted before', () => {
    const t = defaultTuning('scalp')
    expect(t.filters.maxTotalBuyers).toBeUndefined()
    expect(admits(t, f({ totalBuyers: 900, sellUsd: 5_000, overhang: 0.9, farmShare: 1, ageSec: 40_000 }), 'momentum')).toBeNull()
  })
})

// ── the engine, with a stand-in chain (as in signalMix.test.ts) ──

const T = '0x' + 'e9'.repeat(20)
const settle = () => new Promise(r => setTimeout(r, 25))
class TestBot extends Bot {
  override async report(token: string): Promise<SafetyReport> {
    return { token, launchpad: 'ARGUS', at: Date.now(), verdict: 'pass', score: 85, checks: [], template: null, honeypot: { verdict: 'ok', roundTripLossPct: 2 } as never }
  }
}

function setup(ageMin: number) {
  const launched = Date.now() - ageMin * 60_000
  const meta: LaunchInfo = { token: T, name: 'Coin', symbol: 'COIN', decimals: 18, creator: DEV, txHash: '0x', blockNumber: 1, timestamp: launched, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
  const st = new TokenState(T)
  Object.assign(st, { priceUsd: 1, mainPool: 'pool1', liquidityUsd: 20_000, supply: 1e9 })
  const engine = { metas: new Map([[T, meta]]), tokens: new Map([[T, st]]) } as unknown as MarketEngine
  const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
  const sent: ServerMessage[] = []
  const accounts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'dollar' })
  const bot = new TestBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: (_t, m) => sent.push(m), mode: 'paper', speed: null, accounts, liveGrades: 'dollar' })
  let i = 0
  const trade = (o: { side?: 'BUY' | 'SELL'; price: number; usd?: number; at: number; wallet?: string }) => {
    i++
    st.priceUsd = o.price
    const t: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: T, pair: `${T}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: o.side ?? 'BUY',
      baseAmount: 100, quoteAmount: o.usd ?? 60, tokenAmount: 100, price: o.price, priceUsd: o.price, usdValue: o.usd ?? 60, wallet: o.wallet ?? A(1000 + i),
      txHash: `0x${i}`, blockNumber: 10 + i, logIndex: 0, timestamp: o.at, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 20_000,
    }
    bot.onTrade(t, { replay: false })
  }
  const signals = () => sent.filter((m): m is Extract<ServerMessage, { t: 'SIGNAL' }> => m.t === 'SIGNAL').map(m => m.d)
  let clock = Date.now()
  const sweep = async () => { await settle(); clock += 3_000; bot.sweep(clock); await settle() }
  return { bot, accounts, trade, signals, sweep }
}

/** The plan's replays so far: crowded coins lost, the others won. */
function seedReplays(bot: Bot) {
  for (let i = 0; i < 40; i++) {
    const crowded = i % 2 === 0
    const p = openPosition({ id: `r${i}`, strategy: 'snipe', token: A(700 + i), symbol: 'R', launchpad: 'A', signalId: `rs${i}`, price: 1, cost: 0, now: Date.now() - 3_600_000 + i * 60_000, params: dollarParams('snipe', { costIn: 0.01, costOut: 0.01 }) })
    Object.assign(p, { plan: 'dollar', mode: 'paper', rule: 'snipe', features: f({ totalBuyers: crowded ? 140 : 30 }) })
    recordSell(p, p.qty, crowded ? 0.6 : 3, p.openedAt + 120_000, crowded ? 'rug' : 'tp1')
    bot.dollar.set(p.signalId, p)
  }
}

describe('after a restart', () => {
  test("a tape seeded with a coin's last 100 trades is filled from the stored trades before its crowd is counted", async () => {
    const L = Date.now() - 30 * 60_000
    const meta: LaunchInfo = { token: T, name: 'Noah', symbol: 'NOAH', decimals: 18, creator: DEV, txHash: '0x', blockNumber: 1, timestamp: L, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
    // The launch (the creator's $2,500 bag), 40 buyers in the first 40 seconds, then 109 later trades.
    const all: Trade[] = [
      { tradeId: 't0', timestamp: L, blockNumber: 1, side: 'BUY', wallet: DEV, usdValue: 2_500, tokenAmount: 500_000_000, priceUsd: 0.00001 },
      ...Array.from({ length: 40 }, (_, k) => ({ tradeId: `b${k}`, timestamp: L + 4_000 + k * 1_000, blockNumber: 10 + k, side: 'BUY' as const, wallet: A(k + 1), usdValue: 2, tokenAmount: 180_000, priceUsd: 0.000011 })),
      ...Array.from({ length: 109 }, (_, k) => ({ tradeId: `l${k}`, timestamp: L + 44_000 + k * 300, blockNumber: 100 + k, side: 'SELL' as const, wallet: A(500 + k), usdValue: 1, tokenAmount: 100_000, priceUsd: 0.000003 })),
    ].map(t => ({ ...t, chain: 'ARC', token: T, pair: '', pool: 'pool1', quote: '', baseAmount: t.tokenAmount, quoteAmount: t.usdValue, price: t.priceUsd, txHash: t.tradeId, logIndex: 0, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 10_000 }) as Trade)
    const wire = (t: Trade) => ({ id: t.tradeId, s: t.side === 'BUY' ? 'B' : 'S', pu: t.priceUsd, pl: 'pool1', b: t.blockNumber, ts: t.timestamp, w: t.wallet, u: t.usdValue, ba: t.tokenAmount })
    const newestFirst = [...all].reverse()
    const engine = { metas: new Map([[T, meta]]), tokens: new Map(), recentTrades: (_t: string, n: number) => newestFirst.slice(0, n).map(wire) } as unknown as MarketEngine
    const history = { trades: async (_t: string, limit: number, before?: number) => newestFirst.filter(t => before === undefined || t.timestamp < before).slice(0, limit) }
    const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
    const bot = new TestBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: () => {}, mode: 'paper', speed: null, history, liveGrades: 'dollar' })
    bot.seed()
    expect(bot.tapes.get(T)).toHaveLength(100) // the last 100: the launch and the first buyers are gone
    expect(bot.tapes.get(T)[0].ts).toBeLessThan(L + 60_000) // yet it starts within a minute of the launch, as NOAH's did
    const at = L + 45_000
    const crowd = await (bot as unknown as { crowdOf: (t: string, m: LaunchInfo, at: number, liq: number, px: number) => Promise<SignalFeatures> }).crowdOf(T, meta, at, 10_000, 0.000011)
    expect(crowd).toMatchObject({ totalBuyers: 40, sellUsd: 4, overhang: 0.55 }) // four $1 sales came before the entry
    expect(bot.tapes.get(T)).toHaveLength(150) // filled once, for the rules too
  })
})

describe('the engine: live bots sit out a losing kind of coin, and watch for a comeback', () => {
  test('a snipe on a crowded coin still fires (paper measures it), with live bots told why they sit it out', async () => {
    const { bot, trade, signals, sweep } = setup(3)
    seedReplays(bot)
    const t0 = Date.now()
    for (let k = 0; k < 140; k++) trade({ price: 1 + k * 0.002, at: t0 - 90_000 + k * 600 })
    await sweep()
    const s = signals()[0]
    expect(s).toMatchObject({ strategy: 'snipe', rule: 'snipe' })
    expect(s.features).toMatchObject({ totalBuyers: 140, farmShare: 0, creatorLaunches: 0 })
    expect(s.quality!.liveOk).toBe(false)
    expect(s.quality!.pattern).toMatch(/^\d+\+ buyers already in$/)
    // The plan's own limit says why first; the losing pattern is still named.
    expect(s.quality!.liveWhy).toMatch(/^140 buyers already in \(live bots buy coins with 80 or fewer/)
    expect(bot.dollarView().patterns!.map(p => p.id)).toContain('crowded')
    expect(bot.dollarView().watch!.map(w => [w.symbol, w.why])).toEqual([['COIN', expect.stringMatching(/^sat out: \d+\+ buyers already in$/)]])
  })
  test('the same snipe on a coin with a small crowd goes to live bots', async () => {
    const { bot, trade, signals, sweep } = setup(3)
    seedReplays(bot)
    const t0 = Date.now()
    for (let k = 0; k < 12; k++) trade({ price: 1 + k * 0.01, at: t0 - 60_000 + k * 4_500 })
    await sweep()
    expect(signals()[0].features).toMatchObject({ totalBuyers: 12 })
    expect(signals()[0].quality).toMatchObject({ liveOk: true })
    expect(signals()[0].quality!.pattern).toBeUndefined()
  })
  test('a live bot passes over a pattern signal and says why; a paper bot still takes it', () => {
    const accounts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'dollar' })
    const paper = (accounts.create(now, { name: 'Paper One', strategies: ['snipe'] }) as { account: PaperAccount }).account
    accounts.act(paper, { action: 'deposit', amount: 100 }, now); accounts.act(paper, { action: 'start' }, now)
    const quality = { score: 70, grade: 'live' as const, tier: 'A' as const, rank: null, parts: [], liveOk: false, liveWhy: '120+ buyers already in: coins like this won 0 of their last 20 on the $2 plan', pattern: '120+ buyers already in' }
    accounts.onSignal({ id: 'p1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', rule: 'snipe', roundTripPct: 2, liquidityUsd: 20_000, features: f({ totalBuyers: 150 }), quality }, now)
    expect(paper.positions).toHaveLength(1)
  })
  test('the comeback watch: a live trade that lost, and the dip rebound that fired on its coin later', () => {
    const { bot } = setup(30)
    const lost = openPosition({ id: 'l1', strategy: 'scalp', token: T, symbol: 'COIN', launchpad: 'ARGUS', signalId: 'l1', price: 1, cost: 0, now: Date.now() - 20 * 60_000, params: dollarParams('scalp', { costIn: 0, costOut: 0.01 }) })
    Object.assign(lost, { mode: 'live', plan: 'dollar', rule: 'snipe' })
    recordSell(lost, lost.qty, 0.5, Date.now() - 19 * 60_000, 'rug')
    bot.positions.push(lost)
    const back = { id: 'c1', token: T, symbol: 'COIN', strategy: 'second-leg', rule: 'second-leg', at: Date.now() - 5 * 60_000, price: 0.8, quality: { liveOk: false, liveWhy: 'comebacks are watched and measured first: 0 of the 10 replays needed so far' } }
    ;(bot as unknown as { recentSignals: unknown[] }).recentSignals.push(back)
    const w = bot.watchView()
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ symbol: 'COIN', why: 'a live trade lost $1.50 (rug)', comeback: back.at, priceNow: 1 })
    expect(w[0].status).toMatch(/^comeback signal \(comebacks are watched and measured first/)
  })
})
