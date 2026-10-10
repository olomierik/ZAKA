// ARCDEX Algo, live (engine/src/algo): the agent against a stand-in futures service and clock
// (warm-up replay, a decision per market per candle, paper fills, the kill switch, escalations
// without a brain, persistence), the testnet executor against a stand-in contract, the nightly
// review's proposals tested by replay, and the owner's signed controls.
import { describe, expect, test } from 'bun:test'
import type { AlgoMarket, AlgoTrade } from '../../api/_algoProtocol'
import { AlgoAgent } from '../src/algo/agent'
import { algoApi, parseAlgoControl } from '../src/algo/api'
import { Brain } from '../src/algo/brain'
import { cloneConfig, DEFAULT_CONFIG } from '../src/algo/config'
import { AlgoCore } from '../src/algo/core'
import { TestnetExecutor, type ChainView, type PerpsChain } from '../src/algo/executor'
import { RuleReflex } from '../src/algo/reflex'
import { nightlyReview } from '../src/algo/review'
import { closedUpTo } from '../src/algo/state'
import { ControlVerifier } from '../src/bot/control'
import { setLogLevel } from '../src/log'
import type { PerpsTrade } from '../src/perps/events'
import type { PerpsService } from '../src/perps/service'
import type { PerpsBar, Pos } from '../src/perps/shared'
import { market, START } from './helpers/algoBars'

setLogLevel('error')
const MIN = 60_000

class MemSettings {
  m = new Map<string, string>()
  async getSetting(k: string) { return this.m.get(k) ?? null }
  async setSetting(k: string, v: string) { this.m.set(k, v) }
}

/** A stand-in futures service: candles up to the clock, and the oracle's latest price. */
function standIn(bars: Record<AlgoMarket, PerpsBar[]>, clock: { now: number }) {
  return {
    candles: { candles: (m: string) => { const b = bars[m as AlgoMarket] ?? []; return b.slice(0, closedUpTo(b, clock.now + MIN)) } },
    feed: {
      latest: () => {
        const feeds: Record<string, unknown> = {}
        for (const m of ['BTC', 'ETH', 'SOL'] as const) {
          const b = bars[m][closedUpTo(bars[m], clock.now) - 1]
          if (!b) continue
          const v = BigInt(Math.round(b[4] * 1e8))
          feeds[m] = { feed: m, ts: clock.now - 2_000, median: v, price: b[4], pkgs: [{ value: v }, { value: v + 1n }, { value: v - 1n }] }
        }
        return { ts: clock.now - 2_000, fetchedAt: clock.now, feeds }
      },
    },
    deployment: null, events: null, algoAccess: () => null,
  } as unknown as PerpsService
}

