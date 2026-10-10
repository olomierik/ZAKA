// ARCDEX Algo's deterministic core (engine/src/algo): the state engine's causality and size, the
// reflex's typed decisions, calibration, triple-barrier labels, the gates and quarter-Kelly
// sizing, the hard risk layer, the book's arithmetic, and the walk-forward replay: no trades on a
// random walk (no false edge), trades and a profit on a market with real trends.
import { describe, expect, test } from 'bun:test'
import type { AlgoDecision, AlgoState, AlgoTrade } from '../../api/_algoProtocol'
import { Book, pnlAt } from '../src/algo/book'
import { brier, Calibrator, evaluate, isotonic } from '../src/algo/calibration'
import { applyGatePatch, cloneConfig, DEFAULT_CONFIG, withTuned } from '../src/algo/config'
import { thinLabels } from '../src/algo/core'
import { outcomeOf } from '../src/algo/labels'
import { costPct, kellyOf, planTrade } from '../src/algo/policy'
import { RuleReflex } from '../src/algo/reflex'
import { replay } from '../src/algo/replay'
import { RiskLayer } from '../src/algo/risk'
import { buildState, snapshotText, tokensOf } from '../src/algo/state'
import type { PerpsBar } from '../src/perps/shared'
import { market, START, walk } from './helpers/algoBars'

const MIN = 60_000
const cfg = () => cloneConfig(DEFAULT_CONFIG)

function stateAt(bars: PerpsBar[], t: number, ref?: PerpsBar[]) {
  return buildState({ market: 'ETH', bars, t, ref, horizonMin: 240 })
}

describe('state engine', () => {
  const bars = walk(7, 3 * 1440, START, 2500, 0.0009)
  const t = START + 2 * 1440 * MIN

  test('strictly causal: candles after t change nothing, and srcMaxTs never passes t', () => {
    const s = stateAt(bars, t)!
    expect(s).not.toBeNull()
    expect(s.srcMaxTs).toBeLessThanOrEqual(t)
    // Wildly different future candles: the same state.
    const future = bars.map((b, i) => (b[0] + MIN > t ? ([b[0], 1, 1e9, 0.001, 1e6 * (i % 7)] as PerpsBar) : b))
    expect(stateAt(future, t)).toEqual(s)
    // The candle still forming at t isn't read either.
    const forming = [...bars.filter(b => b[0] + MIN <= t), [t, s.px, s.px * 2, s.px / 2, s.px * 1.5] as PerpsBar]
    expect(stateAt(forming, t)).toEqual(s)
  })

  test('needs an hour of candles, and stops when the feed stops', () => {
    expect(stateAt(bars.slice(0, 50), START + 50 * MIN)).toBeNull()
    expect(stateAt(bars.slice(0, 300), START + 320 * MIN)).toBeNull() // last candle 20 min old
  })

  test('the snapshot is one line, well under 400 tokens', () => {
    const s = stateAt(bars, t, walk(8, 3 * 1440, START, 82000, 0.0007))!
    const text = snapshotText({ ...s, inventory: { side: 'long', uPnlPct: 1.23, ageMin: 42 }, dispersionBps: 2.5 })
    expect(text).not.toContain('\n')
    expect(tokensOf(text)).toBeLessThan(400)
    expect(tokensOf(text)).toBeLessThan(100)
    expect(text).toContain('inv=long:1.23%:42m')
  })

  test('returns and volatility are measured as stated', () => {
    // A straight line up 0.01% a minute: r1h ≈ 0.6%, trend positive.
    const line: PerpsBar[] = []
    let px = 100
    for (let i = 0; i < 1500; i++) { const o = px; px *= 1.0001 + (i % 2 ? 0.00002 : -0.00002); line.push([START + i * MIN, o, Math.max(o, px), Math.min(o, px), px]) }
    const s = buildState({ market: 'BTC', bars: line, t: START + 1500 * MIN, horizonMin: 240 })!
    expect(s.r1h!).toBeCloseTo(0.6, 1)
    expect(s.r24h!).toBeCloseTo(14.4, 0)
    expect(s.trend!).toBeGreaterThan(0)
    expect(s.range24!).toBeCloseTo(1, 1)
  })
})

