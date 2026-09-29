import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
// Everything but the Terminal loads on first visit to that page — they
// pull in heavy libraries (Circle Bridge Kit, charting, launchpad flows)
// that would otherwise all have to download before the coin list shows.
const TokenPage       = lazy(() => import('./pages/TokenPage'))
// Argus/Uniswap coins and launchpad (bonding-curve) coins share /token/0x… links.
const CoinPage        = lazy(() => import('./pages/CoinPage'))
const Portfolio       = lazy(() => import('./pages/Portfolio'))
const Launchpad       = lazy(() => import('./pages/Launchpad'))
const Swap            = lazy(() => import('./pages/Swap'))
const Bridge          = lazy(() => import('./pages/Bridge'))
const TraderPage      = lazy(() => import('./pages/TraderPage'))
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'))
const FeedPage        = lazy(() => import('./pages/FeedPage'))
const RewardsPage     = lazy(() => import('./pages/RewardsPage'))
const ClansPage       = lazy(() => import('./pages/ClansPage'))
const ClanPage        = lazy(() => import('./pages/ClanPage'))
const TransfersPage   = lazy(() => import('./pages/TransfersPage'))
const BurnPage        = lazy(() => import('./pages/BurnPage'))
const AlertsPage      = lazy(() => import('./pages/AlertsPage'))
import TradingWalletPanel from './components/TradingWalletPanel'
import DiscoveryPanel from './components/DiscoveryPanel'
import { DiscoverClans, FollowTopTraders, TickerBar } from './components/Rails'
import { captureReferral } from './lib/referral'
import { loadLaunchpadCoins } from './lib/launchpadCoins'
import { pageToPath, pathToPage } from './lib/router'
import './arcdex.css'
import { t as T, N_, useLang } from './lib/i18n'
import { ConnectModalHost } from './components/ConnectWallet'
import { NetworkGuard, WalletPromptHost } from './components/WalletPrompt'
import MobileTabBar from './components/MobileTabBar'
import Sheet, { afterSheetClose } from './components/Sheet'
import { sheetHistory } from './lib/sheetHistory'
import { OPEN_TRADING_WALLET } from './lib/tradingWalletSheet'

// Remember ?ref= or /r/<name> before anything renders (first-touch attribution).
captureReferral()
// Launchpad coins open their own page from /token/0x… links (pages/CoinPage.tsx): know them early.
void loadLaunchpadCoins().catch(() => {})

export type Page =
  | { name: 'terminal' }
  | { name: 'token'; address: string; symbol?: string }
  | { name: 'argus'; address: string; pool: string }
  | { name: 'trader'; address: string }
  | { name: 'clan'; slug: string }
  | { name: 'clans' }
  | { name: 'leaderboard' }
  | { name: 'feed' }
  | { name: 'alerts' }
  | { name: 'rewards' }
  | { name: 'transfers' }
  | { name: 'burn' }
  | { name: 'portfolio' }
  | { name: 'launchpad' }
  | { name: 'swap' }
  | { name: 'bridge'; dir?: 'in' | 'out' }

const fromUrl = (): Page => pathToPage(window.location.pathname, window.location.search) ?? { name: 'terminal' }

const MOBILE_NAV: [Page, string, string][] = [
  [{ name: 'terminal' }, '◈', N_('Terminal')], [{ name: 'feed' }, '◉', N_('Feed')], [{ name: 'leaderboard' }, '♛', N_('Leaderboard')],
  [{ name: 'clans' }, '⚑', N_('Clans')], [{ name: 'rewards' }, '✦', N_('Rewards')], [{ name: 'launchpad' }, '◆', N_('Launchpad')],
  [{ name: 'swap' }, '⇄', N_('Swap')], [{ name: 'bridge' }, '◎', N_('Bridge')], [{ name: 'portfolio' }, '▤', N_('Portfolio')],
]

