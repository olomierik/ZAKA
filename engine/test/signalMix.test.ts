// Why fast-scalp signals outnumbered snipes and dip rebounds (owner,
// 2026-09-30), and the fixes. The momentum rule itself is unchanged.
//   - the snipe rule counted the creator's launch buy: on a dev-sniped coin
//     "one buyer" had most of the buy volume, so no snipe could pass
//   - the momentum rule was checked before the dip rebound, and a rebound is a
//     burst of buying too: it became a scalp and the coin was held 30 minutes
//   - a risk not known yet (holders, funding) made a snipe a scalp and a
//     rebound rejected at once; they wait for the scan now
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import { computeFlow, type TapeTrade } from '../src/intel/flow'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { snipeReady } from '../src/signals/rules'
import { openPosition, recordSell, type Position } from '../src/trading/paper'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const DEV = A(0xde5)
const tape = (o: Partial<TapeTrade>): TapeTrade => ({ block: 110, ts: 0, wallet: A(1), side: 'BUY', usd: 60, tokens: 1_000, price: 0.01, ...o })

describe('the snipe rule reads the market\'s own buying', () => {
  const organic = Array.from({ length: 12 }, (_, i) => tape({ wallet: A(i + 1), block: 110 + i, price: 0.02 + i * 0.001 }))
  const devBuy = tape({ wallet: DEV, block: 100, usd: 2_500, tokens: 499_000_000, price: 0.005 })
  test('a creator who bought $2,500 at launch no longer blocks it as "one buyer"', () => {
    const f = computeFlow([devBuy, ...organic], { launchBlock: 100, creator: DEV, supply: 1e9 })
    expect(f.topBuyerPct).toBeGreaterThan(70) // what the rule used to read
    expect(f.organic).toMatchObject({ buyers: 12, buyUsd: 720, sellUsd: 0 })
    expect(f.organic.topBuyerPct).toBeCloseTo(100 / 12, 6)
    expect(snipeReady(f, 120).ok).toBe(true)
  })
  test('nor passes it on its own: $2,500 of dev buying and two small buyers isn\'t demand', () => {
    const f = computeFlow([devBuy, ...organic.slice(0, 2)], { launchBlock: 100, creator: DEV, supply: 1e9 })
    const r = snipeReady(f, 120)
    expect(r.ok).toBe(false)
    expect(r.failed).toEqual(expect.arrayContaining(['buyers']))
  })
  test('the launch blocks\' buyers are left out; every sale counts; "late" runs from the market\'s first price', () => {
    const f = computeFlow([
      tape({ wallet: A(50), block: 101, usd: 900, price: 0.004 }), // a launch-block sniper
      ...organic,
      tape({ wallet: A(50), side: 'SELL', block: 130, usd: 400, price: 0.027 }),
    ], { launchBlock: 100, creator: DEV, supply: 1e9 })
    expect(f.organic).toMatchObject({ buyers: 12, buyUsd: 720, sellUsd: 400, firstPrice: 0.02 })
    expect(snipeReady(f, 120).failed).toContain('ratio') // $720 bought vs $400 sold: under 2x
  })
})

// ── the bot, with a stand-in engine (as in botFlow.test.ts) ──

const T = '0x' + 'e8'.repeat(20)
const settle = () => new Promise(r => setTimeout(r, 25))

