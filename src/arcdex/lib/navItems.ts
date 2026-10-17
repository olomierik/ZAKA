// The pages that aren't in the main links, in one list for the phone's More sheet (components/MobileTabBar.tsx) and the
// desktop top bar's More menu (components/NavBar.tsx), so a page added to one shows on both. Copy trading follows its
// flag; Admin shows only in a browser where an admin wallet has signed in to /admin (lib/adminSession.ts).

import type { Page } from '../App'
import { N_ } from './i18n'
import { useFlag } from './flags'
import { useTrader } from './identity'
import { isKnownAdmin } from './adminSession'

export interface NavItem { icon: string; label: string; to: Page }

export const MORE_ITEMS: NavItem[] = [
  { icon: '⇄', label: N_('Swap'), to: { name: 'swap' } },
  { icon: '◎', label: N_('Bridge'), to: { name: 'bridge' } },
  { icon: '◆', label: N_('Starknet'), to: { name: 'starknet' } },
  { icon: '⚙', label: N_('ARCDEX Algo'), to: { name: 'signals' } },
  { icon: '♛', label: N_('Top futures traders'), to: { name: 'leaderboard', tab: 'futures' } },
  { icon: '◉', label: N_('Wallet tracker'), to: { name: 'tracker' } },
  { icon: '☰', label: N_('Feed'), to: { name: 'feed' } },
  { icon: '⚑', label: N_('Clans'), to: { name: 'clans' } },
  { icon: '🔥', label: N_('$ARCDEX burn'), to: { name: 'coin' } },
  { icon: '🧭', label: N_('Supported routes'), to: { name: 'routes' } },
]

/** The More list as this visitor sees it: Copy trading first while its flag is on, Admin last for admins. */
export function useMoreItems(): NavItem[] {
  const copyOn = useFlag('walletCopy')
  const me = useTrader().address
  return [
    ...(copyOn ? [{ icon: '⧉', label: N_('Copy trading'), to: { name: 'copy' } as Page }] : []),
    ...MORE_ITEMS,
    ...(isKnownAdmin(me) ? [{ icon: '🛡', label: N_('Admin'), to: { name: 'admin' } as Page }] : []),
  ]
}
