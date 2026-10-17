import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import NavBar, { trenchesPage } from './components/NavBar'
// The Trenches (motion.gift's layout, 2026-10-12) are the home of the app, for every chain.
import Trenches from './pages/Trenches'
// Everything but the Terminal loads on first visit to that page — they
// pull in heavy libraries (Circle Bridge Kit, charting, launchpad flows)
// that would otherwise all have to download before the coin list shows.
const TokenPage       = lazy(() => import('./pages/TokenPage'))
// Argus/Uniswap coins and launchpad (bonding-curve) coins share /token/0x… links.
const CoinPage        = lazy(() => import('./pages/CoinPage'))
const Portfolio       = lazy(() => import('./pages/Portfolio'))
const FuturesPage     = lazy(() => import('./pages/FuturesPage'))
// Hyperliquid (2026-10-11): perpetual futures on every market it lists, and its prediction markets.
const PerpsPage       = lazy(() => import('./pages/PerpsPage'))
const PredictPage     = lazy(() => import('./pages/PredictPage'))
const HlTraderPage    = lazy(() => import('./pages/HlTraderPage'))
const RoutesPage      = lazy(() => import('./pages/RoutesPage'))
const TrackerPage     = lazy(() => import('./pages/TrackerPage'))
const WalletAlertWatcher = lazy(() => import('./components/WalletAlertWatcher'))
// Copy trading (the build pack's Phase 7): engine-held copy wallets mirror verified leaders on Arc.
const CopyTradePage   = lazy(() => import('./pages/CopyTradePage'))
const CopyRunner      = lazy(() => import('./components/CopyRunner'))
const StarknetPage    = lazy(() => import('./pages/StarknetPage'))
const ArcdexPage       = lazy(() => import('./pages/ArcdexPage'))
const AlgoPage        = lazy(() => import('./pages/AlgoPage'))
const Swap            = lazy(() => import('./pages/Swap'))
const Bridge          = lazy(() => import('./pages/Bridge'))
const TraderPage      = lazy(() => import('./pages/TraderPage'))
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'))
const FeedPage        = lazy(() => import('./pages/FeedPage'))
const RewardsPage     = lazy(() => import('./pages/RewardsPage'))
const ClansPage       = lazy(() => import('./pages/ClansPage'))
const ClanPage        = lazy(() => import('./pages/ClanPage'))
const TransfersPage   = lazy(() => import('./pages/TransfersPage'))
const AlertsPage      = lazy(() => import('./pages/AlertsPage'))
const DeployCurveRouter = lazy(() => import('./pages/DeployCurveRouter'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const SignalsPage     = lazy(() => import('./pages/SignalsPage'))
// Robinhood Chain: its coins and stock tokens, bought with USDC on Arc (through Across).
const RobinhoodTokenPage = lazy(() => import('./pages/RobinhoodTokenPage'))
// Solana (2026-10-04): every launchpad's coins, bought with USDC on Arc and sold back to it (through Relay).
const SolanaTokenPage = lazy(() => import('./pages/SolanaTokenPage'))
// BNB Chain (2026-10-05): four.meme's coins, curve and graduated.
const BscTokenPage    = lazy(() => import('./pages/BscTokenPage'))
// Price alerts are watched on every page, but the watcher (Hyperliquid's live prices) loads only once one exists.
const PriceAlertWatcher = lazy(() => import('./components/PriceAlertWatcher'))
// Opens in a sheet on a tap: its code (with the deposit and withdraw windows) loads then.
const TradingWalletPanel = lazy(() => import('./components/TradingWalletPanel'))
const PushSync = lazy(() => import('./components/PushSync'))
// The bell's list of price alerts (Hyperliquid's live prices load with it).
const AlertsPanel = lazy(() => import('./components/AlertsPanel'))
import StatusBar from './components/StatusBar'
import RpcSettingsHost from './components/RpcSettings'
import { getChain, type TChain } from './lib/chains'
import { captureReferral } from './lib/referral'
import { loadLaunchpadCoins } from './lib/launchpadCoins'
import { pageToPath, pathToPage } from './lib/router'
import './arcdex.css'
// The terminal's own styles (motion.gift's layout, 2026-10-12), after the base so they win.
import './terminal.css'
import { t as T, N_, useLang } from './lib/i18n'
import { ConnectModalHost } from './components/ConnectWallet'
import PrivyHost from './privy/PrivyHost'
import { NetworkGuard, WalletPromptHost } from './components/WalletPrompt'
import { TradePausedBar } from './components/TradePausedBar'
import MobileTabBar from './components/MobileTabBar'
import Sheet, { afterSheetClose } from './components/Sheet'
import { sheetHistory } from './lib/sheetHistory'
import { OPEN_TRADING_WALLET } from './lib/tradingWalletSheet'
import { useEmbeddedAddress, useTrader } from './lib/identity'
import { isKnownAdmin } from './lib/adminSession'
import { useFundingScan } from './lib/funding'
import ProfitAlerts from './components/ProfitAlerts'
import PageErrorBoundary from './components/PageErrorBoundary'
import { activeAlerts, useAlerts } from './hl/alerts'
import { usePush } from './lib/push'
import { engineApiUrl } from './api/marketStream'
import { startTraffic } from './lib/traffic'
import { loadRuntimeFlags, useFlag } from './lib/flags'
import { useTracked } from './lib/walletTracker'
import { useCopySettings } from './lib/copySettings'

// Remember ?ref= or /r/<name> before anything renders (first-touch attribution).
captureReferral()
// Launchpad coins open their own page from /token/0x… links (pages/CoinPage.tsx): know them early.
void loadLaunchpadCoins().catch(() => {})

/** A quick buy from the Trenches: the coin's trade form opens with this amount (and, on Arc, slippage) filled in. */
export interface BuyIntent { amount: number; slip: number }

export type Page =
  | { name: 'terminal'; chain?: TChain }
  | { name: 'token'; address: string; symbol?: string; buy?: BuyIntent }
  | { name: 'argus'; address: string; pool: string; buy?: BuyIntent }
  | { name: 'trader'; address: string }
  | { name: 'clan'; slug: string }
  | { name: 'clans' }
  | { name: 'leaderboard'; tab?: 'futures' }
  | { name: 'feed' }
  | { name: 'alerts' }
  | { name: 'rewards' }
  | { name: 'transfers' }
  | { name: 'portfolio' }
  | { name: 'launchpad' }
  | { name: 'swap' }
  | { name: 'bridge'; dir?: 'in' | 'out' }
  | { name: 'deploy-curve-router' }
  | { name: 'admin' }
  | { name: 'signals'; view?: 'market' | 'manage'; bot?: string }
  | { name: 'futures' }
  | { name: 'perps'; coin?: string }
  | { name: 'predict' }
  | { name: 'hl-trader'; address: string }
  | { name: 'routes' }
  | { name: 'tracker'; address?: string }
  | { name: 'copy'; leader?: string }
  | { name: 'starknet' }
  | { name: 'coin' }
  | { name: 'robinhood' }
  | { name: 'rh-token'; address: string; pool?: string; buy?: BuyIntent }
  | { name: 'solana' }
  | { name: 'sol-token'; address: string; pool?: string; buy?: BuyIntent }
  | { name: 'bsc' }
  | { name: 'bsc-token'; address: string; pool?: string; buy?: BuyIntent }

const fromUrl = (): Page => pathToPage(window.location.pathname, window.location.search) ?? { name: 'terminal' }

// The drawer (the menu button on narrow screens): the terminal's pages. The social pages, the launchpad, Autotrade and
// the old market list are no longer linked (owner, 2026-10-12: "remove the features that don't fit"); their links
// still open.
const MOBILE_NAV: [Page, string, string][] = [
  [{ name: 'terminal', chain: 'arc' }, '◈', N_('Trenches · Arc')], [{ name: 'terminal', chain: 'hood' }, '🏹', N_('Trenches · Robinhood Chain')],
  [{ name: 'terminal', chain: 'sol' }, '◎', N_('Trenches · Solana')], [{ name: 'terminal', chain: 'bnb' }, '◆', N_('Trenches · BNB Chain')],
  [{ name: 'perps' }, '📊', N_('Futures')], [{ name: 'predict' }, '🎯', N_('Predict')], [{ name: 'portfolio' }, '▤', N_('Portfolio')],
  [{ name: 'swap' }, '⇄', N_('Swap')], [{ name: 'bridge' }, '◎', N_('Bridge')], [{ name: 'starknet' }, '◆', N_('Starknet')],
  [{ name: 'signals' }, '⚙', N_('ARCDEX Algo')], [{ name: 'leaderboard', tab: 'futures' }, '♛', N_('Top futures traders')], [{ name: 'tracker' }, '◉', N_('Wallet tracker')], [{ name: 'feed' }, '☰', N_('Feed')], [{ name: 'clans' }, '⚑', N_('Clans')],
  [{ name: 'routes' }, '🧭', N_('Supported routes')],
]

export default function App() {
  const [page, setPage]       = useState<Page>(fromUrl)
  const [navOpen, setNavOpen] = useState(false)
  const [bell, setBell] = useState(false)
  // Once an alert exists in this session the watcher stays, so a notice can outlive the last waiting alert.
  const alerts = useAlerts()
  const [watchAlerts, setWatchAlerts] = useState(false)
  // Copy trading from the user's own trading wallet (lib/copyTrade.ts): the walletCopy flag, /admin → Flags.
  const copyOn = useFlag('walletCopy')
  const copying = useCopySettings().on && copyOn
  // Followed wallets with alerts on: their trades show a notice on any page (components/WalletAlertWatcher.tsx).
  const tracking = useTracked().some(w => w.alerts)
  const me = useTrader().address
  const drawer: [Page, string, string][] = [
    ...MOBILE_NAV,
    ...(copyOn ? [[{ name: 'copy' }, '⧉', N_('Copy trading')] as [Page, string, string]] : []),
    // Admin, only for a wallet that signed in to /admin in this browser (lib/adminSession.ts).
    ...(isKnownAdmin(me) ? [[{ name: 'admin' }, '🛡', N_('Admin')] as [Page, string, string]] : []),
  ]
  useEffect(() => { if (activeAlerts(alerts).length) setWatchAlerts(true) }, [alerts])
  // Alerts by push (lib/push.ts): once they're on in this browser, the engine's copy is kept in step.
  const pushOn = !!usePush().sub
  // This page counts as a visitor online (the landing's traffic counter, lib/traffic.ts).
  useEffect(() => { startTraffic(engineApiUrl); loadRuntimeFlags(engineApiUrl) }, [])

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

  // Remount the content on a language change so every string re-renders.
  const lang = useLang()
  // Coin pages are "pushed" screens on phones: a back arrow up top, their
  // own Buy/Sell bar at the bottom instead of the tab bar.
  const detail = page.name === 'argus' || page.name === 'token' || page.name === 'rh-token' || page.name === 'sol-token' || page.name === 'bsc-token'
  const goBack = useCallback(() => {
    if (depth.current > 0) window.history.back()
    else navigate(trenchesPage(getChain()))
  }, [navigate])

  // While the trading wallet is unlocked, record what funds it, so sending
  // back there needs no passcode (lib/funding.ts).
  useFundingScan(useEmbeddedAddress())

  // The trading wallet as a sheet, from any "trading wallet" link.
  const [walletSheet, setWalletSheet] = useState(false)
  useEffect(() => {
    const open = () => setWalletSheet(true)
    window.addEventListener(OPEN_TRADING_WALLET, open)
    return () => window.removeEventListener(OPEN_TRADING_WALLET, open)
  }, [])

  return (
    <div className={`app-shell${detail ? ' is-detail' : ''}`}>
      <NavBar page={page} navigate={navigate} onMenuClick={() => setNavOpen(o => !o)} onBack={detail ? goBack : undefined} onBell={() => setBell(o => !o)} bellCount={activeAlerts(alerts).length} />
      {/* The bridge switches the wallet to other chains on purpose, and Robinhood Chain and BNB Chain sales are signed there. */}
      <NetworkGuard hidden={page.name === 'bridge' || page.name === 'robinhood' || page.name === 'rh-token' || page.name === 'bsc' || page.name === 'bsc-token' || (page.name === 'terminal' && (page.chain ?? getChain()) !== 'arc')} />
      <TradePausedBar />

      <div className="app-body" key={lang}>
        {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
        {/* The drawer (☰ on narrow screens, the lists on phones): every page, then the discovery lists.
            Desktop is edge to edge, as on Binance: the pages are in the top bar and its More menu. */}
        {navOpen && (
          <aside className="sidebar with-discovery sidebar-open">
            <nav className="mobile-nav" style={{ flexWrap: 'wrap', gap: 4, padding: 8 }}>
              {drawer.map(([p, icon, label]) => (
                <button key={label} className={`disc-sub${pageToPath(page) === pageToPath(p) ? ' active' : ''}`} onClick={() => navigate(p)}>{icon} {T(label)}</button>
              ))}
              <a className="disc-sub" href="/about">ⓘ {T('About ARCDEX')}</a>
            </nav>
          </aside>
        )}

        <main className="main-content">
          <PageErrorBoundary resetKey={pageToPath(page)} onHome={() => navigate(trenchesPage(getChain()))}>
          <Suspense fallback={<div className="loading-state">{T("Loading…")}</div>}>
          {page.name === 'terminal'    && <Trenches chain={page.chain ?? getChain()} navigate={navigate} />}
          {page.name === 'token'       && <TokenPage address={page.address} navigate={navigate} />}
          {page.name === 'argus'       && <CoinPage key={page.address} address={page.address} pool={page.pool} navigate={navigate} buy={page.buy} />}
          {page.name === 'portfolio'   && <Portfolio navigate={navigate} />}
          {/* The launchpad is hidden (owner, 2026-10-03): its address shows Arc's Trenches. */}
          {page.name === 'launchpad'   && <Trenches chain="arc" navigate={navigate} />}
          {page.name === 'futures'     && <FuturesPage navigate={navigate} />}
          {page.name === 'perps'       && <PerpsPage navigate={navigate} coin={page.coin} />}
          {page.name === 'predict'     && <PredictPage navigate={navigate} />}
          {page.name === 'hl-trader'   && <HlTraderPage key={page.address} address={page.address} navigate={navigate} />}
          {page.name === 'routes'      && <RoutesPage navigate={navigate} />}
          {page.name === 'tracker'     && <TrackerPage key={page.address ?? ''} navigate={navigate} focus={page.address} />}
          {page.name === 'copy'        && <CopyTradePage key={page.leader ?? ''} navigate={navigate} leader={page.leader} />}
          {page.name === 'starknet'    && <StarknetPage navigate={navigate} />}
          {page.name === 'coin'       && <ArcdexPage navigate={navigate} />}
          {page.name === 'swap'        && <Swap navigate={navigate} />}
          {page.name === 'bridge'      && <Bridge key={page.dir ?? 'out'} initialDir={page.dir ?? 'out'} navigate={navigate} />}
          {page.name === 'trader'      && <TraderPage key={page.address} address={page.address} navigate={navigate} />}
          {page.name === 'clans'       && <ClansPage navigate={navigate} />}
          {page.name === 'clan'        && <ClanPage key={page.slug} slug={page.slug} navigate={navigate} />}
          {page.name === 'leaderboard' && <LeaderboardPage key={page.tab ?? ''} navigate={navigate} initialKind={page.tab === 'futures' ? 'futures' : undefined} />}
          {page.name === 'feed'        && <FeedPage navigate={navigate} />}
          {page.name === 'alerts'      && <AlertsPage navigate={navigate} />}
          {page.name === 'rewards'     && <RewardsPage navigate={navigate} />}
          {page.name === 'transfers'   && <TransfersPage navigate={navigate} />}
          {page.name === 'deploy-curve-router' && <DeployCurveRouter />}
          {page.name === 'admin' && <AdminPage />}
          {/* ARCDEX Algo, the futures agent (2026-10-10); owners of the old bots still reach them to manage and withdraw (/autotrade/manage). */}
          {page.name === 'signals'     && (page.view === 'manage' ? <SignalsPage navigate={navigate} manage /> : <AlgoPage navigate={navigate} />)}
          {page.name === 'robinhood'   && <Trenches chain="hood" navigate={navigate} />}
          {page.name === 'rh-token'    && <RobinhoodTokenPage key={page.address + (page.pool ?? '')} address={page.address} pool={page.pool} navigate={navigate} buy={page.buy} />}
          {page.name === 'solana'      && <Trenches chain="sol" navigate={navigate} />}
          {page.name === 'sol-token'   && <SolanaTokenPage key={page.address + (page.pool ?? '')} address={page.address} pool={page.pool} navigate={navigate} buy={page.buy} />}
          {page.name === 'bsc'         && <Trenches chain="bnb" navigate={navigate} />}
          {page.name === 'bsc-token'   && <BscTokenPage key={page.address + (page.pool ?? '')} address={page.address} pool={page.pool} navigate={navigate} buy={page.buy} />}
          </Suspense>
          </PageErrorBoundary>
        </main>

      </div>

      <StatusBar navigate={navigate} onAlerts={() => setBell(o => !o)} />
      {bell && <PageErrorBoundary resetKey="bell" fallback={null}><Suspense fallback={null}><AlertsPanel navigate={navigate} onClose={() => setBell(false)} /></Suspense></PageErrorBoundary>}
      <RpcSettingsHost />
      {!detail && <MobileTabBar page={page} navigate={navigate} onOpenLists={() => setNavOpen(true)} />}
      <Sheet open={walletSheet} onClose={() => setWalletSheet(false)}>
        <Suspense fallback={null}><TradingWalletPanel navigate={p => { setWalletSheet(false); afterSheetClose(() => navigate(p)) }} /></Suspense>
      </Sheet>
      <ConnectModalHost />
      {/* Email or social sign-in (Privy): loaded only once someone uses it. */}
      <PrivyHost />
      <WalletPromptHost />
      {/* A toast (and, when allowed, a system notification) for every profit the signed-in owner's bots take. */}
      <ProfitAlerts navigate={navigate} />
      {copying && <PageErrorBoundary resetKey="copy" fallback={null}><Suspense fallback={null}><CopyRunner navigate={navigate} /></Suspense></PageErrorBoundary>}
      {tracking && <PageErrorBoundary resetKey="wallets" fallback={null}><Suspense fallback={null}><WalletAlertWatcher navigate={navigate} /></Suspense></PageErrorBoundary>}
      {watchAlerts && <PageErrorBoundary resetKey="alerts" fallback={null}><Suspense fallback={null}><PriceAlertWatcher navigate={navigate} /></Suspense></PageErrorBoundary>}
      {pushOn && <PageErrorBoundary resetKey="push" fallback={null}><Suspense fallback={null}><PushSync /></Suspense></PageErrorBoundary>}
    </div>
  )
}