function baseState(over: Partial<AlgoState> = {}): AlgoState {
  return {
    market: 'ETH', t: START, srcMaxTs: START, px: 2500, r5m: 0.05, r15m: 0.1, r1h: 0.3, r4h: 0.8, r24h: 1.5,
    rv1h: 0.08, rv24h: 0.08, volRatio: 1, trend: 1, z1h: 0.5, jump: 0.2, range24: 0.7, refR1h: 0.2,
    dispersionBps: 1, inventory: null, drawdownPct: 0, dayPnlPct: 0, sigmaH: 1.24, ...over,
  }
}

describe('reflex', () => {
  const k = DEFAULT_CONFIG.reflex
  const rx = new RuleReflex()

  test('an aligned uptrend: trending, long, quality 3', () => {
    const o = rx.decide(baseState(), k)
    expect(o.decision).toEqual({ regime: 'trending', direction: 'long', toxic_flow: false, setup_quality: 3 })
    expect(o.raw).toBeGreaterThan(0.5)
  })

  test('crisis on a 5σ hour, high volatility on an expanding range: both stand aside', () => {
    const crisis = rx.decide(baseState({ r1h: -5 * 0.08 * Math.sqrt(60) }), k).decision
    expect(crisis.regime).toBe('crisis')
    expect(crisis.direction).toBe('neutral')
    const hv = rx.decide(baseState({ volRatio: 2 }), k).decision
    expect(hv.regime).toBe('high_vol')
    expect(hv.direction).toBe('neutral')
  })

  test('toxic flow on a 5σ minute or disagreeing signers; quality drops a point', () => {
    const o = rx.decide(baseState({ jump: 5 }), k)
    expect(o.decision.toxic_flow).toBe(true)
    expect(o.decision.setup_quality).toBe(2)
    expect(rx.decide(baseState({ dispersionBps: 25 }), k).decision.toxic_flow).toBe(true)
  })

  test('no chase when the trend is already stretched; ranging markets fade a stretch', () => {
    expect(rx.decide(baseState({ z1h: 3 }), k).decision.direction).toBe('neutral')
    const fade = rx.decide(baseState({ trend: 0.1, r4h: -0.2, z1h: 2.2, range24: 0.9 }), k)
    expect(fade.decision.regime).toBe('mean_reverting')
    expect(fade.decision.direction).toBe('short')
    expect(fade.decision.setup_quality).toBe(3)
  })
})

describe('calibration', () => {
  test('isotonic blocks never decrease', () => {
    const blocks = isotonic([{ x: 0.1, y: 1 }, { x: 0.2, y: 0 }, { x: 0.3, y: 0 }, { x: 0.4, y: 1 }, { x: 0.5, y: 1 }])
    const means = blocks.map(b => b.sum / b.n)
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThanOrEqual(means[i - 1])
  })

  test('scores that carry no information calibrate to the base rate', () => {
    let s = 3
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const samples = Array.from({ length: 4000 }, () => ({ p: r(), win: r() < 0.3 }))
    const c = new Calibrator().fit(samples)
    for (const p of [0.05, 0.5, 0.95]) expect(Math.abs(c.map(p) - 0.3)).toBeLessThan(0.08)
  })

  test('scores that do carry it are kept, and measured out of sample', () => {
    let s = 5
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const mk = (n: number) => Array.from({ length: n }, () => { const p = r(); return { p, win: r() < p } })
    const { report, calibrator } = evaluate(mk(4000), mk(2000), 1)
    expect(calibrator.map(0.9)).toBeGreaterThan(0.75)
    expect(calibrator.map(0.1)).toBeLessThan(0.25)
    expect(report.skill!).toBeGreaterThan(0.2)
    expect(report.ece!).toBeLessThan(0.08)
    expect(brier([{ p: 1, win: true }, { p: 0, win: false }])).toBe(0)
  })

  test('labels are thinned to one per market and family every 15 minutes', () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, market: 'BTC', family: 'trend' as const, raw: 0.5, win: true, at: START + i * MIN, resolvedAt: START + i * MIN + 1, movePct: 1 }))
    expect(thinLabels(labels, 'trend', START + 1e9, 0, 15)).toHaveLength(4)
    expect(thinLabels(labels, 'trend', START + 10 * MIN, 0, 15)).toHaveLength(1) // only what had resolved
  })
})

