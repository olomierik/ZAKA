// Every page's one place in the menus (owner, 2026-10-17: "if there are buttons that are repetitions, the More button and
// the others, remove them; nothing repeated on our platform"):
//   • the top bar's links: Trenches, Futures, Predict, Portfolio, Swap and Bridge (PRIMARY);
//   • its More menu: everything else (MORE_ITEMS), the same list as the phone's More sheet;
//   • the account menu: what's yours (profile, settings, withdraw, transfers, rewards, support, sign out);
//   • the network menu: the Trenches' chains; the status line: prices, speed and the explorer, no pages.
// Swap and Bridge drop out of the top bar under 1360px; the More menu then shows them (`fold`), so at any width each
// page is on screen once. Phones have the tab bar (Trenches, Futures, Predict, Portfolio) and the More sheet; the ☰
// drawer is for 768-900px, where the top bar has no room for links, and lists PRIMARY then MORE_ITEMS.

import type { Page } from '../App'
import { N_ } from './i18n'
import { useFlag } from './flags'

export interface NavItem { icon: string; label: string; to: Page; /** Shown in the desktop More menu only once the top bar's link of the same page has dropped out. */ fold?: 'wide' }

/** The top bar's links after Trenches (whose chain is the one picked last). */
export const PRIMARY: NavItem[] = [
  { icon: '📊', label: N_('Futures'), to: { name: 'perps' } },
  { icon: '🎯', label: N_('Predict'), to: { name: 'predict' } },
  { icon: '▤', label: N_('Portfolio'), to: { name: 'portfolio' } },
  { icon: '⇄', label: N_('Swap'), to: { name: 'swap' }, fold: 'wide' },
  { icon: '◎', label: N_('Bridge'), to: { name: 'bridge' }, fold: 'wide' },
]

export const MORE_ITEMS: NavItem[] = [
  { icon: '◉', label: N_('Wallet tracker'), to: { name: 'tracker' } },
  { icon: '♛', label: N_('Top futures traders'), to: { name: 'leaderboard', tab: 'futures' } },
  { icon: '☰', label: N_('Feed'), to: { name: 'feed' } },
  { icon: '⚑', label: N_('Clans'), to: { name: 'clans' } },
  { icon: '⚙', label: N_('ARCDEX Algo'), to: { name: 'signals' } },
  { icon: '◆', label: N_('Starknet'), to: { name: 'starknet' } },
  { icon: '🔥', label: N_('$ARCDEX burn'), to: { name: 'coin' } },
  { icon: '🧭', label: N_('Supported routes'), to: { name: 'routes' } },
  { icon: '📈', label: N_('Analytics'), to: { name: 'analytics' } },
]

/** The More list as this visitor sees it: Copy trading first while its flag is on. Admin is in the account menu. */
export function useMoreItems(): NavItem[] {
  const copyOn = useFlag('walletCopy')
  return [
    ...(copyOn ? [{ icon: '⧉', label: N_('Copy trading'), to: { name: 'copy' } as Page }] : []),
    ...MORE_ITEMS,
  ]
}

/** Every page, in menu order, for the ☰ drawer and the phone's More sheet: the top bar's pages that a menu has to carry
 * there, then More. */
export function allPages(more: NavItem[], primary: NavItem[] = PRIMARY): NavItem[] {
  const seen = new Set<string>()
  return [...primary, ...more].filter(i => { const k = JSON.stringify(i.to); if (seen.has(k)) return false; seen.add(k); return true })
}
