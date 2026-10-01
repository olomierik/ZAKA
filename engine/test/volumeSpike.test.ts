// The volume-spike fast scalp (owner, 2026-10-01: "provide a signal after detecting a spike in trading volume; no coins
// with fewer than 30 holders; market cap above $6,000; liquidity above $5,000; take 25% profit"): the rule, its
// baseline and holder count, and the engine firing it on a coin whose last minute's trading jumps.
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { dollarParams, planBlocks, volumeParams } from '../src/bot/dollarPlan'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import { tapeHolders, windowOf, type TapeTrade } from '../src/intel/flow'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { baselinePerMin, PricePath, RULES, volumeReady } from '../src/signals/rules'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const tape = (o: Partial<TapeTrade>): TapeTrade => ({ block: 1, ts: 0, wallet: A(1), side: 'BUY', usd: 60, tokens: 1_000, price: 0.01, ...o })

describe('the rule', () => {
  const minute = (buys: number, sells = 0, from = 1, to = 1.05) => windowOf([
    ...Array.from({ length: buys }, (_, k) => tape({ ts: k, side: 'BUY', usd: 60, wallet: A(100 + k), price: from + ((to - from) * k) / Math.max(1, buys) })),
    ...Array.from({ length: sells }, (_, k) => tape({ ts: buys + k, side: 'SELL', usd: 60, wallet: A(200 + k), price: to })),
  ])
  const ok = { ageSec: 1_200, last: minute(10), baselinePerMin: 40, holders: 45, marketCapUsd: 20_000, liquidityUsd: 12_000 }
  test('fires on the last minute 3× its usual, mostly buying, with the owner\'s floors met', () => {
    const r = volumeReady(ok)
    expect(r.ok).toBe(true)
    expect(r.spike).toBe(15) // $600 against $40 a minute
    expect(r.reasons.join(' · ')).toMatch(/20 min old · \$600 traded in the last minute · 15\.0× its usual \$40 a minute · 100% of it buying/)
  })
  test('not on a young coin, a small or slow minute, selling, a falling price, or under the floors', () => {
    const fails = (o: Partial<typeof ok>) => volumeReady({ ...ok, ...o }).failed
    expect(fails({ ageSec: 300 })).toEqual(['age']) // the launch wave isn't a spike
    expect(fails({ last: minute(3) })).toEqual(['volume']) // $180
    expect(fails({ baselinePerMin: 250 })).toEqual(['spike']) // $600 is 2.4× $250
    expect(fails({ last: minute(6, 4) })).toEqual(['buys']) // 60% buying
    expect(fails({ last: minute(10, 0, 1.05, 1) })).toEqual(['move'])
    expect(fails({ holders: 29 })).toEqual(['holders'])
    expect(fails({ marketCapUsd: 5_999 })).toEqual(['mcap'])
    expect(fails({ liquidityUsd: 4_999 })).toEqual(['liquidity'])
    expect(RULES.volume).toMatchObject({ minHolders: 30, minMarketCapUsd: 6_000, minLiquidityUsd: 5_000, minAgeSec: 600 })
  })
  test('its usual rate: the 10 minutes before the last two, quiet minutes counting as nothing', () => {
    const now = Date.UTC(2026, 9, 1, 12, 30, 30)
    const p = new PricePath(now - 3_600_000)
    for (let m = 15; m >= 1; m--) p.add(now - m * 60_000, 1, 'BUY', 50) // $50 a minute for the last 15 minutes (in time order, as trades arrive)
    p.add(now - 10_000, 1, 'BUY', 5_000) // the spike itself isn't in its own baseline
    expect(baselinePerMin(p, now)).toBe(50)
    const quiet = new PricePath(now - 3_600_000)
    quiet.add(now - 5 * 60_000, 1, 'SELL', 100) // one trade in ten minutes
    expect(baselinePerMin(quiet, now)).toBe(10)
  })
  test('holders: wallets still holding what they bought', () => {
    expect(tapeHolders([
      tape({ wallet: A(1), tokens: 100 }), tape({ wallet: A(2), tokens: 100 }), tape({ wallet: A(3), tokens: 100 }),
      tape({ wallet: A(2), side: 'SELL', tokens: 100 }), // sold all of it
      tape({ wallet: A(3), side: 'SELL', tokens: 40 }), // still holds some
      tape({ wallet: null, tokens: 100 }),
    ])).toBe(2)
  })
  test('sold at +25% on the price (+22.5% after costs), −10%, 20 minutes; the snipes\' limits don\'t apply', () => {
    const paper = volumeParams({ costIn: 0.012, costOut: 0.012, sizeUsd: 10 })
    expect(paper.tp1Multiple).toBeCloseTo(1.2548, 3)
    expect(paper).toMatchObject({ tp1SellPct: 1, stopLoss: 0.9, maxHoldMin: 20, timeStopMin: 20, exitOnCreatorSell: true })
    expect(dollarParams('scalp', { costIn: 0, costOut: 0.012, sizeUsd: 8 }, 'volume').tp1Multiple).toBeCloseTo(1.225 / 0.988, 3)
    const crowd = { ageSec: 1_800, liquidityUsd: 20_000, marketCapUsd: 90_000, buyers: 20, buySellRatio: 5, runUp: 1.1, topBuyerPct: 30, score: 90, flags: [], roundTripPct: 2, totalBuyers: 300 }
    expect(planBlocks(crowd, 'volume')).toBeNull()
    expect(planBlocks(crowd, 'snipe')?.key).toBe('crowded')
  })
})

