// The signal engine end to end (engine/src/quant/engine.ts), the backtester's freedom from look-ahead, walk-forward
// validation, and the owner's signed controls (quant/api.ts).
import { describe, expect, test } from 'bun:test'
import type { Trade } from '../../api/_marketProtocol'
import { quantControlMessage } from '../../api/_quantProtocol'
import type { SafetyReport } from '../src/intel/scanner'
import { parseQuantControl, quantApi, quantStatus } from '../src/quant/api'
import { runBacktest } from '../src/quant/backtest'
import { DEFAULT_CONFIG, mergeConfig, type QuantConfig } from '../src/quant/config'
import { SignalEngine } from '../src/quant/engine'
import { MemoryQuantStore } from '../src/quant/store'
import { walkForward } from '../src/quant/walkforward'
import { A, T0, TOKEN, crowd, launch, trade } from './helpers/quant'

const clean = (token = TOKEN): SafetyReport => ({ token, launchpad: 'ARGUS', at: T0, verdict: 'pass', score: 95, checks: [], template: 'Argus P7 token', honeypot: { verdict: 'ok', buyTaxPct: 0, transferTaxPct: 0, roundTripLossPct: 2, error: null } })
// The pipeline under test, with a bar any decent setup clears (the default bar is the walk-forward's job).
const LOW: QuantConfig = mergeConfig(DEFAULT_CONFIG, { gates: { minSignalScore: 45 }, bands: { watch: 30, weak: 35, candidate: 40 }, edge: { exploreTrades: 1_000 } })

function setup(o: { config?: QuantConfig; safety?: SafetyReport | null; alarm?: () => string | null } = {}) {
  const store = new MemoryQuantStore()
  const asked: string[] = []
  const meta = launch()
  const e = new SignalEngine({
    store, mode: 'backtest', config: o.config ?? LOW,
    meta: t => (t === TOKEN ? meta : null), token: () => null,
    safety: () => (o.safety === undefined ? clean() : o.safety),
    requestSafety: t => asked.push(t),
    rugAlarm: () => o.alarm?.() ?? null,
  })
  const feed = (ts: Trade[]) => { for (const t of ts) { e.ingest(t, { now: t.timestamp }); e.evaluateDue(t.timestamp); e.tick(t.timestamp) } }
  return { e, store, asked, feed }
}
/** A quiet start, then a broad burst of buying: an early-momentum setup. */
const burst = () => [...crowd(10, { from: T0 + 60_000, price: 0.00001, gap: 20_000, wallet0: 1 }), ...crowd(40, { from: T0 + 300_000, price: 0.0000105, gap: 1_400, wallet0: 1_000, step: 0.003 })]
const tail = (from: number, price: number, n: number, step: number, o: { side?: 'BUY' | 'SELL'; liquidity?: number } = {}) =>
  Array.from({ length: n }, (_, i) => trade({ price: price * (1 + step) ** (i + 1), usd: 30, at: from + (i + 1) * 3_000, wallet: A(90_000 + i), side: o.side, liquidity: o.liquidity }))

