// Phones: a native-style bottom tab bar (Trenches · Futures · Predict · Portfolio · More). "More" opens a sheet with
// the other pages and the trading wallet. Hidden on coin pages, which have their own sticky Buy/Sell bar.

import { useState } from 'react'
import Sheet, { afterSheetClose } from './Sheet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { trenchesPage } from './NavBar'
import { useChain } from '../lib/chains'
import { OPEN_RPC_SETTINGS } from '../lib/rpcSettings'
import { t as T, N_ } from '../lib/i18n'
import { useFlag } from '../lib/flags'

const TRENCHES = new Set<Page['name']>(['terminal', 'launchpad', 'robinhood', 'solana', 'bsc'])

const MORE: { icon: string; label: string; to: Page }[] = [
  { icon: '⇄', label: N_('Swap'), to: { name: 'swap' } },
  { icon: '◎', label: N_('Bridge'), to: { name: 'bridge' } },
  { icon: '◆', label: N_('Starknet'), to: { name: 'starknet' } },
  { icon: '♛', label: N_('Top futures traders'), to: { name: 'leaderboard', tab: 'futures' } },
  { icon: '🔥', label: N_('$ARCDEX burn'), to: { name: 'coin' } },
  { icon: '🧭', label: N_('Supported routes'), to: { name: 'routes' } },
]

interface Props { page: Page; navigate: (p: Page) => void; onOpenLists: () => void }

export default function MobileTabBar({ page, navigate }: Props) {
  const chain = useChain()
  const [more, setMore] = useState(false)
  // Copy trading shows once it's switched on (the copyTrading flag, /admin → Flags).
  const copyOn = useFlag('copyTrading')
  const items = copyOn ? [{ icon: '⧉', label: N_('Copy trading'), to: { name: 'copy' } as Page }, ...MORE] : MORE
  const tabs: { key: string; icon: string; label: string; to: Page; on: boolean }[] = [
    { key: 'trenches', icon: '◈', label: T('Trenches'), to: trenchesPage(chain), on: TRENCHES.has(page.name) },
    { key: 'futures', icon: '📊', label: T('Futures'), to: { name: 'perps' }, on: page.name === 'perps' || page.name === 'futures' },
    { key: 'predict', icon: '🎯', label: T('Predict'), to: { name: 'predict' }, on: page.name === 'predict' },
    { key: 'portfolio', icon: '▤', label: T('Portfolio'), to: { name: 'portfolio' }, on: page.name === 'portfolio' },
  ]
  const inMore = items.some(m => m.to.name === page.name)
  const goFromSheet = (fn: () => void) => { setMore(false); afterSheetClose(fn) }

  return (
    <>
      <nav className="tabbar" aria-label={T('Main')}>
        {tabs.map(t => (
          <button key={t.key} className={`tabbar-item${t.on ? ' active' : ''}`} onClick={() => navigate(t.to)}>
            <span className="tabbar-icon">{t.icon}</span>
            <span className="tabbar-label">{t.label}</span>
          </button>
        ))}
        <button className={`tabbar-item${inMore || more ? ' active' : ''}`} onClick={() => setMore(true)}>
          <span className="tabbar-icon">☰</span>
          <span className="tabbar-label">{T('More')}</span>
        </button>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title={T('More')}>
        <div className="more-grid">
          {items.map(m => (
            <button key={m.label} className={`more-item${page.name === m.to.name ? ' active' : ''}`} onClick={() => goFromSheet(() => navigate(m.to))}>
              <span className="more-icon">{m.icon}</span>
              <span>{T(m.label)}</span>
            </button>
          ))}
        </div>
        <button className="more-lists" onClick={() => goFromSheet(openTradingWallet)}>
          <span>⚡ {T('Trading wallet')}</span><span aria-hidden>›</span>
        </button>
        <button className="more-lists" onClick={() => goFromSheet(() => window.dispatchEvent(new Event(OPEN_RPC_SETTINGS)))}>
          <span>⚙ {T('RPC settings')}</span><span aria-hidden>›</span>
        </button>
        <a className="more-lists" href="/about">
          <span>ⓘ {T('About ARCDEX')}</span><span aria-hidden>›</span>
        </a>
      </Sheet>
    </>
  )
}
