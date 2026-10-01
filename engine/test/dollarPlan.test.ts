// The $2 plan, version 2: quick take-profits (owner, 2026-10-01: "Nothing happened, no trades, I hate waiting for hours
// in meme coin trading, I prefer quick take profits and leave"). The take-profit (+7.5% after costs, about +10% on the
// price), the exits (−7%, 3 minutes), live bots taking every snipe at $2 and passing over crowded coins and momentum
// bursts not yet proven, learning their entry filters from their own losses and the team's replays without ever
// turning away most signals, and the engine replaying every signal on the plan for its record and probation.
import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import type { LaunchInfo, SignalFeatures } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { DOLLAR_PLAN, DOLLAR_TARGET_USD, defaultDollarTuning, dollarParams, dollarTakeProfit, onThisPlan, planBlocks, QUICK_LEARN } from '../src/bot/dollarPlan'
import { admits, defaultTuning, learn } from '../src/bot/learner'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import type { Signal } from '../src/bot/types'
import { READY, UserLive, WalletVault } from '../src/bot/userLive'
import type { Rpc } from '../src/chain/http'
import type { PoolInfo, PoolRegistry } from '../src/dex/pools'
import type { MarketEngine } from '../src/market/engine'
import { replayAtLiveSpeed } from '../src/signals/liveSpeed'
import { USDC20, type LiveExecutor } from '../src/trading/live'
import { canOpen, exitsAt, onPrice, openPosition, recordSell, STRATEGIES, type ExitReason, type Position } from '../src/trading/paper'

const now = DOLLAR_PLAN.since + 3_600_000
const settle = () => new Promise(r => setTimeout(r, 30))
const tok = (k: number) => '0x' + k.toString(16).padStart(2, '0').repeat(20)
const T = tok(0xb1)
const poolOf = (token: string): PoolInfo => ({ pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: token as Address, fee: 10_000, tickSpacing: 200, hooks: null, base: token as Address, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 })
const features = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ ageSec: 40, liquidityUsd: 10_000, marketCapUsd: 30_000, buyers: 12, buySellRatio: 3, runUp: 1.2, topBuyerPct: 15, score: 85, flags: [], roundTripPct: 2, ...o })

