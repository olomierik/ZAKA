// The strategy board (owner, 2026-10-01: "only 3 strategies that have proven
// to be working on paper, trading LIVE; bots self-improve and auto-switch
// strategies on the opportunity the signals show; learn from paper bots").
import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import type { BotFilters, StrategyTuning } from '../../api/_marketProtocol'
import { defaultTuning } from '../src/bot/learner'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import { BOARD, boardAdmits, boardEntry, boardParams, BOT_STRATEGIES, pickStrategy, recordOf, type Candidate } from '../src/bot/strategyBoard'
import { READY, UserLive, WalletVault } from '../src/bot/userLive'
import type { PoolInfo } from '../src/dex/pools'
import { USDC20, type LiveExecutor } from '../src/trading/live'
import { openPosition, QUICK_EXITS, recordSell, STRATEGIES, type Position, type Strategy } from '../src/trading/paper'

const NOW = Date.UTC(2026, 9, 1, 12)
let n = 0
/** A closed trade on `strategy` that returned `ret` (0.05 = +5%), opened `agoMin` minutes before `at`. */
function trade(strategy: Strategy, ret: number, o: { at?: number; agoMin?: number; mode?: 'paper' | 'live'; size?: number } = {}): Position {
  const at = o.at ?? NOW, opened = at - (o.agoMin ?? 30) * 60_000
  const p = openPosition({ id: `t${++n}`, strategy, token: `0x${String(n).padStart(40, '0')}`, symbol: 'X', launchpad: 'ARGUS', signalId: `s${n}`, price: 1, cost: 0, now: opened, params: { ...STRATEGIES[strategy], sizeUsd: o.size ?? 10 } })
  p.mode = o.mode ?? 'paper'
  recordSell(p, p.qty, p.sizeUsd * (1 + ret), opened + 60_000, ret > 0 ? 'tp1' : 'stop')
  return p
}
const many = (strategy: Strategy, rets: number[], o: Parameters<typeof trade>[2] = {}) => rets.map((r, i) => trade(strategy, r, { ...o, agoMin: (o.agoMin ?? 30) + i }))
const house = (trades: Position[]): Candidate => ({ kind: 'house', id: 'house', name: 'ARCDEX', trades, tuning: null })
const bot = (name: string, trades: Position[], tuning: StrategyTuning): Candidate => ({ kind: 'bot', id: name, name, slug: name.toLowerCase(), trades, tuning })

