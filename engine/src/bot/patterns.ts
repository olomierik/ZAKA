// What kinds of coin lose (owner, 2026-10-01: "read the trade logs and let each
// bot learn from its mistakes; find the reasons and patterns that make certain
// kinds of coins unprofitable to trade").
//
// Every snipe and fast-scalp signal is replayed on its coin's real trades at
// live speed with the dollar plan (Bot.replayDue); with live bots' own trades,
// that's one outcome per signal. Every minute the engine checks a fixed list of
// candidate kinds of coin against the last 7 days of them: a kind is a losing
// pattern when it has 12+ trades, loses 3%+ a trade on average, loses money in
// all, and does 8+ points a trade worse than the other coins. Live bots sit out
// a signal that matches one ("not traded live: …"); paper bots and the replays
// keep trading and measuring it, so a pattern that stops losing is lifted by
// itself, and one that starts losing is found by itself.
//
// Found first in the trade logs (230 snipes and fast scalps over two days,
// research scripts outside the repo), and checked as it runs here, each signal
// judged only on the trades that had closed before it: every signal made $1.11
// at $2 a trade (+$9.64, then −$8.53); the signals this gate let through made
// $15.59 (+$6.62, then +$8.96), 66% won; the ones it sat out lost $14.48. The
// patterns it held at the end:
//   crowded      100+ buyers already in: 57 trades, −20% a trade (with 80 or
//                fewer, the plan made +7% a trade in both halves: the crowd
//                that would carry the price to +$1 has already bought)
//   old          older than 15 minutes: 52 trades, −15%
//   selling      $30+ sold before the entry: 89 trades, −9%
// and on the way, momentum bursts on a launcher's own recycled wallets and a
// creator holding coins worth 20%+ of the pool (it sells them into the buyers:
// in 44 of 71 dumps the creator sold, a median of 71s after the entry).
// Re-entering a coin after it dumped lost in every version tried (fresh
// buyers, the creator gone, the price off its low): it's watched and measured
// as a comeback (the dip-rebound rule), never traded live until it proves out.

import type { LossPatternView, SignalFeatures, SignalRule } from '../../../api/_marketProtocol'

export const PATTERNS = { days: 7, minTrades: 12, maxAvg: -0.03, minGap: 0.08, everyMs: 60_000, sizeUsd: 2 }

/** A candidate kind of coin: null when the signal doesn't carry the number (older signals): not counted either way. */
interface Candidate { id: string; th: number; label: string; test: (f: SignalFeatures, rule: SignalRule | null) => boolean | null }

const known = <T,>(v: T | null | undefined, fn: (v: T) => boolean) => (v === null || v === undefined ? null : fn(v))
const pct = (x: number) => `${Math.round(x * 100)}%`

export const CANDIDATES: Candidate[] = [
  ...[60, 80, 100, 120, 160].map(th => ({ id: 'crowded', th, label: `${th}+ buyers already in`, test: (f: SignalFeatures) => known(f.totalBuyers, v => v >= th) })),
  ...[30, 60, 100].map(th => ({ id: 'selling', th, label: `$${th}+ sold before the entry`, test: (f: SignalFeatures) => known(f.sellUsd, v => v >= th) })),
  ...[0.1, 0.2, 0.3].map(th => ({ id: 'creator-bag', th, label: `the creator holds coins worth ${pct(th)}+ of the pool`, test: (f: SignalFeatures) => known(f.overhang, v => v >= th) })),
  ...[0.3, 0.5, 0.7].map(th => ({ id: 'farm', th, label: `${pct(th)}+ of the buyers also bought the creator's other coins`, test: (f: SignalFeatures) => known(f.farmShare, v => v >= th) })),
  { id: 'farm-momentum', th: 0.5, label: 'a momentum burst carried by the creator\'s own wallets', test: (f, rule) => known(f.farmShare, v => rule === 'momentum' && v >= 0.5) },
  ...[300, 900, 1800, 3600].map(th => ({ id: 'old', th, label: `older than ${th / 60} minutes`, test: (f: SignalFeatures) => known(f.ageSec, v => v >= th) })),
  ...[2, 3, 5].map(th => ({ id: 'serial', th, label: `the creator launched ${th}+ other coins that day`, test: (f: SignalFeatures) => known(f.creatorLaunches, v => v >= th) })),
  ...[1.2, 1.5, 2].map(th => ({ id: 'run-up', th, label: `already up ${Math.round((th - 1) * 100)}%+`, test: (f: SignalFeatures) => known(f.runUp, v => v >= th) })),
  ...[20, 30].map(th => ({ id: 'one-buyer', th, label: `one buyer ${th}%+ of the buying`, test: (f: SignalFeatures) => known(f.topBuyerPct, v => v >= th) })),
]

