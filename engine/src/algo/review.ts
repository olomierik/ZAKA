// The nightly review, after each UTC day:
//   1. the day's fills, measured: trades, wins, P&L, fees, drawdown
//   2. its misses: decisions a gate held back that would have reached their target, and which
//      gates held directional decisions back
//   3. calibration, out of sample: fit on labels resolved before the day, scored (Brier, ECE,
//      reliability) on the day's own labels
//   4. the brain's notes and at most three proposed tuning changes (none without a brain)
//   5. each proposal replayed against the current settings over the stored candles; it ships only
//      if it trades at least as often as a minimum, makes more per trade, and draws down no more.
// Gates and risk limits never change here: only the owner changes those, by signed control.

import type { AlgoCalibration, AlgoDecisionRow, AlgoMarket, AlgoProposal, AlgoReview } from '../../../api/_algoProtocol'
import type { PerpsBar } from '../perps/shared'
import { dayStart } from './book'
import type { Brain } from './brain'
import { Calibrator, reportOf } from './calibration'
import { TUNABLE, tunedValue, withTuned, type AlgoConfig } from './config'
import { thinLabels, type AlgoCore } from './core'
import type { ResolvedLabel } from './labels'
import { replayAsync } from './replay'

const MEANING: Record<string, string> = {
  trendMin: 'EMA gap (hourly sigmas) that makes a market trending',
  trendMaxStretch: "no trend entry beyond this many hourly sigmas from the hour's mean",
  mrMinStretch: 'a ranging market is faded from this many hourly sigmas',
  highVolRatio: 'volatility ratio that means stand aside',
  tpSigma: 'take-profit, in sigmas of the hold time',
  slSigma: 'stop-loss, in sigmas of the hold time',
}

const DAY = 86_400_000

/** Calibration fit on labels resolved before `testFrom` (one calibrator per family, as the agent
 * uses), scored on the labels of decisions made in [testFrom, testTo). */
export function calibrationReport(labels: readonly ResolvedLabel[], testFrom: number, testTo: number, thinMin: number, at: number): AlgoCalibration {
  const fams = ['trend', 'fade'] as const
  const train = fams.flatMap(f => thinLabels(labels, f, testFrom, 0, thinMin))
  const test = fams.flatMap(f => thinLabels(labels, f, Infinity, testFrom, thinMin)).filter(l => l.at < testTo)
  const cal = Object.fromEntries(fams.map(f => [f, new Calibrator().fit(train.filter(l => l.family === f).map(l => ({ p: l.raw, win: l.win })))])) as Record<'trend' | 'fade', Calibrator>
  const base = train.length ? train.filter(l => l.win).length / train.length : null
  return reportOf(test.map(l => ({ p: cal[l.family].map(l.raw), win: l.win })), base, train.length, at)
}

export interface ReviewDeps {
  core: AlgoCore
  brain: Brain | null
  bars: Partial<Record<AlgoMarket, readonly PerpsBar[]>>
  decisions: readonly AlgoDecisionRow[]
  /** How many days of candles a proposal is replayed over (at most what's stored). */
  replayDays: number
  now: number
}

