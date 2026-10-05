import { captureReferral } from './arcdex/lib/referral'

// arcsense.site/ is the landing page — a small bundle with no wallet
// libraries, so it loads fast for new visitors. Every other path
// (/app, /token/…, /profile/…, …) is the trading app. /r/<name> referral
// links are remembered first, then land on the landing page.
captureReferral()

const root = document.getElementById('root')!
const path = window.location.pathname
if (path === '/' || path === '/index.html') {
  void import('./arcdex/landing/Landing').then(m => m.mountLanding(root))
} else {
  // The page's own code starts loading with the app's, not after it (2026-10-05): a coin page loaded six files one after
  // another (main → app → App → CoinPage → ArgusTokenPage → chart), ~9s on a fast connection. The app's lazy routes
  // then find these already loaded.
  const route: [RegExp, () => Promise<unknown>][] = [
    [/^\/(token|spot)/, () => Promise.all([import('./arcdex/pages/CoinPage'), import('./arcdex/pages/ArgusTokenPage'), import('./arcdex/components/PriceChart')])],
    [/^\/solana\/token\//, () => import('./arcdex/pages/SolanaTokenPage')],
    [/^\/(bnb|bsc)\/token\//, () => import('./arcdex/pages/BscTokenPage')],
    [/^\/robinhood\/token\//, () => import('./arcdex/pages/RobinhoodTokenPage')],
    [/^\/solana\/?$/, () => import('./arcdex/pages/SolanaMarkets')],
    [/^\/(bnb|bsc)\/?$/, () => import('./arcdex/pages/BscMarkets')],
    [/^\/robinhood\/?$/, () => import('./arcdex/pages/RobinhoodMarkets')],
    [/^\/futures/, () => import('./arcdex/pages/FuturesPage')],
    [/^\/swap/, () => import('./arcdex/pages/Swap')],
    [/^\/portfolio/, () => import('./arcdex/pages/Portfolio')],
  ]
  for (const [re, load] of route) if (re.test(path)) { void load().catch(() => {}); break }
  void import('./appMain').then(m => m.mountApp(root))
}
