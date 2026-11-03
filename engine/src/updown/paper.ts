// The engine's paper book for BTC Up/Down: virtual dollars, real Polymarket books, real fees, real results.
//
// - Orders fill after the engine's measured book lag plus Polymarket's 150 ms taker delay, against the book as it is
//   then (strategy.ts fillFak). An order that finds nothing left at its price is counted as missed.
// - A position is sold at the bid when the strategy's exit says so (strategy.ts exitDecision: a scalp once the market
//   pays the model's value, a stop once the model says it's worth well under its cost), after the same delay, against
//   the bids as they then are; whatever isn't sold is held to resolution: Polymarket's own close against the price to
//   beat (Up at or above it).
// - The day's loss stop, the per-window cap and the cooldown are enforced here, whatever the strategy wants.
// - The model is scored against the market on the same snapshots (Brier), so the readiness bar can ask whether it's
//   actually better than the price it trades against: both its raw model and the chance it trades on (learn.ts).
// - Trades of a kind it learned to skip are "shadow" trades: filled and settled like the rest, outside the balance,
//   the caps and the loss stop, so the learner keeps measuring them. Every closed trade gets its lesson (learn.ts).

import { UPDOWN_READY, type UpdownDur, type UpdownExit, type UpdownLane, type UpdownLaneStats, type UpdownReadiness, type UpdownSide, type UpdownStats, type UpdownTrade } from '../../../api/_updownProtocol'
import { RULES } from './strategy'
import { LEARN, lessonOf, type SnapRow } from './learn'

const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const emptyLane = (): UpdownLaneStats => ({ trades: 0, won: 0, staked: 0, pnl: 0, fees: 0 })
/** Shares of a position not yet sold. */
export const heldShares = (t: UpdownTrade) => Math.max(0, t.shares - (t.sold ?? 0))
const feesOf = (t: UpdownTrade) => t.fee + (t.exitFee ?? 0)
const real = (t: UpdownTrade) => !t.shadow

/** A 10-second snapshot of a live window: the raw model, the market's mid, the chance it traded on, seconds left. */
interface Snap extends SnapRow { used: number }

export interface PaperState {
  since: number
  start: number
  bankroll: number
  trades: UpdownTrade[]
  missed: number
  /** Resolved windows the engine watched, and Brier sums over their snapshots. */
  seen: number
  brierModel: number
  brierMarket: number
  brierN: number
  /** The chance it trades on (after what it learned), scored on the same snapshots. */
  brierUsed?: number
  brierUsedN?: number
}

export const freshPaper = (now: number, start = 1_000): PaperState => ({ since: now, start, bankroll: start, trades: [], missed: 0, seen: 0, brierModel: 0, brierMarket: 0, brierN: 0 })

export class PaperBook {
  private spent = new Map<string, number>()
  private lastOrder = new Map<string, number>()
  private snaps = new Map<string, Snap[]>()
  private shadows = new Map<string, number>()
  dirty = false
  /** Called with a resolved window's snapshots, for the learner. */
  onResolved?: (slug: string, rows: SnapRow[], up: boolean) => void

  constructor(public s: PaperState, private limits: { windowUsd: number; dailyLossUsd: number; cooldownMs: number } = RULES) {
    for (const t of s.trades) if (t.result === 'open' && real(t)) this.spent.set(t.slug, (this.spent.get(t.slug) ?? 0) + t.cost)
  }

  todayPnl(now: number) {
    const d = day(now)
    return this.s.trades.filter(t => real(t) && t.result !== 'open' && day(t.filledAt) === d).reduce((a, t) => a + (t.pnl ?? 0), 0)
  }
  /** Open positions count as lost until settled, for the loss stop. */
  todayRisk(now: number) {
    const d = day(now)
    return this.todayPnl(now) - this.s.trades.filter(t => real(t) && t.result === 'open' && day(t.filledAt) === d).reduce((a, t) => a + t.cost - (t.proceeds ?? 0), 0)
  }
  stopped(now: number) { return this.todayRisk(now) <= -this.limits.dailyLossUsd }

  /** Why no new order may go into this window now, or null. */
  blocked(slug: string, now: number): string | null {
    if (this.stopped(now)) return 'the day’s loss stop'
    if ((this.spent.get(slug) ?? 0) >= this.limits.windowUsd - 1) return 'this window’s cap'
    if (now - (this.lastOrder.get(slug) ?? 0) < this.limits.cooldownMs) return 'cooling down after an order'
    return null
  }
  windowLeft(slug: string) { return Math.max(0, this.limits.windowUsd - (this.spent.get(slug) ?? 0)) }
  /** Positions open now (shadow trades aside). */
  openCount() { return this.s.trades.filter(t => t.result === 'open' && real(t)).length }
  /** Marks an order as sent, so a second can't follow before it lands. */
  sending(slug: string, now: number) { this.lastOrder.set(slug, now) }

