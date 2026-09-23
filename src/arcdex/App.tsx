import { useState, useEffect, useRef } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
import TokenPage from './pages/TokenPage'
import Portfolio from './pages/Portfolio'
import { getTrades } from './api/radardex'
import type { Trade } from './api/radardex'
import './arcdex.css'

export type Page = { name: 'terminal' } | { name: 'token'; address: string; symbol?: string } | { name: 'portfolio' }

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
  const feedTokens            = useRef<{ address: string; symbol: string }[]>([])
  const navigate = (p: Page) => setPage(p)

  // register tokens for live feed
  const registerFeedTokens = (tokens: { address: string; symbol: string }[]) => {
    feedTokens.current = tokens.slice(0, 10) // top 10 by volume
  }

  // poll live trades for feed panel
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (feedTokens.current.length === 0) return
      const token = feedTokens.current[Math.floor(Math.random() * Math.min(5, feedTokens.current.length))]
      try {
        const trades = await getTrades(token.address, 3)
        if (cancelled) return
        const items: FeedItem[] = trades.map(t => ({
          id: ++feedId,
          symbol: token.symbol,
          type: t.type,
          amount: t.amountIn,
          price: t.price,
          address: token.address,
          ts: t.timestamp,
        }))
        setFeed(prev => [...items, ...prev].slice(0, 50))
      } catch { /* skip */ }
    }
    const iv = setInterval(() => void poll(), 4000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])

  return (
    <div className="app-shell">
      {/* ── ticker bar ── */}
      <NavBar page={page} navigate={navigate} />

      {/* ── body: sidebar + main + live feed ── */}
      <div className="app-body">
        {/* left sidebar */}
        <aside className="sidebar">
          <nav className="sidebar-nav">
            <div className="sidebar-section">
              <button
                className={`sidebar-item${page.name === 'terminal' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'terminal' })}
              >
                <span className="sidebar-icon">◈</span> TERMINAL
              </button>
              <button className="sidebar-item disabled">
                <span className="sidebar-icon">⇄</span> SWAP
              </button>
              <button className="sidebar-item disabled">
                <span className="sidebar-icon">◎</span> BUY ARCT
              </button>
              <button className="sidebar-item disabled">
                <span className="sidebar-icon">◆</span> PREDICT
              </button>
              <button
                className={`sidebar-item${page.name === 'portfolio' ? ' active' : ''}`}
                onClick={() => navigate({ name: 'portfolio' })}
              >
                <span className="sidebar-icon">▤</span> PORTFOLIO
              </button>
            </div>
            <div className="sidebar-label">DISCOVER</div>
            <div className="sidebar-section">
              <button className="sidebar-item disabled"><span className="sidebar-icon">◉</span> SCANNER</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">◈</span> INSIDERS</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">◎</span> TRADERS</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">●</span> INTEL</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">⊞</span> API</button>
            </div>
            <div className="sidebar-label">EARN</div>
            <div className="sidebar-section">
              <button className="sidebar-item disabled"><span className="sidebar-icon">◆</span> LAUNCHPAD</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">◇</span> LOCKER</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">▣</span> MARKET</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">◈</span> ADVERTISE</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">★</span> REWARDS</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">↗</span> REFERRALS</button>
              <button className="sidebar-item disabled"><span className="sidebar-icon">◎</span> PAY</button>
            </div>
          </nav>
        </aside>

        {/* main content */}
        <main className="main-content">
          {page.name === 'terminal'  && <Terminal navigate={navigate} registerFeedTokens={registerFeedTokens} />}
          {page.name === 'token'     && <TokenPage address={page.address} navigate={navigate} />}
          {page.name === 'portfolio' && <Portfolio navigate={navigate} />}
        </main>

        {/* right live feed */}
        <aside className="feed-panel">
          <div className="feed-header">
            <span className="pulse-dot" /> Arc feed
            <span className="feed-tab active">All</span>
            <span className="feed-tab">News</span>
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
                <div className="feed-price">${item.price < 0.001
                  ? item.price.toExponential(2)
                  : item.price.toPrecision(4)
                }</div>
                <div className="feed-ago">{Math.floor((Date.now() - item.ts * 1000) / 1000)}s ago</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
