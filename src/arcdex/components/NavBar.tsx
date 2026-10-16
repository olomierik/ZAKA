import { useEffect, useRef, useState } from 'react'
import AccountMenu from './AccountMenu'
import SearchBox from './SearchBox'
import ChainLogo from './ChainLogo'
import type { Page } from '../App'
import { LANGS, setLang, t as T, useLang, type Lang } from '../lib/i18n'
import { COIN_LC, COIN_POOL } from '../lib/coin'
import { CHAINS, CHAIN_LIST, setChain, useChain, type TChain } from '../lib/chains'
import { toggleTheme, useTheme } from '../lib/theme'
import { OPEN_RPC_SETTINGS } from '../lib/rpcSettings'

interface Props { page: Page; navigate: (p: Page) => void; onMenuClick: () => void; onBack?: () => void; onBell: () => void; bellCount: number }

/** $ARCDEX's trading page. */
export const COIN_PAGE: Page = { name: 'argus', address: COIN_LC, pool: COIN_POOL }

/** The Trenches for a chain (the chain chips and the network menu). */
export const trenchesPage = (c: TChain): Page => ({ name: 'terminal', chain: c })
const TRENCHES = new Set<Page['name']>(['terminal', 'launchpad', 'robinhood', 'solana', 'bsc'])

export function MoonIcon({ dark }: { dark: boolean }) {
  return dark
    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>
    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" /></svg>
}
export const BellIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2.2 2.2 0 0 0 4 0" /></svg>
const GlobeIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
const Chevron = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>

/** Closes a popover on a click outside it. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [open, close])
  return ref
}

// motion.gift's top bar (owner, 2026-10-12): the mark, theme and language, the pages (Futures and Predict, which
// motion doesn't have, stand out in green), search by name or contract, the network menu (the Trenches' chain and
// RPC settings), price alerts and the account.
export default function NavBar({ page, navigate, onMenuClick, onBack, onBell, bellCount }: Props) {
  const theme = useTheme()
  const lang = useLang()
  const chain = useChain()
  const [searchOpen, setSearchOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [netOpen, setNetOpen] = useState(false)
  const langRef = useOutside(langOpen, () => setLangOpen(false))
  const netRef = useOutside(netOpen, () => setNetOpen(false))

  const links: { label: string; page: Page; active: boolean; hot?: boolean }[] = [
    { label: T('Trenches'), page: trenchesPage(chain), active: TRENCHES.has(page.name) },
    { label: T('Futures'), page: { name: 'perps' }, active: page.name === 'perps' || page.name === 'futures' || page.name === 'hl-trader', hot: true },
    { label: T('Predict'), page: { name: 'predict' }, active: page.name === 'predict', hot: true },
    { label: T('Portfolio'), page: { name: 'portfolio' }, active: page.name === 'portfolio' },
    { label: T('Swap'), page: { name: 'swap' }, active: page.name === 'swap' },
    { label: T('Bridge'), page: { name: 'bridge' }, active: page.name === 'bridge' },
  ]
  const pickChain = (c: TChain) => { setChain(c); setNetOpen(false); navigate(trenchesPage(c)) }

  return (
    <header className="tm-nav">
      <button className="tm-burger" onClick={onMenuClick} aria-label={T('Menu')}><span /><span /><span /></button>
      {onBack && <button className="tm-back" onClick={onBack} aria-label={T('Back')}>‹</button>}

      <button className="tm-logo" onClick={() => navigate(trenchesPage(chain))} aria-label="ARCDEX">
        <img src="/arcdex-mark-48.png" alt="" width={24} height={24} /><span>arcdex</span>
      </button>
      <button className="tm-round" onClick={toggleTheme} title={theme === 'dark' ? T('Light mode') : T('Dark mode')} aria-label={theme === 'dark' ? T('Light mode') : T('Dark mode')}>
        <MoonIcon dark={theme === 'dark'} />
      </button>
      <div className="tm-pop-wrap" ref={langRef}>
        <button className="tm-round tm-lang" onClick={() => setLangOpen(o => !o)} aria-expanded={langOpen} title={T('Language')}>{lang.toUpperCase()}</button>
        {langOpen && (
          <div className="tm-pop">
            {LANGS.map(l => (
              <button key={l.code} className={`tm-pop-item${l.code === lang ? ' on' : ''}`} onClick={() => { setLangOpen(false); void setLang(l.code as Lang) }}>
                <span>{l.name}</span>{l.code === lang && <span className="tm-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="tm-links">
        {links.map(l => (
          <button key={l.label} className={`tm-link${l.active ? ' on' : ''}${l.hot ? ' hot' : ''}`} onClick={() => navigate(l.page)}>{l.label}</button>
        ))}
      </nav>

      <SearchBox navigate={navigate} mobileOpen={searchOpen} />
      <button className="tm-round tm-search-toggle" onClick={() => setSearchOpen(o => !o)} aria-label={T('Search')}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      </button>

      <div className="tm-right">
        <div className="tm-pop-wrap" ref={netRef}>
          <button className="tm-btn tm-net" onClick={() => setNetOpen(o => !o)} aria-expanded={netOpen} title={T('Network')}>
            <GlobeIcon /><ChainLogo chain={chain} size={16} /><span className="tm-net-name">{CHAINS[chain].name}</span><Chevron />
          </button>
          {netOpen && (
            <div className="tm-pop tm-pop-right tm-net-pop">
              <div className="tm-pop-h">{T('Chains')}</div>
              {CHAIN_LIST.map(c => (
                <button key={c} className={`tm-pop-item${c === chain ? ' on' : ''}`} onClick={() => pickChain(c)}>
                  <ChainLogo chain={c} size={18} /><span>{CHAINS[c].name}</span><small>{CHAINS[c].native}</small>{c === chain && <span className="tm-check">✓</span>}
                </button>
              ))}
              <button className="tm-pop-item" onClick={() => { setNetOpen(false); navigate({ name: 'starknet' }) }}>
                <ChainLogo chain="strk" size={18} /><span>Starknet</span><small>{T('Swap')}</small>
              </button>
              <div className="tm-pop-sep" />
              <button className="tm-pop-item" onClick={() => { setNetOpen(false); window.dispatchEvent(new Event(OPEN_RPC_SETTINGS)) }}>
                <span className="tm-rpc-dot" /><span>{T('RPC settings')}</span><small>{T('speed test')}</small>
              </button>
            </div>
          )}
        </div>
        <button className="tm-round tm-sq tm-bell" onClick={onBell} title={T('Price alerts')} aria-label={T('Price alerts')}>
          <BellIcon />{bellCount > 0 && <span className="tm-bell-n">{bellCount}</span>}
        </button>
        <AccountMenu navigate={navigate} />
      </div>
    </header>
  )
}
