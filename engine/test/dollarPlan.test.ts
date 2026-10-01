// The dollar plan (owner, 2026-10-01: "live bots use the snipe and fast scalp
// signals, $2 a trade, take $1 profit and close; let the agent self improve by
// learning from mistakes"): the take-profit that makes $1, the exits, live
// bots taking every snipe and fast scalp at $2, learning their entry filters
// from their own losses and the team's replays (the $1 never moves), and the
// engine replaying every signal on the plan for its record and probation.
import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import type { LaunchInfo, SignalFeatures } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { DOLLAR_PLAN, defaultDollarTuning, dollarParams, dollarTakeProfit } from '../src/bot/dollarPlan'
import { DOLLAR_LEARN, learn } from '../src/bot/learner'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import type { Signal } from '../src/bot/types'
import { READY, UserLive, WalletVault } from '../src/bot/userLive'
import type { Rpc } from '../src/chain/http'
import type { PoolInfo, PoolRegistry } from '../src/dex/pools'
import type { MarketEngine } from '../src/market/engine'
import { replayAtLiveSpeed } from '../src/signals/liveSpeed'
import { USDC20, type LiveExecutor } from '../src/trading/live'
import { canOpen, exitsAt, onPrice, openPosition, recordSell, STRATEGIES, type ExitReason } from '../src/trading/paper'

const now = Date.UTC(2026, 9, 1, 8)
const settle = () => new Promise(r => setTimeout(r, 30))
const tok = (k: number) => '0x' + k.toString(16).padStart(2, '0').repeat(20)
const T = tok(0xb1)
const poolOf = (token: string): PoolInfo => ({ pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: token as Address, fee: 10_000, tickSpacing: 200, hooks: null, base: token as Address, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 })
const features = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ ageSec: 40, liquidityUsd: 10_000, marketCapUsd: 30_000, buyers: 12, buySellRatio: 3, runUp: 1.2, topBuyerPct: 15, score: 85, flags: [], roundTripPct: 2, ...o })

