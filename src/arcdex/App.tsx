import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
// Everything but the Terminal loads on first visit to that page — they
// pull in heavy libraries (Circle Bridge Kit, charting, launchpad flows)
// that would otherwise all have to download before the coin list shows.
const TokenPage       = lazy(() => import('./pages/TokenPage'))
const ArgusTokenPage  = lazy(() => import('./pages/ArgusTokenPage'))
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
import { pageToPath, pathToPage } from './lib/router'
import './arcdex.css'
import { t as T, N_, useLang } from './lib/i18n'

// Remember ?ref= or /r/<name> before anything renders (first-touch attribution).
captureReferral()

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
  | { name: 'bridge' }

const fromUrl = (): Page => pathToPage(window.location.pathname, window.location.search) ?? { name: 'terminal' }

const MOBILE_NAV: [Page, string, string][] = [
  [{ name: 'terminal' }, '◈', N_('Terminal')], [{ name: 'feed' }, '◉', N_('Feed')], [{ name: 'leaderboard' }, '♛', N_('Leaderboard')],
  [{ name: 'clans' }, '⚑', N_('Clans')], [{ name: 'rewards' }, '✦', N_('Rewards')], [{ name: 'launchpad' }, '◆', N_('Launchpad')],
  [{ name: 'swap' }, '⇄', N_('Swap')], [{ name: 'bridge' }, '◎', N_('Bridge')], [{ name: 'portfolio' }, '▤', N_('Portfolio')],
]

export default function App() {
  const [page, setPage]       = useState<Page>(fromUrl)
  const [navOpen, setNavOpen] = useState(false)

  // Every page has a shareable URL; Back/Forward work.
  const navigate = useCallback((p: Page) => {
    setPage(p); setNavOpen(false); window.scrollTo({ top: 0 })
    const path = pageToPath(p)
    if (path !== window.location.pathname + window.location.search) window.history.pushState(null, '', path)
  }, [])
  useEffect(() => {
    const onPop = () => setPage(fromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Terminal still accepts this; nothing consumes it now that the raw Arc
  // swap feed is gone. Stable identity so Terminal's loader doesn't rerun.
  const registerFeedTokens = useCallback((_tokens: { address: string; symbol: string }[]) => {}, [])

  // Remount the content on a language change so every string re-renders.
  const lang = useLang()

  return (
    <div className="app-shell">
      <NavBar page={page} navigate={navigate} onMenuClick={() => setNavOpen(o => !o)} />

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
          {page.name === 'argus'       && <ArgusTokenPage key={page.address} address={page.address} pool={page.pool} navigate={navigate} />}
          {page.name === 'portfolio'   && <Portfolio navigate={navigate} />}
          {page.name === 'launchpad'   && <Launchpad navigate={navigate} />}
          {page.name === 'swap'        && <Swap navigate={navigate} />}
          {page.name === 'bridge'      && <Bridge />}
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
          <TradingWalletPanel />
          <FollowTopTraders navigate={navigate} />
          <DiscoverClans navigate={navigate} />
        </aside>
      </div>

      <TickerBar navigate={navigate} />
    </div>
  )
}
