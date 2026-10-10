// The agent's book: its trades, its equity marked at the latest prices, its peak and its day. The
// same arithmetic as the futures contract (perps/shared.ts): fees on size at open and close and a
// borrow fee by the hour; P&L on size, as a share of the collateral.

import type { AlgoMarket, AlgoMode, AlgoStats, AlgoTrade } from '../../../api/_algoProtocol'
import type { Costs } from './config'

const DAY = 86_400_000
export const dayStart = (t: number) => Math.floor(t / DAY) * DAY
const r2 = (x: number) => Math.round(x * 100) / 100

/** A trade's P&L at `px`: the move on size, less fees and borrow. */
export function pnlAt(t: Pick<AlgoTrade, 'side' | 'entry' | 'sizeUsd' | 'openedAt'>, px: number, at: number, c: Costs) {
  const move = t.side === 'long' ? px / t.entry - 1 : 1 - px / t.entry
  const hours = Math.max(0, at - t.openedAt) / 3_600_000
  const fees = t.sizeUsd * ((c.openFeeBps + c.closeFeeBps) / 10_000 + (c.borrowPctPerHour / 100) * hours)
  return { gross: t.sizeUsd * move, fees, net: t.sizeUsd * move - fees }
}

export class Book {
  trades: AlgoTrade[] = []
  realizedUsd = 0
  peakUsd: number
  dayStartUsd: number
  day: number | null = null
  markedUsd: number

  constructor(public startUsd: number, public mode: AlgoMode) {
    this.peakUsd = startUsd
    this.dayStartUsd = startUsd
    this.markedUsd = startUsd
  }

  open(): AlgoTrade[] { return this.trades.filter(t => t.status === 'open' || t.status === 'pending') }
  closed(): AlgoTrade[] { return this.trades.filter(t => t.status === 'closed') }
  openIn(m: AlgoMarket) { return this.open().find(t => t.market === m) ?? null }

  /** Equity at the given prices: start + realized + open trades' net P&L. Also moves the peak and the day. */
  mark(prices: Partial<Record<AlgoMarket, number>>, now: number, c: Costs): number {
    let u = 0
    for (const t of this.open()) {
      const px = prices[t.market]
      if (t.status === 'open' && px) u += pnlAt(t, px, now, c).net
    }
    const eq = this.startUsd + this.realizedUsd + u
    this.markedUsd = eq
    if (eq > this.peakUsd) this.peakUsd = eq
    const d = dayStart(now)
    if (this.day !== d) { this.day = d; this.dayStartUsd = eq }
    return eq
  }

  /** Closes a trade at `px` (or with the contract's own P&L when given). */
  close(t: AlgoTrade, px: number, at: number, reason: string, c: Costs, onChain?: { pnlUsd: number; feesUsd: number }) {
    const p = onChain ? { net: onChain.pnlUsd, fees: onChain.feesUsd } : pnlAt(t, px, at, c)
    t.status = 'closed'
    t.closedAt = at
    t.exit = px
    t.pnlUsd = r2(p.net)
    t.feesUsd = r2(p.fees)
    t.pnlPct = t.collateralUsd > 0 ? Math.round((p.net / t.collateralUsd) * 10_000) / 100 : null
    t.reason = reason
    this.realizedUsd += p.net
  }

  stats(): AlgoStats {
    const cl = this.closed().sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    const wins = cl.filter(t => (t.pnlUsd ?? 0) > 0)
    const losses = cl.filter(t => (t.pnlUsd ?? 0) <= 0)
    const gw = wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    const gl = -losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    let eq = this.startUsd, peak = eq, mdd = 0
    for (const t of cl) {
      eq += t.pnlUsd ?? 0
      peak = Math.max(peak, eq)
      mdd = Math.max(mdd, peak > 0 ? (peak - eq) / peak : 0)
    }
    const pnl = cl.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    return {
      trades: cl.length, wins: wins.length,
      winRate: cl.length ? Math.round((wins.length / cl.length) * 1000) / 1000 : null,
      pnlUsd: r2(pnl), pnlPct: Math.round((pnl / this.startUsd) * 10_000) / 100,
      profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : wins.length ? null : null,
      avgWinUsd: wins.length ? r2(gw / wins.length) : null,
      avgLossUsd: losses.length ? r2(-gl / losses.length) : null,
      maxDrawdownPct: Math.round(mdd * 10_000) / 100,
      feesUsd: r2(cl.reduce((s, t) => s + t.feesUsd, 0)),
    }
  }

  toJSON() {
    return { startUsd: this.startUsd, mode: this.mode, trades: this.trades.slice(-2_000), realizedUsd: this.realizedUsd, peakUsd: this.peakUsd, dayStartUsd: this.dayStartUsd, day: this.day }
  }

  static from(j: ReturnType<Book['toJSON']>): Book {
    const b = new Book(j.startUsd, j.mode)
    b.trades = j.trades
    b.realizedUsd = j.realizedUsd
    b.peakUsd = j.peakUsd
    b.dayStartUsd = j.dayStartUsd
    b.day = j.day
    b.markedUsd = j.startUsd + j.realizedUsd
    return b
  }
}