describe('triple-barrier labels', () => {
  const t = START + 100 * MIN
  const mk = (rows: [number, number, number][]): PerpsBar[] => {
    const out: PerpsBar[] = []
    for (let i = 0; i <= 100; i++) out.push([START + i * MIN, 100, 100, 100, 100])
    rows.forEach(([hi, lo, c], j) => out.push([t + j * MIN, 100, hi, lo, c]))
    return out
  }
  const b = { side: 'long' as const, at: t, tpPct: 1, slPct: 1.5, horizonMin: 10 }

  test('take-profit first is a win; stop first a loss; both in one candle counts the stop', () => {
    // The first candle after the decision is the fill (100).
    expect(outcomeOf(mk([[100, 100, 100], [101.2, 99.9, 101]]), b, t + 1e7)).toMatchObject({ done: true, win: true, reason: 'tp' })
    expect(outcomeOf(mk([[100, 100, 100], [100.2, 98.4, 99]]), b, t + 1e7)).toMatchObject({ done: true, win: false, reason: 'sl' })
    expect(outcomeOf(mk([[100, 100, 100], [101.5, 98.4, 100]]), b, t + 1e7)).toMatchObject({ win: false, reason: 'sl' })
  })

  test('pending until known; a time-out at the horizon is not a win', () => {
    const flat = mk(Array.from({ length: 20 }, () => [100.2, 99.9, 100.1] as [number, number, number]))
    expect(outcomeOf(flat, b, t + 5 * MIN).done).toBe(false)
    expect(outcomeOf(flat, b, t + 30 * MIN)).toMatchObject({ done: true, win: false, reason: 'time' })
  })
})

function decision(over: Partial<AlgoDecision> = {}): AlgoDecision {
  return { regime: 'trending', direction: 'long', toxic_flow: false, setup_quality: 3, risk_state: 'safe', confidence: 0.85, ...over }
}

