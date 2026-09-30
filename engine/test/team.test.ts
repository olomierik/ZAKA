// The bots as a team: going live on the team's record, a new bot starting from
// its best teammate's settings, every bot reading the team's trades, probation
// judged on everyone's trades, and the marketplace's live and paper bots apart.

import { describe, expect, test } from 'bun:test'
import { PaperAccounts, TEAM, type PaperAccount } from '../src/bot/paperAccounts'
import { probationOf } from '../src/bot/probation'
import { MemoryBotStore } from '../src/bot/store'
import { READY, readinessWithTeam, TEAM_READY } from '../src/bot/userLive'
import { openPosition, recordSell, STRATEGIES, type Position, type Strategy } from '../src/trading/paper'

const now = Date.UTC(2026, 8, 30, 16)
let n = 0
/** A closed trade: its signal, strategy, rule and outcome. */
function trade(o: { win: boolean; strategy?: Strategy; rule?: 'snipe' | 'momentum'; signal?: string; at?: number; liq?: number; mode?: 'paper' | 'live' }): Position {
  const i = n++
  const strategy = o.strategy ?? 'scalp'
  const at = o.at ?? now - 3_600_000 + i * 1_000
  const p = openPosition({ id: `t${i}`, strategy, token: `0x${String(i + 1).padStart(40, '0')}`, symbol: `C${i}`, launchpad: 'Argus', signalId: o.signal ?? `sig${i}`, price: 1, cost: 0.01, now: at, params: STRATEGIES[strategy] })
  p.mode = o.mode ?? 'paper'
  p.rule = o.rule ?? (strategy === 'scalp' ? 'momentum' : 'snipe')
  p.features = { ageSec: 300, liquidityUsd: o.liq ?? 10_000, marketCapUsd: 50_000, buyers: 12, buySellRatio: 2, runUp: 1.1, topBuyerPct: 15, score: 90, flags: [], roundTripPct: 2 }
  recordSell(p, p.qty, p.qty * (o.win ? 1.2 : 0.9), at + 60_000, o.win ? 'tp1' : 'stop')
  return p
}
const setup = () => new PaperAccounts({ store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
const bot = (accts: PaperAccounts, name: string, strategies: Strategy[] = ['scalp']) => (accts.create(now, { name, strategies }, 'owner') as { account: PaperAccount }).account

describe('going live on the team\'s record', () => {
  const teamWins = () => Array.from({ length: READY.minTrades }, (_, i) => trade({ win: i % 4 !== 0 }))
  test('the team qualifies and the bot has 5 of its own without a loss: ready', () => {
    const own = Array.from({ length: TEAM_READY.minOwn }, (_, i) => trade({ win: i !== 0 }))
    const r = readinessWithTeam(own, teamWins())
    expect(r).toMatchObject({ ok: true, via: 'team', trades: 5, team: { trades: 20, ok: true } })
  })
  test('4 of its own, or its own at a loss, or a losing team: not yet', () => {
    expect(readinessWithTeam(Array.from({ length: 4 }, () => trade({ win: true })), teamWins()).ok).toBe(false)
    expect(readinessWithTeam(Array.from({ length: 5 }, (_, i) => trade({ win: i === 0 })), teamWins()).ok).toBe(false)
    expect(readinessWithTeam(Array.from({ length: 5 }, () => trade({ win: true })), Array.from({ length: 20 }, (_, i) => trade({ win: i % 2 === 0 && i < 8 }))).ok).toBe(false)
  })
  test('its own 20 still work without the team', () => {
    expect(readinessWithTeam(Array.from({ length: 20 }, (_, i) => trade({ win: i % 4 !== 0 })), []).via).toBe('own')
  })
  test('an account reads the team\'s trades on its own strategies, the last 7 days', () => {
    const accts = setup()
    const veteran = bot(accts, 'Veteran')
    for (const p of teamWins()) { veteran.positions.push(p); accts.observe(p) }
    accts.observe(trade({ win: false, strategy: 'snipe' })) // another strategy: not counted for a scalp bot
    const rookie = bot(accts, 'Rookie')
    for (let i = 0; i < 5; i++) rookie.positions.push(trade({ win: true }))
    expect(accts.readinessOf(rookie, now)).toMatchObject({ ok: true, via: 'team', team: { trades: 20 } })
    expect(accts.readinessOf(rookie, now + 8 * 86_400_000).ok).toBe(false) // a week later the team's trades are too old
  })
})

describe('a new bot starts from the team\'s best settings', () => {
  test('the teammate with the most made per trade on the strategy (10+ trades, in profit)', () => {
    const accts = setup()
    const good = bot(accts, 'Good')
    good.tuning.scalp = { ...good.tuning.scalp, version: 7, takeProfit: 1.11, rules: { snipe: { ...good.tuning.scalp.filters, minBuyers: 30 } } }
    for (let i = 0; i < 12; i++) good.positions.push(trade({ win: i % 3 !== 0 }))
    const poor = bot(accts, 'Poor')
    poor.tuning.scalp = { ...poor.tuning.scalp, takeProfit: 1.25 }
    for (let i = 0; i < 12; i++) poor.positions.push(trade({ win: i % 3 === 0 }))
    const few = bot(accts, 'Few')
    for (let i = 0; i < 5; i++) few.positions.push(trade({ win: true }))
    const rookie = bot(accts, 'Rookie')
    expect(rookie.tuning.scalp).toMatchObject({ version: 1, takeProfit: 1.11, rules: { snipe: { minBuyers: 30 } } })
    expect(rookie.learnLog[0]).toMatchObject({ kind: 'team', strategy: 'scalp' })
    expect(rookie.learnLog[0].text).toMatch(/Started from the team's best fast scalp settings: Good's \(12 trades, 67% won\)/)
  })
  test('no teammate qualifies: the defaults', () => {
    const accts = setup()
    const rookie = bot(accts, 'Alone')
    expect(rookie.tuning.scalp.version).toBe(1)
    expect(rookie.learnLog).toHaveLength(0)
  })
})

describe('every bot reads the team\'s trades', () => {
  test('a running bot learns from 5+ team trades closed since its settings changed, without trading itself', () => {
    const accts = setup()
    const rookie = bot(accts, 'Listener')
    accts.act(rookie, { action: 'deposit', amount: 1_000 }, now)
    accts.act(rookie, { action: 'start' }, now)
    // The team: thin pools lost, deep ones won.
    for (let i = 0; i < 7; i++) accts.observe(trade({ win: true, liq: 8_000 + i * 1_000, at: now + 1_000 + i }))
    for (let i = 0; i < 5; i++) accts.observe(trade({ win: false, liq: 2_000 + i * 300, at: now + 2_000 + i }))
    accts.tick(now + TEAM.syncEveryMs + 10_000)
    expect(rookie.tuning.scalp.rules?.momentum?.minLiquidityUsd).toBe(8_000)
    expect(rookie.learnLog[0].text).toMatch(/read from its 0 trades and 12 of the team's/)
    // Not again until 10 minutes have passed and 5 more have closed.
    const v = rookie.tuning.scalp.version
    accts.tick(now + TEAM.syncEveryMs + 20_000)
    expect(rookie.tuning.scalp.version).toBe(v)
  })
  test('live trades join the team too', () => {
    const accts = setup()
    accts.observe(trade({ win: true, mode: 'live', signal: 'L1' }))
    accts.observe(trade({ win: false, mode: 'paper', signal: 'L1' })) // the same signal: kept once
    expect(accts.teamTrades().map(p => p.mode)).toEqual(['live'])
  })
})

describe('probation on everyone\'s trades', () => {
  test('the paper book first, then the team\'s signals it didn\'t take, one per signal', () => {
    const house = Array.from({ length: 6 }, (_, i) => trade({ win: false, signal: `h${i}` }))
    const team = [...Array.from({ length: 6 }, (_, i) => trade({ win: false, signal: `t${i}` })), trade({ win: true, signal: 'h0' })]
    expect(probationOf('momentum', house, p => p.rule, now)).toBeNull() // 6: too few to judge
    expect(probationOf('momentum', [...house, ...team], p => p.rule, now)?.why).toMatch(/won 0 of their last 12 trades/) // h0's win is a duplicate
  })
})

describe('the marketplace: live and paper bots apart', () => {
  test('?mode= lists one kind, and counts both', () => {
    const accts = setup()
    const a = bot(accts, 'Paper One'); accts.act(a, { action: 'deposit', amount: 100 }, now)
    const b = bot(accts, 'Paper Two'); accts.act(b, { action: 'deposit', amount: 100 }, now)
    const c = bot(accts, 'Live One'); accts.act(c, { action: 'deposit', amount: 100 }, now); c.mode = 'live'
    expect(accts.market('pnl', 100, now).counts).toEqual({ live: 1, paper: 2 })
    expect(accts.market('pnl', 100, now, 'live').bots.map(x => x.slug)).toEqual(['live-one'])
    expect(accts.market('pnl', 100, now, 'paper').bots.map(x => x.slug).sort()).toEqual(['paper-one', 'paper-two'])
    expect(accts.market('pnl', 100, now, 'paper').total).toBe(2)
  })
})
