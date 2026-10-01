// The signal engine's parts, one by one (engine/src/quant): the tape and its windows, flow, momentum, liquidity and
// costs, exhaustion, distribution, wallets and smart money, the regime, safety, scoring and the strategies.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, mergeConfig, validateConfig, exitsFor } from '../src/quant/config'
import { computeFeatures } from '../src/quant/features'
import { buyPressure, organicFlowScore } from '../src/quant/flow'
import { costsOf, impactOf, maxSizeFor } from '../src/quant/liquidity'
import { regimeOf } from '../src/quant/regime'
import { assessSafety } from '../src/quant/safety'
import { bandOf, scoreSignal } from '../src/quant/score'
import { breakout, checkStrategies, earlyMomentum, planFor, smartMoney, stopPctFor } from '../src/quant/strategies'
import { qtradeOf, TokenTape, type QTrade } from '../src/quant/tape'
import { WalletBook } from '../src/quant/wallets'
import type { SafetyReport } from '../src/intel/scanner'
import { A, T0, TOKEN, crowd, trade } from './helpers/quant'

const q = (o: Partial<QTrade> & { ts: number; price?: number | null }, i = 0): QTrade => ({ id: `t${o.ts}:${i}:${Math.random()}`, ord: o.ts * 10 + i, side: 'BUY', usd: 50, tokens: 50 / (o.price ?? 0.00001), price: 0.00001, wallet: A(1), liquidity: 20_000, ...o })
const tapeOf = (trades: ReturnType<typeof trade>[], creator: string | null = A(0xc4ea)) => {
  const t = new TokenTape(TOKEN, T0, creator, 1e9, 'ARGUS', 'COIN')
  for (const x of trades) t.add(qtradeOf(x, true)!)
  return t
}

describe('the tape', () => {
  test('drops a duplicate event and puts a late one back in chain order', () => {
    const t = new TokenTape(TOKEN, T0, null, 1e9)
    expect(t.add(q({ ts: T0 + 1_000, ord: 3 }))).toBe(true)
    const late = q({ ts: T0 + 500, ord: 1, id: 'late' })
    expect(t.add(late)).toBe(true)
    expect(t.add({ ...late })).toBe(false) // the same id again
    expect(t.trades.map(x => x.ord)).toEqual([1, 3])
  })
  test('windows: volume, buyers, sellers, new buyers, large trades, VWAP and the opening price', () => {
    const t = tapeOf([
      trade({ price: 1, usd: 100, at: T0 + 1_000, wallet: A(1) }),
      trade({ price: 1.1, usd: 300, at: T0 + 30_000, wallet: A(2) }), // large: over $250
      trade({ price: 1.2, usd: 100, at: T0 + 40_000, wallet: A(1) }),
      trade({ side: 'SELL', price: 1.15, usd: 50, at: T0 + 50_000, wallet: A(3) }),
    ])
    const w = t.window(T0 + 60_000, 35_000)
    expect(w).toMatchObject({ buys: 2, sells: 1, buyUsd: 400, sellUsd: 50, buyers: 2, sellers: 1, largeBuys: 1, newBuyers: 1, open: 1, close: 1.15, high: 1.2 })
    expect(w.vwap!).toBeCloseTo((1.1 * 300 + 1.2 * 100 + 1.15 * 50) / 450, 6)
    expect(t.window(T0 + 60_000, 5_000).trades).toBe(0) // zero volume: zeros, no NaN
    expect(t.window(T0 + 60_000, 5_000).avgBuy).toBe(0)
  })
  test('holders, the creator\'s bag and the largest holders, from the trades', () => {
    const t = tapeOf([
      trade({ price: 1, usd: 100, at: T0 + 1_000, wallet: A(0xc4ea) }),
      trade({ price: 1, usd: 300, at: T0 + 2_000, wallet: A(2) }),
      trade({ price: 1, usd: 50, at: T0 + 3_000, wallet: A(3) }),
      trade({ side: 'SELL', price: 1, usd: 100, at: T0 + 4_000, wallet: A(0xc4ea) }), // the creator sold out
    ])
    expect(t.holders).toBe(2)
    expect(t.creatorLeft()).toBe(0)
    expect(t.topHolders(1)[0].wallet).toBe(A(2))
    expect(t.priceAt(T0 + 2_500)).toBe(1)
    expect(t.volume(T0 + 5_000, 10_000)).toBe(550)
  })
  test('a side pool\'s trade counts as volume but not as the price', () => {
    const x = qtradeOf(trade({ price: 99, at: T0, pool: 'side' }), false)!
    expect(x.price).toBeNull()
    expect(x.liquidity).toBeNull()
    expect(qtradeOf({ ...trade({ price: 1, at: T0 }), side: 'UNKNOWN' }, true)).toBeNull()
  })
})

