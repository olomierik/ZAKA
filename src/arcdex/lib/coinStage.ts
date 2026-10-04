// Where a coin is in its life (2026-10-04, owner: "classify coins as near bond, graduated, new"), the same on every
// chain: the coin board's columns and the Markets tabs.
//
//   new          launched under an hour ago
//   bonding      still on its launchpad's bonding curve
//   near         70%+ of the way along that curve: about to graduate
//   graduated    off the curve (or launched straight into a pool), and not yet established
//   established  graduated, a day old or more, $10K+ of liquidity and 100+ holders

import type { ArcToken } from '../api/radardex'
import type { RhCoin } from '../api/robinhoodMarket'
import { N_ } from './i18n'

export type Stage = 'new' | 'bonding' | 'near' | 'graduated' | 'established'

export const STAGE = {
  newMs: 3_600_000,
  /** Near bond from this far along the curve (owner's call: 70% or 80%; 70% suggested and used). */
  nearPct: 70,
  established: { ageMs: 86_400_000, liquidityUsd: 10_000, holders: 100, traders24h: 50 },
} as const

export const STAGE_LABEL: Record<Stage, string> = {
  new: N_('New'), bonding: N_('Bonding'), near: N_('Near bond'), graduated: N_('Graduated'), established: N_('Established'),
}

export interface StageInput {
  ageMs: number
  /** Still on a launchpad's bonding curve. */
  onCurve: boolean
  /** 0–100 along the curve, when known. */
  progress: number | null
  liquidityUsd: number
  /** Unknown: null. */
  holders: number | null
  /** Unique wallets trading in 24h, where holders aren't known (Robinhood Chain). */
  traders24h?: number | null
}

export function stageOf(c: StageInput): Stage {
  if (c.onCurve) {
    if ((c.progress ?? 0) >= STAGE.nearPct) return 'near'
    return c.ageMs > 0 && c.ageMs < STAGE.newMs ? 'new' : 'bonding'
  }
  if (c.ageMs > 0 && c.ageMs < STAGE.newMs) return 'new'
  const e = STAGE.established
  const crowd = c.holders !== null ? c.holders >= e.holders : (c.traders24h ?? 0) >= e.traders24h
  return c.ageMs >= e.ageMs && c.liquidityUsd >= e.liquidityUsd && crowd ? 'established' : 'graduated'
}

/** An Arc coin: a curve coin (ARCDEX's launchpad, Mercuri, SolonPad) or an Argus launch not yet bonded is on its curve. */
export function arcStageInput(t: ArcToken): StageInput {
  const onCurve = !t.graduated && t.bondingProgress !== null && t.bondingProgress < 100
  return { ageMs: t.ageMs, onCurve, progress: onCurve ? t.bondingProgress : null, liquidityUsd: t.liquidity, holders: t.holderCount > 0 ? t.holderCount : null }
}

/** Robinhood Chain's curve venues: Pons's curve (V1 and V2). A coin there hasn't graduated to Pons V2 Dex yet. */
const RH_CURVE_DEXES = new Set(['pons-dot-family', 'pons-v2'])

/** A Robinhood Chain coin: Pons coins on their curve; every other launchpad launches straight into a pool. Robinhood's
 * stock tokens are established by nature. */
export function rhStageInput(c: RhCoin): StageInput {
  return {
    ageMs: c.createdAt > 0 ? Math.max(0, Date.now() - c.createdAt) : 0,
    onCurve: RH_CURVE_DEXES.has(c.dex),
    progress: null,
    liquidityUsd: c.liquidity,
    holders: null,
    traders24h: c.traders24h,
  }
}

export const rhStage = (c: RhCoin): Stage => (c.stock && !c.launchpad ? 'established' : stageOf(rhStageInput(c)))
export const arcStage = (t: ArcToken): Stage => stageOf(arcStageInput(t))
