import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
// Everything but the Terminal loads on first visit to that page — they
// pull in heavy libraries (Circle Bridge Kit, charting, launchpad flows)
// that would otherwise all have to download before the coin list shows.
const TokenPage      = lazy(() => import('./pages/TokenPage'))
const ArgusTokenPage = lazy(() => import('./pages/ArgusTokenPage'))
const Portfolio      = lazy(() => import('./pages/Portfolio'))
const Launchpad      = lazy(() => import('./pages/Launchpad'))
const Swap           = lazy(() => import('./pages/Swap'))
const Bridge         = lazy(() => import('./pages/Bridge'))
const TraderPage     = lazy(() => import('./pages/TraderPage'))
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'))
const FeedPage       = lazy(() => import('./pages/FeedPage'))
const RewardsPage    = lazy(() => import('./pages/RewardsPage'))
import TradingWalletPanel from './components/TradingWalletPanel'
import { subscribeAll, deriveTradeInfo, type LiveTrade } from './api/arcRpc'
import { getPairByAddress } from './api/dexscreener'
import { subscribeLaunchpadTrades, type LaunchpadLiveTrade } from './api/launchpadRpc'
import { getLaunchpadToken, LAUNCHPAD_ADDRESS } from './api/launchpad'
import { captureReferral } from './lib/referral'
import { useTrader } from './lib/identity'
import './arcdex.css'

// Remember ?ref= before anything renders (first-touch attribution).
captureReferral()

export type Page = { name: 'terminal' } | { name: 'token'; address: string; symbol?: string } | { name: 'argus'; address: string; pool: string } | { name: 'trader'; address: string } | { name: 'leaderboard' } | { name: 'feed' } | { name: 'rewards' } | { name: 'portfolio' } | { name: 'launchpad' } | { name: 'swap' } | { name: 'bridge' }

// ── live feed item ────────────────────────────────────────────────────
interface FeedItem {
  id: number
  symbol: string
  type: 'buy' | 'sell'
  amount: number
  price: number
  address: string
  ts: number
}
let feedId = 0