describe('flow', () => {
  test('buy pressure', () => {
    expect(buyPressure({ buyUsd: 75, sellUsd: 25 })).toBe(0.75)
    expect(buyPressure({ buyUsd: 0, sellUsd: 0 })).toBeNull()
  })
  test('$100k from 5 wallets is not $100k from 300', () => {
    const narrow = organicFlowScore({ buyers: 5, top5BuyShare: 1, buyerHHI: 0.2, buyUsd: 100_000 })
    const broad = organicFlowScore({ buyers: 300, top5BuyShare: 0.05, buyerHHI: 1 / 300, buyUsd: 100_000 })
    expect(narrow).toBeLessThan(0.3)
    expect(broad).toBeGreaterThan(0.95)
    expect(organicFlowScore({ buyers: 0, top5BuyShare: 0, buyerHHI: 0, buyUsd: 0 })).toBe(0)
  })
  test('features: growth, acceleration and the organic score on a broad, accelerating crowd', () => {
    const quiet = crowd(10, { from: T0 + 60_000, price: 0.00001, gap: 20_000, wallet0: 1 })
    const burst = crowd(40, { from: T0 + 300_000, price: 0.0000105, gap: 1_400, wallet0: 1_000, step: 0.003 })
    const r = computeFeatures(tapeOf([...quiet, ...burst]), T0 + 360_000, { wallets: null, regime: 'NEUTRAL', large: DEFAULT_CONFIG.large })
    expect(r.f.buy_pressure_1m).toBe(1)
    expect(r.f.unique_buyers_1m).toBeGreaterThan(30)
    expect(r.f.unique_buyer_growth!).toBeGreaterThan(2)
    expect(r.f.volume_acceleration!).toBeGreaterThan(2)
    expect(r.f.organic_flow_score).toBeGreaterThan(0.6)
    expect(r.f.price_change_1m!).toBeGreaterThan(0.05)
    expect(r.f.higher_highs + r.f.higher_lows).toBeGreaterThan(2)
  })
})

describe('liquidity and costs', () => {
  test('price impact and the largest size for an impact', () => {
    expect(impactOf(100, 20_000)).toBeCloseTo(100 / 10_100, 8)
    expect(impactOf(100, 0)).toBe(1) // no pool: can't be exited
    expect(impactOf(100, null)).toBe(1)
    const s = maxSizeFor(20_000, 0.02)
    expect(impactOf(s, 20_000)).toBeCloseTo(0.02, 8)
    expect(maxSizeFor(0, 0.02)).toBe(0)
  })
  test('costs: the probe\'s round trip (fees and taxes) plus impact both ways and gas', () => {
    const c = costsOf(100, 20_000, { probeRoundTripPct: 6, buyTaxPct: 2, defaultFeePct: 1, gasUsdPerTx: 0.01 })
    expect(c.buyTax).toBeCloseTo(0.02, 8)
    expect(c.feePerSide).toBeCloseTo(0.01, 8)
    expect(c.sellTax).toBeCloseTo(0.02, 8)
    expect(c.roundTrip).toBeCloseTo(0.06 + c.entrySlippage + c.exitSlippage + 0.02 / 100, 8)
    const plain = costsOf(100, 20_000, { probeRoundTripPct: null, buyTaxPct: null, defaultFeePct: 1, gasUsdPerTx: 0.01 })
    expect(plain.buyTax + plain.sellTax).toBe(0)
  })
})