export async function nightlyReview(d: ReviewDeps): Promise<{ review: AlgoReview; cfg: AlgoConfig | null }> {
  const to = dayStart(d.now)
  const from = to - DAY
  const day = new Date(from).toISOString().slice(0, 10)
  const core = d.core
  const trades = core.book.closed().filter(t => (t.closedAt ?? 0) >= from && (t.closedAt ?? 0) < to)
  const wins = trades.filter(t => (t.pnlUsd ?? 0) > 0)
  const pnl = trades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const all = core.book.stats()
  const stats = {
    ...all, trades: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length : null,
    pnlUsd: Math.round(pnl * 100) / 100, pnlPct: Math.round((pnl / core.book.startUsd) * 10_000) / 100,
    feesUsd: Math.round(trades.reduce((s, t) => s + t.feesUsd, 0) * 100) / 100,
  }
  const rows = d.decisions.filter(r => r.at >= from && r.at < to)
  const gateFailures: Record<string, number> = {}
  for (const r of rows) if (r.decision.direction !== 'neutral') for (const c of r.gate.checks) if (!c.ok) gateFailures[c.id] = (gateFailures[c.id] ?? 0) + 1
  const labelById = new Map(core.labeler.resolved.map(l => [l.id, l]))
  const missedWinners = rows.filter(r => !r.gate.passed && r.decision.direction !== 'neutral' && labelById.get(r.id)?.win).length
  const calibration = calibrationReport(core.labeler.resolved, from, to, core.cfg.thinMin, d.now)
  const tunables = Object.entries(TUNABLE).map(([param, t]) => ({ param, value: tunedValue(core.cfg, param)!, min: t.min, max: t.max, meaning: MEANING[param] ?? param }))

  const notes = d.brain?.enabled ? await d.brain.review({ day, stats, calibration, trades, decisions: rows.length, setups: rows.filter(r => r.gate.passed).length, gateFailures, missedWinners, tunables }) : null
  const proposals: AlgoProposal[] = []
  let cfg: AlgoConfig | null = null
  for (const p of (notes?.proposals ?? []).slice(0, 3)) {
    const cur = tunedValue(core.cfg, p.param)
    if (cur === null || !Number.isFinite(p.to)) { proposals.push({ param: p.param, from: cur ?? NaN, to: p.to, why: p.why, status: 'rejected', test: { tradesBefore: 0, tradesAfter: 0, expectancyBefore: null, expectancyAfter: null, brierBefore: null, brierAfter: null, detail: 'not a tunable setting' } }); continue }
    proposals.push(await testProposal(d, cfg ?? core.cfg, p.param, cur, p.to, p.why))
    if (proposals.at(-1)!.status === 'shipped') cfg = withTuned(cfg ?? core.cfg, p.param, p.to)
  }

  const deterministic = `${stats.trades} trades, ${stats.wins} won, P&L $${stats.pnlUsd}. ${rows.filter(r => r.gate.passed).length} setups passed every gate out of ${rows.length} decisions. Calibration skill ${calibration.skill ?? '—'} (above 0 beats the base rate) on ${calibration.nTest} held-out labels.`
  return {
    cfg,
    review: {
      id: `review-${day}`, at: d.now, day, by: notes?.by ?? 'rules', stats, decisions: rows.length, setups: rows.filter(r => r.gate.passed).length,
      calibration, summary: notes?.summary ?? `${deterministic} No brain is connected (ANTHROPIC_API_KEY), so nothing was proposed.`,
      lessons: notes?.lessons ?? [], proposals,
    },
  }
}

async function testProposal(d: ReviewDeps, base: AlgoConfig, param: string, from: number, to: number, why: string): Promise<AlgoProposal> {
  const t = TUNABLE[param]
  const clamped = Math.min(t.max, Math.max(t.min, to))
  const end = Math.floor(d.now / 60_000) * 60_000
  const start = end - d.replayDays * DAY
  // Both replays warm up on the first day and are measured over the rest.
  const run = (c: AlgoConfig) => replayAsync({ bars: d.bars, cfg: c, from: start + DAY, to: end })
  const [a, b] = [await run(base), await run(withTuned(base, param, clamped))]
  const sa = a.summary.stats, sb = b.summary.stats
  const exp = (s: typeof sa) => (s.trades ? s.pnlUsd / s.trades : null)
  const ea = exp(sa), eb = exp(sb)
  const minTrades = 5
  let ok = false, detail: string
  if (sb.trades < minTrades) detail = `only ${sb.trades} trades with the change over ${d.replayDays - 1} days (needs ${minTrades})`
  else if (ea !== null && (eb ?? -Infinity) <= ea) detail = `made $${(eb ?? 0).toFixed(2)} a trade against $${ea.toFixed(2)} now`
  else if (sb.maxDrawdownPct > sa.maxDrawdownPct + 1) detail = `drawdown ${sb.maxDrawdownPct}% against ${sa.maxDrawdownPct}% now`
  else if (sb.pnlUsd <= 0) detail = `lost $${(-sb.pnlUsd).toFixed(2)} over the replay`
  else { ok = true; detail = `${sb.trades} trades at $${(eb ?? 0).toFixed(2)} each (now ${sa.trades} at ${ea === null ? '—' : '$' + ea.toFixed(2)}), drawdown ${sb.maxDrawdownPct}%` }
  return {
    param, from, to: clamped, why, status: ok ? 'shipped' : 'rejected',
    test: { tradesBefore: sa.trades, tradesAfter: sb.trades, expectancyBefore: ea, expectancyAfter: eb, brierBefore: null, brierAfter: null, detail },
  }
}
