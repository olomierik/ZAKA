// A signal rule on probation, and bots learning from each other's trades.

import { describe, expect, test } from 'bun:test'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { probationOf, PROBATION, RULE_REVISED } from '../src/bot/probation'
import { MemoryBotStore } from '../src/bot/store'
import { openPosition, recordSell, STRATEGIES, type Position } from '../src/trading/paper'

const T = '0x' + 'ab'.repeat(20)
const revised = RULE_REVISED.momentum!

function closedAt(i: number, win: boolean, o: { openedAt?: number; rule?: 'momentum' | 'snipe' } = {}): Position {
  const at = o.openedAt ?? revised - 86_400_000 + i * 60_000
  const p = openPosition({ id: `p${i}`, strategy: 'scalp', token: T, symbol: 'C', launchpad: 'ARGUS', signalId: `s${i}`, price: 1, cost: 0, now: at, params: STRATEGIES.scalp })
  p.mode = 'paper'
  p.rule = o.rule ?? 'momentum'
  p.features = { ageSec: 300, liquidityUsd: 10_000, marketCapUsd: 50_000, buyers: 10, buySellRatio: 2, runUp: 1.1, topBuyerPct: 15, score: 80, flags: [], roundTripPct: 3 }
  recordSell(p, p.qty, p.qty * (win ? 1.15 : 0.9), at + 60_000, win ? 'tp1' : 'stop')
  return p
}
const ruleOf = (p: Position) => p.rule

describe('probation', () => {
  const now = revised + 3_600_000
  test('a rule that won 4 of 14 and lost money is on probation; one that wins is not', () => {
    const book = Array.from({ length: 14 }, (_, i) => closedAt(i, i < 4))
    expect(probationOf('momentum', book, ruleOf, now)?.why).toMatch(/Momentum bursts won 4 of their last 14 trades \(−\$.*\): bots sit them out/)
    const snipes = Array.from({ length: 16 }, (_, i) => closedAt(100 + i, i < 12, { rule: 'snipe' }))
    expect(probationOf('snipe', [...book, ...snipes], ruleOf, now)).toBeNull()
  })
  test('too few trades to judge: not on probation', () => {
    const book = Array.from({ length: PROBATION.minTrades - 1 }, (_, i) => closedAt(i, false))
    expect(probationOf('momentum', book, ruleOf, now)).toBeNull()
  })
  test('once the revised rule has 10 trades of its own, only those count', () => {
    const old = Array.from({ length: 14 }, (_, i) => closedAt(i, i < 4))
    const fresh = Array.from({ length: 10 }, (_, i) => closedAt(200 + i, i < 6, { openedAt: revised + i * 60_000 }))
    expect(probationOf('momentum', [...old, ...fresh.slice(0, 9)], ruleOf, revised + 86_400_000)).not.toBeNull()
    expect(probationOf('momentum', [...old, ...fresh], ruleOf, revised + 86_400_000)).toBeNull()
  })
})

describe('bots and a rule on probation', () => {
  const setup = () => {
    const accts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    const made = accts.create(revised, { name: 'Prober', strategies: ['scalp'] }) as { account: PaperAccount }
    accts.act(made.account, { action: 'deposit', amount: 1_000 }, revised)
    accts.act(made.account, { action: 'start' }, revised)
    return { accts, a: made.account }
  }
  const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'scalp', roundTripPct: 2, liquidityUsd: 30_000, rule: 'momentum', ...o })
  test('a bot sits out a signal on probation, and says why', () => {
    const { accts, a } = setup()
    accts.onSignal(sig({ probation: { why: 'Momentum bursts won 4 of their last 14 trades' } }), revised + 1_000)
    expect(a.positions).toHaveLength(0)
    expect(a.skips[0].text).toMatch(/not traded: Momentum bursts won 4 of their last 14/)
  })
  test('the same signal off probation is bought, and the position keeps its rule', () => {
    const { accts, a } = setup()
    accts.onSignal(sig(), revised + 1_000)
    expect(a.positions[0]).toMatchObject({ status: 'open', rule: 'momentum' })
  })
})
