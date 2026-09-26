// Phones: a native-style bottom tab bar (Home · Feed · Swap · Portfolio ·
// More) instead of a hamburger drawer. "More" opens a sheet with every other
// page, plus the lists panel (watchlist, trending, most held…).
// Hidden on coin pages, which have their own sticky Buy/Sell bar.

import { useState } from 'react'
import Sheet, { afterSheetClose } from './Sheet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T, N_ } from '../lib/i18n'

const TABS: { page: Page['name']; icon: string; label: string; to: Page }[] = [
  { page: 'terminal', icon: '◈', label: N_('Home'), to: { name: 'terminal' } },
  { page: 'feed', icon: '◉', label: N_('Feed'), to: { name: 'feed' } },
  { page: 'swap', icon: '⇄', label: N_('Swap'), to: { name: 'swap' } },
  { page: 'portfolio', icon: '▤', label: N_('Portfolio'), to: { name: 'portfolio' } },
]

const MORE: { icon: string; label: string; to: Page }[] = [
  { icon: '◆', label: N_('Launchpad'), to: { name: 'launchpad' } },
  { icon: '◎', label: N_('Bridge'), to: { name: 'bridge' } },
  { icon: '♛', label: N_('Leaderboard'), to: { name: 'leaderboard' } },
  { icon: '⚑', label: N_('Clans'), to: { name: 'clans' } },
  { icon: '✦', label: N_('Rewards'), to: { name: 'rewards' } },
  { icon: '🔔', label: N_('Alerts'), to: { name: 'alerts' } },
  { icon: '⇅', label: N_('Transfers'), to: { name: 'transfers' } },
  { icon: '🔥', label: N_('$ARCD burn'), to: { name: 'burn' } },
]

interface Props { page: Page; navigate: (p: Page) => void; onOpenLists: () => void }

export default function MobileTabBar({ page, navigate, onOpenLists }: Props) {
  const [more, setMore] = useState(false)
  const inMore = MORE.some(m => m.to.name === page.name)
  const go = (p: Page) => navigate(p)
  const goFromSheet = (fn: () => void) => { setMore(false); afterSheetClose(fn) }

  return (
    <>
      <nav className="tabbar" aria-label={T("Main")}>
        {TABS.map(t => (
          <button key={t.page} className={`tabbar-item${t.page === 'swap' ? ' tabbar-trade' : ''}${page.name === t.page ? ' active' : ''}`} onClick={() => go(t.to)}>
            <span className="tabbar-icon">{t.icon}</span>
            <span className="tabbar-label">{T(t.label)}</span>
          </button>
        ))}
        <button className={`tabbar-item${inMore || more ? ' active' : ''}`} onClick={() => setMore(true)}>
          <span className="tabbar-icon">☰</span>
          <span className="tabbar-label">{T("More")}</span>
        </button>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title={T("More")}>
        <div className="more-grid">
          {MORE.map(m => (
            <button key={m.label} className={`more-item${page.name === m.to.name ? ' active' : ''}`} onClick={() => goFromSheet(() => navigate(m.to))}>
              <span className="more-icon">{m.icon}</span>
              <span>{T(m.label)}</span>
            </button>
          ))}
        </div>
        <button className="more-lists" onClick={() => goFromSheet(openTradingWallet)}>
          <span>⚡ {T("Trading wallet")}</span><span aria-hidden>›</span>
        </button>
        <button className="more-lists" onClick={() => goFromSheet(onOpenLists)}>
          <span>☆ {T("Watchlist, trending & most held")}</span><span aria-hidden>›</span>
        </button>
      </Sheet>
    </>
  )
}