describe('the agent, live in paper mode', () => {
  test('warms up on stored candles, decides every candle, trades only through the gates, and survives a restart', async () => {
    const bars = market(5, 0.3, 6)
    const clock = { now: START + 3 * 1440 * MIN + 30_000 }
    const settings = new MemSettings()
    const agent = new AlgoAgent({ perps: standIn(bars, clock), settings, vault: null, brain: new Brain(null), now: () => clock.now, tickEveryMs: 0 })
    await agent.start()
    expect(agent.replay).not.toBeNull()
    expect(agent.replay!.decisions).toBeGreaterThan(5_000)
    expect(agent.core.labeler.resolved.length).toBeGreaterThan(1_000)
    expect(agent.status().reflex.calibrated).toBe(true)
    // A day live, a tick every 20 seconds.
    const end = clock.now + 1440 * MIN
    for (; clock.now < end; clock.now += 20_000) await agent.tick()
    const s = agent.status()
    expect(s.mode).toBe('paper')
    expect(agent.decisions(500, null).length).toBe(500)
    expect(agent.decisions(10, 'BTC').every(d => d.market === 'BTC')).toBe(true)
    // One decision per market per candle.
    const btc = agent.decisions(200, 'BTC').map(d => d.at)
    expect(new Set(btc).size).toBe(btc.length)
    expect(btc[0] - btc[1]).toBe(MIN)
    const trades = agent.trades(1_000).filter(t => t.openedAt >= START + 3 * 1440 * MIN)
    expect(trades.length).toBeGreaterThan(0)
    for (const t of trades) {
      const row = agent.core.decisions.find(d => d.id === t.decisionId)
      if (row) {
        expect(row.gate.passed).toBe(true)
        expect(row.decision.confidence).toBeGreaterThan(0.8)
        expect(row.decision.setup_quality).toBeGreaterThanOrEqual(2)
        expect(row.decision.risk_state).toBe('safe')
      }
      expect(t.leverage).toBeLessThanOrEqual(3)
    }
    expect(s.risk.drawdownPct).toBeLessThan(15)
    // Restart: the same book, calibration and settings come back.
    agent.stop()
    await new Promise(r => setTimeout(r, 10))
    const again = new AlgoAgent({ perps: standIn(bars, clock), settings, vault: null, brain: new Brain(null), now: () => clock.now, tickEveryMs: 0 })
    await again.start()
    expect(again.core.book.closed().length).toBe(agent.core.book.closed().length)
    expect(again.core.book.realizedUsd).toBeCloseTo(agent.core.book.realizedUsd, 6)
    expect(again.status().reflex.calibrated).toBe(true) // refit at start from the replayed candles
    expect(again.reviews.length).toBe(agent.reviews.length)
    again.stop()
  }, 120_000)

  test("the owner's kill switch closes everything and stops new trades until re-armed", async () => {
    const bars = market(4, 0.3, 6)
    const clock = { now: START + 3 * 1440 * MIN + 30_000 }
    const agent = new AlgoAgent({ perps: standIn(bars, clock), settings: new MemSettings(), vault: null, brain: new Brain(null), now: () => clock.now, tickEveryMs: 0 })
    await agent.start()
    let guard = 0
    while (!agent.core.book.open().some(t => t.status === 'open') && guard++ < 1440 * 3) { clock.now += 20_000; await agent.tick() }
    expect(agent.core.book.open().length).toBeGreaterThan(0)
    await agent.setKill(true, 'test')
    expect(agent.core.book.open().filter(t => t.status === 'open')).toHaveLength(0)
    const before = agent.core.book.trades.length
    for (let i = 0; i < 180; i++) { clock.now += 20_000; await agent.tick() }
    expect(agent.core.book.trades.length).toBe(before)
    expect(agent.status().risk.killSwitch.tripped).toBe(true)
    const killed = agent.decisions(30, null).filter(d => d.gate.checks.some(c => c.id === 'risk' && !c.ok))
    for (const d of killed) expect(d.gate.checks.find(c => c.id === 'risk')!.detail).toContain('kill switch')
    await agent.setKill(false, 'test over')
    expect(agent.status().risk.killSwitch.tripped).toBe(false)
    agent.stop()
  }, 120_000)

  test('without a brain, an escalation closes the position and says why', async () => {
    const bars = market(4, 0.3, 6)
    const clock = { now: START + 3 * 1440 * MIN + 30_000 }
    const agent = new AlgoAgent({ perps: standIn(bars, clock), settings: new MemSettings(), vault: null, brain: new Brain(null), now: () => clock.now, tickEveryMs: 0 })
    await agent.start()
    for (let i = 0; i < 1440 * 3; i++) { clock.now += 20_000; await agent.tick() }
    const escalated = agent.core.book.trades.filter(t => t.escalations.length)
    for (const t of escalated) {
      expect(t.escalations[0].by).toBe('rules')
      expect(t.escalations[0].action).toBe('close')
      expect(t.escalations[0].why).toContain('no brain')
    }
    // And one forced: an open paper position, escalated, is closed by the code.
    const row = agent.core.decisions[agent.core.decisions.length - 1]
    const px = agent.status().markets[row.market]!.price!
    const t: AlgoTrade = { id: 'forced', mode: 'paper', market: row.market, side: 'long', status: 'open', decisionId: row.id, openedAt: clock.now - 10 * MIN, entry: px, tp: px * 1.02, sl: px * 0.97, tpPct: 2, slPct: 3, sizeUsd: 1000, collateralUsd: 400, leverage: 2.5, confidence: 0.85, kelly: 0.3, regime: 'trending', closedAt: null, exit: null, pnlUsd: null, pnlPct: null, feesUsd: 0, reason: null, positionId: null, txOpen: null, txClose: null, escalations: [] }
    agent.core.book.trades.push(t)
    await agent.escalate(t, row, 'test trigger', { [row.market]: px }, clock.now)
    expect(t.status).toBe('closed')
    expect(t.reason).toBe('escalated: test trigger')
    expect(t.escalations[0]).toMatchObject({ by: 'rules', action: 'close' })
    agent.stop()
  }, 120_000)
})

