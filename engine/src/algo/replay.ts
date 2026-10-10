// The replay: the same core the agent trades with, run candle by candle over stored one-minute
// candles. Walk-forward by construction: the calibration is refit every few hours from labels
// already resolved at that moment, so no decision is scored by a fit that saw its own future.
// Fills at the next candle's close; stops before targets inside a candle; escalations close
// (there's no brain in a replay); the kill switch and the daily loss limit apply as live.

import type { AlgoDecisionRow, AlgoMarket, AlgoReplay } from '../../../api/_algoProtocol'
import { ALGO_MARKETS } from '../../../api/_algoProtocol'
import type { PerpsBar } from '../perps/shared'
import type { AlgoConfig } from './config'
import { AlgoCore } from './core'
import type { ResolvedLabel } from './labels'
import { RuleReflex, type Reflex } from './reflex'
import { MIN } from './state'

export interface ReplayInput {
  bars: Partial<Record<AlgoMarket, readonly PerpsBar[]>>
  cfg: AlgoConfig
  from: number
  to: number
  reflex?: Reflex
  /** Labels resolved before `from` (a warm start); later ones are made by the replay itself. */
  priorLabels?: ResolvedLabel[]
  refitEveryMin?: number
  startUsd?: number
  /** Every decision row, as it's made. */
  onRow?: (row: AlgoDecisionRow) => void
}

export interface ReplayResult {
  core: AlgoCore
  summary: AlgoReplay
}

/** Runs the replay at once (tests, small windows). */
export function replay(i: ReplayInput): ReplayResult {
  const g = steps(i)
  for (;;) { const n = g.next(); if (n.done) return n.value }
}

/** The same replay, yielding to the event loop every simulated hour: the engine keeps serving. */
export async function replayAsync(i: ReplayInput): Promise<ReplayResult> {
  const g = steps(i)
  for (;;) {
    const n = g.next()
    if (n.done) return n.value
    await new Promise<void>(r => setImmediate(r))
  }
}

function* steps(i: ReplayInput): Generator<void, ReplayResult, void> {
  const core = new AlgoCore(i.cfg, i.reflex ?? new RuleReflex(), 'paper', i.startUsd ?? i.cfg.startUsd)
  if (i.priorLabels?.length) core.labeler.resolved.push(...i.priorLabels.filter(l => l.resolvedAt <= i.from))
  core.refit(i.from)
  const barsOf = (m: AlgoMarket | string) => i.bars[m as AlgoMarket] ?? []
  // Each market's candles by close time, for the walk.
  const byClose = new Map<AlgoMarket, Map<number, PerpsBar>>()
  for (const m of ALGO_MARKETS) byClose.set(m, new Map((i.bars[m] ?? []).map(b => [b[0] + MIN, b])))
  const refitMs = (i.refitEveryMin ?? 360) * MIN
  let nextRefit = i.from + refitMs
  let decisions = 0, setups = 0
  const start = Math.ceil(i.from / MIN) * MIN
  for (let t = start; t <= i.to; t += MIN) {
    // 1. This candle's prices: pending fills, stops and targets.
    const prices: Partial<Record<AlgoMarket, number>> = {}
    for (const m of ALGO_MARKETS) {
      const b = byClose.get(m)!.get(t)
      if (!b) continue
      prices[m] = b[4]
      core.onPrice(m, b[4], t, b[2], b[3])
    }
    // 2. Mark; the drawdown limit trips the kill switch and closes everything.
    for (const tr of core.mark(prices, t)) {
      const px = prices[tr.market]
      if (tr.status === 'pending') { tr.status = 'failed'; tr.reason = 'kill switch'; continue }
      if (px) core.closeTrade(tr, px, t, 'kill switch: drawdown limit')
    }
    // 3. Labels and calibration, from what is known at t.
    if (t % (15 * MIN) === 0) core.resolveLabels(barsOf, t)
    if (t >= nextRefit) { core.refit(t); nextRefit = t + refitMs }
    // 4. The decisions.
    const r = core.step(t, { barsOf, priceAgeOf: m => (prices[m] ? 0 : null) })
    decisions += r.rows.length
    if (i.onRow) for (const row of r.rows) i.onRow(row)
    setups += r.rows.filter(x => x.gate.passed).length
    for (const c of r.closeNow) { const px = prices[c.trade.market]; if (px) core.closeTrade(c.trade, px, t, c.reason) }
    for (const e of r.escalate) {
      const px = prices[e.trade.market]
      if (!px) continue
      e.trade.escalations.push({ at: t, trigger: e.trigger, by: 'replay', action: 'close', why: 'no brain in a replay: the code closes' })
      core.closeTrade(e.trade, px, t, `escalated: ${e.trigger}`)
    }
    // Keep the decision log small in long replays.
    if (core.decisions.length > 1_000) core.decisions.splice(0, core.decisions.length - 200)
    if (t % (60 * MIN) === 0) yield
  }
  // Anything still open is marked out at the last price.
  for (const tr of core.book.open()) {
    const bars = i.bars[tr.market] ?? []
    const last = bars.filter(b => b[0] + MIN <= i.to).at(-1)
    if (tr.status === 'pending' || !last) { tr.status = 'failed'; tr.reason = 'replay ended before the fill'; continue }
    core.closeTrade(tr, last[4], i.to, 'replay ended')
  }
  core.resolveLabels(barsOf, i.to)
  const stats = core.book.stats()
  return {
    core,
    summary: {
      at: Date.now(), from: i.from, to: i.to, stats, decisions, setups,
      note: `Walk-forward replay of ${Math.round((i.to - i.from) / 3_600_000)} hours of signed oracle candles: calibration refit every ${Math.round(refitMs / 3_600_000)}h from labels resolved by then; fills at the next candle's close.`,
    },
  }
}