export default function App() {
  const [page, setPage]       = useState<Page>(fromUrl)
  const [navOpen, setNavOpen] = useState(false)

  // Every page has a shareable URL; Back/Forward work. `depth` counts the
  // steps taken inside the app, so a back arrow knows whether "back" stays here.
  const depth = useRef(0)
  const navigate = useCallback((p: Page) => {
    setPage(p); setNavOpen(false); window.scrollTo({ top: 0 })
    const path = pageToPath(p)
    if (path !== window.location.pathname + window.location.search) { window.history.pushState(null, '', path); depth.current++ }
  }, [])
  useEffect(() => {
    const onPop = () => {
      // A bottom sheet's own history entry, not a page change (see sheetHistory).
      if (sheetHistory.ignoreNextPop) { sheetHistory.ignoreNextPop = false; return }
      if (sheetHistory.open > 0) return
      setPage(fromUrl()); depth.current = Math.max(0, depth.current - 1)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Terminal still accepts this; nothing consumes it now that the raw Arc
  // swap feed is gone. Stable identity so Terminal's loader doesn't rerun.
  const registerFeedTokens = useCallback((_tokens: { address: string; symbol: string }[]) => {}, [])

  // Remount the content on a language change so every string re-renders.
  const lang = useLang()
  // Coin pages are "pushed" screens on phones: a back arrow up top, their
  // own Buy/Sell bar at the bottom instead of the tab bar.
  const detail = page.name === 'argus' || page.name === 'token'
  const goBack = useCallback(() => {
    if (depth.current > 0) window.history.back()
    else navigate({ name: 'terminal' })
  }, [navigate])

  // The trading wallet as a sheet, from any "trading wallet" link.
  const [walletSheet, setWalletSheet] = useState(false)
  useEffect(() => {
    const open = () => setWalletSheet(true)
    window.addEventListener(OPEN_TRADING_WALLET, open)
    return () => window.removeEventListener(OPEN_TRADING_WALLET, open)
  }, [])

  return (
    <div className={`app-shell${detail ? ' is-detail' : ''}`}>
      <NavBar page={page} navigate={navigate} onMenuClick={() => setNavOpen(o => !o)} onBack={detail ? goBack : undefined} />
      {/* The bridge switches the wallet to other chains on purpose. */}
      <NetworkGuard hidden={page.name === 'bridge'} />

      <div className="app-body" key={lang}>
        {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
        {/* left: fomo-style discovery panel (+ nav on phones) */}
        <aside className={`sidebar with-discovery${navOpen ? ' sidebar-open' : ''}`}>
          <nav className="mobile-nav" style={{ flexWrap: 'wrap', gap: 4, padding: 8, borderBottom: '1px solid var(--adx-border)' }}>
            {MOBILE_NAV.map(([p, icon, label]) => (
              <button key={label} className={`disc-sub${page.name === p.name ? ' active' : ''}`} onClick={() => navigate(p)}>{icon} {T(label)}</button>
            ))}
          </nav>
          <DiscoveryPanel navigate={navigate} />
        </aside>

        <main className="main-content">
          <Suspense fallback={<div className="loading-state">{T("Loading…")}</div>}>
          {page.name === 'terminal'    && <Terminal navigate={navigate} registerFeedTokens={registerFeedTokens} />}
          {page.name === 'token'       && <TokenPage address={page.address} navigate={navigate} />}
          {page.name === 'argus'       && <CoinPage key={page.address} address={page.address} pool={page.pool} navigate={navigate} />}
          {page.name === 'portfolio'   && <Portfolio navigate={navigate} />}
          {page.name === 'launchpad'   && <Launchpad navigate={navigate} />}
          {page.name === 'swap'        && <Swap navigate={navigate} />}
          {page.name === 'bridge'      && <Bridge key={page.dir ?? 'out'} initialDir={page.dir ?? 'out'} />}
          {page.name === 'trader'      && <TraderPage key={page.address} address={page.address} navigate={navigate} />}
          {page.name === 'clans'       && <ClansPage navigate={navigate} />}
          {page.name === 'clan'        && <ClanPage key={page.slug} slug={page.slug} navigate={navigate} />}
          {page.name === 'leaderboard' && <LeaderboardPage navigate={navigate} />}
          {page.name === 'feed'        && <FeedPage navigate={navigate} />}
          {page.name === 'alerts'      && <AlertsPage navigate={navigate} />}
          {page.name === 'rewards'     && <RewardsPage navigate={navigate} />}
          {page.name === 'transfers'   && <TransfersPage navigate={navigate} />}
          {page.name === 'burn'        && <BurnPage navigate={navigate} />}
          </Suspense>
        </main>

        {/* right: cash / trading wallet + who to follow */}
        <aside className="feed-panel" style={{ overflowY: 'auto' }}>
          <TradingWalletPanel navigate={navigate} />
          <FollowTopTraders navigate={navigate} />
          <DiscoverClans navigate={navigate} />
        </aside>
      </div>

      <TickerBar navigate={navigate} />
      {!detail && <MobileTabBar page={page} navigate={navigate} onOpenLists={() => setNavOpen(true)} />}
      <Sheet open={walletSheet} onClose={() => setWalletSheet(false)}>
        <TradingWalletPanel navigate={p => { setWalletSheet(false); afterSheetClose(() => navigate(p)) }} />
      </Sheet>
      <ConnectModalHost />
      <WalletPromptHost />
    </div>
  )
}