describe('the take-profit that makes $1 on $2', () => {
  test('live: the price over what it paid, less the sale\'s cost; paper: both costs', () => {
    expect(dollarTakeProfit({ costIn: 0, costOut: 0.01 })).toBeCloseTo(1.5 / 0.99, 4)
    expect(dollarTakeProfit({ costIn: 0.01, costOut: 0.01 })).toBeCloseTo(1.5 * 1.01 / 0.99, 4)
    // A $2 paper trade with 1% costs, sold in full there, makes $1.
    const params = dollarParams('snipe', { costIn: 0.01, costOut: 0.01 })
    const p = openPosition({ id: 'p', strategy: 'snipe', token: T, symbol: 'C', launchpad: 'A', signalId: 's', price: 1, cost: 0.01, now, params })
    p.exits = params
    onPrice(p, params.tp1Multiple, now + 30_000, params)
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1', sizeUsd: 2 })
    expect(p.pnlUsd).toBeCloseTo(1, 2)
  })
  test('all of it at +$1; −10% stop (fast scalps −7%); out when the creator sells; 10 minutes (20) at most, with no earlier time stop', () => {
    const snipe = dollarParams('snipe', { costIn: 0, costOut: 0.01 })
    expect(snipe).toMatchObject({ sizeUsd: 2, tp1SellPct: 1, stopLoss: 0.9, maxHoldMin: 10, exitOnCreatorSell: true })
    expect(dollarParams('scalp', { costIn: 0, costOut: 0.01 })).toMatchObject({ stopLoss: 0.93, maxHoldMin: 20 })
    const p = openPosition({ id: 'p', strategy: 'snipe', token: T, symbol: 'C', launchpad: 'A', signalId: 's', price: 1, cost: 0, now, params: snipe })
    p.exits = snipe
    expect(exitsAt(p, 1.01, now + 5 * 60_000)).toEqual([]) // flat after 5 minutes: still held
    expect(exitsAt(p, 1.4, now + 9 * 60_000)).toEqual([]) // +40%: short of $1
    expect(exitsAt(p, 1.01, now + 10 * 60_000)[0].reason).toBe('time')
    expect(exitsAt(p, 0.89, now + 60_000)[0].reason).toBe('stop')
    expect(DOLLAR_PLAN).toMatchObject({ sizeUsd: 2, targetUsd: 1 })
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

/** A live bot on the dollar plan, its wallet holding $100. Its own picks: fast scalps only. */
async function liveBot(sellAt = 1.6) {
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

describe('live bots on the dollar plan', () => {
  test('every snipe and fast scalp, whatever the bot picked: $2, all of it sold once it makes $1', async () => {
    const { accounts, a, wallet, signal } = await liveBot(1.6)
    signal({ id: 'sn1', token: T }) // a snipe: the bot picked fast scalps only, it takes it anyway
    await settle()
    const p = a.positions.find(x => x.mode === 'live' && x.signalId === 'sn1')!
    expect(p).toMatchObject({ strategy: 'snipe', plan: 'dollar', sizeUsd: 2, rule: 'snipe' })
    expect(p.exits!.tp1Multiple).toBeCloseTo(1.515, 2) // +$1 after the sale's ~1% cost
    expect(p.exits).toMatchObject({ tp1SellPct: 1, stopLoss: 0.9, maxHoldMin: 10, exitOnCreatorSell: true })
    expect(wallet.calls).toEqual(['buy 2'])
    accounts.onPrice(T, 1.4, Date.now(), false, true) // +40%: held
    await settle()
    expect(p.status).toBe('open')
    accounts.onPrice(T, 1.6, Date.now(), false, true) // past +$1: all of it sold
    await settle()
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    const gross = (p.pnlUsd ?? 0) + (p.feeUsd ?? 0)
    expect(gross).toBeGreaterThan(1) // $3.20 back on $2, less gas
    // A momentum scalp too; a dip rebound isn't traded live.
    signal({ id: 'mo1', token: tok(0xb2), strategy: 'scalp', rule: 'momentum' })
    signal({ id: 'dr1', token: tok(0xb3), strategy: 'second-leg', rule: 'second-leg' })
    await settle()
    expect(a.positions.find(x => x.signalId === 'mo1')).toMatchObject({ mode: 'live', strategy: 'scalp', plan: 'dollar', exits: { stopLoss: 0.93, maxHoldMin: 20 } })
    expect(a.positions.some(x => x.signalId === 'dr1')).toBe(false)
    expect(a.skips.find(s => s.text.includes('Dip'))?.text ?? a.skips[0].text).toMatch(/live bots trade snipes and fast scalps/)
    expect(accounts.view(a).live).toMatchObject({ sizing: { tradeUsd: 2, growthPct: 0 }, plan: { sizeUsd: 2, targetUsd: 1 } })
  })
  test('a rule on probation is sat out', async () => {
    const { a, signal, wallet } = await liveBot()
    signal({ id: 'pr1', token: T, strategy: 'scalp', rule: 'momentum', probation: { why: 'Momentum bursts won 3 of their last 20 trades (−$9.00): bots sit them out until that recovers' } })
    await settle()
    expect(wallet.calls).toEqual([])
    expect(a.skips[0].text).toMatch(/not traded: Momentum bursts won 3 of their last 20/)
  })
  test('it learns from its own losing trades: a kind that lost 4 of 4 is skipped for 12 hours; the $1 take-profit never moves', async () => {
    const { accounts, a, wallet, signal } = await liveBot(0.85)
    for (let k = 0; k < 4; k++) {
      const token = tok(0xc0 + k)
      signal({ id: `l${k}`, token })
      await settle()
      accounts.onPrice(token, 0.85, Date.now(), false, true) // −15%: the stop, sold at 0.85
      await settle()
    }
    const lost = a.positions.filter(p => p.mode === 'live' && p.plan === 'dollar')
    expect(lost).toHaveLength(4)
    expect(lost.every(p => p.status === 'closed' && (p.pnlUsd ?? 0) < 0)).toBe(true)
    const t = a.dollarTuning!.snipe!
    expect(t.rules?.snipe?.skip).toBe(true)
    expect(t.takeProfit).toBe(1.5)
    expect(a.learnLog[0].text).toMatch(/^Live \(\$2, sold at \+\$1\): snipes: won 0 of its last 4/)
    // Its paper settings are untouched.
    expect(a.tuning.snipe.rules?.snipe?.skip).toBeFalsy()
    // The next snipe isn't bought (it waits out its 4-loss pause first, then its learned skip).
    a.pausedUntil = null
    wallet.calls.length = 0
    signal({ id: 'l5', token: tok(0xd0) })
    await settle()
    expect(wallet.calls).toEqual([])
    expect(a.skips[0].text).toMatch(/it learned to skip snipes for now/)
  })
  test('and from the team\'s replays before risking a cent: rugs in thin pools raise the liquidity it needs', async () => {
    const { accounts, a, signal, wallet } = await liveBot()
    // Ten replays of snipes on the plan: the six in thin pools were rugged, the four in deep pools made $1.
    for (let i = 0; i < 10; i++) {
      const thin = i < 6
      const p = openPosition({ id: `r${i}`, strategy: 'snipe', token: tok(0x10 + i), symbol: 'R', launchpad: 'A', signalId: `rs${i}`, price: 1, cost: 0, now: now - 3_600_000 + i * 60_000, params: dollarParams('snipe', { costIn: 0.01, costOut: 0.01 }) })
      Object.assign(p, { plan: 'dollar', mode: 'paper', rule: 'snipe', features: features({ liquidityUsd: thin ? 3_000 : 20_000 }) })
      recordSell(p, p.qty, thin ? 0.2 : 3, p.openedAt + 90_000, (thin ? 'rug' : 'tp1') as ExitReason)
      accounts.observeDollar(p)
    }
    accounts.tick(Date.now() + 11 * 60_000) // the team sync, every 10 minutes
    const t = a.dollarTuning!.snipe!
    expect(t.rules?.snipe?.minLiquidityUsd).toBeGreaterThan(3_000)
    expect(t.takeProfit).toBe(1.5)
    expect(a.learnLog[0].text).toMatch(/Live \(\$2, sold at \+\$1\): snipes: .*rugs or dumps.*\(read from its 0 trades and 10 of the team's\)/)
    signal({ id: 'th1', token: T, liquidityUsd: 3_000, features: features({ liquidityUsd: 3_000 }) })
    await settle()
    expect(wallet.calls).toEqual([])
    expect(a.skips[0].text).toMatch(/not traded live: liquidity \$3,000 is under its learned minimum/)
  })
  test("the day's loss counts from the plan's start: losses under the old exits don't keep a bot out", () => {
    const old = openPosition({ id: 'old', strategy: 'precision', token: T, symbol: 'DEGEN', launchpad: 'A', signalId: 'old', price: 1, cost: 0, now: DOLLAR_PLAN.since - 3_700_000, params: { ...STRATEGIES.precision, sizeUsd: 8 } })
    recordSell(old, old.qty, 0.5, DOLLAR_PLAN.since - 3_600_000, 'rug') // −$7.50 before the plan started
    const risk = { maxOpen: 3, maxOpenScalp: 2, cooldownMin: 360, dailyLossUsd: 5 }
    const later = DOLLAR_PLAN.since + 3_600_000
    expect(canOpen([old], tok(0xe1), later, risk).key).toBe('daily-loss')
    expect(canOpen([old], tok(0xe1), later, { ...risk, since: DOLLAR_PLAN.since }).ok).toBe(true)
  })
  test('learning on the plan keeps the $1 take-profit where near misses would have pulled it in', () => {
    const t = defaultDollarTuning('scalp')
    const near = Array.from({ length: 8 }, (_, i) => {
      const params = dollarParams('scalp', { costIn: 0, costOut: 0.01 })
      const p = openPosition({ id: `n${i}`, strategy: 'scalp', token: tok(0x30 + i), symbol: 'N', launchpad: 'A', signalId: `n${i}`, price: 1, cost: 0, now: now + i * 60_000, params })
      Object.assign(p, { exits: params, plan: 'dollar', mode: 'live', rule: 'momentum', features: features(), tuningVersion: 1, peak: 1.45 })
      recordSell(p, p.qty, i < 6 ? 1.8 : 3.1, p.openedAt + 300_000, i < 6 ? 'time' : 'tp1')
      return p
    })
    expect(learn(t, 'scalp', near, now + 3_600_000)?.tuning.takeProfit ?? t.takeProfit).toBeLessThan(1.5) // paper learning would move it
    expect(learn(t, 'scalp', near, now + 3_600_000, [], false, DOLLAR_LEARN)?.tuning.takeProfit ?? t.takeProfit).toBe(1.5)
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
    expect(v.kinds.find(k => k.rule === 'momentum')).toMatchObject({ replays: { trades: 11, wins: 0, hits: 0 }, probation: expect.stringMatching(/won 0 of their last 11/) })
    expect(v.exits.map(e => e.text)).toEqual(['$2 a trade, all of it sold once it makes $1; out at −10%, when the creator sells, or after 10 minutes', '$2 a trade, all of it sold once it makes $1; out at −7%, when the creator sells, or after 20 minutes'])
  })
  test('a replay on the plan: +$1 when the price gets there within the hold; the creator\'s sale closes it', () => {
    const c = 0.01
    const exits = dollarParams('snipe', { costIn: c, costOut: c })
    const up = [{ ts: now + 3_000, price: 1 }, { ts: now + 60_000, price: 1.3 }, { ts: now + 120_000, price: 1.6 }, { ts: now + 123_000, price: 1.62 }]
    const r = replayAtLiveSpeed(up, { at: now, price: 1, roundTripPct: 2, exits, now: now + 3_600_000 })
    expect(r).toMatchObject({ reason: 'tp1', final: true })
    expect(r.ret! * 2).toBeGreaterThan(1)
    const dumped = [{ ts: now + 3_000, price: 1 }, { ts: now + 30_000, price: 1.05, creatorSold: true }, { ts: now + 33_000, price: 0.7 }]
    expect(replayAtLiveSpeed(dumped, { at: now, price: 1, roundTripPct: 2, exits, now: now + 3_600_000 })).toMatchObject({ reason: 'creator', final: true })
  })
})
