// The signal engine's trading parts (engine/src/quant): sizing, the expected-value check, exits, the risk governor and
// the live gate, paper fills, and live orders (idempotency, the per-coin lock, timeouts, retried sales).
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, DEFAULT_EXITS, mergeConfig } from '../src/quant/config'
import { LiveOrders, paperBuy, paperSell, type ExecutionEvent } from '../src/quant/execution'
import { costsOf } from '../src/quant/liquidity'
import { bookStats, manage, type MarketNow, type QPosition } from '../src/quant/positions'
import { tradeQuality } from '../src/quant/quality'
import { RiskGovernor } from '../src/quant/risk'
import { positionSize } from '../src/quant/sizing'
import { T0, TOKEN } from './helpers/quant'

const position = (o: Partial<QPosition> = {}): QPosition => ({
  id: 'p', signalId: 's', token: TOKEN, symbol: 'COIN', strategy: 'early_momentum', mode: 'paper', status: 'open', openedAt: T0, closedAt: null,
  plannedUsd: 50, costUsd: 50, entryPrice: 1, tokens: 50, remainingTokens: 50, proceedsUsd: 0, feesUsd: 0, exits: DEFAULT_EXITS,
  breakevenMult: 1.02, stopPrice: 0.9, stopPct: 10, stopKind: 'initial', highPrice: 1, lowPrice: 1, tpHit: 0, trailPct: null,
  volatilityPct: 4, liquidityAtEntry: 20_000, exitReason: null, fills: [], pnlUsd: null, returnPct: null, maxGainPct: 0, maxDrawdownPct: 0, ...o,
})
const market = (o: Partial<MarketNow>): MarketNow => ({ now: T0 + 60_000, price: 1, liquidity: 20_000, liquidityHigh15m: 20_000, distribution: 0, momentumTurn: false, volatilityPct: 4, emergency: null, ...o })

describe('sizing', () => {
  const base = { equityUsd: 1_000, exposureUsd: 0, confidence: 1, stopPct: 10, roundTrip: 0.04, liquidity: 100_000, strategyProfitFactor: null }
  test('from the risk per trade: 1% of $1,000 over a 14% loss at the stop', () => {
    const s = positionSize(base, mergeConfig(DEFAULT_CONFIG, { sizing: { maxPositionUsd: 1_000 } }))
    expect(s.usd).toBeCloseTo(10 / 0.14, 1)
    expect(s.limitedBy).toBe('risk per trade')
  })
  test('smaller with less confidence and a losing strategy; capped by the pool, the maximum and exposure', () => {
    const c = mergeConfig(DEFAULT_CONFIG, { sizing: { maxPositionUsd: 1_000 } })
    expect(positionSize({ ...base, confidence: 0 }, c).usd).toBeCloseTo((10 / 0.14) * 0.5, 1)
    expect(positionSize({ ...base, strategyProfitFactor: 0.7 }, c).usd).toBeCloseTo((10 / 0.14) * 0.5, 1)
    expect(positionSize({ ...base, liquidity: 2_000 }, c).limitedBy).toMatch(/the pool/)
    expect(positionSize(base, DEFAULT_CONFIG).usd).toBe(50) // the $50 maximum
    expect(positionSize({ ...base, exposureUsd: 290 }, c).usd).toBeCloseTo(10, 1) // $300 exposure cap
    expect(positionSize({ ...base, liquidity: 0 }, c)).toMatchObject({ usd: 0 }) // zero liquidity: not traded
  })
})

