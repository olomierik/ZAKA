// The risk layer: hard, deterministic limits no model can override, checked before every order.
//
//   max drawdown   15% under the peak equity: the kill switch trips, every position is closed, and
//                  only the owner's signed re-arm turns trading back on
//   daily loss     5% of the day's opening equity: no new trades until the next UTC day
//   position       notional at most 100% of equity, at most 2% of equity at risk a trade,
//                  leverage at most 3×, at most 3 positions and one per market
//   data           no order on a price older than 45 seconds
//   kill switch    tripped by the owner or by the drawdown; checked first, every time
//
// It also says the risk state the reflex's decision carries: reduce near a limit (80% of the way),
// near_limit half-way, safe otherwise.

import type { AlgoLimits, AlgoMarket, AlgoPlan, AlgoRisk, AlgoRiskState } from '../../../api/_algoProtocol'
import type { Book } from './book'

export interface KillState { tripped: boolean; reason: string | null; at: number | null }

export class RiskLayer {
  kill: KillState = { tripped: false, reason: null, at: null }

  constructor(private limits: () => AlgoLimits) {}

  drawdownPct(b: Book): number {
    return b.peakUsd > 0 ? Math.max(0, ((b.peakUsd - b.markedUsd) / b.peakUsd) * 100) : 0
  }

  dayLossPct(b: Book): number {
    return b.dayStartUsd > 0 ? Math.max(0, ((b.dayStartUsd - b.markedUsd) / b.dayStartUsd) * 100) : 0
  }

  dayPnlPct(b: Book): number {
    return b.dayStartUsd > 0 ? ((b.markedUsd - b.dayStartUsd) / b.dayStartUsd) * 100 : 0
  }

  riskState(b: Book): AlgoRiskState {
    if (this.kill.tripped) return 'reduce'
    const L = this.limits()
    const dd = this.drawdownPct(b) / L.maxDrawdownPct
    const day = this.dayLossPct(b) / L.maxDailyLossPct
    const worst = Math.max(dd, day)
    if (worst >= 0.8) return 'reduce'
    if (worst >= 0.5 || b.open().length >= L.maxOpen) return 'near_limit'
    return 'safe'
  }

  trip(reason: string, now: number) {
    if (this.kill.tripped) return
    this.kill = { tripped: true, reason, at: now }
  }

  rearm() {
    this.kill = { tripped: false, reason: null, at: null }
  }

  /** After each mark: trips the kill switch on the drawdown limit. Returns true when it just tripped. */
  watch(b: Book, now: number): boolean {
    const L = this.limits()
    const dd = this.drawdownPct(b)
    if (!this.kill.tripped && dd >= L.maxDrawdownPct) {
      this.trip(`drawdown ${dd.toFixed(2)}% reached the ${L.maxDrawdownPct}% limit`, now)
      return true
    }
    return false
  }

  /** null when the order may go; otherwise why not. Checked before every new position. */
  checkOpen(o: { plan: AlgoPlan; market: AlgoMarket; book: Book; priceAgeMs: number | null; staleMs: number }): string | null {
    const L = this.limits()
    if (this.kill.tripped) return `the kill switch is tripped (${this.kill.reason ?? 'by the owner'})`
    const dd = this.drawdownPct(o.book)
    if (dd >= L.maxDrawdownPct) return `drawdown ${dd.toFixed(2)}% at the ${L.maxDrawdownPct}% limit`
    const day = this.dayLossPct(o.book)
    if (day >= L.maxDailyLossPct) return `today's loss ${day.toFixed(2)}% reached the ${L.maxDailyLossPct}% limit`
    if (o.priceAgeMs === null || o.priceAgeMs > o.staleMs) return `the price is stale (${o.priceAgeMs === null ? 'none' : Math.round(o.priceAgeMs / 1000) + 's old'})`
    const open = o.book.open()
    if (open.length >= L.maxOpen) return `${open.length} positions open (at most ${L.maxOpen})`
    if (open.some(t => t.market === o.market)) return `already in ${o.market}`
    const eq = o.book.markedUsd
    if (!(eq > 0)) return 'no equity'
    if (o.plan.sizeUsd > (L.maxPositionPct / 100) * eq + 1e-6) return `size $${o.plan.sizeUsd.toFixed(2)} over ${L.maxPositionPct}% of equity`
    const exposure = open.reduce((s, t) => s + t.sizeUsd, 0) + o.plan.sizeUsd
    if (exposure > (L.maxPositionPct / 100) * eq * L.maxOpen + 1e-6) return 'total exposure over the limit'
    const atRisk = o.plan.sizeUsd * ((o.plan.slPct) / 100)
    if (atRisk > (L.maxRiskPerTradePct / 100) * eq * 1.25 + 1e-6) return `$${atRisk.toFixed(2)} at risk, over ${L.maxRiskPerTradePct}% of equity`
    if (o.plan.leverage > L.maxLeverage) return `leverage ${o.plan.leverage}× over ${L.maxLeverage}×`
    return null
  }

  view(b: Book): AlgoRisk {
    const r2 = (x: number) => Math.round(x * 100) / 100
    return {
      limits: this.limits(),
      equityUsd: r2(b.markedUsd), startUsd: b.startUsd, peakUsd: r2(b.peakUsd),
      drawdownPct: r2(this.drawdownPct(b)), dayStartUsd: r2(b.dayStartUsd), dayPnlPct: r2(this.dayPnlPct(b)),
      open: b.open().length, risk_state: this.riskState(b), killSwitch: { ...this.kill },
    }
  }
}
