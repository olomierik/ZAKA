import { captureReferral } from './arcdex/lib/referral'
import { isChunkError, reloadForNewVersion, watchChunkErrors } from './arcdex/lib/chunkReload'
import { firstScreen, isReturning } from './arcdex/lib/returning'

// arcsense.site/ is always the landing page (owner, 2026-10-18; lib/returning.ts). The landing page is a small bundle with no wallet libraries; its Log in opens
// the app at /trenches?login=1, which opens Privy's sign-in. /about is always the landing page. /r/<name> referral
// links are remembered first.
captureReferral()
// A page left open across a deploy reloads to get the new version instead of going blank (lib/chunkReload.ts).
watchChunkErrors()
const failed = (e: unknown) => { if (isChunkError(e)) reloadForNewVersion(); else throw e }

const root = document.getElementById('root')!
const path = window.location.pathname
if (firstScreen(path, isReturning()) === 'landing') {
  void import('./arcdex/landing/Landing').then(m => m.mountLanding(root), failed)
} else {
  // The page's own code starts loading with the app's, not after it (2026-10-05): a coin page loaded six files one after
  // another (main → app → App → CoinPage → ArgusTokenPage → chart), ~9s on a fast connection. The app's lazy routes
  // then find these already loaded.
  const route: [RegExp, () => Promise<unknown>][] = [
    [/^\/(token|spot)\b/, () => Promise.all([import('./arcdex/pages/CoinPage'), import('./arcdex/pages/ArgusTokenPage'), import('./arcdex/components/PriceChart')])],
    [/^\/solana\/token\//, () => import('./arcdex/pages/SolanaTokenPage')],
    [/^\/(bnb|bsc)\/token\//, () => import('./arcdex/pages/BscTokenPage')],
    [/^\/robinhood\/token\//, () => import('./arcdex/pages/RobinhoodTokenPage')],
    [/^\/futures\/testnet/, () => import('./arcdex/pages/FuturesPage')],
    [/^\/(futures|perps|trade)\b/, () => Promise.all([import('./arcdex/pages/PerpsPage'), import('./arcdex/components/PriceChart')])],
    [/^\/predict/, () => import('./arcdex/pages/PredictPage')],
    [/^\/starknet/, () => import('./arcdex/pages/StarknetPage')],
    [/^\/swap/, () => import('./arcdex/pages/Swap')],
    [/^\/portfolio/, () => import('./arcdex/pages/Portfolio')],
  ]
  for (const [re, load] of route) if (re.test(path)) { void load().catch(() => {}); break }
  void import('./appMain').then(m => m.mountApp(root), failed)
}
