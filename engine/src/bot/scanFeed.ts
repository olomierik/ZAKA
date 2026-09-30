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

import type { LaunchInfo, RejectionStats, ScanRow, ScanStats } from '../../../api/_marketProtocol'

/** Rejection keys in words (rules: signals/rules.ts `failed` ids; safety: intel/scanner.ts check ids). */
export const REASON_LABELS: Record<string, string> = {
  'snipe:age': 'snipe: too early or past its first 10 minutes', 'snipe:buyers': 'snipe: not enough buyers yet', 'snipe:bought': 'snipe: not enough bought yet',
  'snipe:ratio': 'snipe: sells too heavy', 'snipe:topbuyer': 'snipe: one buyer dominates', 'snipe:late': 'snipe: already ran too far', 'snipe:offpeak': 'snipe: already falling from its peak',
  'scalp:age': 'scalp: under a minute old', 'scalp:buyers': 'scalp: too few buyers in 2 minutes', 'scalp:bought': 'scalp: too little bought in 2 minutes',
  'scalp:ratio': 'scalp: sells too heavy', 'scalp:move': 'scalp: no move (or a spike)', 'scalp:offhigh': 'scalp: off its 2-minute high',
  'scalp:topbuyer': 'scalp: one buyer dominates', 'scalp:liquidity': 'scalp: pool too thin',
  'leg:peak': 'dip rebound: hasn\'t run 2× yet', 'leg:drawdown': 'dip rebound: no 25–70% pullback', 'leg:bottom': 'dip rebound: bottom too recent',
  'leg:higherlow': 'dip rebound: no higher low', 'leg:bounce': 'dip rebound: not off the bottom yet', 'leg:buying': 'dip rebound: no buying back',
  'leg:atpeak': 'dip rebound: still at its peak', 'leg:age': 'over 48 hours old', 'leg:notrades': 'no trades',
  'safety:honeypot': 'safety: honeypot or heavy tax', 'safety:contract': 'safety: the owner can still mint/freeze/pause', 'safety:proxy': 'safety: upgradeable contract',
  'safety:hook': 'safety: a hook that can block sales', 'safety:liquidity': 'safety: under $1,000 liquidity', 'safety:bundle': 'safety: bundled launch',
  'safety:clusters': 'safety: early buyers funded from one source', 'safety:wash': 'safety: wash trading', 'safety:creator': 'safety: the creator dumped',
  'safety:selfdestruct': 'safety: can self-destruct', 'safety:rug-guard': 'rug guard alarm (30-minute quarantine)', 'safety:risky-for-rebound': 'dip rebound needs a clean coin',
  'pending:honeypot': 'checking: honeypot probe', 'pending:clusters': 'checking: funding trace', 'pending:liquidity': 'checking: liquidity',
  'safety:unavailable': 'safety scan unavailable',
}

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
  record(base: Pick<ScanRow, 'token' | 'symbol' | 'launchpad' | 'launchedAt' | 'priceUsd' | 'marketCapUsd' | 'liquidityUsd'>, outcome: Pick<ScanRow, 'status' | 'stage' | 'reasons'> & { strategy?: ScanRow['strategy']; keys?: string[] }, now = Date.now()) {
    const prev = this.rows.get(base.token)
    // A signal or a rejection stays as the coin's verdict: a later "still watching"
    // (for a second leg) only refreshes its numbers.
    const keep = outcome.status === 'watching' && (prev?.status === 'signal' || prev?.status === 'rejected')
    if (outcome.status === 'rejected' && prev?.status !== 'rejected') this.rejectTimes.push(now)
    if (outcome.status === 'signal' && prev?.status !== 'signal') this.signalTimes.push(now)
    const verdict = keep ? { status: prev!.status, stage: prev!.stage, reasons: prev!.reasons, strategy: prev!.strategy, keys: prev!.keys } : outcome
    this.put({ ...base, ...verdict, at: now, evals: (prev?.evals ?? 0) + 1 })
    this.evalTimes.push(now)
    this.lastEvalAt = now
  }

  /**
   * Why the coins being watched aren't signals, by their main reason (the
   * first key of each row): the numbers behind loosening a rule (owner,
   * 2026-09-30: "check which rejections are most common").
   */
  rejections(now = Date.now()): RejectionStats {
    const counts = new Map<string, number>()
    let watching = 0
    for (const r of this.rows.values()) {
      if (r.status === 'signal' || r.status === 'new') continue
      watching++
      const k = r.keys?.[0] ?? `${r.stage}:other`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([key, coins]) => ({ key, label: REASON_LABELS[key] ?? key, coins }))
    return { top, watching, at: now }
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
