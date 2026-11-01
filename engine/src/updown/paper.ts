// The engine's paper book for BTC Up/Down: virtual dollars, real Polymarket books, real fees, real results.
//
// - Orders fill after the engine's measured book lag plus Polymarket's 150 ms taker delay, against the book as it is
//   then (strategy.ts fillFak). An order that finds nothing left at its price is counted as missed.
// - A position is held to resolution: Polymarket's own close against the price to beat (Up at or above it).
// - The day's loss stop, the per-window cap and the cooldown are enforced here, whatever the strategy wants.
// - The model is scored against the market on the same snapshots (Brier), so the readiness bar can ask whether it's
//   actually better than the price it trades against.

import { UPDOWN_READY, type UpdownDur, type UpdownLane, type UpdownLaneStats, type UpdownReadiness, type UpdownSide, type UpdownStats, type UpdownTrade } from '../../../api/_updownProtocol'
import { RULES } from './strategy'

const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const emptyLane = (): UpdownLaneStats => ({ trades: 0, won: 0, staked: 0, pnl: 0, fees: 0 })

interface Snap { p: number; market: number }

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
}

export const freshPaper = (now: number, start = 1_000): PaperState => ({ since: now, start, bankroll: start, trades: [], missed: 0, seen: 0, brierModel: 0, brierMarket: 0, brierN: 0 })

export class PaperBook {
  private spent = new Map<string, number>()
  private lastOrder = new Map<string, number>()
  private snaps = new Map<string, Snap[]>()
  dirty = false

  constructor(public s: PaperState) {
    for (const t of s.trades) if (t.result === 'open') this.spent.set(t.slug, (this.spent.get(t.slug) ?? 0) + t.cost)
  }

  todayPnl(now: number) {
    const d = day(now)
    return this.s.trades.filter(t => t.result !== 'open' && day(t.filledAt) === d).reduce((a, t) => a + (t.pnl ?? 0), 0)
  }
  /** Open positions count as lost until settled, for the loss stop. */
  todayRisk(now: number) {
    const d = day(now)
    return this.todayPnl(now) - this.s.trades.filter(t => t.result === 'open' && day(t.filledAt) === d).reduce((a, t) => a + t.cost, 0)
  }
  stopped(now: number) { return this.todayRisk(now) <= -RULES.dailyLossUsd }

  /** Why no new order may go into this window now, or null. */
  blocked(slug: string, now: number): string | null {
    if (this.stopped(now)) return 'the day’s loss stop'
    if ((this.spent.get(slug) ?? 0) >= RULES.windowUsd - 1) return 'this window’s cap'
    if (now - (this.lastOrder.get(slug) ?? 0) < RULES.cooldownMs) return 'cooling down after an order'
    return null
  }
  windowLeft(slug: string) { return Math.max(0, RULES.windowUsd - (this.spent.get(slug) ?? 0)) }
  /** Marks an order as sent, so a second can't follow before it lands. */
  sending(slug: string, now: number) { this.lastOrder.set(slug, now) }

  record(t: Omit<UpdownTrade, 'id' | 'result' | 'pnl'>) {
    const trade: UpdownTrade = { ...t, id: `${t.slug}:${t.filledAt}:${t.side}`, result: 'open', pnl: null }
    this.s.trades.push(trade)
    this.s.bankroll = r6(this.s.bankroll - t.cost)
    this.spent.set(t.slug, (this.spent.get(t.slug) ?? 0) + t.cost)
    if (this.s.trades.length > 5_000) this.s.trades.splice(0, this.s.trades.length - 5_000)
    this.dirty = true
    return trade
  }
  miss() { this.s.missed++; this.dirty = true }

  snapshot(slug: string, p: number, market: number) {
    const a = this.snaps.get(slug) ?? []
    a.push({ p, market })
    this.snaps.set(slug, a)
  }