describe('the engine', () => {
  test('a broad, accelerating crowd: a signal with its reasons, a paper buy after the latency, targets sold on the way up', () => {
    const { e, feed } = setup()
    feed(burst())
    const s = e.signals.find(x => x.decision === 'traded')!
    expect(s).toBeDefined()
    expect(s.strategy).toBe('early_momentum')
    expect(s.why_signal_triggered[0]).toMatch(/every condition met/)
    expect(s.why_trade_allowed.join(' | ')).toMatch(/safety .*allowed.*edge/)
    expect(Object.keys(s.components)).toEqual(['flow', 'momentum', 'volume', 'liquidity', 'smartMoney', 'holders', 'safety', 'regime'])
    expect(s.recommended_targets.map(t => t.gainPct)).toEqual([12, 25, 50])
    expect(s.position_size).toBeGreaterThan(0)
    expect(e.positions.find(x => x.signalId === s.id)).toBeDefined()
    const last = burst()[49]
    feed(tail(last.timestamp, last.priceUsd!, 60, 0.006))
    const after = [...e.positions, ...e.closed].find(x => x.signalId === s.id)!
    expect(after.fills[0].side).toBe('BUY')
    expect(after.fills[0].at - s.at).toBeGreaterThanOrEqual(DEFAULT_CONFIG.execution.entryLatencyMs)
    expect(after.tpHit).toBeGreaterThanOrEqual(2)
    expect(after.fills.filter(f => f.side === 'SELL').length).toBeGreaterThanOrEqual(2)
  })
  test('duplicate events are dropped before anything counts them', () => {
    const { e } = setup()
    const t = trade({ price: 0.00001, at: T0 + 5_000 })
    e.ingest(t, { now: t.timestamp }); e.ingest({ ...t }, { now: t.timestamp })
    expect(e.tapes.get(TOKEN)!.trades.length).toBe(1)
  })
  test('no safety scan (an RPC outage): the signal is refused and a scan is asked for', () => {
    const { e, feed, asked } = setup({ safety: null })
    feed(burst())
    const s = e.signals[e.signals.length - 1]
    expect(s.decision).toBe('rejected')
    expect(s.why_trade_rejected.join()).toMatch(/no safety scan/)
    expect(asked).toContain(TOKEN)
    expect(e.positions.length).toBe(0)
  })
  test('a rug alarm while holding: everything sold at once', () => {
    let alarm: string | null = null
    const { e, feed } = setup({ alarm: () => alarm })
    feed(burst())
    const last = burst()[49]
    feed(tail(last.timestamp, last.priceUsd!, 3, 0.001))
    expect(e.positions.some(p => p.status === 'open')).toBe(true)
    alarm = 'liquidity fell 60% ($20.0K → $8.0K): pulled or drained'
    feed(tail(last.timestamp + 10_000, last.priceUsd!, 4, -0.01))
    const p = e.closed.find(x => x.mode === 'backtest')!
    expect(p.exitReason).toMatch(/emergency: liquidity fell/)
  })
  test('rapid liquidity removal: out on the liquidity rule even without an alarm', () => {
    const { e, feed } = setup()
    feed(burst())
    const last = burst()[49]
    feed(tail(last.timestamp, last.priceUsd!, 3, 0.001))
    feed(tail(last.timestamp + 10_000, last.priceUsd!, 3, 0, { liquidity: 9_000 }))
    expect(e.closed[0]?.exitReason).toMatch(/liquidity fell/)
  })
  test('the kill switch: open positions sold, nothing new bought', async () => {
    const { e, feed } = setup()
    feed(burst())
    const last = burst()[49]
    feed(tail(last.timestamp, last.priceUsd!, 3, 0.001))
    expect(e.positions.filter(p => p.status === 'open').length).toBe(1)
    const r = await e.setConfig(mergeConfig(e.cfg, { risk: { killSwitch: true } }), 'test', 'kill')
    expect(r.ok).toBe(true)
    feed(tail(last.timestamp + 10_000, last.priceUsd!, 4, 0.001))
    expect(e.closed[0].exitReason).toMatch(/kill switch/)
    expect(e.riskLog.some(x => x.kind === 'emergency')).toBe(true)
  })
  test('one signal per coin and strategy per cooldown', () => {
    const { e, feed } = setup({ config: mergeConfig(LOW, { gates: { minSignalScore: 99 } }) })
    feed(burst())
    feed(tail(burst()[49].timestamp, 0.0000155, 20, 0.003))
    expect(e.signals.filter(s => s.strategy === 'early_momentum').length).toBe(1)
  })
  test('settings that don\'t validate are refused and nothing changes', async () => {
    const { e } = setup()
    const r = await e.setConfig(mergeConfig(e.cfg, { weights: { flow: 50 } }), 'test', 'bad')
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/add up to 100/) })
    expect(e.cfg.weights.flow).toBe(20)
  })
})

/** Three coins over two hours, each with a quiet start, a burst and a fade. */
function market(): { launches: ReturnType<typeof launch>[]; trades: Trade[] } {
  const launches = [0, 1, 2].map(i => launch({ token: `0x${(0xc1 + i).toString(16).repeat(20)}`, symbol: `C${i}`, timestamp: T0 + i * 30 * 60_000 }))
  const trades: Trade[] = []
  launches.forEach((l, i) => {
    const t0 = l.timestamp
    trades.push(...crowd(10, { token: l.token, from: t0 + 60_000, price: 0.00001, gap: 20_000, wallet0: 1 + i * 10_000 }))
    trades.push(...crowd(40, { token: l.token, from: t0 + 300_000, price: 0.0000105, gap: 1_400, wallet0: 1_000 + i * 10_000, step: 0.003 }))
    trades.push(...Array.from({ length: 40 }, (_, k) => trade({ token: l.token, price: 0.0000165 * (1 + (k % 2 ? -0.01 : 0.008)) ** k, usd: 30, at: t0 + 360_000 + k * 4_000, side: k % 3 ? 'BUY' : 'SELL' })))
  })
  return { launches, trades: trades.sort((a, b) => a.timestamp - b.timestamp) }
}