describe('wallets and smart money', () => {
  const cfg = DEFAULT_CONFIG.smartMoney
  /** `wins` winning and `losses` losing round trips of $100, on different coins. */
  const record = (book: WalletBook, w: string, wins: number, losses: number, from = T0) => {
    let t = from
    for (let i = 0; i < wins + losses; i++) {
      const coin = `0x${(i + 1).toString(16).padStart(40, '0')}`
      book.onTrade(w, coin, 'BUY', 100, 1_000, t, t - 60_000)
      book.onTrade(w, coin, 'SELL', i < wins ? 150 : 80, 1_000, t + 600_000, t - 60_000)
      t += 3_600_000
    }
    return t
  }
  test('a closed position is one trade; an open one doesn\'t count; a sale of coins it never bought is ignored', () => {
    const b = new WalletBook(cfg)
    b.onTrade(A(1), TOKEN, 'BUY', 100, 1_000, T0, T0)
    expect(b.stats(A(1), T0)!.trade_count).toBe(0)
    b.onTrade(A(1), TOKEN, 'SELL', 60, 500, T0 + 1_000, T0)
    b.onTrade(A(1), TOKEN, 'SELL', 70, 500, T0 + 2_000, T0)
    const s = b.stats(A(1), T0 + 3_000)!
    expect(s).toMatchObject({ trade_count: 1, wins: 1 })
    expect(s.average_return).toBeCloseTo(0.3, 8)
    b.onTrade(A(2), TOKEN, 'SELL', 100, 1_000, T0, T0)
    expect(b.stats(A(2))!.trade_count).toBe(0)
  })
  test('smart money: winning often and by more than it loses over several coins; not because it is large', () => {
    const b = new WalletBook(cfg)
    record(b, A(1), 8, 2)
    const s = b.stats(A(1), T0 + 30 * 86_400_000)!
    expect(s.class).toBe('SMART_MONEY')
    expect(s.quality).toBeGreaterThan(0.3)
    // A large wallet that loses is not smart money.
    const big = new WalletBook(cfg)
    let t = T0
    for (let i = 0; i < 10; i++) { const c = `0x${(i + 1).toString(16).padStart(40, '0')}`; big.onTrade(A(2), c, 'BUY', 100_000, 1e6, t, t); big.onTrade(A(2), c, 'SELL', 60_000, 1e6, t + 600_000, t); t += 3_600_000 }
    expect(big.stats(A(2), t)!.class).toBe('HIGH_RISK')
  })
  test('a wallet buying more coins a day than a person would is a bot, never smart money', () => {
    const b = new WalletBook({ ...cfg, maxTokensPerDay: 5 })
    let t = T0
    for (let i = 0; i < 10; i++) { const c = `0x${(i + 1).toString(16).padStart(40, '0')}`; b.onTrade(A(3), c, 'BUY', 100, 1_000, t, t); b.onTrade(A(3), c, 'SELL', 200, 1_000, t + 60_000, t); t += 120_000 }
    expect(b.stats(A(3), t)!.class).toBe('SCALPER')
  })
  test('a coin\'s smart money: who entered, a cluster, and smart wallets leaving', () => {
    const b = new WalletBook(cfg)
    const end = record(b, A(1), 8, 2)
    record(b, A(2), 8, 2)
    const tape = new TokenTape(TOKEN, end, null, 1e9)
    for (const [i, w] of [A(1), A(2)].entries()) { const x = qtradeOf(trade({ price: 1, usd: 100, at: end + 60_000 + i * 30_000, wallet: w }), true)!; tape.add(x); b.onTrade(w, TOKEN, 'BUY', 100, x.tokens, x.ts, end) }
    const v = b.smartView(tape, end + 120_000)
    expect(v).toMatchObject({ smart_money_count: 2, cluster: true, smart_money_exits: 0 })
    const sell = qtradeOf(trade({ side: 'SELL', price: 1, usd: 100, at: end + 150_000, wallet: A(1) }), true)!
    tape.add(sell); b.onTrade(A(1), TOKEN, 'SELL', 100, sell.tokens, sell.ts, end)
    expect(b.smartView(tape, end + 160_000).smart_money_exits).toBe(1)
  })
})

describe('the regime', () => {
  const coin = (change: number, o: Partial<{ volume: number; liquidityChange: number; alarm: boolean; volatility: number }> = {}) => ({ volume: o.volume ?? 1_000, change, buyPressure: 0.5 + change, volatility: o.volatility ?? 3, liquidityChange: o.liquidityChange ?? 0, alarm: o.alarm ?? false })
  const c = DEFAULT_CONFIG.regime
  test('bullish, bearish, neutral, high volatility, liquidity stressed', () => {
    expect(regimeOf([coin(0.1), coin(0.05), coin(0.08), coin(-0.01), coin(0.2)], c, T0).regime).toBe('BULLISH')
    expect(regimeOf([coin(-0.1), coin(-0.05), coin(-0.08), coin(0.01), coin(-0.2)], c, T0).regime).toBe('BEARISH')
    expect(regimeOf([coin(0.01), coin(-0.01), coin(0.005), coin(-0.002), coin(0)], c, T0).regime).toBe('NEUTRAL')
    expect(regimeOf([1, 2, 3, 4, 5].map(() => coin(0, { volatility: 20 })), c, T0).regime).toBe('HIGH_VOLATILITY')
    expect(regimeOf([coin(0, { alarm: true }), coin(0, { liquidityChange: -0.6 }), coin(0), coin(0), coin(0)], c, T0).regime).toBe('LIQUIDITY_STRESSED')
    expect(regimeOf([coin(0.1)], c, T0)).toMatchObject({ regime: 'NEUTRAL', why: expect.stringMatching(/not enough/) })
  })
})