  /** A window's result: settles its positions and scores its snapshots. Returns the trades settled. */
  settle(slug: string, up: boolean): UpdownTrade[] {
    const out: UpdownTrade[] = []
    for (const t of this.s.trades) {
      if (t.slug !== slug || t.result !== 'open') continue
      const won = (t.side === 'up') === up
      const payout = won ? t.shares : 0
      t.result = won ? 'won' : 'lost'
      t.pnl = r6(payout - t.cost)
      this.s.bankroll = r6(this.s.bankroll + payout)
      out.push(t)
    }
    const snaps = this.snaps.get(slug)
    if (snaps?.length) {
      const y = up ? 1 : 0
      for (const sn of snaps) { this.s.brierModel += (sn.p - y) ** 2; this.s.brierMarket += (sn.market - y) ** 2; this.s.brierN++ }
      this.s.seen++
    }
    this.snaps.delete(slug)
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
    for (const t of s.trades) {
      staked += t.cost; fees += t.fee
      for (const g of [byLane[t.lane], byDur[t.dur]]) { g.trades++; g.staked += t.cost; g.fees += t.fee; if (t.result === 'won') g.won++; if (t.pnl !== null) g.pnl += t.pnl }
      if (t.result === 'open') { open++; continue }
      if (t.result === 'won') won++; else lost++
      pnl += t.pnl ?? 0
      const d = day(t.filledAt)
      const row = days.get(d) ?? { day: d, trades: 0, pnl: 0, staked: 0 }
      row.trades++; row.pnl += t.pnl ?? 0; row.staked += t.cost
      days.set(d, row)
    }
    const round = (g: UpdownLaneStats) => ({ ...g, staked: r6(g.staked), pnl: r6(g.pnl), fees: r6(g.fees) })
    return {
      since: s.since, bankroll: r6(s.bankroll), start: s.start, trades: s.trades.length, open, won, lost,
      staked: r6(staked), fees: r6(fees), pnl: r6(pnl), missed: s.missed,
      byLane: { A: round(byLane.A), B: round(byLane.B) }, byDur: { '5m': round(byDur['5m']), '15m': round(byDur['15m']) },
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, pnl: r6(d.pnl), staked: r6(d.staked) })),
      windowsTraded: new Set(s.trades.map(t => t.slug)).size, windowsSeen: s.seen,
      brier: { model: s.brierN ? s.brierModel / s.brierN : null, market: s.brierN ? s.brierMarket / s.brierN : null, samples: s.brierN },
      todayPnl: r6(this.todayPnl(now)), stoppedToday: this.stopped(now),
    }
  }

  readiness(now: number): UpdownReadiness {
    const st = this.stats(now)
    const daysRun = Math.floor((now - this.s.since) / 86_400_000)
    // Two consecutive weeks, each positive after fees (the most recent 14 days, split in two).
    const weekPnl = (fromDay: number, toDay: number) => st.days.filter(d => { const age = (now - Date.parse(d.day)) / 86_400_000; return age >= fromDay && age < toDay }).reduce((a, d) => a + d.pnl, 0)
    const weeksPositive = (weekPnl(0, 7) > 0 ? 1 : 0) + (weekPnl(7, 14) > 0 ? 1 : 0)
    const modelBeatsMarket = st.brier.model === null || st.brier.market === null ? null : st.brier.model <= st.brier.market
    const why: string[] = []
    if (daysRun < UPDOWN_READY.days) why.push(`${daysRun} of ${UPDOWN_READY.days} days on paper`)
    if (st.windowsTraded < UPDOWN_READY.windows) why.push(`${st.windowsTraded} of ${UPDOWN_READY.windows} windows traded`)
    if (weeksPositive < UPDOWN_READY.weeksPositive) why.push(`${weeksPositive} of 2 weeks positive after fees`)
    if (modelBeatsMarket !== true) why.push(modelBeatsMarket === null ? 'model not scored yet' : 'the market’s price scores better than the model')
    return { ready: !why.length, days: daysRun, windows: st.windowsTraded, weeksPositive, modelBeatsMarket, why }
  }
}

export type { UpdownSide }
