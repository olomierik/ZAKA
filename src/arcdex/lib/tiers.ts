// Autotrade access tiers by $ARCD held (owner's decision, 2026-10-01: Tier 1
// at 5M, Tier 2 at 20M, Tier 3 at 50M $ARCD). Announced now, enforced later:
// nothing is locked yet (sign-in is by email, so enforcing needs each account
// to link a wallet holding $ARCD first). The landing page and the Autotrade
// page both read this list.

import { N_ } from './i18n'

export interface ArcdTier { id: 'free' | 't1' | 't2' | 't3'; name: string; minArcd: number; perks: string[] }

export const ARCD_TIERS: ArcdTier[] = [
  { id: 'free', name: N_('Free'), minArcd: 0, perks: [N_('Paper trading'), N_('1 bot')] },
  { id: 't1', name: N_('Tier 1'), minArcd: 5_000_000, perks: [N_('Live trading'), N_('Up to 3 bots')] },
  { id: 't2', name: N_('Tier 2'), minArcd: 20_000_000, perks: [N_('Live trading'), N_('Up to 5 bots')] },
  { id: 't3', name: N_('Tier 3'), minArcd: 50_000_000, perks: [N_('Live trading'), N_('Up to 5 bots'), N_('Half the profit fee: 7.5% instead of 15%')] },
]

/** Whether the engine checks holdings yet (it doesn't: the tiers are announced). */
export const TIERS_ENFORCED = false

/** "5M", "20M", "50M". */
export const arcdAmount = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n.toLocaleString('en-US'))
