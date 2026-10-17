// Each launchpad's own icon on its coins (2026-10-17, owner: "all launchpad coins should show the launchpad icon or
// symbol"). The icon is the launchpad site's own favicon, through Google's favicon service (one small cached PNG, no
// third-party logos bundled with the app). A launchpad without a known site keeps its coloured letter.

import { LAUNCHPADS } from '../../../api/_launchpads'

/** Sites of the launchpads named on Robinhood Chain, Solana and BNB Chain (Arc's are in api/_launchpads.ts). */
const SITES: Record<string, string> = {
  'pump.fun': 'pump.fun', 'pumpswap': 'pump.fun', 'launchlab': 'raydium.io', 'letsbonk': 'letsbonk.fun', 'meteora dbc': 'meteora.ag',
  'moonshot': 'moonshot.com', 'moonit': 'moon.it', 'boop': 'boop.fun', 'daos.fun': 'daos.fun', 'bags': 'bags.fm', 'heaven': 'heaven.xyz',
  'wavebreak': 'wavebreak.fun', 'token mill': 'tokenmill.xyz', 'virtuals': 'virtuals.io', 'clanker': 'clanker.world', 'printr': 'printr.money',
  'stonk.fun': 'stonk.fun', 'easya kickstart': 'easya.io', 'bankr': 'bankr.bot', 'clank.trade': 'clank.trade', 'pons': 'pons.family',
  'mint club': 'mint.club', 'o1': 'o1.exchange', 'frontier.fun': 'frontier.fun', 'hoodit': 'hoodit.fun', 'four.meme': 'four.meme',
  'aka.fun': 'aka.fun', 'peach': 'peach.fun', 'faze': 'faze.fun', 'long.supply': 'long.supply', 'arcdex': 'arcsense.site',
}

const host = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

/** The launchpad's site (host), or null. */
export function launchpadSite(name: string | null | undefined): string | null {
  if (!name) return null
  const k = name.trim().toLowerCase()
  if (SITES[k]) return SITES[k]
  const lp = LAUNCHPADS.find(l => l.name.toLowerCase() === k)
  return lp?.site ? host(lp.site) || null : null
}

/** The launchpad's icon (a 64 px PNG), or null when its site isn't known. */
export function launchpadIcon(name: string | null | undefined): string | null {
  const site = launchpadSite(name)
  return site ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64` : null
}