describe('safety', () => {
  const report = (checks: SafetyReport['checks'], o: Partial<SafetyReport> = {}): SafetyReport => ({ token: TOKEN, launchpad: 'ARGUS', at: T0, verdict: 'pass', score: 90, checks, template: 'Argus P7 token', honeypot: { verdict: 'ok', buyTaxPct: 0, transferTaxPct: 0, roundTripLossPct: 4, error: null }, ...o })
  const base = { rugAlarm: null, liquidity: 20_000, impactPct: 0.5, top10Pct: 20, creatorLeft: 0, creatorPct: 0, limits: DEFAULT_CONFIG.gates }
  test('a clean coin is allowed', () => {
    expect(assessSafety({ ...base, report: report([]) })).toMatchObject({ trade_allowed: true, safety_score: 90, critical: [] })
  })
  test('critical: no scan yet, a hard fail, a rug alarm, taxes too high, a pool too thin for the size', () => {
    expect(assessSafety({ ...base, report: null }).critical[0]).toMatch(/no safety scan/)
    expect(assessSafety({ ...base, report: report([{ id: 'honeypot', ok: false, hard: true, detail: 'a holder can\'t sell' }]) }).trade_allowed).toBe(false)
    expect(assessSafety({ ...base, report: report([]), rugAlarm: 'liquidity fell 60%' }).critical.join()).toMatch(/rug guard/)
    expect(assessSafety({ ...base, report: report([], { honeypot: { verdict: 'ok', buyTaxPct: 10, transferTaxPct: 0, roundTripLossPct: 30, error: null } }) }).critical.join()).toMatch(/round trip costs 30/)
    expect(assessSafety({ ...base, report: report([]), liquidity: 0 }).trade_allowed).toBe(false) // zero liquidity
    expect(assessSafety({ ...base, report: report([]), impactPct: 9 }).critical.join()).toMatch(/not exitable/)
  })
  test('the creator: sold out is a flag (nothing left to dump); sold part and still holding is critical', () => {
    const creatorFail = report([{ id: 'creator', ok: false, hard: true, detail: 'sold 99% of their buy' }], { score: 70 })
    const out = assessSafety({ ...base, report: creatorFail, creatorLeft: 0.01 })
    expect(out).toMatchObject({ trade_allowed: true, risk_flags: ['creator-exited'], safety_score: 100 })
    expect(assessSafety({ ...base, report: creatorFail, creatorLeft: 0.3 }).trade_allowed).toBe(false)
  })
})

describe('the score', () => {
  const r = computeFeatures(tapeOf([...crowd(10, { from: T0 + 60_000, price: 0.00001, gap: 20_000, wallet0: 1 }), ...crowd(40, { from: T0 + 300_000, price: 0.0000105, gap: 1_400, wallet0: 1_000, step: 0.003 })]), T0 + 360_000, { wallets: null, regime: 'NEUTRAL', large: DEFAULT_CONFIG.large })
  test('every component within its weight, adding up to the total', () => {
    const s = scoreSignal(r.f, { safetyScore: 90, impactPct: 0.5 }, DEFAULT_CONFIG)
    const w = DEFAULT_CONFIG.weights
    for (const k of Object.keys(w) as (keyof typeof w)[]) { expect(s.components[k]).toBeGreaterThanOrEqual(0); expect(s.components[k]).toBeLessThanOrEqual(w[k]) }
    expect(s.signal_score).toBeCloseTo(Object.values(s.components).reduce((a, b) => a + b, 0) - s.distribution_penalty, 0)
    expect(s.components.safety).toBe(9)
    expect(s.components.regime).toBe(3)
    expect(s.components.flow).toBeGreaterThan(14)
  })
  test('weights come from the settings; distribution costs points, then invalidates', () => {
    const noFlow = mergeConfig(DEFAULT_CONFIG, { weights: { flow: 0, momentum: 35 } })
    expect(validateConfig(noFlow)).toBeNull()
    expect(scoreSignal(r.f, { safetyScore: 90, impactPct: 0.5 }, noFlow).components.flow).toBe(0)
    const dumped = scoreSignal({ ...r.f, distribution_score: 80 }, { safetyScore: 90, impactPct: 0.5 }, DEFAULT_CONFIG)
    expect(dumped).toMatchObject({ band: 'NO_TRADE', invalidated: expect.stringMatching(/distribution/) })
    expect(scoreSignal({ ...r.f, distribution_score: 55 }, { safetyScore: 90, impactPct: 0.5 }, DEFAULT_CONFIG).distribution_penalty).toBe(5)
  })
  test('bands follow the settings', () => {
    expect(bandOf(49, DEFAULT_CONFIG.bands)).toBe('NO_TRADE')
    expect(bandOf(70, DEFAULT_CONFIG.bands)).toBe('WEAK')
    expect(bandOf(80, DEFAULT_CONFIG.bands)).toBe('TRADE_CANDIDATE')
    expect(bandOf(90, DEFAULT_CONFIG.bands)).toBe('HIGH_CONVICTION')
    expect(bandOf(70, { watch: 50, weak: 60, candidate: 70, highConviction: 80 })).toBe('TRADE_CANDIDATE')
  })
  test('settings that don\'t add up or don\'t exist are refused', () => {
    expect(validateConfig(mergeConfig(DEFAULT_CONFIG, { weights: { flow: 30 } }))).toMatch(/add up to 100/)
    expect(() => mergeConfig(DEFAULT_CONFIG, { nope: 1 })).toThrow(/not a setting/)
    expect(validateConfig(mergeConfig(DEFAULT_CONFIG, { exits: { ladder: [{ gainPct: 20, sellPct: 60 }, { gainPct: 10, sellPct: 60 }] } }))).toMatch(/must rise|more than 100/)
  })
})