describe('policy: the gates and quarter Kelly', () => {
  const s = baseState({ sigmaH: 2 })

  test('a setup that clears every gate is sized by a quarter Kelly, capped at 2% risk', () => {
    const c = cfg()
    const { gate, plan } = planTrade({ state: s, decision: decision(), calibrated: true, equityUsd: 10_000, cfg: c })
    expect(gate.passed).toBe(true)
    const cost = costPct(c)
    const b = (2 - cost) / (3 + cost)
    expect(plan!.kelly).toBeCloseTo(kellyOf(0.85, b), 3)
    expect(plan!.fraction).toBeCloseTo(Math.min(0.25 * kellyOf(0.85, b), 0.02), 4)
    expect(plan!.riskUsd).toBeLessThanOrEqual(200 + 1e-6)
    expect(plan!.sizeUsd * ((3 + cost) / 100)).toBeCloseTo(plan!.riskUsd, 0)
    expect(plan!.leverage).toBeLessThanOrEqual(3)
    // Liquidation (1% maintenance + fees) at least twice as far as the stop.
    expect(1 / plan!.leverage - 0.01 - cost / 100).toBeGreaterThanOrEqual(2 * 0.03)
    expect(plan!.tp).toBeCloseTo(2500 * 1.02, 2)
    expect(plan!.sl).toBeCloseTo(2500 * 0.97, 2)
  })

  test('each gate refuses on its own: quality, confidence (strictly above 0.80), risk state, toxic, regime, calibration', () => {
    const c = cfg()
    const fails = (d: Partial<AlgoDecision>, calibrated = true) => planTrade({ state: s, decision: decision(d), calibrated, equityUsd: 10_000, cfg: c }).gate.checks.filter(x => !x.ok).map(x => x.id)
    expect(fails({ setup_quality: 1 })).toContain('quality')
    expect(fails({ confidence: 0.8 })).toContain('confidence')
    expect(fails({ risk_state: 'near_limit' })).toContain('risk_state')
    expect(fails({ toxic_flow: true })).toContain('toxic')
    expect(fails({ regime: 'crisis', direction: 'long' })).toContain('regime')
    expect(fails({ direction: 'neutral' })).toContain('direction')
    expect(fails({}, false)).toContain('calibrated')
    expect(fails({})).toEqual([])
  })

  test('no trade without a positive expectation after costs, or with a target the costs would eat', () => {
    const c = cfg()
    expect(planTrade({ state: s, decision: decision({ confidence: 0.75 }), calibrated: true, equityUsd: 10_000, cfg: withTuned(c, 'tpSigma', 0.6) }).gate.checks.find(x => x.id === 'edge')!.ok).toBe(false)
    expect(planTrade({ state: baseState({ sigmaH: 0.1 }), decision: decision(), calibrated: true, equityUsd: 10_000, cfg: c }).gate.checks.find(x => x.id === 'target')!.ok).toBe(false)
  })

  test("the owner's gate changes are bounded: never under 0.6 confidence or over half Kelly", () => {
    expect(() => applyGatePatch(cfg(), { minConfidence: 0.5 })).toThrow()
    expect(() => applyGatePatch(cfg(), { kellyFraction: 0.9 })).toThrow()
    expect(() => applyGatePatch(cfg(), { maxDrawdownPct: 20 })).toThrow()
    expect(() => applyGatePatch(cfg(), { trendMin: 1 })).toThrow()
    expect(applyGatePatch(cfg(), { minConfidence: 0.7, maxOpen: 2 }).gates.minConfidence).toBe(0.7)
  })
})

function trade(over: Partial<AlgoTrade> = {}): AlgoTrade {
  return {
    id: 't', mode: 'paper', market: 'ETH', side: 'long', status: 'open', decisionId: 'd', openedAt: START, entry: 2500, tp: 2550, sl: 2460, tpPct: 2, slPct: 1.6,
    sizeUsd: 3000, collateralUsd: 1000, leverage: 3, confidence: 0.85, kelly: 0.3, regime: 'trending', closedAt: null, exit: null,
    pnlUsd: null, pnlPct: null, feesUsd: 0, reason: null, positionId: null, txOpen: null, txClose: null, escalations: [], ...over,
  }
}