describe('the expected edge', () => {
  const costs = costsOf(50, 20_000, { probeRoundTripPct: 4, buyTaxPct: 0, defaultFeePct: 1, gasUsdPerTx: 0.01 })
  test('the prior before any record; the record takes over as trades close', () => {
    const prior = tradeQuality({ sizeUsd: 50, costs, stopPct: 10, record: null, edge: DEFAULT_CONFIG.edge })
    expect(prior.expected_net_return_pct).toBeCloseTo(0.5 * 18 - 0.5 * 8 - costs.roundTrip * 100, 1)
    const losing = { trades: 40, wins: 8, returns: Array.from({ length: 40 }, (_, i) => (i < 8 ? 0.1 : -0.08)) }
    const q = tradeQuality({ sizeUsd: 50, costs, stopPct: 10, record: losing, edge: DEFAULT_CONFIG.edge })
    expect(q.ok).toBe(false)
    expect(q.p_win).toBeLessThan(0.35)
  })
  test('very high taxes leave no edge; paper may explore a strategy without a record', () => {
    const taxed = costsOf(50, 20_000, { probeRoundTripPct: 20, buyTaxPct: 10, defaultFeePct: 1, gasUsdPerTx: 0.01 })
    expect(tradeQuality({ sizeUsd: 50, costs: taxed, stopPct: 10, record: null, edge: DEFAULT_CONFIG.edge }).ok).toBe(false)
    const thin = costsOf(50, 20_000, { probeRoundTripPct: 3, buyTaxPct: 0, defaultFeePct: 1, gasUsdPerTx: 0.01 }) // about +1% expected: under 1.5%, over 0
    expect(tradeQuality({ sizeUsd: 50, costs: thin, stopPct: 10, record: null, edge: DEFAULT_CONFIG.edge }).ok).toBe(false)
    expect(tradeQuality({ sizeUsd: 50, costs: thin, stopPct: 10, record: null, edge: DEFAULT_CONFIG.edge, explore: true }).ok).toBe(true)
  })
})

describe('exits', () => {
  test('the ladder: 20% at +12%, 25% at +25% (of the original), then the stop to break-even and the trail armed', () => {
    const p = position()
    const r1 = manage(p, market({ price: 1.13 }))
    expect(r1.actions).toEqual([{ fraction: 0.2, reason: expect.stringMatching(/target 1/), kind: 'target' }])
    expect(r1).toMatchObject({ tpHit: 1, stopKind: 'breakeven' })
    expect(r1.stopPrice).toBeCloseTo(1.02, 8)
    const after1 = position({ tpHit: 1, remainingTokens: 40, stopPrice: r1.stopPrice, stopKind: 'breakeven', highPrice: 1.13 })
    const r2 = manage(after1, market({ price: 1.26 }))
    expect(r2.actions[0].fraction).toBeCloseTo(12.5 / 40, 8) // 25% of the original 50 = 12.5 of the 40 left
    expect(r2.stopKind).toBe('trailing')
    expect(r2.trailPct).toBe(12) // 3 × 4% volatility
    expect(r2.stopPrice).toBeCloseTo(1.26 * 0.88, 8)
  })
  test('two targets at once in one jump', () => {
    const r = manage(position(), market({ price: 1.3 }))
    expect(r.actions.map(a => a.kind)).toEqual(['target', 'target'])
    expect(r.tpHit).toBe(2)
  })
  test('the stop, emergency, liquidity pulled, distribution, momentum gone, time and staleness', () => {
    expect(manage(position(), market({ price: 0.89 })).actions[0]).toMatchObject({ kind: 'stop', fraction: 1 })
    expect(manage(position(), market({ emergency: 'rug guard: liquidity fell 70%' })).actions[0].kind).toBe('emergency')
    expect(manage(position(), market({ liquidity: 14_000 })).actions[0].kind).toBe('liquidity') // −30% from entry
    expect(manage(position(), market({ distribution: 80 })).actions[0].kind).toBe('distribution')
    expect(manage(position(), market({ momentumTurn: true, now: T0 + 30_000 })).actions).toEqual([]) // not in the first 2 minutes
    expect(manage(position(), market({ momentumTurn: true, now: T0 + 180_000 })).actions[0].kind).toBe('momentum')
    expect(manage(position(), market({ now: T0 + 61 * 60_000, price: 1.05 })).actions[0].kind).toBe('time')
    expect(manage(position(), market({ now: T0 + 11 * 60_000, price: 1.01 })).actions[0].reason).toMatch(/not up 3%/)
  })
  test('a crash through the stop (extreme price movement) still sells everything', () => {
    expect(manage(position(), market({ price: 0.2 })).actions).toEqual([{ fraction: 1, reason: expect.stringMatching(/stop/), kind: 'stop' }])
  })
  test('book statistics: win rate, profit factor, drawdown, target hit rates, stop rate', () => {
    const closed = [
      position({ pnlUsd: 10, returnPct: 20, closedAt: T0 + 1, tpHit: 2, exitReason: 'trailing stop' }),
      position({ pnlUsd: -5, returnPct: -10, closedAt: T0 + 2, tpHit: 0, exitReason: 'stop (−10%)' }),
      position({ pnlUsd: -5, returnPct: -10, closedAt: T0 + 3, tpHit: 0, exitReason: 'stop (−10%)' }),
      position({ pnlUsd: 20, returnPct: 40, closedAt: T0 + 4, tpHit: 3, exitReason: 'target 3' }),
    ]
    const s = bookStats(closed, 1_000)
    expect(s).toMatchObject({ trades: 4, wins: 2, win_rate: 0.5, profit_factor: 3, net_pnl: 20, max_drawdown_usd: 10, expectancy_pct: 10, stop_rate: 0.5 })
    expect(s.tp_hit_rates).toEqual([0.5, 0.5, 0.25])
  })
})