function fakeChain(o: Partial<ChainView> = {}) {
  const calls: { fn: string; args: unknown }[] = []
  const view: ChainView = { positions: [], requestIds: [], execFee: 100_000n, minCollateral: 1_000_000n, requestTimeout: 120, usdc: 5_000_000_000n, gasWei: 10n ** 18n, ...o }
  const closed: PerpsTrade[] = []
  const chain: PerpsChain = {
    agent: '0x00000000000000000000000000000000000000aa',
    marketId: m => ['BTC', 'ETH', 'SOL'].indexOf(m),
    read: async () => view,
    approve: async amount => { calls.push({ fn: 'approve', args: amount }); return '0x01' },
    requestOpen: async a => { calls.push({ fn: 'requestOpen', args: a }); return { tx: '0x02', requestId: 7n } },
    requestClose: async id => { calls.push({ fn: 'requestClose', args: id }); return '0x03' },
    cancel: async id => { calls.push({ fn: 'cancel', args: id }); return '0x04' },
    closeOf: id => closed.find(t => t.positionId === id) ?? null,
    cancelledOf: id => closed.find(t => t.kind === 'cancelled' && t.requestId === id) ?? null,
    fund: async () => null,
  }
  return { chain, calls, view, closed }
}

function pendingTrade(over: Partial<AlgoTrade> = {}): AlgoTrade {
  return {
    id: 'T1', mode: 'testnet', market: 'ETH', side: 'long', status: 'pending', decisionId: 'd', openedAt: Date.now(), entry: 2500, tp: 2525, sl: 2462.5, tpPct: 1, slPct: 1.5,
    sizeUsd: 3000, collateralUsd: 1000, leverage: 3, confidence: 0.85, kelly: 0.3, regime: 'trending', closedAt: null, exit: null, pnlUsd: null, pnlPct: null,
    feesUsd: 0, reason: null, positionId: null, txOpen: null, txClose: null, escalations: [], ...over,
  }
}

const pos = (over: Partial<Pos>): Pos => ({ trader: '0x00000000000000000000000000000000000000aa', marketId: 1, isLong: true, openedAt: BigInt(Math.floor(Date.now() / 1000)), tpSlSetAt: 0n, size: 3_000_000_000n, collateral: 997_600_000n, entryPrice: 250_100_000_000n, borrowIndex: 0n, maxProfit: 0n, tp: 252_500_000_000n, sl: 246_250_000_000n, ...over })