  /** Whether another shadow trade may go into this window on this side. */
  shadowRoom(slug: string, side: UpdownSide) { return (this.shadows.get(`${slug}:${side}`) ?? 0) < LEARN.shadowPerWindow }

  record(t: Omit<UpdownTrade, 'id' | 'result' | 'pnl'>) {
    const trade: UpdownTrade = { ...t, id: `${t.slug}:${t.filledAt}:${t.side}${t.shadow ? ':shadow' : ''}`, result: 'open', pnl: null }
    this.s.trades.push(trade)
    if (t.shadow) {
      const k = `${t.slug}:${t.side}`
      this.shadows.set(k, (this.shadows.get(k) ?? 0) + 1)
    } else {
      this.s.bankroll = r6(this.s.bankroll - t.cost)
      this.spent.set(t.slug, (this.spent.get(t.slug) ?? 0) + t.cost)
    }
    if (this.s.trades.length > 5_000) this.s.trades.splice(0, this.s.trades.length - 5_000)
    this.dirty = true
    return trade
  }
  miss() { this.s.missed++; this.dirty = true }

  /** A sale of part or all of a position before the result. Sold out, the trade closes with its P&L; the window's cap
   *  gets back the share of the cost that was sold. */
  sell(id: string, fill: { shares: number; proceeds: number; fee: number }, why: UpdownExit, now: number): UpdownTrade | null {
    const t = this.s.trades.find(x => x.id === id)
    if (!t || t.result !== 'open' || fill.shares <= 0) return null
    const shares = Math.min(fill.shares, heldShares(t))
    const k = shares / fill.shares
    t.sold = r6((t.sold ?? 0) + shares)
    t.proceeds = r6((t.proceeds ?? 0) + fill.proceeds * k)
    t.exitFee = r6((t.exitFee ?? 0) + fill.fee * k)
    t.exitAt = now
    t.exit = why
    if (real(t)) {
      this.s.bankroll = r6(this.s.bankroll + fill.proceeds * k)
      this.spent.set(t.slug, Math.max(0, (this.spent.get(t.slug) ?? 0) - t.cost * (shares / t.shares)))
    }
    if (heldShares(t) < 0.01) {
      t.pnl = r6((t.proceeds ?? 0) - t.cost)
      t.result = t.pnl > 0 ? 'won' : 'lost'
      t.lesson = lessonOf(t)
    }
    this.dirty = true
    return t
  }

  /** The side's best bid while a position is held, for its lesson. */
  mark(t: UpdownTrade, bid: number) {
    if (t.hi === undefined || bid > t.hi) { t.hi = bid; this.dirty = true }
    if (t.lo === undefined || bid < t.lo) { t.lo = bid; this.dirty = true }
  }

  snapshot(slug: string, p: number, market: number, used = p, left = 0) {
    const a = this.snaps.get(slug) ?? []
    a.push({ p, market, used, left })
    this.snaps.set(slug, a)
  }

  /** A window's result: settles its positions and scores its snapshots. Returns the trades settled. */
  settle(slug: string, up: boolean): UpdownTrade[] {
    const out: UpdownTrade[] = []
    for (const t of this.s.trades) {
      if (t.slug !== slug || t.result !== 'open') continue
      const payout = (t.side === 'up') === up ? heldShares(t) : 0
      t.pnl = r6(payout + (t.proceeds ?? 0) - t.cost)
      t.result = t.pnl > 0 ? 'won' : 'lost'
      t.lesson = lessonOf(t)
      if (real(t)) this.s.bankroll = r6(this.s.bankroll + payout)
      out.push(t)
    }
    const snaps = this.snaps.get(slug)
    if (snaps?.length) {
      const y = up ? 1 : 0
      for (const sn of snaps) {
        this.s.brierModel += (sn.p - y) ** 2; this.s.brierMarket += (sn.market - y) ** 2; this.s.brierN++
        this.s.brierUsed = (this.s.brierUsed ?? 0) + (sn.used - y) ** 2; this.s.brierUsedN = (this.s.brierUsedN ?? 0) + 1
      }
      this.s.seen++
      this.onResolved?.(slug, snaps, up)
    }
    this.snaps.delete(slug)
    for (const k of [...this.shadows.keys()]) if (k.startsWith(`${slug}:`)) this.shadows.delete(k)
    this.spent.delete(slug)
    this.lastOrder.delete(slug)
    this.dirty = true
    return out
  }

