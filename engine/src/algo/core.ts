// ARCDEX Algo's core: one candle close → for each market, the state, the reflex's decision, its
// calibrated confidence, the risk state, the gates and the size. The same code runs live
// (agent.ts) and over history (replay.ts), so the replay measures the agent that trades.
//
// Paper fills: an order fills at the first price at least `fillDelayMs` after the decision (live)
// or at the next candle's close (replay); take-profit and stop-loss are watched on every price,
// a stop before a target inside one candle; a trade still open at its horizon is closed.
// Open positions are re-read every candle: a crisis closes them (code, never delegated); a
// confidence under `escalateBelow`, a flipped direction or high volatility escalates them to the
// brain, whose only choices are hold or close (and without a brain, close).

import type { AlgoDecision, AlgoDecisionRow, AlgoMarket, AlgoTrade } from '../../../api/_algoProtocol'
import { ALGO_MARKETS } from '../../../api/_algoProtocol'
import type { PerpsBar } from '../perps/shared'
import { Book, pnlAt } from './book'
import { Calibrator } from './calibration'
import type { AlgoConfig } from './config'
import { Labeler, type ResolvedLabel } from './labels'
import { planTrade } from './policy'
import { familyOf, type Reflex } from './reflex'
import { RiskLayer } from './risk'
import { buildState, closedUpTo, MIN, snapshotText } from './state'

export const REF: Record<AlgoMarket, AlgoMarket> = { BTC: 'ETH', ETH: 'BTC', SOL: 'BTC' }

export interface StepContext {
  barsOf: (m: AlgoMarket) => readonly PerpsBar[]
  /** Live only: the oracle's signer dispersion and the latest price's age. */
  dispersionOf?: (m: AlgoMarket) => number | null
  priceAgeOf?: (m: AlgoMarket) => number | null
  minCollateralUsd?: number
}

export interface Escalation { trade: AlgoTrade; row: AlgoDecisionRow; trigger: string }

export interface StepResult {
  rows: AlgoDecisionRow[]
  /** Trades the gate and the risk layer passed: pending until filled. */
  opened: AlgoTrade[]
  /** Trades the code closes now (crisis), and the ones to escalate. */
  closeNow: { trade: AlgoTrade; reason: string }[]
  escalate: Escalation[]
}

let seq = 0
const newId = (p: string, t: number) => `${p}-${t.toString(36)}-${(++seq).toString(36)}`

export class AlgoCore {
  book: Book
  risk: RiskLayer
  labeler = new Labeler()
  calibrators: Record<'trend' | 'fade', Calibrator> = { trend: new Calibrator(), fade: new Calibrator() }
  decisions: AlgoDecisionRow[] = []
  /** Pending fills: the trade and the earliest time it may fill. */
  private fillAfter = new Map<string, number>()

  constructor(public cfg: AlgoConfig, public reflex: Reflex, mode: AlgoBookMode = 'paper', startUsd = cfg.startUsd) {
    this.book = new Book(startUsd, mode)
    this.risk = new RiskLayer(() => this.cfg.limits)
  }

  calibrated(family: 'trend' | 'fade'): boolean {
    return this.calibrators[family].n >= this.cfg.minLabels
  }

  /** Refits both calibrators on the labels resolved by `now`, thinned to one per market and family
   * every `thinMin` minutes: a decision every minute with a four-hour horizon makes neighbours'
   * labels nearly the same outcome, and counting each would claim confidence the data hasn't earned. */
  refit(now: number, since = 0) {
    for (const fam of ['trend', 'fade'] as const) this.calibrators[fam].fit(thinLabels(this.labeler.resolved, fam, now, since, this.cfg.thinMin).map(l => ({ p: l.raw, win: l.win })))
  }

  resolveLabels(barsOf: (m: string) => readonly PerpsBar[], now: number): ResolvedLabel[] {
    return this.labeler.resolve(barsOf, now)
  }