// ── the engine, with a stand-in chain (as in signalMix.test.ts) ──

const T = '0x' + 'e7'.repeat(20)
const settle = () => new Promise(r => setTimeout(r, 25))
class TestBot extends Bot {
  override async report(token: string): Promise<SafetyReport> {
    return { token, launchpad: 'ARGUS', at: Date.now(), verdict: 'pass', score: 85, checks: [], template: null, honeypot: { verdict: 'ok', roundTripLossPct: 2 } as never }
  }
}

function setup(o: { ageMin: number; liquidityUsd?: number }) {
  const now = Date.now()
  const meta: LaunchInfo = { token: T, name: 'Coin', symbol: 'COIN', decimals: 18, creator: A(0xde5), txHash: '0x', blockNumber: 1, timestamp: now - o.ageMin * 60_000, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
  const st = new TokenState(T)
  Object.assign(st, { priceUsd: 0.00001, mainPool: 'pool1', liquidityUsd: o.liquidityUsd ?? 12_000, supply: 1e9 }) // a $10,000 market cap
  const engine = { metas: new Map([[T, meta]]), tokens: new Map([[T, st]]) } as unknown as MarketEngine
  const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
  const sent: ServerMessage[] = []
  const bot = new TestBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: (_t, m) => sent.push(m), mode: 'paper', speed: null })
  let i = 0
  const trade = (t: { side?: 'BUY' | 'SELL'; price: number; usd: number; at: number; wallet: string }) => {
    i++
    st.priceUsd = t.price
    const tr: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: T, pair: `${T}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: t.side ?? 'BUY',
      baseAmount: t.usd / t.price, quoteAmount: t.usd, tokenAmount: t.usd / t.price, price: t.price, priceUsd: t.price, usdValue: t.usd, wallet: t.wallet,
      txHash: `0x${i}`, blockNumber: 10 + i, logIndex: 0, timestamp: t.at, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: o.liquidityUsd ?? 12_000,
    }
    bot.onTrade(tr, { replay: false })
  }
  /** `holders` wallets buying $20 each through the last 12 minutes, then a minute of 12 buys ($720) as the price climbs. */
  const spike = (holders: number) => {
    for (let k = 0; k < holders; k++) trade({ price: 0.00001, usd: 20, at: now - 12 * 60_000 + Math.floor((k * 10 * 60_000) / holders), wallet: A(1_000 + k) })
    for (let k = 0; k < 12; k++) trade({ price: 0.00001 * (1 + k * 0.004), usd: 60, at: now - 50_000 + k * 3_500, wallet: A(5_000 + k) })
  }
  const signals = () => sent.filter((m): m is Extract<ServerMessage, { t: 'SIGNAL' }> => m.t === 'SIGNAL').map(m => m.d)
  const sweep = async () => { await settle(); bot.sweep(now + 3_000); await settle() }
  return { bot, spike, signals, sweep }
}

describe('the engine fires it', () => {
  test('a coin 20 minutes old with 40 holders whose last minute\'s trading jumps: a volume spike, a fast scalp', async () => {
    const { spike, signals, sweep } = setup({ ageMin: 20 })
    spike(40)
    await sweep()
    const s = signals().find(x => x.rule === 'volume')
    expect(s).toMatchObject({ strategy: 'scalp', rule: 'volume', symbol: 'COIN' })
    expect(s!.reasons.join(' · ')).toMatch(/\$720 traded in the last minute · .*× its usual \$\d+ a minute · 100% of it buying · .*52 holders · market cap \$10,\d+ · \$12,000 liquidity/)
  })
  test('not under 30 holders, under $5,000 of liquidity, or on a coin in its first 10 minutes', async () => {
    for (const [o, holders] of [[{ ageMin: 20 }, 15], [{ ageMin: 20, liquidityUsd: 4_500 }, 40], [{ ageMin: 8 }, 40]] as const) {
      const { spike, signals, sweep } = setup(o)
      spike(holders)
      await sweep()
      expect(signals().filter(x => x.rule === 'volume')).toEqual([])
    }
  })
})
