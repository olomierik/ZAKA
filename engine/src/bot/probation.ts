// A signal rule on probation (2026-09-30, owner: "refine the signal engine to
// produce quality signals"). The engine's own paper book trades every signal,
// so it measures each rule, and the team's trades (every bot's, paper and live)
// add the signals it couldn't take. When a rule's recent record there loses (negative
// P&L and under half won), its signals still fire and the paper book still
// trades them, but visitors' bots and the owner's live bot sit them out until
// the record recovers. A rule whose thresholds changed is judged on its own
// trades once it has enough of them.

import type { SignalRule } from '../../../api/_marketProtocol'
import type { Position } from '../trading/paper'

export const PROBATION = { window: 20, minTrades: 10, maxAgeMs: 7 * 86_400_000 }

/** When a rule's thresholds last changed (signals/rules.ts). */
export const RULE_REVISED: Partial<Record<SignalRule, number>> = { momentum: Date.UTC(2026, 9, 1, 6), snipe: Date.UTC(2026, 9, 1, 6) }

const LABEL: Record<SignalRule, string> = { momentum: 'Momentum bursts', snipe: 'Snipes', 'second-leg': 'Dip rebounds', volume: 'Volume spikes' }
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`

/** Why `rule` is on probation, or null. `positions`: the engine's paper book; `ruleOf` names each position's rule. */
export function probationOf(rule: SignalRule, positions: Position[], ruleOf: (p: Position) => SignalRule | null | undefined, now: number): { why: string } | null {
  // One trade per signal (the first given: the engine's paper book, then the team's), paper or live.
  const seen = new Set<string>()
  const all = positions
    .filter(p => p.status === 'closed' && ruleOf(p) === rule && now - (p.closedAt ?? 0) <= PROBATION.maxAgeMs && !seen.has(p.signalId) && (seen.add(p.signalId), true))
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const revised = RULE_REVISED[rule]
  const since = revised ? all.filter(p => p.openedAt >= revised) : []
  const judged = (since.length >= PROBATION.minTrades ? since : all).slice(-PROBATION.window)
  if (judged.length < PROBATION.minTrades) return null
  const wins = judged.filter(p => (p.pnlUsd ?? 0) > 0).length
  const pnl = judged.reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
  if (pnl >= 0 || wins / judged.length >= 0.5) return null
  return { why: `${LABEL[rule]} won ${wins} of their last ${judged.length} trades (${money(pnl)}): bots sit them out until that recovers` }
}