/** A signal's outcome on the dollar plan: its replay, or a live bot's real trade (one per signal). */
export interface Outcome { signalId: string; at: number; rule: SignalRule | null; features: SignalFeatures | undefined; ret: number }

interface Active extends LossPatternView { test: Candidate['test'] }

/** The losing patterns found in `rows`: per candidate id, the threshold whose coins lost the most (empty: none qualifies). */
export function findPatterns(rows: Outcome[], now = Date.now()): Active[] {
  const recent = rows.filter(r => r.features && now - r.at <= PATTERNS.days * 86_400_000)
  const best = new Map<string, Active>()
  for (const c of CANDIDATES) {
    const hit: number[] = [], rest: number[] = []
    for (const r of recent) {
      const m = c.test(r.features!, r.rule)
      if (m === null) continue
      ;(m ? hit : rest).push(r.ret)
    }
    if (hit.length < PATTERNS.minTrades || !rest.length) continue
    const sum = hit.reduce((s, x) => s + x, 0), avg = sum / hit.length, restAvg = rest.reduce((s, x) => s + x, 0) / rest.length
    if (avg > PATTERNS.maxAvg || sum >= 0 || restAvg - avg < PATTERNS.minGap) continue
    const pnlUsd = Math.round(sum * PATTERNS.sizeUsd * 100) / 100
    const prev = best.get(c.id)
    if (prev && prev.pnlUsd <= pnlUsd) continue
    best.set(c.id, { id: c.id, label: c.label, trades: hit.length, wins: hit.filter(x => x > 0).length, avgPct: Math.round(avg * 1_000) / 10, pnlUsd, restAvgPct: Math.round(restAvg * 1_000) / 10, test: c.test })
  }
  return [...best.values()].sort((a, b) => a.pnlUsd - b.pnlUsd)
}

/** The patterns in force, found again every minute. */
export class PatternBook {
  private active: Active[] = []
  private at = 0

  /** Finds the patterns again if a minute has passed (or `force`). */
  refresh(rows: () => Outcome[], now = Date.now(), force = false) {
    if (!force && now - this.at < PATTERNS.everyMs) return
    this.at = now
    this.active = findPatterns(rows(), now)
  }

  /** The losing pattern a signal matches (the one that lost most), or null. */
  match(f: SignalFeatures | undefined, rule: SignalRule | null): LossPatternView | null {
    if (!f) return null
    const hit = this.active.find(p => p.test(f, rule) === true)
    return hit ? view(hit) : null
  }

  view(): LossPatternView[] { return this.active.map(view) }
}

const view = ({ test: _test, ...p }: Active): LossPatternView => p

/** Why a signal is sat out, in words. */
export const patternWhy = (p: LossPatternView) =>
  `${p.label[0].toUpperCase()}${p.label.slice(1)}: coins like this won ${p.wins} of their last ${p.trades} on the $2 plan (${p.avgPct}% a trade, ${p.pnlUsd < 0 ? '−' : ''}$${Math.abs(p.pnlUsd).toFixed(2)}; other coins ${p.restAvgPct > 0 ? '+' : ''}${p.restAvgPct}%)`
