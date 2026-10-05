// What's trading across every chain, for the home page (2026-10-05, owner: "we have no users; compare us with
// DexScreener and fix what's missing"). DexScreener opens on its market and its totals (24h volume, transactions);
// ARCDEX's home page opened on a $5K coin. This serves the home page's live markets in one small answer: the busiest
// listed coins on Arc, Robinhood Chain, Solana and BNB Chain, and each chain's totals, from the lists the engine
// already keeps (no GeckoTerminal call). Served by the engine at /api/trending; read at most every 20 seconds.
//
// The same rules as the markets: launchpad coins and established coins (api/_launchpads.ts), $15K or more of market
// cap, not rugged, no stablecoins.

import { kvGet } from './_supabaseAdmin'
import { isEstablishedCoin, isLaunchpadCoin } from './_launchpads'
import type { ArgusPool } from './_argusCore'
import { rhRows, type RhSnapshot } from './rhmarket'
import { solRows, type SolSnapshot } from './solmarket'
import { bscRows, type BscSnapshot } from './bscmarket'
import type { RhCoin } from './_rhCore'

export const config = { runtime: 'edge' }

export type TrendChain = 'arc' | 'robinhood' | 'solana' | 'bsc'
export interface TrendRow {
  chain: TrendChain
  address: string
  pool: string
  symbol: string
  name: string
  image: string | null
  launchpad: string | null
  priceUsd: number
  change24h: number
  volume24h: number
  marketCapUsd: number
  liquidityUsd: number
  txns24h: number
}
export interface ChainTotals { chain: TrendChain; coins: number; volume24h: number; txns24h: number }
export interface TrendingAnswer { at: number; rows: TrendRow[]; totals: ChainTotals[] }

const MIN_MC = 15_000
const STABLE = /^(usdc|usdt|eurc|usyc|dai|usdg|pyusd|usde|fdusd|tusd|usds|usd|weth|wbnb|wsol)$/i
const rugged = (change24h: number, liquidity: number) => change24h <= -90 || liquidity < 500

export function arcRows(pools: ArgusPool[], now = Date.now()): TrendRow[] {
  const out: TrendRow[] = []
  for (const p of pools) {
    const mc = p.marketCapUsd ?? p.fdvUsd ?? 0
    const txns = p.txns24h.buys + p.txns24h.sells
    const age = p.createdAt ? now - Date.parse(p.createdAt) : 0
    const listed = isLaunchpadCoin(p.launchpad ?? 'Argus')
      || isEstablishedCoin({ symbol: p.token.symbol, liquidityUsd: p.liquidityUsd, ageMs: Number.isFinite(age) ? age : 0, marketCapUsd: mc, txns24h: txns })
    if (!listed || mc < MIN_MC || STABLE.test(p.token.symbol) || rugged(p.change.h24, p.liquidityUsd)) continue
    out.push({
      chain: 'arc', address: p.token.address, pool: p.pool, symbol: p.token.symbol, name: p.token.name, image: p.token.image,
      launchpad: p.launchpad ?? 'Argus', priceUsd: p.priceUsd, change24h: p.change.h24, volume24h: p.volume24h,
      marketCapUsd: mc, liquidityUsd: p.liquidityUsd, txns24h: txns,
    })
  }
  return out
}

const fromCoin = (chain: TrendChain) => (c: RhCoin): TrendRow => ({
  chain, address: c.address, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, launchpad: c.launchpad,
  priceUsd: c.priceUsd, change24h: c.change24h, volume24h: c.volume24h, marketCapUsd: c.marketCap,
  liquidityUsd: c.liquidity, txns24h: c.buys24h + c.sells24h,
})
const listedOther = (r: TrendRow) => r.marketCapUsd >= MIN_MC && !STABLE.test(r.symbol) && !rugged(r.change24h, r.liquidityUsd)

/** The busiest first: 24h volume, with recent trading lifting a coin (DexScreener's trending works on activity too).
 * One coin per ticker (the bigger: a copycat of a trending coin shouldn't sit beside it), and at most `perChain` of the
 * first `head` from one chain, so the top of the list shows every chain. */
export function rankTrending(rows: TrendRow[], limit = 30, head = 8, perChain = 3): TrendRow[] {
  const score = (r: TrendRow) => Math.log10(1 + r.volume24h) * 2 + Math.log10(1 + r.txns24h)
  const bySymbol = new Map<string, TrendRow>()
  for (const r of rows) {
    const k = r.symbol.trim().toUpperCase()
    const cur = bySymbol.get(k)
    if (!cur || r.marketCapUsd > cur.marketCapUsd) bySymbol.set(k, r)
  }
  const ranked = [...bySymbol.values()].sort((a, b) => score(b) - score(a))
  const top: TrendRow[] = []
  const rest: TrendRow[] = []
  const count = new Map<TrendChain, number>()
  for (const r of ranked) {
    if (top.length < head && (count.get(r.chain) ?? 0) < perChain) { top.push(r); count.set(r.chain, (count.get(r.chain) ?? 0) + 1) }
    else rest.push(r)
  }
  return [...top, ...rest].slice(0, limit)
}

export function totalsOf(rows: TrendRow[]): ChainTotals[] {
  const by = new Map<TrendChain, ChainTotals>()
  for (const r of rows) {
    const t = by.get(r.chain) ?? { chain: r.chain, coins: 0, volume24h: 0, txns24h: 0 }
    t.coins++; t.volume24h += r.volume24h; t.txns24h += r.txns24h
    by.set(r.chain, t)
  }
  return [...by.values()]
}

let cached: TrendingAnswer | null = null
const FRESH_MS = 20_000

export async function trending(read: typeof kvGet = kvGet, now = Date.now()): Promise<TrendingAnswer> {
  if (cached && now - cached.at < FRESH_MS) return cached
  const [arc, rh, sol, bsc] = await Promise.all([
    read<{ pools: ArgusPool[] }>('argus:market').catch(() => null),
    read<RhSnapshot>('rh:market').catch(() => null),
    read<SolSnapshot>('sol:market').catch(() => null),
    read<BscSnapshot>('bsc:market').catch(() => null),
  ])
  const all = [
    ...(arc?.value?.pools ? arcRows(arc.value.pools, now) : []),
    ...(rh?.value ? rhRows(rh.value).map(fromCoin('robinhood')).filter(listedOther) : []),
    // A mint someone can still freeze or inflate (or with an extension that can take holders' coins) is Danger.
    ...(sol?.value ? solRows(sol.value).filter(c => !c.mint || (!c.mint.freezeAuthority && !c.mint.mintAuthority && c.mint.danger.length === 0)).map(fromCoin('solana')).filter(listedOther) : []),
    ...(bsc?.value ? bscRows(bsc.value).map(fromCoin('bsc')).filter(listedOther) : []),
  ]
  cached = { at: now, rows: rankTrending(all), totals: totalsOf(all) }
  return cached
}

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(await trending()), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=120' },
  })
}