  /** The decisions at candle close `t` for every market. */
  step(t: number, ctx: StepContext): StepResult {
    const res: StepResult = { rows: [], opened: [], closeNow: [], escalate: [] }
    const g = this.cfg.gates
    for (const m of ALGO_MARKETS) {
      const t0 = performance.now()
      const bars = ctx.barsOf(m)
      const pos = this.book.openIn(m)
      const end = closedUpTo(bars, t)
      const pxNow = end > 0 ? bars[end - 1][4] : null
      const s = buildState({
        market: m, bars, t, ref: ctx.barsOf(REF[m]), dispersionBps: ctx.dispersionOf?.(m) ?? null,
        inventory: pos && pos.status === 'open' && pxNow ? { side: pos.side, uPnlPct: Math.round((pos.side === 'long' ? pxNow / pos.entry - 1 : 1 - pxNow / pos.entry) * 1_000_000) / 10_000, ageMin: Math.round((t - pos.openedAt) / MIN) } : null,
        drawdownPct: this.risk.drawdownPct(this.book), dayPnlPct: this.risk.dayPnlPct(this.book),
        horizonMin: this.cfg.geometry.horizonMin,
      })
      if (!s) continue
      if (s.srcMaxTs > t) throw new Error(`state for ${m} read past ${t}`) // causality is a hard rule
      const out = this.reflex.decide(s, this.cfg.reflex)
      const fam = familyOf(out.decision.regime)
      const cal = fam && out.decision.direction !== 'neutral' ? this.calibrators[fam] : null
      const confidence = cal ? Math.round(cal.map(out.raw) * 10_000) / 10_000 : 0
      const decision: AlgoDecision = { ...out.decision, risk_state: this.risk.riskState(this.book), confidence }
      const { gate, plan } = planTrade({ state: s, decision, calibrated: !!fam && this.calibrated(fam), equityUsd: this.book.markedUsd, cfg: this.cfg, minCollateralUsd: ctx.minCollateralUsd })
      const row: AlgoDecisionRow = {
        id: newId(m, t), at: t, market: m, decision, raw: out.raw, why: out.why, gate, action: 'none',
        snapshot: snapshotText(s), provider: this.reflex.provider, latencyMs: 0, plan,
      }
      // Every directional decision is labeled, traded or not.
      if (fam && decision.direction !== 'neutral' && s.sigmaH) {
        this.labeler.add({ id: row.id, market: m, family: fam, raw: out.raw, barrier: { side: decision.direction === 'long' ? 'long' : 'short', at: t, tpPct: this.cfg.geometry.tpSigma * s.sigmaH, slPct: this.cfg.geometry.slSigma * s.sigmaH, horizonMin: this.cfg.geometry.horizonMin } })
      }
      if (pos && pos.status === 'open') {
        // The position's thesis, re-read.
        const sameSide = decision.direction === pos.side
        const flipped = decision.direction !== 'neutral' && !sameSide
        if (decision.regime === 'crisis') {
          res.closeNow.push({ trade: pos, reason: 'crisis: closed by the risk code' })
          row.action = 'close'
        } else if (flipped || decision.regime === 'high_vol' || (sameSide && confidence < g.escalateBelow)) {
          const trigger = flipped ? `the reflex now says ${decision.direction}` : decision.regime === 'high_vol' ? 'volatility spiked' : `confidence fell to ${confidence.toFixed(2)} (under ${g.escalateBelow})`
          res.escalate.push({ trade: pos, row, trigger })
          row.action = 'escalate'
        } else row.action = 'hold'
      } else if (!pos && gate.passed && plan) {
        const why = this.risk.checkOpen({ plan, market: m, book: this.book, priceAgeMs: ctx.priceAgeOf ? ctx.priceAgeOf(m) : 0, staleMs: this.cfg.staleMs })
        if (why) {
          gate.checks.push({ id: 'risk', ok: false, detail: why })
          gate.passed = false
        } else {
          gate.checks.push({ id: 'risk', ok: true, detail: 'within every limit' })
          const trade: AlgoTrade = {
            id: newId(`T${m}`, t), mode: this.book.mode, market: m, side: plan.side, status: 'pending', decisionId: row.id,
            openedAt: t, entry: plan.entry, tp: plan.tp, sl: plan.sl, tpPct: plan.tpPct, slPct: plan.slPct, sizeUsd: plan.sizeUsd, collateralUsd: plan.collateralUsd, leverage: plan.leverage,
            confidence, kelly: plan.kelly, regime: decision.regime, closedAt: null, exit: null, pnlUsd: null, pnlPct: null, feesUsd: 0, reason: null,
            positionId: null, txOpen: null, txClose: null, escalations: [],
          }
          this.book.trades.push(trade)
          this.fillAfter.set(trade.id, t + this.cfg.costs.fillDelayMs)
          res.opened.push(trade)
          row.action = 'open'
        }
      }
      row.latencyMs = Math.round((performance.now() - t0) * 100) / 100
      res.rows.push(row)
      this.decisions.push(row)
    }
    // A little over a day of decisions: the nightly review reads the whole day.
    if (this.decisions.length > 4_800) this.decisions.splice(0, this.decisions.length - 4_800)
    return res
  }