describe('the board: which strategies live bots trade, and with whose settings', () => {
  test('three strategies; dip rebounds are measured on paper only', () => {
    expect(BOT_STRATEGIES).toEqual(['precision', 'snipe', 'scalp'])
    expect(pickStrategy('second-leg', [house(many('second-leg', Array(10).fill(0.2)))], [], NOW)).toMatchObject({ status: 'paused', why: expect.stringMatching(/measured on paper only/) })
  })
  test('only trades from paper at live speed count: instant fills from before 30 September, 17:00 UTC don\'t', () => {
    const old = many('snipe', Array(10).fill(0.3), { at: BOARD.since - 60_000 })
    expect(recordOf(old, BOARD.since + 3_600_000)).toBeNull()
    expect(recordOf(many('snipe', [0.1, -0.05]), NOW)).toMatchObject({ trades: 2, wins: 1 })
    expect(recordOf(many('snipe', [0.1], { at: NOW - 49 * 3_600_000 }), NOW)).toBeNull() // older than 48 hours
  })
  test('not enough paper trades yet: on trial, traded at the platform\'s settings', () => {
    const pick = pickStrategy('snipe', [house(many('snipe', [0.06, 0.06, -0.07]))], [], NOW)
    expect(pick).toMatchObject({ status: 'trial', source: null, why: expect.stringMatching(/3 of 8 paper trades/) })
    expect(boardParams(pick, 2)).toEqual({ ...QUICK_EXITS, sizeUsd: 2 })
  })
  test('the engine\'s own paper book in profit: live, with the platform\'s settings', () => {
    const pick = pickStrategy('scalp', [house(many('scalp', [0.06, 0.06, 0.06, -0.07, 0.06, 0.06, -0.07, 0.06, 0.06]))], [], NOW)
    expect(pick).toMatchObject({ status: 'live', source: { kind: 'house' }, why: expect.stringMatching(/the engine's own paper book's settings: it won 7 of its last 9/) })
    expect(boardParams(pick, 2)).toEqual({ ...QUICK_EXITS, sizeUsd: 2 })
    expect(boardAdmits(pick, undefined, 'snipe')).toBeNull()
  })
  test('a paper bot doing better takes over: live bots trade with its learned exits and filters', () => {
    const learned: StrategyTuning = { ...defaultTuning('snipe'), version: 4, takeProfit: 1.2, stopLoss: 0.88, rules: { snipe: { minLiquidityUsd: 1_000, minBuyers: 20, minBuySellRatio: 0, maxRunUp: 100, minScore: 0, maxTopBuyerPct: 100, avoidFlags: [] } as BotFilters } }
    const pick = pickStrategy('snipe', [
      house(many('snipe', [0.06, 0.06, -0.07, 0.06, -0.07, 0.06, 0.06, 0.06])),
      bot('Owl', many('snipe', [0.15, 0.15, -0.1, 0.15, 0.15, 0.15, -0.1, 0.15, 0.15, 0.15]), learned),
    ], [], NOW)
    expect(pick).toMatchObject({ status: 'live', source: { kind: 'bot', name: 'Owl' } })
    expect(boardParams(pick, 2)).toMatchObject({ sizeUsd: 2, tp1Multiple: 1.2, stopLoss: 0.88 })
    const few = { ageSec: 40, liquidityUsd: 9_000, marketCapUsd: 50_000, buyers: 12, buySellRatio: 3, runUp: 1.05, topBuyerPct: 8, score: 90, flags: [], roundTripPct: 2 }
    expect(boardAdmits(pick, few, 'snipe')).toMatch(/Owl's learned filter/)
    expect(boardAdmits(pick, { ...few, buyers: 25 }, 'snipe')).toBeNull()
    expect(boardEntry(pick)).toMatchObject({ strategy: 'snipe', status: 'live', source: { kind: 'bot', name: 'Owl', trades: 10, wins: 8 }, exits: { takeProfit: 1.2, sellPct: 50, stopLoss: 0.88 } })
  })
  test('every paper book losing: paused for live, with the best of them in words', () => {
    const pick = pickStrategy('scalp', [house(many('scalp', [0.06, -0.07, -0.07, 0.06, -0.07, -0.07, -0.07, 0.06]))], [], NOW)
    expect(pick).toMatchObject({ status: 'paused', why: expect.stringMatching(/no paper book is in profit on it; the best, the engine's own paper book, won 3 of its last 8/) })
  })
  test('paper and live disagree: live bots\' own last trades losing pause it, whatever paper shows', () => {
    const paper = house(many('precision', Array(10).fill(0.1)))
    const live = many('precision', [-0.3, 0.1, -0.25, -0.2, 0.1, -0.4], { mode: 'live' })
    expect(pickStrategy('precision', [paper], live, NOW)).toMatchObject({ status: 'paused', why: expect.stringMatching(/live bots' own last 6 trades on it won 2/) })
    expect(pickStrategy('precision', [paper], live.slice(0, 5), NOW).status).toBe('live') // under 6 live trades: paper decides
    expect(pickStrategy('precision', [paper], live, NOW + 25 * 3_600_000).status).toBe('live') // a day later those live trades have aged out: paper decides again
  })
})

// ── live bots on the board ────────────────────────────────────────────

const T = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'
const pool: PoolInfo = { pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: T, fee: 10_000, tickSpacing: 200, hooks: null, base: T, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 }
const settle = () => new Promise(r => setTimeout(r, 30))

function setup() {
  const calls: string[] = []
  let held = 0n
  const w = { balance: 100 }
  const exec = {
    address: '0x' + 'ab'.repeat(20) as Address,
    ready: async () => '0x' as Address,
    balanceUsd: async () => w.balance,
    buy: async (_p: PoolInfo, _t: Address, usd: number) => { calls.push(`buy ${usd}`); held = BigInt(Math.round(usd * 1e6)) * 10n ** 12n; w.balance -= usd; return { hash: '0xb' as Hex, tokens: held, usd, gasUsd: 0.01, at: Date.now() } },
    approveForSale: async () => [],
    tokenBalance: async () => held,
    sell: async (_p: PoolInfo, _t: Address, amount: bigint) => { const usd = Number(amount) / 1e18 * 1.2; held -= amount; w.balance += usd; return { hash: '0xs' as Hex, tokens: amount, usd, gasUsd: 0.01, at: Date.now() } },
    sendUsdc: async (_to: Address, usd: number) => { w.balance -= usd; return { hash: '0xf' as Hex, tokens: 0n, usd, gasUsd: 0.001, at: Date.now() } },
  } as unknown as LiveExecutor
  const live = new UserLive({ vault: new WalletVault('11'.repeat(32)), makeExec: () => exec, pools: () => pool })
  const accounts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], live, liveRouting: 'board' })
  const housePaper: Position[] = []
  accounts.setHouse({ paper: () => housePaper, live: () => [] })
  return { accounts, calls, housePaper }
}
const at = () => Date.now()
const ctx = (id: string, token: string) => ({ signal: { id, token, strategy: 'scalp' } as never, pool: { ...pool, currency1: token as Address, base: token as Address }, meta: { token, symbol: 'COIN', launchpad: 'Argus' } as never })
const sig = (o: Partial<PaperSignal>): PaperSignal => ({ id: 's1', token: T, symbol: 'COIN', launchpad: 'Argus', price: 1, strategy: 'scalp', roundTripPct: 2, liquidityUsd: 50_000, ...o })
const tok = (k: number) => '0x' + k.toString(16).padStart(2, '0').repeat(20)

async function liveBot(accounts: PaperAccounts, strategies: Strategy[]) {
  const a = (accounts.create(at(), { name: `Live ${strategies.join(' ')}`.slice(0, 24), strategies }, 'owner') as { account: PaperAccount }).account
  // Its paper record (to go live), on dip rebounds: a strategy the board doesn't read, so this bot isn't one of its books.
  for (let i = 0; i < READY.minTrades; i++) a.positions.push(trade('second-leg', i % 4 ? 0.1 : -0.05, { at: at() - 3 * 3_600_000 }))
  accounts.createWallet(a, at())
  expect(await accounts.setMode(a, 'live', { verified: true }, at())).toBeNull()
  accounts.act(a, { action: 'start' }, at())
  return a
}

describe('live bots switch between the three strategies by themselves', () => {
  test('a live bot that picked Fast scalp trades a snipe too, with the settings of the paper bot doing best on it', async () => {
    const { accounts, calls } = setup()
    // A paper bot that learned to take snipes at +20%: in profit on its last 10 at live speed.
    const owl = (accounts.create(at(), { name: 'Owl', strategies: ['snipe'] }, 'other') as { account: PaperAccount }).account
    owl.tuning.snipe = { ...owl.tuning.snipe, version: 3, takeProfit: 1.2 }
    owl.positions.push(...many('snipe', [0.15, 0.15, -0.1, 0.15, 0.15, 0.15, -0.1, 0.15, 0.15, 0.15], { at: at() }))
    const a = await liveBot(accounts, ['scalp'])
    accounts.onSignal(sig({ id: 'sn1', strategy: 'snipe', token: tok(0xa1) }), at(), ctx('sn1', tok(0xa1)))
    await settle()
    const p = a.positions.find(x => x.signalId === 'sn1')!
    expect(p).toMatchObject({ mode: 'live', strategy: 'snipe', sizeUsd: 2 })
    expect(p.exits).toMatchObject({ tp1Multiple: 1.2 }) // Owl's learned take-profit
    expect(calls).toEqual(['buy 2'])
    expect(accounts.boardView(at()).find(e => e.strategy === 'snipe')).toMatchObject({ status: 'live', source: { name: 'Owl' } })
  })
  test('a paused strategy is passed over with the reason; a dip rebound isn\'t a live bot\'s', async () => {
    const { accounts, calls, housePaper } = setup()
    housePaper.push(...many('scalp', [0.06, -0.07, -0.07, 0.06, -0.07, -0.07, -0.07, 0.06], { at: at() }))
    const a = await liveBot(accounts, ['scalp', 'snipe'])
    accounts.onSignal(sig({ id: 'sc1', strategy: 'scalp', token: tok(0xa2) }), at(), ctx('sc1', tok(0xa2)))
    await settle()
    expect(calls).toEqual([])
    expect(a.skips[0].text).toMatch(/not traded live: Fast scalp is paused for live: no paper book is in profit on it/)
    accounts.onSignal(sig({ id: 'dr1', strategy: 'second-leg', token: tok(0xa3) }), at(), ctx('dr1', tok(0xa3)))
    await settle()
    expect(a.skips[0].text).toMatch(/live bots trade Precision, Snipe and Fast scalp/)
    // A snipe has no paper record yet: on trial, bought at $2 with the platform's settings.
    accounts.onSignal(sig({ id: 'sn2', strategy: 'snipe', token: tok(0xa4) }), at(), ctx('sn2', tok(0xa4)))
    await settle()
    expect(calls).toEqual(['buy 2'])
    expect(a.positions.find(x => x.signalId === 'sn2')?.exits).toMatchObject({ tp1Multiple: QUICK_EXITS.tp1Multiple, tp1SellPct: 1 })
  })
  test('paper bots get signals again, and learn from them', () => {
    const { accounts } = setup()
    expect(accounts.paperSignals).toBe(true)
    const a = (accounts.create(at(), { name: 'Paper one' }, 'p') as { account: PaperAccount }).account
    expect(a.strategies).toEqual(['precision', 'snipe', 'scalp'])
    accounts.act(a, { action: 'deposit', amount: 100 }, at()); accounts.act(a, { action: 'start' }, at())
    accounts.onSignal(sig({ id: 'pp1', strategy: 'snipe', token: tok(0xa5) }), at())
    expect(a.positions.find(x => x.signalId === 'pp1')).toMatchObject({ mode: 'paper', strategy: 'snipe' })
  })
})

// ── the engine's own paper book on the board ─────────────────────────

import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'

class CleanBot extends Bot {
  override async report(token: string): Promise<SafetyReport> {
    return { token, launchpad: 'ARGUS', at: Date.now(), verdict: 'pass', score: 90, checks: [{ id: 'holders', ok: true, hard: false, risk: true, detail: 'top 10 hold 30%' }], template: null, honeypot: { verdict: 'ok', roundTripLossPct: 2 } as never }
  }
}

function botSetup(ageSec: number) {
  const C = '0x' + 'e9'.repeat(20), DEV = '0x' + 'de'.repeat(20)
  const launched = Date.now() - ageSec * 1_000
  const meta: LaunchInfo = { token: C, name: 'Coin', symbol: 'COIN', decimals: 18, creator: DEV, txHash: '0x', blockNumber: 1, timestamp: launched, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
  const st = new TokenState(C)
  Object.assign(st, { priceUsd: 1, mainPool: 'pool1', liquidityUsd: 20_000, supply: 1e9 })
  const engine = { metas: new Map([[C, meta]]), tokens: new Map([[C, st]]) } as unknown as MarketEngine
  const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
  const accounts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'board' })
  const sent: ServerMessage[] = []
  const b = new CleanBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: (_t, m) => sent.push(m), mode: 'paper', accounts, speed: null, liveGrades: 'board' })
  let i = 0
  const buy = (price: number, at: number) => {
    i++
    st.priceUsd = price
    const t: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: C, pair: `${C}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: 'BUY',
      baseAmount: 100, quoteAmount: 60, tokenAmount: 100, price, priceUsd: price, usdValue: 60, wallet: '0x' + (0x100 + i).toString(16).padStart(40, '0'),
      txHash: `0x${i}`, blockNumber: 10 + i, logIndex: 0, timestamp: at, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 20_000,
    }
    b.onTrade(t, { replay: false })
  }
  const sweep = async () => { await new Promise(r => setTimeout(r, 25)); b.sweep(Date.now() + 3_000); await new Promise(r => setTimeout(r, 25)) }
  const signals = () => sent.filter((m): m is Extract<ServerMessage, { t: 'SIGNAL' }> => m.t === 'SIGNAL').map(m => m.d)
  return { b, buy, sweep, signals }
}

describe('the engine\'s own paper book trades as live bots do on the board', () => {
  test('a Core snipe: the quick exits, and live bots may take it (on trial)', async () => {
    const { b, buy, sweep, signals } = botSetup(120)
    const t0 = Date.now()
    for (let k = 0; k < 16; k++) buy(1 + k * 0.008, t0 - 60_000 + k * 3_000)
    await sweep()
    const [s] = signals()
    expect(s.quality).toMatchObject({ level: 'core', liveOk: true })
    const p = b.positions.find(x => x.signalId === s.id)!
    expect(p).toMatchObject({ strategy: 'snipe', mode: 'paper' })
    expect(p.exits ?? STRATEGIES[p.strategy]).toMatchObject({ tp1Multiple: QUICK_EXITS.tp1Multiple, tp1SellPct: 1 })
  })
  test('a Prime early crowd: the engine\'s book trades it with Precision', async () => {
    const { b, buy, sweep, signals } = botSetup(50)
    const t0 = Date.now()
    for (let k = 0; k < 12; k++) buy(1 + k * 0.005, t0 - 25_000 + k * 2_000)
    await sweep()
    const s = signals()[0]
    expect(s?.quality?.level).toBe('prime')
    expect(b.positions.find(x => x.signalId === s.id)).toMatchObject({ strategy: 'precision' })
  })
})