describe('the risk governor and the live gate', () => {
  const gov = (patch: unknown = {}, env = false) => new RiskGovernor(() => mergeConfig(DEFAULT_CONFIG, patch), env)
  const ask = { mode: 'paper' as const, token: TOKEN, sizeUsd: 40, equityUsd: 1_000, open: [] as QPosition[], closedToday: [] as QPosition[], score: 80, safetyScore: 90, exhaustion: 20, liquidity: 20_000, slippagePct: 1 }
  test('every limit', () => {
    expect(gov().check(ask, T0)).toBeNull()
    expect(gov({ risk: { killSwitch: true } }).check(ask, T0)).toMatch(/kill switch/)
    expect(gov({ risk: { tradingEnabled: false } }).check(ask, T0)).toMatch(/switched off/)
    expect(gov({ risk: { paperEnabled: false } }).check(ask, T0)).toMatch(/paper trading is switched off/)
    expect(gov().check({ ...ask, mode: 'live' }, T0)).toMatch(/live trading is switched off/)
    expect(gov().check({ ...ask, closedToday: [position({ pnlUsd: -150, closedAt: T0 })] }, T0 + 1_000)).toMatch(/loss limit/)
    expect(gov().check({ ...ask, open: [position()] }, T0)).toMatch(/already holding/) // no duplicate position in a coin
    expect(gov().check({ ...ask, open: [1, 2, 3, 4, 5].map(i => position({ id: `${i}`, token: `0x${i}`, costUsd: 10 })) }, T0)).toMatch(/positions open/)
    expect(gov().check({ ...ask, open: [position({ token: '0x1', costUsd: 290 })] }, T0)).toMatch(/exposure/)
    expect(gov().check({ ...ask, slippagePct: 9 }, T0)).toMatch(/slippage/)
    expect(gov().check({ ...ask, liquidity: 1_000 }, T0)).toMatch(/liquidity/)
    expect(gov().check({ ...ask, score: 50 }, T0)).toMatch(/score/)
    expect(gov().check({ ...ask, safetyScore: 40 }, T0)).toMatch(/safety/)
    expect(gov().check({ ...ask, exhaustion: 90 }, T0)).toMatch(/exhaustion/)
  })
  test('live stays off until every condition passes', () => {
    const good = { trades: 40, wins: 24, losses: 16, win_rate: 0.6, profit_factor: 1.6, gross_profit: 100, gross_loss: 60, net_pnl: 40, average_trade: 1, average_winner: 4, average_loser: -3.7, expectancy_pct: 2, max_drawdown_usd: 20, max_drawdown_pct: 5, average_hold_min: 8, tp_hit_rates: [], stop_rate: 0.3, exit_reasons: {} }
    const gate = (patch: unknown, env: boolean, o: Partial<{ hasWallet: boolean; oos: typeof good & { at: number } | null; paper: typeof good & { firstAt: number | null } }>) =>
      gov(patch, env).liveGate({ hasWallet: true, oos: { ...good, at: T0 }, paper: { ...good, firstAt: T0 - 3 * 86_400_000 }, ...o }, T0 + 3_600_000)
    expect(gate({ risk: { liveEnabled: true } }, true, {}).ok).toBe(true)
    expect(gate({ risk: { liveEnabled: true } }, false, {}).checks.find(c => !c.ok)?.id).toBe('env') // SIG_LIVE_ALLOWED
    expect(gate({}, true, {}).checks.find(c => !c.ok)?.id).toBe('switch') // off by default
    expect(gate({ risk: { liveEnabled: true } }, true, { hasWallet: false }).ok).toBe(false)
    expect(gate({ risk: { liveEnabled: true } }, true, { oos: null }).checks.find(c => !c.ok)?.id).toBe('backtest')
    expect(gate({ risk: { liveEnabled: true } }, true, { oos: { ...good, profit_factor: 0.9, at: T0 } }).checks.find(c => !c.ok)?.id).toBe('oos_pf')
    expect(gate({ risk: { liveEnabled: true } }, true, { paper: { ...good, trades: 5, firstAt: T0 - 3 * 86_400_000 } }).checks.find(c => !c.ok)?.id).toBe('paper_trades')
  })
})