  /** Paper: a price for `m` at `ts` fills pending trades and closes ones at their target, stop or horizon. */
  onPrice(m: AlgoMarket, px: number, ts: number, hi = px, lo = px): AlgoTrade[] {
    const closed: AlgoTrade[] = []
    for (const t of this.book.open()) {
      if (t.market !== m) continue
      if (t.status === 'pending') {
        const after = this.fillAfter.get(t.id) ?? t.openedAt
        if (ts < after) continue
        this.fill(t, px, ts)
        continue
      }
      const long = t.side === 'long'
      if (long ? lo <= t.sl : hi >= t.sl) { this.closeTrade(t, t.sl, ts, 'stop-loss'); closed.push(t); continue }
      if (long ? hi >= t.tp : lo <= t.tp) { this.closeTrade(t, t.tp, ts, 'take-profit'); closed.push(t); continue }
      if (ts - t.openedAt >= this.cfg.geometry.horizonMin * MIN) { this.closeTrade(t, px, ts, 'horizon reached'); closed.push(t) }
    }
    return closed
  }

  /** Paper fill at `px`: target and stop keep their planned distances from the real entry. */
  fill(t: AlgoTrade, px: number, ts: number) {
    const long = t.side === 'long'
    t.entry = px
    t.openedAt = ts
    t.tp = long ? px * (1 + t.tpPct / 100) : px * (1 - t.tpPct / 100)
    t.sl = long ? px * (1 - t.slPct / 100) : px * (1 + t.slPct / 100)
    t.status = 'open'
    this.fillAfter.delete(t.id)
  }

  closeTrade(t: AlgoTrade, px: number, ts: number, reason: string, onChain?: { pnlUsd: number; feesUsd: number }) {
    this.book.close(t, px, ts, reason, this.cfg.costs, onChain)
  }

  /** Marks the book and lets the risk layer watch it; returns the trades to close when the kill switch just tripped. */
  mark(prices: Partial<Record<AlgoMarket, number>>, now: number): AlgoTrade[] {
    this.book.mark(prices, now, this.cfg.costs)
    if (this.risk.watch(this.book, now)) return this.book.open()
    return []
  }

  unrealized(t: AlgoTrade, px: number, now: number) {
    return pnlAt(t, px, now, this.cfg.costs)
  }
}

export type AlgoBookMode = 'paper' | 'testnet'

/** One label per market and family every `thinMin` minutes, resolved by `now`. */
export function thinLabels(all: readonly ResolvedLabel[], fam: 'trend' | 'fade', now: number, since: number, thinMin: number): ResolvedLabel[] {
  const last = new Map<string, number>()
  const out: ResolvedLabel[] = []
  for (const l of [...all].filter(x => x.family === fam && x.resolvedAt <= now && x.at >= since).sort((a, b) => a.at - b.at)) {
    const prev = last.get(l.market)
    if (prev !== undefined && l.at - prev < thinMin * MIN) continue
    last.set(l.market, l.at)
    out.push(l)
  }
  return out
}
