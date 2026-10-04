// Shareable URLs for every page (fomo-style): /token/0x…, /profile/name,
// /clans/slug, /r/name (referral). The app keeps its page state object;
// this maps it to and from the address bar. vercel.json already serves
// the SPA for every path; / itself is the landing page (src/main.tsx).

import type { Page } from '../App'
import { COIN_LC, COIN_POOL } from './coin'

export function pageToPath(p: Page): string {
  switch (p.name) {
    case 'terminal':    return '/app'
    case 'argus':       return `/token/${p.address}${p.pool ? `?pool=${p.pool}` : ''}`
    case 'token':       return `/token/${p.address}`
    case 'trader':      return `/profile/${p.address}`
    case 'clan':        return `/clans/${p.slug}`
    case 'clans':       return '/clans'
    case 'leaderboard': return '/leaderboard'
    case 'feed':        return '/feed'
    case 'alerts':      return '/alerts'
    case 'rewards':     return '/rewards'
    case 'transfers':   return '/transfers'
    case 'portfolio':   return '/portfolio'
    case 'launchpad':   return '/launchpad'
    case 'swap':        return '/swap'
    case 'bridge':      return p.dir === 'in' ? '/bridge?dir=in' : '/bridge'
    case 'deploy-curve-router': return '/deploy/curve-router'
    case 'signals':     return p.bot ? `/bots/${encodeURIComponent(p.bot)}` : p.view === 'market' ? '/bots' : p.view === 'manage' ? '/autotrade/manage' : '/autotrade'
    case 'futures':     return '/futures'
    case 'coin':        return '/burn'
    case 'robinhood':   return '/robinhood'
    case 'rh-token':    return `/robinhood/token/${p.address}${p.pool ? `?pool=${p.pool}` : ''}`
  }
}

/** The page for the current address bar, or null to show the default. */
export function pathToPage(pathname: string, search: string): Page | null {
  const parts = pathname.replace(/^\/arcdex(\.html)?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const q = new URLSearchParams(search)
  const [a, b] = parts
  if (!a) return null
  switch (a) {
    case 'token':
    case 'tokens':
      if (b && /^0x[0-9a-fA-F]{40}$/.test(b)) {
        const pool = q.get('pool')
        return pool ? { name: 'argus', address: b.toLowerCase(), pool: pool.toLowerCase() } : { name: 'argus', address: b.toLowerCase(), pool: '' }
      }
      return null
    case 'profile':     return b ? { name: 'trader', address: b } : null
    case 'clans':       return b ? { name: 'clan', slug: b } : { name: 'clans' }
    case 'app':
    case 'markets':     return { name: 'terminal' }
    // Spot opens on $ARCDEX/USDC, as Binance's opens on its own pair.
    case 'spot':        return { name: 'argus', address: COIN_LC, pool: COIN_POOL }
    case 'leaderboard': return { name: 'leaderboard' }
    case 'feed':        return { name: 'feed' }
    case 'alerts':      return { name: 'alerts' }
    case 'rewards':
    case 'earn':        return { name: 'rewards' }
    case 'transfers':   return { name: 'transfers' }
    case 'portfolio':   return { name: 'portfolio' }
    case 'launchpad':   return { name: 'launchpad' }
    case 'swap':        return { name: 'swap' }
    case 'bridge':      return { name: 'bridge', dir: q.get('dir') === 'in' ? 'in' : 'out' }
    case 'signals':
    case 'autotrade':   return b === 'manage' ? { name: 'signals', view: 'manage' } : { name: 'signals' }
    case 'futures':
    case 'perps':       return { name: 'futures' }
    // $ARCDEX: its burns, buybacks and the fee ledger (/sense was $SENSE's, before 2026-10-04).
    case 'sense':
    case 'burn':        return { name: 'coin' }
    // The bot marketplace, and one bot's public page.
    case 'bots':        return b ? { name: 'signals', view: 'market', bot: b.toLowerCase() } : { name: 'signals', view: 'market' }
    // Robinhood Chain's markets, and one of its coins (a v4 pool's id is 32 bytes).
    case 'robinhood':
      if (b === 'token' && parts[2] && /^0x[0-9a-fA-F]{40}$/.test(parts[2])) {
        const pool = (q.get('pool') ?? '').toLowerCase()
        return { name: 'rh-token', address: parts[2].toLowerCase(), pool: /^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(pool) ? pool : '' }
      }
      return { name: 'robinhood' }
    // Not linked anywhere: the owner deploys ArcDexCurveRouter here.
    case 'deploy':      return b === 'curve-router' ? { name: 'deploy-curve-router' } : null
    default:            return null
  }
}

/** /r/<ref> referral links: returns the ref, or null. */
export function referralFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/r\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}
