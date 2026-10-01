// Launchpad coins only (owner's request, 2026-10-01: "making sure all coins
// come from Arc launchpads, to avoid smart-contract coins"). A coin may become
// a signal only if:
//   origin   it was launched by a known Arc launchpad: one of the engine's
//            adapters (Argus, ARCDEX, Mercuri, SolonPad, Peach, Faze) or a
//            launch contract the generic v4 detector names (Aka.fun, o1,
//            Minara, Long.supply). "Other" (a pool opened in its coin's
//            creation transaction, sent to a contract nobody has listed) never
//            qualifies: anyone can deploy such a coin, with any code
//   code     where that launchpad's standard coin code has been learned
//            (intel/templateData.ts, engine/scripts/learn-templates.ts), the
//            coin's code matches it. A custom contract can hide what the
//            scanner's bytecode checks and its one-time sell test miss (a sell
//            that starts failing later); the launchpad's own code can't.
//            ARCDEX's and Long.supply's coins are trusted by origin until their
//            code is learned: their launchpads deploy every coin themselves
//
// SIGNALS_LAUNCHPAD_ONLY (Railway): `strict` (the default: origin and code),
// `origin` (origin only: for a launchpad whose code changed until its template
// is relearned), `off` (any coin, as before). Coins from elsewhere still show
// in the Terminal; they just never become signals.

import type { LaunchInfo } from '../../../api/_marketProtocol'

export type LaunchpadOnly = 'strict' | 'origin' | 'off'

/** Each known Arc launchpad (as the engine names it) and its standard coin code's template names; empty: not learned yet. */
export const LAUNCHPAD_TEMPLATES: Record<string, readonly string[]> = {
  ARGUS: ['Argus P7 token', 'Argus P8 token'],
  ARCDEX: [],
  Mercuri: ['Mercuri token'],
  SolonPad: ['SolonPad token'],
  Peach: ['Peach token'],
  Faze: ['Faze token'],
  'Aka.fun': ['Aka.fun token'],
  o1: ['o1 token'],
  Minara: ['Minara token'],
  'Long.supply': [],
}

const BY_KEY = new Map(Object.entries(LAUNCHPAD_TEMPLATES).map(([name, t]) => [name.toLowerCase(), { name, templates: t }]))

/** The known launchpad a coin came from, or null ("Other", or a name nobody listed). */
export function knownLaunchpad(meta: Pick<LaunchInfo, 'launchpad'>): { name: string; templates: readonly string[] } | null {
  return BY_KEY.get((meta.launchpad ?? '').toLowerCase()) ?? null
}

/** Why a coin can't be a signal under `mode` (null: it can). `template`: the standard code its contract matches, if any; undefined while not read. */
export function launchpadGate(mode: LaunchpadOnly, meta: Pick<LaunchInfo, 'launchpad' | 'entry'>, template?: string | null): string | null {
  if (mode === 'off') return null
  const lp = knownLaunchpad(meta)
  if (!lp) return `not launched by a known Arc launchpad (${meta.launchpad || 'unknown'}${meta.entry ? `, via ${meta.entry}` : ''}): only launchpad coins become signals`
  if (mode === 'origin' || !lp.templates.length || template === undefined) return null
  if (template && lp.templates.includes(template)) return null
  return `its code isn't ${lp.name}'s standard coin${template ? ` (it matches ${template})` : ''}: a custom contract, not the launchpad's own`
}