describe('testnet executor', () => {
  test('opens with an exact approval and the plan on-chain; the position comes back with its real entry', async () => {
    const f = fakeChain()
    const ev: string[] = []
    const ex = new TestnetExecutor(f.chain, { filled: (t, e, id) => { t.entry = e; t.positionId = id; t.status = 'open'; ev.push(`filled ${e} ${id}`) }, closed: () => ev.push('closed'), failed: (_t, w) => ev.push(`failed ${w}`) })
    await ex.reconcile([], Date.now())
    const t = pendingTrade()
    await ex.open(t)
    expect(f.calls[0]).toEqual({ fn: 'approve', args: 1_000_000_000n + 100_000n })
    expect(f.calls[1].fn).toBe('requestOpen')
    expect(f.calls[1].args).toEqual({ marketId: 1, isLong: true, collateral: 1_000_000_000n, size: 3_000_000_000n, acceptable: 251_250_000_000n, tp: 252_500_000_000n, sl: 246_250_000_000n })
    expect(t.txOpen).toBe('0x02')
    f.view.positions = [[42n, pos({})]]
    await ex.reconcile([t], Date.now())
    expect(ev).toEqual(['filled 2501 42'])
    expect(t.positionId).toBe('42')
  })

  test("a position the keeper closed at its target is booked with the contract's P&L", async () => {
    const f = fakeChain()
    let got: unknown = null
    const ex = new TestnetExecutor(f.chain, { filled: () => {}, closed: (_t, exit, _at, reason, onChain) => { got = { exit, reason, onChain } }, failed: () => {} })
    const t = pendingTrade({ status: 'open', positionId: '42' })
    f.closed.push({ kind: 'takeProfit', positionId: '42', requestId: null, trader: 'x', market: 'ETH', isLong: true, size: null, collateral: null, price: '252500000000', pnl: '30000000', fees: '2500000', payout: null, reason: null, block: 1, tx: '0xabc', at: 5 })
    await ex.reconcile([t], Date.now())
    expect(got).toEqual({ exit: 2525, reason: 'take-profit', onChain: { pnlUsd: 27.5, feesUsd: 2.5 } })
  })

  test('refused requests fail; stale ones are cancelled for a refund; no gas or too little USDC sends nothing', async () => {
    const f = fakeChain()
    const failed: string[] = []
    const ex = new TestnetExecutor(f.chain, { filled: () => {}, closed: () => {}, failed: (_t, w) => failed.push(w) })
    await ex.reconcile([], Date.now())
    const a = pendingTrade({ id: 'A' })
    await ex.open(a)
    f.closed.push({ kind: 'cancelled', positionId: null, requestId: '7', trader: 'x', market: null, isLong: null, size: null, collateral: null, price: null, pnl: null, fees: null, payout: null, reason: 'price moved', block: 1, tx: '0x1', at: 1 })
    await ex.reconcile([a], Date.now())
    expect(failed.pop()).toContain('price moved')
    f.closed.length = 0
    const b = pendingTrade({ id: 'B' })
    await ex.open(b)
    f.view.requestIds = [7n]
    await ex.reconcile([b], Date.now() + 200_000)
    expect(f.calls.at(-1)).toEqual({ fn: 'cancel', args: 7n })
    expect(failed.pop()).toContain('cancelled and refunded')
    f.view.gasWei = 0n
    await ex.open(pendingTrade({ id: 'C' }))
    expect(failed.pop()).toContain('gas')
    f.view.gasWei = 10n ** 18n
    f.view.usdc = 10_000_000n
    await ex.open(pendingTrade({ id: 'D' }))
    expect(failed.pop()).toContain('tUSDC')
  })
})

describe('nightly review', () => {
  test('without a brain: measured, nothing proposed, and it says so', async () => {
    const core = new AlgoCore(cloneConfig(DEFAULT_CONFIG), new RuleReflex())
    const { review, cfg } = await nightlyReview({ core, brain: new Brain(null), bars: market(2), decisions: [], replayDays: 2, now: START + 2 * 1440 * MIN + 5 * 3_600_000 })
    expect(cfg).toBeNull()
    expect(review.by).toBe('rules')
    expect(review.proposals).toHaveLength(0)
    expect(review.summary).toContain('No brain is connected')
  })

  test("a brain's proposals are replayed before anything ships; gates are never among them", async () => {
    const core = new AlgoCore(cloneConfig(DEFAULT_CONFIG), new RuleReflex())
    const brain = Object.assign(new Brain(null), {
      review: async () => ({ summary: 's', lessons: ['l'], by: 'claude-opus-5-5', proposals: [{ param: 'minConfidence', to: 0.6, why: 'trade more' }, { param: 'tpSigma', to: 9, why: 'wider' }, { param: 'slSigma', to: 2, why: 'room' }] }),
    })
    Object.defineProperty(brain, 'enabled', { get: () => true })
    const { review, cfg } = await nightlyReview({ core, brain, bars: market(3, 0), decisions: [], replayDays: 3, now: START + 3 * 1440 * MIN + 5 * 3_600_000 })
    expect(review.by).toBe('claude-opus-5-5')
    expect(review.proposals[0]).toMatchObject({ param: 'minConfidence', status: 'rejected' })
    expect(review.proposals[0].test.detail).toContain('not a tunable')
    expect(review.proposals[1].to).toBe(2) // clamped to its range
    // A random walk: no edge either way, so nothing ships.
    expect(review.proposals.every(p => p.status === 'rejected')).toBe(true)
    expect(cfg).toBeNull()
  }, 60_000)
})