class TestBot extends Bot {
  /** The holders check: true (fine), false (a known risk), null (not read in time). */
  holdersOk: boolean | null = true
  override async report(token: string): Promise<SafetyReport> {
    const verdict = this.holdersOk === true ? 'pass' : 'risky'
    return { token, launchpad: 'ARGUS', at: Date.now(), verdict, score: 85, checks: [{ id: 'holders', ok: this.holdersOk, hard: false, risk: true, detail: this.holdersOk === null ? 'holders could not be read' : 'top 10 hold 30%' }], template: null, honeypot: { verdict: 'ok', roundTripLossPct: 3 } as never }
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
  const bot = new TestBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: (_t, m) => sent.push(m), mode: 'paper', speed: null })
  let i = 0
  const trade = (o: { side?: 'BUY' | 'SELL'; price: number; usd?: number; at: number; wallet?: string }) => {
    i++
    st.priceUsd = o.price
    const t: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: T, pair: `${T}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: o.side ?? 'BUY',
      baseAmount: 100, quoteAmount: o.usd ?? 60, tokenAmount: 100, price: o.price, priceUsd: o.price, usdValue: o.usd ?? 60, wallet: o.wallet ?? A(i),
      txHash: `0x${i}`, blockNumber: 10 + i, logIndex: 0, timestamp: o.at, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 20_000,
    }
    bot.onTrade(t, { replay: false })
  }
  const signals = () => sent.filter((m): m is Extract<ServerMessage, { t: 'SIGNAL' }> => m.t === 'SIGNAL').map(m => m.d)
  let clock = Date.now()
  /** Evaluates the coin again (the sweep, past its 2-second spacing). */
  const sweep = async () => { await settle(); clock += 3_000; bot.sweep(clock); await settle() }
  return { bot, trade, signals, sweep }
}

/** A coin that ran 2.2×, fell 41%, held a higher low and is being bought again: a dip rebound, and a momentum burst too. */
function rebound(trade: ReturnType<typeof setup>['trade']) {
  const now = Date.now(), m = (min: number) => now - min * 60_000
  trade({ price: 1, at: m(19) })
  trade({ price: 2.2, at: m(15) })
  trade({ side: 'SELL', price: 1.3, at: m(12) })
  trade({ price: 1.38, at: m(8) })
  // Thirteen buyers in the last two minutes, several in the last 30 seconds: a crowd still buying, as the momentum rule wants.
  for (let k = 0; k < 13; k++) trade({ price: 1.4 + k * 0.01, at: now - 110_000 + k * 8_500 })
}

describe('the rules\' order and the scan\'s unknowns', () => {
  test('a rebound that is also a momentum burst is a dip rebound now, not a scalp; no scalp follows it at once', async () => {
    const { trade, signals, sweep } = setup(20)
    rebound(trade)
    await sweep()
    await sweep()
    expect(signals().map(s => [s.strategy, s.rule])).toEqual([['second-leg', 'second-leg']])
  })
  test('on a coin with a known risk the rebound is rejected, and the momentum scalp fires as before', async () => {
    const { bot, trade, signals, sweep } = setup(20)
    bot.holdersOk = false
    rebound(trade)
    await sweep()
    expect(signals().map(s => [s.strategy, s.rule])).toEqual([['scalp', 'momentum']])
  })
  test('a snipe whose holders aren\'t read yet waits for the scan, then fires as a snipe', async () => {
    const { bot, trade, signals, sweep } = setup(2)
    bot.holdersOk = null
    const now = Date.now()
    for (let k = 0; k < 12; k++) trade({ price: 1 + k * 0.01, at: now - 60_000 + k * 4_500 })
    await sweep()
    expect(signals()).toEqual([])
    expect(bot.scan.get(T)).toMatchObject({ status: 'checking', keys: ['pending:holders'] })
    bot.holdersOk = true // the scan answered
    await sweep()
    expect(signals().map(s => [s.strategy, s.rule])).toEqual([['snipe', 'snipe']])
  })
  test('…and if they never are, it fires as a small, fast scalp, as before', async () => {
    const { bot, trade, signals, sweep } = setup(2)
    bot.holdersOk = null
    const now = Date.now()
    for (let k = 0; k < 12; k++) trade({ price: 1 + k * 0.01, at: now - 60_000 + k * 4_500 })
    await sweep()
    ;(bot as unknown as { riskWait: Map<string, number> }).riskWait.set(`snipe:${T}`, Date.now() - 60_000) // waited past the limit
    await sweep()
    expect(signals().map(s => [s.strategy, s.rule])).toEqual([['scalp', 'snipe']])
  })
})

describe('Core signals go to live bots, past their rule\'s probation (2026-10-01: regular live trades)', () => {
  /** Twelve losing paper snipes: the snipe rule is on probation. */
  const losingSnipes = (): Position[] => Array.from({ length: 12 }, (_, i) => {
    const p: Position = { ...openPosition({ id: `l${i}`, strategy: 'snipe', token: A(0x900 + i), symbol: 'L', launchpad: 'ARGUS', signalId: `l${i}`, price: 1, cost: 0.01, now: Date.now() - 3_600_000 + i * 60_000 }), mode: 'paper', rule: 'snipe' }
    recordSell(p, p.qty, p.sizeUsd * 0.85, p.openedAt + 60_000, 'stop')
    return p
  })
  const buyers = (trade: ReturnType<typeof setup>['trade'], n: number) => {
    const now = Date.now()
    for (let k = 0; k < n; k++) trade({ price: 1 + k * 0.008, at: now - 60_000 + k * 3_000 })
  }
  test('a wide crowd (Core) fires without the rule\'s probation, and live bots may take it', async () => {
    const { bot, trade, signals, sweep } = setup(2)
    bot.positions.push(...losingSnipes())
    buyers(trade, 16)
    await sweep()
    const [s] = signals()
    expect(s.quality?.level).toBe('core')
    expect(s.probation).toBeNull()
    expect(s.quality?.liveOk).toBe(true)
  })
  test('a Standard signal still carries it, and live bots pass it over', async () => {
    const { bot, trade, signals, sweep } = setup(2)
    bot.positions.push(...losingSnipes())
    buyers(trade, 11)
    await sweep()
    const [s] = signals()
    expect(s.quality?.level).toBe('standard')
    expect(s.probation?.why).toMatch(/Snipes won 0 of their last 12/)
    expect(s.quality?.liveOk).toBe(false)
  })
})
