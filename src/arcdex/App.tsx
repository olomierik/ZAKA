import { useState, useEffect, useRef } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
import TokenPage from './pages/TokenPage'
import Portfolio from './pages/Portfolio'
import Launchpad from './pages/Launchpad'
import Swap from './pages/Swap'
import Bridge from './pages/Bridge'
import TradingWalletPanel from './components/TradingWalletPanel'
import { subscribeAll, deriveTradeInfo, type LiveTrade } from './api/arcRpc'
import { getPairByAddress } from './api/dexscreener'
import './arcdex.css'

export type Page = { name: 'terminal' } | { name: 'token'; address: string; symbol?: string } | { name: 'portfolio' } | { name: 'launchpad' } | { name: 'swap' } | { name: 'bridge' }

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
  const navigate = (p: Page) => { setPage(p); setNavOpen(false) }

  // Terminal registers its top-by-volume tokens here — currently unused for
  // filtering (the feed below is network-wide), kept so a future "trending
  // only" toggle can filter without touching Terminal.
  const registerFeedTokens = (tokens: { address: string; symbol: string }[]) => {
    feedTokens.current = tokens.slice(0, 10)
  }

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
          {page.name === 'terminal'   && <Terminal navigate={navigate} registerFeedTokens={registerFeedTokens} />}
          {page.name === 'token'      && <TokenPage address={page.address} navigate={navigate} />}
          {page.name === 'portfolio'  && <Portfolio navigate={navigate} />}
          {page.name === 'launchpad'  && <Launchpad navigate={navigate} />}
          {page.name === 'swap'       && <Swap navigate={navigate} />}
          {page.name === 'bridge'     && <Bridge />}
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
