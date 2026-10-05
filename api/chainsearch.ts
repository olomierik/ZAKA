// The top bar's search on the other chains (2026-10-05, owner: "search across every chain"): coins on Robinhood
// Chain, Solana and BNB Chain matching a name, ticker or address, from the lists the engine keeps for each chain's
// markets (api/rhmarket.ts, api/solmarket.ts, api/bscmarket.ts), so a search costs no GeckoTerminal call. Served by
// the engine at /api/chainsearch?q=. Only listed coins: launchpad coins (and Robinhood's stock tokens), as the
// markets show them. The three lists are read at most every 20 seconds.

import { kvGet } from './_supabaseAdmin'
import { searchScore } from './_marketProtocol'
import { rhRows, type RhSnapshot } from './rhmarket'
import { solRows, type SolSnapshot } from './solmarket'
import { bscRows, type BscSnapshot } from './bscmarket'
import type { RhCoin } from './_rhCore'

export const config = { runtime: 'edge' }

export type HitChain = 'robinhood' | 'solana' | 'bsc'
export interface ChainHit {
  chain: HitChain
  /** As the chain writes it: EVM addresses in lower case, Solana's in base58 (case kept). */
  address: string
  symbol: string
  name: string
  image: string | null
  pool: string
  launchpad: string | null
  stock?: boolean
  priceUsd: number
  marketCapUsd: number
  liquidityUsd: number
  change24h: number
}

const toHit = (chain: HitChain) => (c: RhCoin): ChainHit => ({
  chain, address: c.address, symbol: c.symbol, name: c.name, image: c.image, pool: c.pool, launchpad: c.launchpad,
  ...(c.stock ? { stock: true } : {}),
  priceUsd: c.priceUsd, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, change24h: c.change24h,
})

let cached: { at: number; rows: ChainHit[] } | null = null
const FRESH_MS = 20_000

/** Every listed coin of the three chains, from the stored lists. */
export async function chainRows(read: typeof kvGet = kvGet): Promise<ChainHit[]> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.rows
  const [rh, sol, bsc] = await Promise.all([
    read<RhSnapshot>('rh:market').catch(() => null),
    read<SolSnapshot>('sol:market').catch(() => null),
    read<BscSnapshot>('bsc:market').catch(() => null),
  ])
  const rows = [
    ...(rh?.value ? rhRows(rh.value).map(toHit('robinhood')) : []),
    ...(sol?.value ? solRows(sol.value).map(toHit('solana')) : []),
    ...(bsc?.value ? bscRows(bsc.value).map(toHit('bsc')) : []),
  ]
  cached = { at: Date.now(), rows }
  return rows
}

/** The best matches for a lower-cased query: exact ticker or address first, then prefixes, then contains; bigger
 * coins first among equals. */
export function searchChainRows(rows: ChainHit[], q: string, limit = 12): ChainHit[] {
  if (q.length < 2) return []
  return rows
    .map(c => ({ c, s: searchScore({ symbol: c.symbol, name: c.name, address: c.address }, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.c.marketCapUsd || b.c.liquidityUsd) - (a.c.marketCapUsd || a.c.liquidityUsd))
    .slice(0, limit)
    .map(x => x.c)
}

export default async function handler(req: Request): Promise<Response> {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase().replace(/^\$+/, '').slice(0, 64)
  const hits = searchChainRows(await chainRows(), q)
  return new Response(JSON.stringify({ hits }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=60' },
  })
}
