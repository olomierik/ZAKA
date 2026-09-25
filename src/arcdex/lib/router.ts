// Shareable URLs for every page (fomo-style): /token/0x…, /profile/name,
// /clans/slug, /r/name (referral). The app keeps its page state object;
// this maps it to and from the address bar. vercel.json already serves
// the SPA for every path; / itself is the landing page (src/main.tsx).

import type { Page } from '../App'

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
    case 'burn':        return '/burn'
    case 'portfolio':   return '/portfolio'
    case 'launchpad':   return '/launchpad'
    case 'swap':        return '/swap'
    case 'bridge':      return '/bridge'
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
    case 'app':         return { name: 'terminal' }
    case 'leaderboard': return { name: 'leaderboard' }
    case 'feed':        return { name: 'feed' }
    case 'alerts':      return { name: 'alerts' }
    case 'rewards':
    case 'earn':        return { name: 'rewards' }
    case 'transfers':   return { name: 'transfers' }
    case 'burn':        return { name: 'burn' }
    case 'portfolio':   return { name: 'portfolio' }
    case 'launchpad':   return { name: 'launchpad' }
    case 'swap':        return { name: 'swap' }
    case 'bridge':      return { name: 'bridge' }
    default:            return null
  }
}

/** /r/<ref> referral links: returns the ref, or null. */
export function referralFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/r\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}
