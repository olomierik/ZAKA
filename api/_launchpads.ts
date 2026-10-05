// Arc's launchpads: how ARCDEX recognises, labels and links each one.
// Shared by the market list (api/_argusCore.ts, server and browser) and the
// app (badges, colors, "trade on …" links). (The leading underscore keeps
// Vercel from deploying this file as a function.)
//
// GeckoTerminal files a launchpad's pools under its own "dex" on Arc
// (argus, minara-fun, tolly-arc, …). `launchpadOf` matches a dex id or name
// to a launchpad here. Where a coin trades decides whether ARCDEX's router
// can trade it — any Uniswap v3 or v4 pool paired with USDC can (see
// buildSwapRoute in src/arcdex/api/argusMarket.ts):
//   Uniswap v4: Argus, Minara, o1, SolonPad (instant), UBI.fun, graduated Mercuri
//   Uniswap v3: Tolly (locked 1% pools), RadarDEX, Archemist, graduated Sashimi
//   own curve or DEX: Sashimi, Warp (CircleWarp) and Mercuri before graduating;
//     graduated Warp coins trade on WarpDex, CircleWarp's Uniswap V2 fork
// Sources: each launchpad's docs and DefiLlama's Arc adapters
// (github.com/DefiLlama/dimension-adapters, fees/<name>).

export interface Launchpad {
  name: string
  color: string
  /** Only where the address is confirmed (docs, DefiLlama, the Arc ecosystem list). */
  site?: string
  /** Matches a GeckoTerminal dex id or name (lowercased, "id name"). */
  match: RegExp
}

export const LAUNCHPADS: Launchpad[] = [
  { name: 'Argus', color: '#7c3aed', site: 'https://argus.world', match: /\bargus/ },
  { name: 'Minara', color: '#06b6d4', site: 'https://minara.fun', match: /\bminara/ },
  { name: 'Tolly', color: '#059669', site: 'https://tollylabs.com', match: /\btolly/ },
  { name: 'RadarDEX', color: '#3b82f6', site: 'https://radardex.pro', match: /\bradar/ },
  { name: 'Warp', color: '#f59e0b', site: 'https://circlewarp.fun', match: /circlewarp|\bwarp/ },
  { name: 'Archemist', color: '#d97706', site: 'https://archemist.fun', match: /archemist/ },
  { name: 'o1', color: '#f97316', site: 'https://o1.exchange', match: /\bo1\b/ },
  { name: 'SolonPad', color: '#a855f7', site: 'https://solonpad.fun', match: /\bsolon/ },
  { name: 'UBI.fun', color: '#22c55e', site: 'https://ubi.fun', match: /\bubi(\b|dot|fun)/ },
  { name: 'Sashimi', color: '#fb7185', site: 'https://sashimi.fun', match: /sashimi/ },
  { name: 'Mercuri', color: '#94a3b8', site: 'https://launch.mercuri.finance', match: /mercuri/ },
  { name: 'Bozo', color: '#eab308', site: 'https://bozo.fun', match: /\bbozo/ },
  { name: 'ArcPad', color: '#e11d48', match: /\barcpad/ },
  { name: 'Arc.fun', color: '#ec4899', match: /\barc[.-]?fun\b|\barcfun/ },
  { name: 'Flipt', color: '#14b8a6', match: /\bflipt/ },
  { name: 'Onmi', color: '#8b5cf6', match: /\bonmi/ },
  { name: 'NebulaPad', color: '#6366f1', match: /\bnebula/ },
  // Found on GeckoTerminal's Arc venues and traced to their launch contracts
  // on 2026-09-30 (engine/scripts/discover-launchpads.ts). Sites unconfirmed.
  { name: 'Peach', color: '#fb923c', match: /\bpeach\b/ },
  { name: 'Faze', color: '#0ea5e9', match: /\bfaze\b/ },
  { name: 'Aka.fun', color: '#f43f5e', match: /\baka[.-]?fun\b/ },
  { name: 'Long.supply', color: '#84cc16', match: /\blong[.-]?supply\b/ },
  { name: 'Virtuals', color: '#10b981', match: /\bvirtuals?\b/ },
  { name: 'Foci', color: '#a3a3a3', match: /\bfoci\b/ },
  { name: 'Lunya', color: '#c084fc', match: /\blunya\b/ },
]

/** Plain DEXes (not launch venues): their pools aren't listed as launches. */
const GENERIC_DEX = /uniswap|pancake|sushi|curve|balancer|algebra|camelot|aerodrome|velodrome|izumi|kyber|maverick|dodo|woofi|fluid|ambient|syncswap|pegd|stable/
/** What a launch venue GeckoTerminal adds later is likely to be called. */
const LAUNCH_WORDS = /\bfun\b|\.fun|pad\b|launch|pump|meme/