export default function App() {
  const [page, setPage]       = useState<Page>({ name: 'terminal' })
  const [feed, setFeed]       = useState<FeedItem[]>([])
  const [navOpen, setNavOpen] = useState(false)
  const feedTokens            = useRef<{ address: string; symbol: string }[]>([])
  const navigate = (p: Page) => { setPage(p); setNavOpen(false); window.scrollTo({ top: 0 }) }
  const me = useTrader().address

  // Terminal registers its top-by-volume tokens here — currently unused for
  // filtering (the feed below is network-wide), kept so a future "trending
  // only" toggle can filter without touching Terminal.
  // Stable identity: Terminal's loader depends on it, and App re-renders on
  // every feed trade — a fresh function each time would re-run Terminal's
  // full reload on every trade on Arc.
  const registerFeedTokens = useCallback((tokens: { address: string; symbol: string }[]) => {
    feedTokens.current = tokens.slice(0, 10)
  }, [])

  // Live feed via Arc mainnet WebSocket — every Swap event on-chain, no
  // dependency on any third-party REST API for the trade stream itself.
  // Swap logs only carry the pool address and two unlabeled amounts (token0/
  // token1 by address sort, not by base/quote role), so both the symbol AND
  // which side is USDC have to be resolved via pair metadata before a trade
  // can be shown — otherwise buy/sell and the dollar amount can come out
  // backwards (token0 vs token1 varies per pool).
  useEffect(() => {
    const metaCache = new Map<string, { symbol: string; quoteIsToken0: boolean }>()
    const pending = new Set<string>()

    const unsub = subscribeAll((trade: LiveTrade) => {
      const meta = metaCache.get(trade.pairAddress)
      if (meta) {
        const { kind, usd } = deriveTradeInfo(trade, meta.quoteIsToken0)
        setFeed(prev => [{
          id: ++feedId, symbol: meta.symbol, type: kind, amount: usd, price: 0,
          address: trade.pairAddress, ts: trade.timestamp,
        }, ...prev].slice(0, 50))
        return
      }

      if (pending.has(trade.pairAddress)) return // wait for the in-flight resolution, don't show a guess
      pending.add(trade.pairAddress)
      void getPairByAddress(trade.pairAddress).then(p => {
        pending.delete(trade.pairAddress)
        if (!p) return
        const quoteIsToken0 = p.quoteToken.address.toLowerCase() < p.baseToken.address.toLowerCase()
        metaCache.set(trade.pairAddress, { symbol: p.baseToken.symbol, quoteIsToken0 })
      })
    })
    return unsub
  }, [])

  // ArcLaunchpad trades don't come through the feed above — that one only
  // listens for the generic Uniswap-style Swap event, and our own
  // launchpad emits a completely different, custom Trade event. Every
  // buy/sell across every launch gets merged into the same global feed
  // here so "live trades on Arc" genuinely means every launchpad, not
  // just external pools.
  useEffect(() => {
    if (LAUNCHPAD_ADDRESS.length !== 42) return
    const symbolCache = new Map<string, string>()
    const pending = new Set<string>()

    const unsub = subscribeLaunchpadTrades(LAUNCHPAD_ADDRESS, (trade: LaunchpadLiveTrade) => {
      const kind: 'buy' | 'sell' = trade.isBuy ? 'buy' : 'sell'
      const push = (symbol: string) => {
        setFeed(prev => [{
          id: ++feedId, symbol, type: kind, amount: trade.usdcAmount, price: 0,
          address: trade.token, ts: trade.timestamp,
        }, ...prev].slice(0, 50))
      }

      const cached = symbolCache.get(trade.token.toLowerCase())
      if (cached) { push(cached); return }

      if (pending.has(trade.token.toLowerCase())) return
      pending.add(trade.token.toLowerCase())
      void getLaunchpadToken(trade.token as `0x${string}`).then(t => {
        pending.delete(trade.token.toLowerCase())
        if (!t) return
        symbolCache.set(trade.token.toLowerCase(), t.symbol)
        push(t.symbol)
      })
    })
    return unsub
  }, [])

  return (
    <div className="app-shell">
      {/* ── ticker bar ── */}
      <NavBar page={page} navigate={navigate} onMenuClick={() => setNavOpen(o => !o)} />

      {/* ── body: sidebar + main + live feed ── */}
      <div className="app-body">
        {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
        {/* left sidebar */}
        <aside className={`sidebar${navOpen ? ' sidebar-open' : ''}`}>
          <nav className="sidebar-nav">
            <div className="sidebar-section">
              <button
                className={`sidebar-item${page.name === 'terminal' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'terminal' })}
              >
                <span className="sidebar-icon">◈</span> TERMINAL
              </button>
              <button
                className={`sidebar-item${page.name === 'swap' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'swap' })}
              >
                <span className="sidebar-icon">⇄</span> SWAP
              </button>
              <button
                className={`sidebar-item${page.name === 'bridge' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'bridge' })}
              >
                <span className="sidebar-icon">◎</span> BRIDGE
              </button>
              <button
                className={`sidebar-item${page.name === 'portfolio' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'portfolio' })}
              >
                <span className="sidebar-icon">▤</span> PORTFOLIO
              </button>
            </div>
            <div className="sidebar-label">SOCIAL</div>
            <div className="sidebar-section">
              <button className={`sidebar-item${page.name === 'feed' ? ' active' : ''}`} onClick={() => navigate({ name: 'feed' })}>
                <span className="sidebar-icon">◉</span> FEED
              </button>
              <button className={`sidebar-item${page.name === 'leaderboard' ? ' active' : ''}`} onClick={() => navigate({ name: 'leaderboard' })}>
                <span className="sidebar-icon">♛</span> LEADERBOARD
              </button>
              <button className={`sidebar-item${page.name === 'rewards' ? ' active' : ''}`} onClick={() => navigate({ name: 'rewards' })}>
                <span className="sidebar-icon">✦</span> INVITE & EARN
              </button>
              {me && (
                <button className={`sidebar-item${page.name === 'trader' && page.address.toLowerCase() === me.toLowerCase() ? ' active' : ''}`} onClick={() => navigate({ name: 'trader', address: me })}>
                  <span className="sidebar-icon">☺</span> MY PROFILE
                </button>
              )}
            </div>
            <div className="sidebar-label">EARN</div>
            <div className="sidebar-section">
              <button
                className={`sidebar-item${page.name === 'launchpad' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'launchpad' })}
              >
                <span className="sidebar-icon">◆</span> LAUNCHPAD
              </button>
            </div>
          </nav>
        </aside>

        {/* main content */}
        <main className="main-content">
          <Suspense fallback={<div className="loading-state">Loading…</div>}>
          {page.name === 'terminal'   && <Terminal navigate={navigate} registerFeedTokens={registerFeedTokens} />}
          {page.name === 'token'      && <TokenPage address={page.address} navigate={navigate} />}
          {page.name === 'argus'      && <ArgusTokenPage key={page.address} address={page.address} pool={page.pool} navigate={navigate} />}
          {page.name === 'portfolio'  && <Portfolio navigate={navigate} />}
          {page.name === 'launchpad'  && <Launchpad navigate={navigate} />}
          {page.name === 'swap'       && <Swap navigate={navigate} />}
          {page.name === 'bridge'     && <Bridge />}
          {page.name === 'trader'     && <TraderPage key={page.address} address={page.address} navigate={navigate} />}
          {page.name === 'leaderboard' && <LeaderboardPage navigate={navigate} />}
          {page.name === 'feed'       && <FeedPage navigate={navigate} />}
          {page.name === 'rewards'    && <RewardsPage navigate={navigate} />}
          </Suspense>
        </main>

        {/* right live feed */}
        <aside className="feed-panel">
          <TradingWalletPanel />
          <div className="feed-header">
            <span className="pulse-dot" /> Arc feed
          </div>
          <div className="feed-list">
            {feed.length === 0 ? (
              <div className="feed-empty">Waiting for trades…</div>
            ) : feed.map(item => (
              <div key={item.id} className={`feed-item ${item.type}`}>
                <div className="feed-token">{item.symbol}</div>
                <div className="feed-action">
                  {item.type === 'buy' ? 'Buy' : 'Sell'} ${item.amount < 1
                    ? item.amount.toFixed(4)
                    : item.amount >= 1000
                      ? `${(item.amount/1000).toFixed(1)}K`
                      : item.amount.toFixed(2)
                  }
                </div>
                <div className="feed-ago">{Math.max(0, Math.floor((Date.now() - item.ts) / 1000))}s ago</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