  /** Windows the book holds open positions in. */
  openSlugs() { return [...new Set(this.s.trades.filter(t => t.result === 'open').map(t => t.slug))] }

  stats(now: number): UpdownStats {
    const s = this.s
    const byLane: Record<UpdownLane, UpdownLaneStats> = { A: emptyLane(), B: emptyLane() }
    const byDur: Record<UpdownDur, UpdownLaneStats> = { '5m': emptyLane(), '15m': emptyLane() }
    const days = new Map<string, { day: string; trades: number; pnl: number; staked: number }>()
    let won = 0, lost = 0, open = 0, staked = 0, fees = 0, pnl = 0
    const exits: Record<UpdownExit, number> = { scalp: 0, stop: 0 }
    const shadow = { trades: 0, won: 0, pnl: 0 }
    for (const t of s.trades) {
      if (!real(t)) { shadow.trades++; if (t.result === 'won') shadow.won++; shadow.pnl += t.pnl ?? 0; continue }
      staked += t.cost; fees += feesOf(t)
      for (const g of [byLane[t.lane], byDur[t.dur]]) { g.trades++; g.staked += t.cost; g.fees += feesOf(t); if (t.result === 'won') g.won++; if (t.pnl !== null) g.pnl += t.pnl }
      if (t.result === 'open') { open++; continue }
      if (t.exit && heldShares(t) < 0.01) exits[t.exit]++
      if (t.result === 'won') won++; else lost++
      pnl += t.pnl ?? 0
      const d = day(t.filledAt)
      const row = days.get(d) ?? { day: d, trades: 0, pnl: 0, staked: 0 }
      row.trades++; row.pnl += t.pnl ?? 0; row.staked += t.cost
      days.set(d, row)
    }
    const round = (g: UpdownLaneStats) => ({ ...g, staked: r6(g.staked), pnl: r6(g.pnl), fees: r6(g.fees) })
    return {
      since: s.since, bankroll: r6(s.bankroll), start: s.start, trades: s.trades.length - shadow.trades, open, won, lost,
      staked: r6(staked), fees: r6(fees), pnl: r6(pnl), missed: s.missed, exits,
      byLane: { A: round(byLane.A), B: round(byLane.B) }, byDur: { '5m': round(byDur['5m']), '15m': round(byDur['15m']) },
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, pnl: r6(d.pnl), staked: r6(d.staked) })),
      windowsTraded: new Set(s.trades.filter(real).map(t => t.slug)).size, windowsSeen: s.seen,
      brier: { model: s.brierN ? s.brierModel / s.brierN : null, market: s.brierN ? s.brierMarket / s.brierN : null, samples: s.brierN, used: s.brierUsedN ? s.brierUsed! / s.brierUsedN : null, usedSamples: s.brierUsedN ?? 0 },
      shadow: { ...shadow, pnl: r6(shadow.pnl) },
      todayPnl: r6(this.todayPnl(now)), stoppedToday: this.stopped(now),
    }
  }

  readiness(now: number): UpdownReadiness {
    const st = this.stats(now)
    const daysRun = Math.floor((now - this.s.since) / 86_400_000)
    // Two consecutive weeks, each positive after fees (the most recent 14 days, split in two).
    const weekPnl = (fromDay: number, toDay: number) => st.days.filter(d => { const age = (now - Date.parse(d.day)) / 86_400_000; return age >= fromDay && age < toDay }).reduce((a, d) => a + d.pnl, 0)
    const weeksPositive = (weekPnl(0, 7) > 0 ? 1 : 0) + (weekPnl(7, 14) > 0 ? 1 : 0)
    // The chance it trades on, once it has been scored on enough snapshots; the raw model before that.
    const mine = (st.brier.usedSamples ?? 0) >= 300 ? st.brier.used! : st.brier.model
    const modelBeatsMarket = mine === null || st.brier.market === null ? null : mine <= st.brier.market
    const why: string[] = []
    if (daysRun < UPDOWN_READY.days) why.push(`${daysRun} of ${UPDOWN_READY.days} days on paper`)
    if (st.windowsTraded < UPDOWN_READY.windows) why.push(`${st.windowsTraded} of ${UPDOWN_READY.windows} windows traded`)
    if (weeksPositive < UPDOWN_READY.weeksPositive) why.push(`${weeksPositive} of 2 weeks positive after fees`)
    if (modelBeatsMarket !== true) why.push(modelBeatsMarket === null ? 'model not scored yet' : 'the market’s price scores better than the model')
    return { ready: !why.length, days: daysRun, windows: st.windowsTraded, weeksPositive, modelBeatsMarket, why }
  }
}

export type { UpdownSide }