describe('book and risk layer', () => {
  test("P&L uses the contract's fees: 0.08% each way and 0.0025% an hour", () => {
    const c = DEFAULT_CONFIG.costs
    const p = pnlAt(trade(), 2550, START + 2 * 3_600_000, c)
    expect(p.gross).toBeCloseTo(60, 6)
    expect(p.fees).toBeCloseTo(3000 * 0.0016 + 3000 * 0.000025 * 2, 6)
    const b = new Book(10_000, 'paper')
    const t = trade()
    b.trades.push(t)
    b.close(t, 2550, START + 2 * 3_600_000, 'take-profit', c)
    expect(t.pnlUsd).toBeCloseTo(60 - 4.95, 2)
    expect(t.pnlPct).toBeCloseTo(5.51, 2)
    expect(b.stats()).toMatchObject({ trades: 1, wins: 1, winRate: 1 })
  })

  test('the kill switch blocks every order; the 15% drawdown trips it', () => {
    const c = cfg()
    const b = new Book(10_000, 'paper')
    const risk = new RiskLayer(() => c.limits)
    const plan = planTrade({ state: baseState({ sigmaH: 2 }), decision: decision(), calibrated: true, equityUsd: 10_000, cfg: c }).plan!
    const ask = { plan, market: 'ETH' as const, book: b, priceAgeMs: 1_000, staleMs: c.staleMs }
    b.mark({}, START, c.costs)
    expect(risk.checkOpen(ask)).toBeNull()
    risk.trip('owner', START)
    expect(risk.checkOpen(ask)).toContain('kill switch')
    risk.rearm()
    // A losing open trade takes the book 16% under its peak.
    const t = trade({ sizeUsd: 3000, entry: 2500 })
    b.trades.push(t)
    b.mark({ ETH: 2500 * (1 - 0.54) }, START + 1000, c.costs)
    expect(risk.watch(b, START + 1000)).toBe(true)
    expect(risk.kill.tripped).toBe(true)
    expect(risk.riskState(b)).toBe('reduce')
  })

  test("today's loss, stale prices, one position per market and at most three", () => {
    const c = cfg()
    const risk = new RiskLayer(() => c.limits)
    const plan = planTrade({ state: baseState({ sigmaH: 2 }), decision: decision(), calibrated: true, equityUsd: 10_000, cfg: c }).plan!
    const b = new Book(10_000, 'paper')
    b.mark({}, START, c.costs)
    expect(risk.checkOpen({ plan, market: 'ETH', book: b, priceAgeMs: 60_000, staleMs: c.staleMs })).toContain('stale')
    b.trades.push(trade({ market: 'ETH' }))
    expect(risk.checkOpen({ plan, market: 'ETH', book: b, priceAgeMs: 0, staleMs: c.staleMs })).toContain('already in ETH')
    b.trades.push(trade({ id: 'b', market: 'BTC' }), trade({ id: 's', market: 'SOL' }))
    expect(risk.checkOpen({ plan, market: 'ETH', book: b, priceAgeMs: 0, staleMs: c.staleMs })).toContain('positions open')
    const b2 = new Book(10_000, 'paper')
    b2.mark({}, START, c.costs)
    b2.realizedUsd = -600
    b2.mark({}, START + 1, c.costs)
    expect(risk.checkOpen({ plan, market: 'ETH', book: b2, priceAgeMs: 0, staleMs: c.staleMs })).toContain("today's loss")
  })
})

describe('walk-forward replay', () => {
  test('a random walk: the calibrated agent finds no edge and never trades', () => {
    const bars = market(7, 0, 1)
    const r = replay({ bars, cfg: cfg(), from: START + 1440 * MIN, to: START + 7 * 1440 * MIN })
    expect(r.summary.decisions).toBeGreaterThan(20_000)
    expect(r.summary.stats.trades).toBe(0)
    expect(r.core.calibrators.trend.n).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minLabels)
    // Its confidence stays near the base rate, nowhere near the 0.80 bar.
    expect(r.core.calibrators.trend.map(0.99)).toBeLessThan(0.6)
  }, 60_000)

  test('a market with six-hour trends: it trades them and makes money after fees', () => {
    const bars = market(7, 0.3, 1)
    const r = replay({ bars, cfg: cfg(), from: START + 1440 * MIN, to: START + 7 * 1440 * MIN })
    const s = r.summary.stats
    expect(s.trades).toBeGreaterThan(10)
    expect(s.pnlUsd).toBeGreaterThan(0)
    expect(s.feesUsd).toBeGreaterThan(0)
    expect(s.maxDrawdownPct).toBeLessThan(15)
    for (const t of r.core.book.closed()) {
      expect(t.confidence).toBeGreaterThan(0.8)
      expect(t.leverage).toBeLessThanOrEqual(3)
    }
  }, 60_000)

  test('causal: replaying to an earlier end gives the same decisions up to it', () => {
    const bars = market(3, 0.3, 2)
    const to1 = START + 2 * 1440 * MIN
    const rows = (to: number) => {
      const out: unknown[] = []
      replay({ bars, cfg: cfg(), from: START + 1440 * MIN, to, onRow: d => { if (d.at <= to1) out.push([d.market, d.at, d.decision, d.raw, d.gate.passed]) } })
      return out
    }
    const a = rows(to1), b = rows(START + 3 * 1440 * MIN)
    expect(a.length).toBeGreaterThan(3_000)
    expect(b).toEqual(a)
  }, 60_000)
})