describe('paper fills', () => {
  const costs = { feePerSide: 0.01, buyTax: 0.02, sellTax: 0.03, gasUsdPerTx: 0.01 }
  test('a buy pays impact, the fee, the buy tax and gas; a sale pays impact, the fee, the sell tax and gas', () => {
    const b = paperBuy(100, 1, 20_000, costs, T0)!
    expect(b.tokens).toBeCloseTo(100 * 0.99 * 0.98 * (1 - 100 / 10_100), 6)
    expect(b.usd).toBeCloseTo(100.01, 6)
    const s = paperSell(b.tokens, 1, 20_000, costs, T0)!
    expect(s.usd).toBeLessThan(b.tokens * 0.99 * 0.97)
    expect(paperBuy(100, 1, 0, costs, T0)).toBeNull() // no pool
    expect(paperSell(0, 1, 20_000, costs, T0)).toBeNull()
  })
})

describe('live orders', () => {
  const pool = { pool: 'p', dex: 'uniswap-v4' } as never
  const fill = (tokens: bigint, usd: number) => ({ hash: '0xabc' as const, tokens, usd, gasUsd: 0.01, at: T0, roundTrip: null })
  const make = (exec: Record<string, unknown>, o: Partial<{ timeoutMs: number }> = {}) => {
    const events: ExecutionEvent[] = []
    const orders = new LiveOrders({ exec: { approveForSale: async () => [], tokenBalance: async () => 0n, ...exec } as never, pool: () => pool, event: e => events.push(e), timeoutMs: () => o.timeoutMs ?? 1_000 })
    return { orders, events }
  }
  test('the same order asked twice is sent once (duplicate-order protection)', async () => {
    let sent = 0
    const { orders, events } = make({ buy: async () => { sent++; return fill(10n ** 18n, 5) } })
    const [a, b] = await Promise.all([orders.buy('k1', 'p1', TOKEN, 5, 800, 12), orders.buy('k1', 'p1', TOKEN, 5, 800, 12)])
    expect(sent).toBe(1)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ ok: true, tokens: 1, usd: 5 })
    expect(events.map(e => e.kind)).toContain('duplicate')
  })
  test('one order per coin at a time', async () => {
    let release!: () => void
    const { orders } = make({ buy: () => new Promise(r => { release = () => r(fill(10n ** 18n, 5)) }) })
    const first = orders.buy('a', 'p1', TOKEN, 5, 800, 12)
    expect(await orders.buy('b', 'p2', TOKEN, 5, 800, 12)).toMatchObject({ ok: false, status: 'skipped' })
    release()
    expect((await first).ok).toBe(true)
  })
  test('a transaction that never confirms times out; a failed one says why', async () => {
    const { orders } = make({ buy: () => new Promise(() => {}) }, { timeoutMs: 50 })
    expect(await orders.buy('t', 'p1', TOKEN, 5, 800, 12)).toMatchObject({ ok: false, status: 'timeout' })
    const failing = make({ buy: async () => { throw new Error('pre-flight: a holder can\'t sell') } })
    expect(await failing.orders.buy('f', 'p1', TOKEN, 5, 800, 12)).toMatchObject({ ok: false, status: 'failed', error: expect.stringMatching(/pre-flight/) })
  })
  test('a sale is retried at rising slippage until it goes through', async () => {
    const tried: number[] = []
    const { orders, events } = make({ sell: async (_p: unknown, _t: unknown, _a: bigint, bps: number) => { tried.push(bps); if (bps < 3_000) throw new Error('TooLittleReceived'); return fill(-(10n ** 18n), 4.5) } })
    expect(await orders.sell('s', 'p1', TOKEN, 10n ** 18n, [800, 1_500, 3_000, 6_000])).toMatchObject({ ok: true, usd: 4.5 })
    expect(tried).toEqual([800, 1_500, 3_000])
    expect(events.filter(e => e.kind === 'retry').length).toBe(2)
  })
})
