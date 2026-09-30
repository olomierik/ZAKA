// What the signal engine is doing, coin by coin: every coin launched in the
// last 48 hours, with where it stands and why. The site shows it live (the
// `scan` channel, pushed every 2s, and GET /v1/bot/scan), so anyone can see
// the engine working and why most coins never become a signal.
//
//   new        launched, no trade yet
//   watching   the market rules aren't met (yet): which ones, in words
//   checking   the rules are met; the safety scan hasn't finished
//   rejected   a hard safety check failed (honeypot, mint power, bundle, …)
//   signal     it fired (snipe, fast scalp or second leg)

import type { LaunchInfo, ScanRow, ScanStats } from '../../../api/_marketProtocol'

const DAY = 86_400_000

export class ScanFeed {
  readonly rows = new Map<string, ScanRow>()
  private changed = new Set<string>()
  private evalTimes: number[] = []
  private signalTimes: number[] = []
  private rejectTimes: number[] = []
  private lastEvalAt: number | null = null

  /** A launch: listed straight away, before its first trade. */
  launch(l: LaunchInfo) {
    if (this.rows.has(l.token)) return
    this.put({ token: l.token, symbol: l.symbol, launchpad: l.launchpad, launchedAt: l.timestamp, status: 'new', stage: 'snipe', reasons: ['waiting for the first trade'], priceUsd: l.priceUsd ?? null, marketCapUsd: l.marketCapUsd ?? null, liquidityUsd: null, at: l.timestamp, evals: 0 })
  }

  /** The outcome of one evaluation of a coin. */
  record(base: Pick<ScanRow, 'token' | 'symbol' | 'launchpad' | 'launchedAt' | 'priceUsd' | 'marketCapUsd' | 'liquidityUsd'>, outcome: Pick<ScanRow, 'status' | 'stage' | 'reasons'> & { strategy?: ScanRow['strategy'] }, now = Date.now()) {
    const prev = this.rows.get(base.token)
    // A signal or a rejection stays as the coin's verdict: a later "still watching"
    // (for a second leg) only refreshes its numbers.
    const keep = outcome.status === 'watching' && (prev?.status === 'signal' || prev?.status === 'rejected')
    if (outcome.status === 'rejected' && prev?.status !== 'rejected') this.rejectTimes.push(now)
    if (outcome.status === 'signal' && prev?.status !== 'signal') this.signalTimes.push(now)
    const verdict = keep ? { status: prev!.status, stage: prev!.stage, reasons: prev!.reasons, strategy: prev!.strategy } : outcome
    this.put({ ...base, ...verdict, at: now, evals: (prev?.evals ?? 0) + 1 })
    this.evalTimes.push(now)
    this.lastEvalAt = now
  }

  /** The row only (a rejection or signal the next evaluation shouldn't overwrite with "watching"). */
  get(token: string) { return this.rows.get(token) }

  drop(token: string) { this.rows.delete(token); this.changed.delete(token) }

  private put(r: ScanRow) {
    this.rows.set(r.token, r)
    this.changed.add(r.token)
  }

  stats(now = Date.now()): ScanStats {
    const prune = (a: number[], span: number) => { while (a.length && now - a[0] > span) a.shift() }
    prune(this.evalTimes, 60_000); prune(this.signalTimes, DAY); prune(this.rejectTimes, DAY)
    const byStatus: ScanStats['byStatus'] = { new: 0, watching: 0, checking: 0, rejected: 0, signal: 0 }
    for (const r of this.rows.values()) byStatus[r.status]++
    return { watching: this.rows.size, evalsPerMin: this.evalTimes.length, lastEvalAt: this.lastEvalAt, signals24h: this.signalTimes.length, rejected24h: this.rejectTimes.length, byStatus }
  }

  /** The most recently evaluated coins first, optionally of one status. */
  list(limit: number, status?: ScanRow['status']): ScanRow[] {
    const all = [...this.rows.values()].filter(r => !status || r.status === status)
    return all.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  /** Rows changed since the last call (the push every 2s), newest first. */
  drainChanged(limit: number): ScanRow[] {
    const out = [...this.changed].map(t => this.rows.get(t)).filter((r): r is ScanRow => !!r).sort((a, b) => b.at - a.at).slice(0, limit)
    this.changed.clear()
    return out
  }
}

/** The failed parts of a rule's reasons ("✗ …"), or all of them if none are marked. */
export const failing = (reasons: string[]) => {
  const f = reasons.filter(r => r.startsWith('✗'))
  return f.length ? f : reasons
}
