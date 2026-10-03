// Autotrade tiers by $ARCD held (owner's decisions: Tier 1 at 5M, Tier 2 at
// 20M, Tier 3 at 50M $ARCD, 2026-10-01; tiered by signal quality, 2026-09-30).
// The engine's table (engine/src/bot/tiers.ts, GET /v1/tiers) is the one that
// counts; this copy is what the landing page and the Autotrade page show when
// the engine can't be reached, so keep the two in step.
//
// Everything is free until the engine enforces tiers (TIERS_ENFORCED on
// Railway): every account gets every grade of signal and every strategy, so
// everyone sees what each tier's signals do before anything is charged.

import type { BotStrategy, SignalGrade, TierId, TierInfo } from '../../../api/_marketProtocol'
import { N_ } from './i18n'

export interface ArcdTier { id: TierId; name: string; minArcd: number; perks: string[] }

export const ARCD_TIERS: ArcdTier[] = [
  { id: 'free', name: N_('Free'), minArcd: 0, perks: [N_('Paper trading'), N_('1 bot'), N_('Standard signals')] },
  { id: 't1', name: N_('Tier 1'), minArcd: 5_000_000, perks: [N_('Live trading'), N_('Up to 3 bots'), N_('Standard signals')] },
  { id: 't2', name: N_('Tier 2'), minArcd: 20_000_000, perks: [N_('Live trading'), N_('Up to 5 bots'), N_('Core and Standard signals'), N_('Ahead of Tier 1 when a signal is crowded')] },
  { id: 't3', name: N_('Tier 3'), minArcd: 50_000_000, perks: [N_('Live trading'), N_('Up to 5 bots'), N_('Prime signals and the Precision strategy'), N_('First in line on every signal'), N_('Half the profit fee: 7.5% instead of 15%')] },
]

/** The engine's answer wins (GET /v1/tiers `enforced`); this is only the fallback. */
export const TIERS_ENFORCED = false

/**
 * When tiers start by themselves; null: not scheduled. Off until further notice
 * (owner's decision, 2026-10-03; it was 3 October 2026, 00:00 UTC). The
 * engine's `enforceAt` wins; this is the fallback.
 */
export const TIERS_START: number | null = null

/** "2d 4h 12m" until `at` (null once it's passed). */
export function countdown(at: number, now = Date.now()): string | null {
  const ms = at - now
  if (ms <= 0) return null
  const m = Math.floor(ms / 60_000), d = Math.floor(m / 1_440), h = Math.floor((m % 1_440) / 60)
  return d > 0 ? `${d}d ${h}h ${m % 60}m` : h > 0 ? `${h}h ${m % 60}m` : `${Math.max(1, m)}m`
}

/** A tier's name, from the engine's table or this one. */
export const tierName = (id: TierId, list: Pick<TierInfo, 'id' | 'name'>[] = ARCD_TIERS) => list.find(t => t.id === id)?.name ?? id

/** Signal grades (engine/src/signals/grades.ts) and the lowest tier that gets each. */
export const GRADE_NAME: Record<SignalGrade, string> = { prime: N_('Prime'), core: N_('Core'), standard: N_('Standard') }
export const GRADE_COLOR: Record<SignalGrade, string> = { prime: '#facc15', core: '#38bdf8', standard: '#94a3b8' }
export const GRADE_TIER: Record<SignalGrade, TierId> = { prime: 't3', core: 't2', standard: 'free' }
export const STRATEGY_TIER: Partial<Record<BotStrategy, TierId>> = { precision: 't3' }

/** "5M", "20M", "50M". */
export const arcdAmount = (n: number) => (n >= 1e6 ? `${Math.round((n / 1e6) * 100) / 100}M` : n.toLocaleString('en-US'))