describe('backtesting', () => {
  test('no look-ahead: the signals up to a moment are the same whether or not the data goes on after it', async () => {
    const data = market()
    const cut = T0 + 70 * 60_000
    const full = await runBacktest(data, { config: LOW, from: T0, to: T0 + 3 * 3_600_000 })
    const part = await runBacktest({ launches: data.launches, trades: data.trades.filter(t => t.timestamp <= cut) }, { config: LOW, from: T0, to: cut })
    const key = (s: { at: number; token: string; strategy: string; signal_score: number; decision: string }) => `${s.at}:${s.token}:${s.strategy}:${s.signal_score}:${s.decision}`
    const before = (xs: typeof full.signals) => xs.filter(s => s.at <= cut).map(key)
    expect(before(full.signals).length).toBeGreaterThan(0)
    expect(before(part.signals)).toEqual(before(full.signals))
  })
  test('the report: totals and the breakdowns by strategy, score, token age, liquidity and regime', async () => {
    const r = await runBacktest(market(), { config: LOW, from: T0, to: T0 + 3 * 3_600_000 })
    expect(r.report.traded).toBeGreaterThan(0)
    expect(r.report.totals.trades).toBe(r.positions.filter(p => p.status === 'closed').length)
    for (const k of ['byStrategy', 'byScore', 'byAge', 'byLiquidity', 'byRegime'] as const) expect(r.report[k].length).toBeGreaterThan(0)
    // Every position is closed by the end (sold at the last price).
    expect(r.positions.every(p => p.status === 'closed' || p.status === 'failed')).toBe(true)
  })
  test('walk-forward: each fold chooses on training, checks on validation, and reports its untouched test window', async () => {
    const data = market()
    const wf = await walkForward(data, { base: LOW, folds: 2, warmupMs: 10 * 60_000, grid: [{ name: 'a', patch: {} }, { name: 'b', patch: { gates: { minSignalScore: 99 } } }], minTrainTrades: 0 })
    expect(wf.folds.length).toBe(2)
    for (const f of wf.folds) { expect(f.test[0]).toBe(f.validate[1]); expect(f.validate[0]).toBe(f.train[1]) }
    expect(wf.oos.trades).toBe(wf.oosPositions)
  })
})

describe('the owner\'s controls', () => {
  const deps = (verify: (m: string) => string | null) => {
    const { e } = setup()
    return { engine: e, validator: null, control: { verifyText: async (m: string) => verify(m) } as never, warm: () => ({ done: true, trades: 0, detail: '' }), metricsToken: null }
  }
  const post = (body: unknown) => new Request('http://x/v1/quant/control', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const sig = '0x' + 'ab'.repeat(65)
  test('the signed text says exactly what changes', () => {
    expect(quantControlMessage({ action: 'settings', patch: '{"gates":{"minSignalScore":70}}', note: 'walk-forward chose 70' }, T0)).toBe('ARCDEX signal engine\nChange its settings: {"gates":{"minSignalScore":70}}\nWhy: walk-forward chose 70\nAt: 2026-10-02T12:00:00.000Z')
    expect(parseQuantControl({ action: 'settings', patch: 5, note: 'x', at: T0, signature: sig })).toMatch(/patch/)
    expect(parseQuantControl({ action: 'kill', on: true, at: T0, signature: '0x1' })).toMatch(/signature/)
  })
  test('settings change and the kill switch, only with the owner\'s signature', async () => {
    let signedText = ''
    const d = deps(m => { signedText = m; return null })
    const url = new URL('http://x/v1/quant/control')
    const r = await quantApi(post({ action: 'settings', patch: '{"gates":{"minSignalScore":70}}', note: 'test', at: T0, signature: sig }), url, d, json)
    expect(r.status).toBe(200)
    expect(d.engine.cfg.gates.minSignalScore).toBe(70)
    expect(signedText).toMatch(/minSignalScore":70/)
    expect((await quantApi(post({ action: 'kill', on: true, at: T0, signature: sig }), url, d, json)).status).toBe(200)
    expect(d.engine.cfg.risk.killSwitch).toBe(true)
    const bad = await quantApi(post({ action: 'settings', patch: '{"weights":{"flow":99}}', note: 'bad', at: T0, signature: sig }), url, d, json)
    expect(bad.status).toBe(400)
    const refused = deps(() => "not signed by the owner's wallet")
    expect((await quantApi(post({ action: 'kill', on: true, at: T0, signature: sig }), url, refused, json)).status).toBe(403)
    expect(refused.engine.cfg.risk.killSwitch).toBe(false)
  })
  test('the status: switches, the live gate (off), the regime and every setting', () => {
    const s = quantStatus(deps(() => null))
    expect(s.controls).toMatchObject({ liveEnabled: false, liveAllowedByEnv: false, killSwitch: false })
    expect(s.liveGate.ok).toBe(false)
    expect(s.config).toHaveProperty('weights')
  })
})