describe('the take-profit: +7.5% after costs on $2', () => {
  test('live: the price over what it paid, less the sale\'s cost; paper: both costs', () => {
    expect(dollarTakeProfit({ costIn: 0, costOut: 0.01 })).toBeCloseTo(1.075 / 0.99, 4)
    expect(dollarTakeProfit({ costIn: 0.012, costOut: 0.012 })).toBeCloseTo(1.1012, 3) // about +10% on the price
    // A $2 paper trade with 1% costs, sold in full there, makes $0.15.
    const params = dollarParams('snipe', { costIn: 0.01, costOut: 0.01 })
    const p = openPosition({ id: 'p', strategy: 'snipe', token: T, symbol: 'C', launchpad: 'A', signalId: 's', price: 1, cost: 0.01, now, params })
    p.exits = params
    onPrice(p, params.tp1Multiple, now + 30_000, params)
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1', sizeUsd: 2 })
    expect(p.pnlUsd).toBeCloseTo(0.15, 2)
    expect(DOLLAR_TARGET_USD).toBe(0.15)
  })
  test('all of it at the take-profit; −7% stop; out when the creator sells; 3 minutes at most, with no earlier time stop', () => {
    const snipe = dollarParams('snipe', { costIn: 0, costOut: 0.01 })
    expect(snipe).toMatchObject({ sizeUsd: 2, tp1SellPct: 1, stopLoss: 0.93, maxHoldMin: 3, timeStopMin: 3, exitOnCreatorSell: true })
    expect(dollarParams('scalp', { costIn: 0, costOut: 0.01 })).toMatchObject({ stopLoss: 0.93, maxHoldMin: 3 })
    const p = openPosition({ id: 'p', strategy: 'snipe', token: T, symbol: 'C', launchpad: 'A', signalId: 's', price: 1, cost: 0, now, params: snipe })
    p.exits = snipe
    expect(exitsAt(p, 1.01, now + 2 * 60_000)).toEqual([]) // flat after 2 minutes: still held
    expect(exitsAt(p, 1.05, now + 2.5 * 60_000)).toEqual([]) // +5%: short of the take-profit
    expect(exitsAt(p, 1.09, now + 60_000)[0].reason).toBe('tp1')
    expect(exitsAt(p, 1.01, now + 3 * 60_000)[0].reason).toBe('time')
    expect(exitsAt(p, 0.92, now + 60_000)[0].reason).toBe('stop')
    expect(DOLLAR_PLAN).toMatchObject({ version: 2, sizeUsd: 2, netGain: 0.075, maxBuyers: 80 })
  })
  test('80 buyers or fewer already in, and no wallet over 15% of the buying; a count the signal lacks isn\'t checked', () => {
    expect(planBlocks(features({ totalBuyers: 80 }))).toBeNull()
    expect(planBlocks(features({ totalBuyers: 81 }))).toMatchObject({ key: 'crowded', why: expect.stringMatching(/^81 buyers already in \(live bots buy coins with 80 or fewer/) })
    expect(planBlocks(features())).toBeNull()
    expect(planBlocks(features({ topBuyerPct: 15 }))).toBeNull()
    // Today's three rugs: one wallet held 17–25% of the buying.
    expect(planBlocks(features({ topBuyerPct: 17.2 }))).toMatchObject({ key: 'top-buyer', why: expect.stringMatching(/^one wallet bought 17% of the buying \(live bots buy coins where none is over 15%/) })
  })
})

/** A stand-in bot wallet: buys at $1 a token, sells at `sellAt`, records every call. */
function stubWallet(o: { balance: number; sellAt: number }) {
  const calls: string[] = []
  let held = 0n
  const exec = {
    address: '0x' + 'ab'.repeat(20) as Address,
    ready: async () => '0x' as Address,
    balanceUsd: async () => o.balance,
    buy: async (_p: PoolInfo, _t: Address, usd: number) => { calls.push(`buy ${usd}`); held = BigInt(Math.round(usd * 1e6)) * 10n ** 12n; o.balance -= usd; return { hash: '0xb' as Hex, tokens: held, usd, gasUsd: 0.01, at: Date.now() } },
    approveForSale: async () => [],
    tokenBalance: async () => held,
    sell: async (_p: PoolInfo, _t: Address, amount: bigint) => { const usd = Number(amount) / 1e18 * o.sellAt; calls.push(`sell ${usd.toFixed(2)}`); held -= amount; o.balance += usd; return { hash: '0xs' as Hex, tokens: amount, usd, gasUsd: 0.01, at: Date.now() } },
    sendUsdc: async (to: Address, usd: number) => { calls.push(`send ${usd} to ${to}`); o.balance -= usd; return { hash: '0xf' as Hex, tokens: 0n, usd, gasUsd: 0.001, at: Date.now() } },
  }
  return { calls, exec: exec as unknown as LiveExecutor, o }
}

/** A live bot on the plan, its wallet holding $100. Its own picks: fast scalps only. */
async function liveBot(sellAt = 1.12) {
  const store = new MemoryBotStore()
  const wallet = stubWallet({ balance: 100, sellAt })
  const live = new UserLive({ vault: new WalletVault('11'.repeat(32)), makeExec: () => wallet.exec, pools: token => poolOf(token) })
  const accounts = new PaperAccounts({ speed: null, store, priceOf: () => 1, params: s => STRATEGIES[s], live, liveRouting: 'dollar' })
  const a = (accounts.create(now, { name: 'Dollar', strategies: ['scalp'] }, 'owner') as { account: PaperAccount }).account
  for (let i = 0; i < READY.minTrades; i++) {
    const p = openPosition({ id: `p${i}`, strategy: 'scalp', token: tok(i + 1), symbol: 'X', launchpad: 'Argus', signalId: `x${i}`, price: 1, cost: 0.01, now: now - 3_600_000 + i * 60_000 })
    p.mode = 'paper'
    recordSell(p, p.qty, p.qty * (i % 4 ? 1.2 : 0.9), p.openedAt + 60_000, i % 4 ? 'tp1' : 'stop')
    a.positions.push(p)
  }
  accounts.createWallet(a, now)
  expect(await accounts.setMode(a, 'live', { verified: true }, now)).toBeNull()
  accounts.act(a, { action: 'start' }, now)
  const signal = (o: Partial<PaperSignal> & { id: string; token: string }) => {
    const s: PaperSignal = { symbol: 'COIN', launchpad: 'Argus', price: 1, strategy: 'snipe', rule: 'snipe', roundTripPct: 2, liquidityUsd: 10_000, features: features(), ...o }
    accounts.onSignal(s, Date.now(), { signal: { id: s.id, token: s.token, strategy: s.strategy } as never, pool: poolOf(s.token), meta: { token: s.token, symbol: 'COIN', launchpad: 'Argus' } as never })
  }
  return { accounts, a, wallet, signal }
}

describe('live bots on the plan', () => {
  test('every snipe, whatever the bot picked: $2, all of it sold at about +10%', async () => {
    const { accounts, a, wallet, signal } = await liveBot(1.12)
    signal({ id: 'sn1', token: T }) // a snipe: the bot picked fast scalps only, it takes it anyway
    await settle()
    const p = a.positions.find(x => x.mode === 'live' && x.signalId === 'sn1')!
    expect(p).toMatchObject({ strategy: 'snipe', plan: 'dollar', sizeUsd: 2, rule: 'snipe' })
    expect(p.exits!.tp1Multiple).toBeCloseTo(1.086, 2) // +7.5% after the sale's ~1% cost
    expect(p.exits).toMatchObject({ tp1SellPct: 1, stopLoss: 0.93, maxHoldMin: 3, exitOnCreatorSell: true })
    expect(wallet.calls).toEqual(['buy 2'])
    accounts.onPrice(T, 1.05, Date.now(), false, true) // +5%: held
    await settle()
    expect(p.status).toBe('open')
    accounts.onPrice(T, 1.12, Date.now(), false, true) // past the take-profit: all of it sold
    await settle()
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    const gross = (p.pnlUsd ?? 0) + (p.feeUsd ?? 0)
    expect(gross).toBeGreaterThan(0.15) // $2.24 back on $2, less gas
    expect(accounts.view(a).live).toMatchObject({ sizing: { tradeUsd: 2, growthPct: 0 }, plan: { sizeUsd: 2, targetUsd: 0.15, takeProfitPct: 7.5, maxHoldMin: 3 } })
  })
  test('passed over: a crowded coin, a momentum burst and a comeback not yet proven', async () => {
    const { a, wallet, signal } = await liveBot()
    signal({ id: 'cr1', token: tok(0xb4), features: features({ totalBuyers: 140 }) })
    signal({ id: 'tb1', token: tok(0xb6), features: features({ topBuyerPct: 24.9 }) })
    signal({ id: 'mo1', token: tok(0xb2), strategy: 'scalp', rule: 'momentum' })
    signal({ id: 'dr1', token: tok(0xb3), strategy: 'second-leg', rule: 'second-leg' })
    await settle()
    expect(wallet.calls).toEqual([])
    const texts = a.skips.map(s => s.text)
    expect(texts.some(t => /not traded live: 140 buyers already in \(live bots buy coins with 80 or fewer/.test(t))).toBe(true)
    expect(texts.some(t => /not traded live: one wallet bought 25% of the buying/.test(t))).toBe(true)
    expect(texts.filter(t => /momentum bursts and comebacks are replayed and measured first/.test(t))).toHaveLength(2)
    // Once the engine says a momentum burst is proven (its replays on the plan made money), it's bought.
    signal({ id: 'mo2', token: tok(0xb5), strategy: 'scalp', rule: 'momentum', quality: { score: 70, grade: 'live', tier: 'A', rank: null, parts: [], liveOk: true, liveWhy: null } as never })
    await settle()
    expect(wallet.calls).toEqual(['buy 2'])
  })
  test('a rule on probation is sat out', async () => {
    const { a, signal, wallet } = await liveBot()
    signal({ id: 'pr1', token: T, probation: { why: 'Snipes won 3 of their last 20 trades (−$9.00): bots sit them out until that recovers' } })
    await settle()
    expect(wallet.calls).toEqual([])
    expect(a.skips[0].text).toMatch(/not traded: Snipes won 3 of their last 20/)
  })
  test('four losses in a row pause it for 30 minutes, but no lesson stops it trading: the take-profit never moves', async () => {
    const { accounts, a, wallet, signal } = await liveBot(0.9)
    for (let k = 0; k < 4; k++) {
      const token = tok(0xc0 + k)
      signal({ id: `l${k}`, token })
      await settle()
      accounts.onPrice(token, 0.9, Date.now(), false, true) // −10%: the stop, sold at 0.9
      await settle()
    }
    const lost = a.positions.filter(p => p.mode === 'live' && p.plan === 'dollar')
    expect(lost).toHaveLength(4)
    expect(lost.every(p => p.status === 'closed' && (p.pnlUsd ?? 0) < 0)).toBe(true)
    const t = a.dollarTuning!.snipe!
    expect(t.rules?.snipe?.skip).toBeFalsy() // skipping snipes would turn away every one of them
    expect(t.takeProfit).toBe(1.075)
    expect(a.pausedUntil).toBeGreaterThan(Date.now())
    // After the pause, the next snipe is bought.
    a.pausedUntil = null
    wallet.calls.length = 0
    signal({ id: 'l5', token: tok(0xd0) })
    await settle()
    expect(wallet.calls).toEqual(['buy 2'])
  })
  test('it learns from the team\'s replays before risking a cent: rugs in thin pools raise the liquidity it needs', async () => {
    const { accounts, a, signal, wallet } = await liveBot()
    // Ten replays of snipes on the plan: the three in thin pools were rugged, the seven in deep pools took their profit.
    for (let i = 0; i < 10; i++) {
      const thin = i < 3
      const p = openPosition({ id: `r${i}`, strategy: 'snipe', token: tok(0x10 + i), symbol: 'R', launchpad: 'A', signalId: `rs${i}`, price: 1, cost: 0, now: now - 3_600_000 + i * 60_000, params: dollarParams('snipe', { costIn: 0.01, costOut: 0.01 }) })
      Object.assign(p, { plan: 'dollar', mode: 'paper', rule: 'snipe', features: features({ liquidityUsd: thin ? 3_000 : 20_000 }) })
      recordSell(p, p.qty, thin ? 0.2 : 2.2, p.openedAt + 90_000, (thin ? 'rug' : 'tp1') as ExitReason)
      accounts.observeDollar(p)
    }
    accounts.tick(Date.now() + 11 * 60_000) // the team sync, every 10 minutes
    const t = a.dollarTuning!.snipe!
    expect(t.rules?.snipe?.minLiquidityUsd).toBeGreaterThan(3_000)
    expect(t.takeProfit).toBe(1.075)
    expect(a.learnLog[0].text).toMatch(/^Live \(\$2, quick take-profits\): snipes: .*\(read from its 0 trades and 10 of the team's\)/)
    signal({ id: 'th1', token: T, liquidityUsd: 3_000, features: features({ liquidityUsd: 3_000 }) })
    await settle()
    expect(wallet.calls).toEqual([])
    expect(a.skips[0].text).toMatch(/not traded live: liquidity \$3,000 is under its learned minimum/)
  })
  test("the day's loss counts from the plan's start: losses under the old exits don't keep a bot out", () => {
    const old = openPosition({ id: 'old', strategy: 'snipe', token: T, symbol: 'NOAH', launchpad: 'A', signalId: 'old', price: 1, cost: 0, now: DOLLAR_PLAN.since - 3_700_000, params: { ...STRATEGIES.snipe, sizeUsd: 8 } })
    recordSell(old, old.qty, 0.5, DOLLAR_PLAN.since - 3_600_000, 'rug') // −$7.50 before the plan started
    const risk = { maxOpen: 3, maxOpenScalp: 2, cooldownMin: 360, dailyLossUsd: 5 }
    const later = DOLLAR_PLAN.since + 3_600_000
    expect(canOpen([old], tok(0xe1), later, risk).key).toBe('daily-loss')
    expect(canOpen([old], tok(0xe1), later, { ...risk, since: DOLLAR_PLAN.since }).ok).toBe(true)
  })
})

describe('learning on the plan', () => {
  /** A closed $2 trade on the plan in a pool with `liquidityUsd`. */
  const trade = (i: number, liquidityUsd: number, won: boolean): Position => {
    const params = dollarParams('snipe', { costIn: 0, costOut: 0.01 })
    const p = openPosition({ id: `q${i}`, strategy: 'snipe', token: tok(0x50 + i), symbol: 'Q', launchpad: 'A', signalId: `q${i}`, price: 1, cost: 0, now: now + i * 60_000, params })
    Object.assign(p, { exits: params, plan: 'dollar', mode: 'paper', rule: 'snipe', features: features({ liquidityUsd }) })
    recordSell(p, p.qty, won ? 2.2 : 1, p.openedAt + 90_000, won ? 'tp1' : 'rug')
    return p
  }
  test('a lesson that would turn away more than half of the kind\'s recent signals isn\'t taken', () => {
    // Six thin pools rugged, four deep ones won: "liquidity of at least $20,000" would skip six of ten.
    const team = Array.from({ length: 10 }, (_, i) => trade(i, i < 6 ? 3_000 : 20_000, i >= 6))
    const free = learn(defaultTuning('snipe'), 'snipe', [], now + 3_600_000, team, true, { pinTakeProfit: true })!
    expect(free.tuning.rules!.snipe!.minLiquidityUsd).toBe(20_000) // without the guard
    const guarded = learn(defaultDollarTuning('snipe'), 'snipe', [], now + 3_600_000, team, true, QUICK_LEARN)
    const f = guarded?.tuning.rules?.snipe
    expect(f?.minLiquidityUsd ?? 0).toBeLessThanOrEqual(3_000)
    expect(admits(guarded?.tuning ?? defaultDollarTuning('snipe'), features({ liquidityUsd: 3_000 }), 'snipe')).toBeNull()
  })
  test('the take-profit stays where near misses would have pulled it in', () => {
    const t = defaultDollarTuning('scalp')
    const near = Array.from({ length: 8 }, (_, i) => {
      const params = dollarParams('scalp', { costIn: 0, costOut: 0.01 })
      const p = openPosition({ id: `n${i}`, strategy: 'scalp', token: tok(0x30 + i), symbol: 'N', launchpad: 'A', signalId: `n${i}`, price: 1, cost: 0, now: now + i * 60_000, params })
      Object.assign(p, { exits: params, plan: 'dollar', mode: 'live', rule: 'snipe', features: features(), tuningVersion: 1, peak: 1.07 })
      recordSell(p, p.qty, i < 6 ? 1.9 : 2.2, p.openedAt + 180_000, i < 6 ? 'time' : 'tp1')
      return p
    })
    expect(learn(t, 'scalp', near, now + 3_600_000)?.tuning.takeProfit ?? t.takeProfit).toBeLessThan(1.075) // paper learning would move it
    expect(learn(t, 'scalp', near, now + 3_600_000, [], false, QUICK_LEARN)?.tuning.takeProfit ?? t.takeProfit).toBe(1.075)
  })
  test('settings learned on the +$1 plan start over', () => {
    const old = { ...defaultTuning('snipe'), takeProfit: 1.5, targetUsd: 1, rules: { snipe: { ...defaultTuning('snipe').filters, maxRunUp: 1.08, avoidFlags: ['copycat'] } } }
    expect(onThisPlan(old)).toBe(false)
    expect(onThisPlan(defaultDollarTuning('snipe'))).toBe(true)
  })
  test('a live bot loaded with +$1 settings starts over on this plan, and its log says why', async () => {
    const store = new MemoryBotStore()
    const first = new PaperAccounts({ speed: null, store, priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'dollar' })
    const a = (first.create(now, { name: 'Veteran', strategies: ['snipe'] }, 'owner') as { account: PaperAccount }).account
    a.mode = 'live'
    a.dollarTuning = { snipe: { ...defaultTuning('snipe'), version: 6, takeProfit: 1.5, targetUsd: 1, rules: { snipe: { ...defaultTuning('snipe').filters, maxRunUp: 1.08, avoidFlags: ['copycat'] } } } }
    store.savePaperAccount(a)
    const second = new PaperAccounts({ speed: null, store, priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'dollar' })
    await second.load()
    const b = second.bySlugOf(a.slug)!
    expect(b.dollarTuning!.snipe).toMatchObject({ takeProfit: 1.075, livePlan: 2, version: 1 })
    expect(b.dollarTuning!.snipe!.rules?.snipe).toBeUndefined()
    expect(b.learnLog[0].text).toMatch(/^Live \(\$2, quick take-profits\): the live plan changed to quick take-profits/)
  })
})

describe('the engine replays every snipe and fast scalp on the plan', () => {
  test('its record, a creator\'s sale closing a replay, and probation for a rule whose replays lose', async () => {
    const store = new MemoryBotStore()
    const creator = '0x' + 'de'.repeat(20)
    const mk = (i: number): Signal => ({ id: `m${i}`, strategy: 'scalp', rule: 'momentum', token: tok(0x40 + i), symbol: `M${i}`, name: 'M', launchpad: 'ARGUS', at: now - 3 * 3_600_000 + i * 60_000, price: 1, marketCapUsd: null, liquidityUsd: 7_000, ageSec: 600, reasons: [], safety: { verdict: 'pass', score: 90, checks: [] }, executable: true, features: features({ ageSec: 600 }) } as unknown as Signal)
    const sigs = Array.from({ length: 11 }, (_, i) => mk(i))
    for (const s of sigs) store.saveSignal(s)
    const metas = new Map<string, LaunchInfo>(sigs.map(s => [s.token, { token: s.token, creator } as LaunchInfo]))
    const history = {
      trades: async (token: string) => {
        const s = sigs.find(x => x.token === token)!
        // Every one dumps through the stop; the last one's creator sells first.
        const last = s.id === 'm10'
        return Array.from({ length: 20 }, (_, i) => ({ timestamp: s.at + 3_000 + i * 10_000, priceUsd: 1 - i * 0.01, side: last && i === 2 ? 'SELL' : 'BUY', wallet: last && i === 2 ? creator : '0xbuyer' })).reverse() as never
      },
    }
    const engine = { metas, tokens: new Map() } as unknown as MarketEngine
    const accounts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s], liveRouting: 'dollar' })
    const bot = new Bot({ rpc: {} as Rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store, publish: () => {}, mode: 'paper', history, accounts, liveGrades: 'dollar' })
    await bot.start()
    for (let i = 0; i < 3; i++) await bot.replayDue(now, 8)
    expect(bot.dollar.size).toBe(11)
    const replays = [...bot.dollar.values()]
    expect(replays.every(p => p.plan === 'dollar' && p.status === 'closed' && (p.pnlUsd ?? 0) < 0)).toBe(true)
    expect(bot.dollar.get('m10')!.exitReason).toBe('creator')
    expect(bot.dollar.get('m0')!.exitReason).toBe('stop')
    expect(accounts.dollarTeam('scalp')).toHaveLength(11) // what live bots learn from
    expect(bot.dollarProbation('momentum', now)?.why).toMatch(/Momentum bursts won 0 of their last 11 trades/)
    const v = bot.dollarView(now)
    expect(v).toMatchObject({ sizeUsd: 2, targetUsd: 0.15, netGainPct: 7.5, maxBuyers: 80, maxTopBuyerPct: 15 })
    expect(v.kinds.find(k => k.rule === 'momentum')).toMatchObject({ replays: { trades: 11, wins: 0, hits: 0 }, probation: expect.stringMatching(/won 0 of their last 11/) })
    expect(v.exits.map(e => e.text)).toEqual(Array(3).fill('$2 a trade, all of it sold at +7.5% after costs (about +10% on the price); out at −7%, when the creator sells, or after 3 minutes'))
  })
  test('momentum bursts are measured first: not proven until their replays make money', async () => {
    const store = new MemoryBotStore()
    const engine = { metas: new Map(), tokens: new Map() } as unknown as MarketEngine
    const bot = new Bot({ rpc: {} as Rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store, publish: () => {}, mode: 'paper', liveGrades: 'dollar' })
    const add = (i: number, won: boolean) => {
      const p = openPosition({ id: `w${i}`, strategy: 'scalp', token: tok(0x60 + i), symbol: 'W', launchpad: 'A', signalId: `w${i}`, price: 1, cost: 0, now: now - 3_600_000 + i * 60_000, params: dollarParams('scalp', { costIn: 0.01, costOut: 0.01 }) })
      Object.assign(p, { plan: 'dollar', mode: 'paper', rule: 'momentum', features: features() })
      recordSell(p, p.qty, won ? 2.15 : 1.86, p.openedAt + 60_000, won ? 'tp1' : 'stop')
      bot.dollar.set(p.signalId, p)
    }
    for (let i = 0; i < 9; i++) add(i, i % 3 !== 0)
    const view = () => bot.dollarView(now).kinds.find(k => k.rule === 'momentum')!.probation
    expect(view()).toMatch(/momentum bursts are replayed and measured first: 9 of the 10 replays needed so far/)
    add(9, true) // 10 replays, 7 won, +$0.21 in all
    expect(view()).toBeNull()
  })
  test('a replay on the plan: the take-profit when the price gets there within 3 minutes; the creator\'s sale closes it', () => {
    const c = 0.01
    const exits = dollarParams('snipe', { costIn: c, costOut: c })
    const up = [{ ts: now + 3_000, price: 1 }, { ts: now + 60_000, price: 1.05 }, { ts: now + 90_000, price: 1.12 }, { ts: now + 93_000, price: 1.13 }]
    const r = replayAtLiveSpeed(up, { at: now, price: 1, roundTripPct: 2, exits, now: now + 3_600_000 })
    expect(r).toMatchObject({ reason: 'tp1', final: true })
    expect(r.ret! * 2).toBeGreaterThan(0.15)
    const flat = [{ ts: now + 3_000, price: 1 }, { ts: now + 100_000, price: 1.02 }, { ts: now + 185_000, price: 1.01 }, { ts: now + 190_000, price: 1.01 }]
    expect(replayAtLiveSpeed(flat, { at: now, price: 1, roundTripPct: 2, exits, now: now + 3_600_000 })).toMatchObject({ reason: 'time', final: true })
    const dumped = [{ ts: now + 3_000, price: 1 }, { ts: now + 30_000, price: 1.05, creatorSold: true }, { ts: now + 33_000, price: 0.7 }]
    expect(replayAtLiveSpeed(dumped, { at: now, price: 1, roundTripPct: 2, exits, now: now + 3_600_000 })).toMatchObject({ reason: 'creator', final: true })
  })
})