// Ids come as "tolly-arc" or "uniswap_v3": treat _ as a separator, like -.
const text = (id: string, name = '') => `${id} ${name}`.toLowerCase().replace(/_/g, '-')

/** The launchpad behind a GeckoTerminal dex (by id or name), or null. */
export function launchpadOf(dexId: string, dexName = ''): Launchpad | null {
  const s = text(dexId, dexName)
  return LAUNCHPADS.find(l => l.match.test(s)) ?? null
}

/** The launchpad with this display name (as on a market row), or null. */
export function launchpadNamed(name: string): Launchpad | null {
  const n = name.trim().toLowerCase()
  return LAUNCHPADS.find(l => l.name.toLowerCase() === n) ?? null
}

/** A GeckoTerminal dex whose pools are launches: a known launchpad, or a
 * new venue named like one — not a plain DEX. */
export function isLaunchpadDex(dexId: string, dexName = ''): boolean {
  if (launchpadOf(dexId, dexName)) return true
  const s = text(dexId, dexName)
  return !GENERIC_DEX.test(s) && LAUNCH_WORDS.test(s)
}

/** ARCDEX's own launchpad (ArcLaunchpad), as market rows and the engine name it. */
export const OWN_LAUNCHPAD = 'ARCDEX'

/** Whether a coin's launchpad (a market row's badge, the engine's name, or a GeckoTerminal dex name)
 * is a real launch venue: ARCDEX's own, a known launchpad, or a venue named like one. Coins from
 * anywhere else ("Other": a contract no launchpad made, or a plain DEX pool) aren't listed or
 * searchable (owner, 2026-10-04: only launchpad coins, to keep malicious contracts out). */
export function isLaunchpadCoin(launchpad: string | null | undefined): boolean {
  const lp = (launchpad ?? '').trim()
  if (!lp || /^other$/i.test(lp)) return false
  return lp.toUpperCase() === OWN_LAUNCHPAD || isLaunchpadDex(lp, lp)
}

/** An established coin from a plain DEX (2026-10-05, owner: "find what's missing against DexScreener"): Arc's
 * most-traded coins (TOLLY, ARCMAN, KAIRO, COOL…) trade on plain Uniswap pools, and the launchpad-only rule kept every
 * one of them out of the lists and search. A coin from any venue is listed once it has proven itself: real liquidity,
 * three days of trading, a real market cap and steady trades. Launchpad coins are listed as before; stablecoins aren't
 * markets to trade. The safety rating still hides a Danger coin from the default lists. */
export const ESTABLISHED = { minLiquidityUsd: 25_000, minAgeMs: 3 * 86_400_000, minMarketCapUsd: 100_000, minTxns24h: 25 }
const STABLE = /^(usdc|usdt|eurc|usyc|dai|usdg|pyusd|usde|fdusd|tusd|usds|usd)$/i

export function isEstablishedCoin(o: { symbol: string; liquidityUsd: number; ageMs: number; marketCapUsd: number; txns24h: number }): boolean {
  if (STABLE.test(o.symbol.trim())) return false
  return o.liquidityUsd >= ESTABLISHED.minLiquidityUsd && o.ageMs >= ESTABLISHED.minAgeMs
    && o.marketCapUsd >= ESTABLISHED.minMarketCapUsd && o.txns24h >= ESTABLISHED.minTxns24h
}

/** A market row's badge: the launchpad's name, else GeckoTerminal's name for the dex. */
export function launchpadLabel(dexId: string, dexName = ''): string {
  return launchpadOf(dexId, dexName)?.name ?? (dexName.replace(/\s*\(arc\)\s*$/i, '').trim() || dexId)
}

/** Known GeckoTerminal dex ids on Arc, for when the live list can't be read. */
// Checked 2026-09-30: Tolly, RadarDEX, Warp and Archemist had no pools listed
// any more and are out; Peach ($840k/day then), Faze and Aka.fun are in.
export const KNOWN_LAUNCHPAD_DEXES: { id: string; name: string }[] = [
  { id: 'peach', name: 'Peach' },
  { id: 'faze', name: 'Faze' },
  { id: 'o1-launchpad-arc', name: 'o1 Launchpad' },
  { id: 'minara-fun', name: 'Minara.fun' },
  { id: 'aka-fun', name: 'Aka.fun' },
  { id: 'long-supply', name: 'Long.supply' },
]