describe('the strategies', () => {
  const f = computeFeatures(tapeOf([...crowd(10, { from: T0 + 60_000, price: 0.00001, gap: 20_000, wallet0: 1 }), ...crowd(40, { from: T0 + 300_000, price: 0.0000105, gap: 1_400, wallet0: 1_000, step: 0.003 })]), T0 + 360_000, { wallets: null, regime: 'NEUTRAL', large: DEFAULT_CONFIG.large }).f
  test('early momentum: a young coin with broad, accelerating buying', () => {
    const c = earlyMomentum(f, DEFAULT_CONFIG.strategies.early_momentum)
    expect(c.conditions.filter(x => !x.ok)).toEqual([])
    expect(c.ok).toBe(true)
    expect(earlyMomentum({ ...f, token_age_sec: 3_600 }, DEFAULT_CONFIG.strategies.early_momentum).conditions.find(x => !x.ok)?.id).toBe('age')
    expect(earlyMomentum({ ...f, broad_based: false }, DEFAULT_CONFIG.strategies.early_momentum).ok).toBe(false)
  })
  test('breakout needs an established coin over its range; smart money needs smart wallets', () => {
    expect(breakout(f, DEFAULT_CONFIG.strategies.breakout).conditions.find(x => x.id === 'established')?.ok).toBe(false)
    expect(breakout({ ...f, token_age_sec: 7_200, range_15m_pct: 12, break_pct: 3, distribution_score: 0, exhaustion_score: 10 }, DEFAULT_CONFIG.strategies.breakout).ok).toBe(true)
    expect(smartMoney(f, DEFAULT_CONFIG.strategies.smart_money, { windowMin: 5 }).ok).toBe(false)
    expect(smartMoney({ ...f, smart_money_count: 3, smart_money_runup_pct: 10, exhaustion_score: 10 }, DEFAULT_CONFIG.strategies.smart_money, { windowMin: 5 }).ok).toBe(true)
    expect(smartMoney({ ...f, smart_money_count: 3, smart_money_runup_pct: 80 }, DEFAULT_CONFIG.strategies.smart_money, { windowMin: 5 }).ok).toBe(false) // already ran
  })
  test('each strategy switches off on its own', () => {
    const off = mergeConfig(DEFAULT_CONFIG, { strategies: { breakout: { enabled: false }, smart_money: { enabled: false } } })
    expect(checkStrategies(f, off).map(c => c.strategy)).toEqual(['early_momentum'])
  })
  test('the stop follows volatility within its bounds; the plan carries entry, stop and targets', () => {
    const e = exitsFor(DEFAULT_CONFIG, 'early_momentum')
    expect(stopPctFor(1, e)).toBe(6) // 2.5 × 1% under the 6% floor
    expect(stopPctFor(4, e)).toBe(10)
    expect(stopPctFor(30, e)).toBe(20)
    expect(stopPctFor(null, e)).toBe(20)
    const p = planFor('early_momentum', 1, 4, DEFAULT_CONFIG)
    expect(p.stop).toEqual({ price: 0.9, pct: 10 })
    expect(p.targets.map(t => t.gainPct)).toEqual([12, 25, 50])
    expect(p.targets[0].price).toBeCloseTo(1.12, 8)
  })
})