describe("the owner's controls", () => {
  test('parsed strictly', () => {
    const sig = `0x${'ab'.repeat(65)}`
    expect(parseAlgoControl({ action: 'kill', on: true, at: 1, signature: sig })).toContain('note')
    expect(parseAlgoControl({ action: 'mode', mode: 'live', at: 1, signature: sig })).toBe('unknown action')
    expect(parseAlgoControl({ action: 'reset', startUsd: 5, at: 1, signature: sig })).toContain('startUsd')
    expect(parseAlgoControl({ action: 'kill', on: true, note: 'x', at: 1, signature: '0x12' })).toContain('signature')
    expect(typeof parseAlgoControl({ action: 'gates', patch: '{"minConfidence":0.7}', note: 'x', at: 1, signature: sig })).toBe('object')
  })

  test('signed by the owner: kill, gates in bounds; anything else refused', async () => {
    const bars = market(1)
    const clock = { now: START + 1440 * MIN }
    const agent = new AlgoAgent({ perps: standIn(bars, clock), settings: new MemSettings(), vault: null, brain: new Brain(null), now: () => clock.now, tickEveryMs: 0 })
    await agent.start()
    const GOOD = `0x${'cd'.repeat(65)}`
    const verifier = new ControlVerifier('0x00000000000000000000000000000000000000bb', [], async a => a.signature === GOOD)
    const call = (body: unknown) => algoApi(new Request('http://x/v1/algo/control', { method: 'POST', body: JSON.stringify(body) }), new URL('http://x/v1/algo/control'), agent, verifier, (status, b) => new Response(JSON.stringify(b), { status }))
    const now = Date.now()
    expect((await call({ action: 'kill', on: true, note: 'stop', at: now, signature: `0x${'ee'.repeat(65)}` })).status).toBe(403)
    expect((await call({ action: 'kill', on: true, note: 'stop', at: now, signature: GOOD })).status).toBe(200)
    expect(agent.status().risk.killSwitch.tripped).toBe(true)
    expect((await call({ action: 'gates', patch: '{"minConfidence":0.5}', note: 'x', at: now + 1, signature: `0x${'cd'.repeat(64)}c1` })).status).toBe(403) // a new signature, but not the owner's
    const G2 = `0x${'cd'.repeat(65)}`
    const v2 = new ControlVerifier('0x00000000000000000000000000000000000000bb', [], async () => true)
    const call2 = (body: unknown) => algoApi(new Request('http://x/v1/algo/control', { method: 'POST', body: JSON.stringify(body) }), new URL('http://x/v1/algo/control'), agent, v2, (status, b) => new Response(JSON.stringify(b), { status }))
    expect((await call2({ action: 'gates', patch: '{"minConfidence":0.5}', note: 'x', at: now, signature: G2 })).status).toBe(400)
    expect((await call2({ action: 'gates', patch: '{"minConfidence":0.85}', note: 'tighter', at: now, signature: `0x${'cf'.repeat(65)}` })).status).toBe(200)
    expect(agent.core.cfg.gates.minConfidence).toBe(0.85)
    const st = await algoApi(new Request('http://x/v1/algo/status'), new URL('http://x/v1/algo/status'), agent, null, (status, b) => new Response(JSON.stringify(b), { status }))
    expect(st.status).toBe(200)
    agent.stop()
  }, 60_000)
})
