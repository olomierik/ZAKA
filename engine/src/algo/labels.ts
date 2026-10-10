// Outcome labels: did a decision's trade reach its take-profit before its stop-loss, within its
// horizon (triple barrier)? Every directional decision is labeled, traded or not, so the reflex is
// calibrated on far more than its few trades. A label is only known once its barrier is hit or its
// horizon has passed, so a calibration fit at time T only ever reads labels resolved by T.
//
// Fills match the replay's: the close of the candle after the decision (the keeper fills a market
// order with the first signed price after it). Within one candle, a stop counts before a target.

import type { PerpsBar } from '../perps/shared'
import { closedUpTo, MIN } from './state'

export interface Barrier {
  side: 'long' | 'short'
  /** Decision time (a candle close). */
  at: number
  tpPct: number
  slPct: number
  horizonMin: number
}

export interface Outcome {
  done: boolean
  win: boolean
  reason: 'tp' | 'sl' | 'time' | null
  entry: number | null
  exit: number | null
  exitAt: number | null
  /** The price move in the trade's favour, % (before costs). */
  movePct: number | null
}

/** The barrier's outcome from the candles closed by `now`. */
export function outcomeOf(bars: readonly PerpsBar[], b: Barrier, now: number): Outcome {
  const pending: Outcome = { done: false, win: false, reason: null, entry: null, exit: null, exitAt: null, movePct: null }
  const end = closedUpTo(bars, now)
  const start = closedUpTo(bars, b.at, end) // the first candle after the decision
  if (start >= end) return pending
  const fill = bars[start]
  const entry = fill[4]
  const long = b.side === 'long'
  const tp = long ? entry * (1 + b.tpPct / 100) : entry * (1 - b.tpPct / 100)
  const sl = long ? entry * (1 - b.slPct / 100) : entry * (1 + b.slPct / 100)
  const deadline = fill[0] + MIN + b.horizonMin * MIN
  const move = (px: number) => (long ? (px / entry - 1) : (1 - px / entry)) * 100
  for (let i = start + 1; i < end; i++) {
    const [t, , hi, lo, c] = bars[i]
    if (t + MIN > deadline) break
    const hitSl = long ? lo <= sl : hi >= sl
    const hitTp = long ? hi >= tp : lo <= tp
    if (hitSl) return { done: true, win: false, reason: 'sl', entry, exit: sl, exitAt: t + MIN, movePct: move(sl) }
    if (hitTp) return { done: true, win: true, reason: 'tp', entry, exit: tp, exitAt: t + MIN, movePct: move(tp) }
    if (t + MIN === deadline) return { done: true, win: false, reason: 'time', entry, exit: c, exitAt: t + MIN, movePct: move(c) }
  }
  if (now >= deadline) {
    // The feed had a gap at the deadline: the last close before it decides.
    const j = closedUpTo(bars, deadline, end) - 1
    const c = j >= start ? bars[j][4] : entry
    return { done: true, win: false, reason: 'time', entry, exit: c, exitAt: deadline, movePct: move(c) }
  }
  return pending
}

export interface PendingLabel {
  id: string
  market: string
  family: 'trend' | 'fade'
  raw: number
  barrier: Barrier
}

export interface ResolvedLabel { id: string; market: string; family: 'trend' | 'fade'; raw: number; win: boolean; at: number; resolvedAt: number; movePct: number }

/** Labels waiting for their outcome, and the resolved ones (the last `keep`). */
export class Labeler {
  pending: PendingLabel[] = []
  resolved: ResolvedLabel[] = []
  constructor(private keep = 50_000) {}

  add(l: PendingLabel) { this.pending.push(l) }

  /** Resolves what it can with each market's candles; returns the newly resolved. */
  resolve(barsOf: (market: string) => readonly PerpsBar[], now: number): ResolvedLabel[] {
    const out: ResolvedLabel[] = []
    const left: PendingLabel[] = []
    for (const l of this.pending) {
      const o = outcomeOf(barsOf(l.market), l.barrier, now)
      if (!o.done) { left.push(l); continue }
      out.push({ id: l.id, market: l.market, family: l.family, raw: l.raw, win: o.win, at: l.barrier.at, resolvedAt: o.exitAt ?? now, movePct: o.movePct ?? 0 })
    }
    this.pending = left
    this.resolved.push(...out)
    if (this.resolved.length > this.keep) this.resolved.splice(0, this.resolved.length - this.keep)
    return out
  }
}
