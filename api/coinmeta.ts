// One coin, in a few hundred bytes, for its page's link preview and search-engine title (2026-10-05, owner: "we have
// no users; compare us with DexScreener"). A shared ARCDEX coin link showed the site's generic card, and every coin
// page had the same title; DexScreener's read "ARGUS $13.02M - Argus / USDC on Arc". The site's edge function
// (netlify/edge-functions/coin-meta.ts) asks this for the coin and writes it into the page's head.
//
//   /api/coinmeta?chain=arc|robinhood|solana|bsc&address=…  one coin from the lists the engine keeps
//   /api/coinmeta?sitemap=1                                  every listed coin's page, for /sitemap.xml
//
// Served by the engine; read from the stored lists (no GeckoTerminal call), at most every 30 seconds.

import { kvGet } from './_supabaseAdmin'
import type { ArgusPool } from './_argusCore'
import { trending, type TrendChain } from './trending'
import { rhRows, type RhSnapshot } from './rhmarket'
import { solRows, type SolSnapshot } from './solmarket'
import { bscRows, type BscSnapshot } from './bscmarket'
import type { RhCoin } from './_rhCore'

export const config = { runtime: 'edge' }

export interface CoinMeta {
  chain: TrendChain
  address: string
  pool: string | null
  symbol: string
  name: string
  image: string | null
  launchpad: string | null
  quote: string | null
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  change24h: number | null
}

interface Book { at: number; coins: Map<string, CoinMeta> }
let book: Book | null = null
const FRESH_MS = 30_000
const key = (chain: TrendChain, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

const fromArc = (p: ArgusPool): CoinMeta => ({
  chain: 'arc', address: p.token.address, pool: p.pool, symbol: p.token.symbol, name: p.token.name, image: p.token.image,
  launchpad: p.launchpad ?? 'Argus', quote: p.quote.symbol, priceUsd: p.priceUsd, marketCapUsd: p.marketCapUsd ?? p.fdvUsd,
  liquidityUsd: p.liquidityUsd, change24h: p.change.h24,
})
const fromCoin = (chain: TrendChain) => (c: RhCoin): CoinMeta => ({
  chain, address: c.address, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, launchpad: c.launchpad,
  quote: c.quoteSymbol, priceUsd: c.priceUsd, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, change24h: c.change24h,
})

export async function coinBook(read: typeof kvGet = kvGet, now = Date.now()): Promise<Map<string, CoinMeta>> {
  if (book && now - book.at < FRESH_MS) return book.coins
  const [arc, rh, sol, bsc] = await Promise.all([
    read<{ pools: ArgusPool[] }>('argus:market').catch(() => null),
    read<RhSnapshot>('rh:market').catch(() => null),
    read<SolSnapshot>('sol:market').catch(() => null),
    read<BscSnapshot>('bsc:market').catch(() => null),
  ])
  const coins = new Map<string, CoinMeta>()
  const add = (m: CoinMeta) => {
    const k = key(m.chain, m.address)
    const cur = coins.get(k)
    if (!cur || (m.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) coins.set(k, m)
  }
  for (const p of arc?.value?.pools ?? []) add(fromArc(p))
  if (rh?.value) for (const c of rhRows(rh.value)) add(fromCoin('robinhood')(c))
  if (sol?.value) for (const c of solRows(sol.value)) add(fromCoin('solana')(c))
  if (bsc?.value) for (const c of bscRows(bsc.value)) add(fromCoin('bsc')(c))
  book = { at: now, coins }
  return coins
}

const json = (body: unknown, maxAge: number) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=600` },
})

const CHAINS = new Set<TrendChain>(['arc', 'robinhood', 'solana', 'bsc'])

export default async function handler(req: Request): Promise<Response> {
  const u = new URL(req.url)
  if (u.searchParams.get('sitemap')) {
    // The listed coins (the markets' rules, via /api/trending's ranking of all of them) and every coin the lists know.
    const [t, all] = await Promise.all([trending(), coinBook()])
    const top = new Set(t.rows.map(r => key(r.chain, r.address)))
    const pages = [...all.values()].filter(m => top.has(key(m.chain, m.address)) || (m.liquidityUsd ?? 0) >= 5_000)
      .map(m => ({ chain: m.chain, address: m.address, pool: m.pool }))
    return json({ pages }, 3600)
  }
  const chain = (u.searchParams.get('chain') ?? 'arc') as TrendChain
  const address = (u.searchParams.get('address') ?? '').trim()
  if (!CHAINS.has(chain) || !address || address.length > 64) return json({ coin: null }, 60)
  const coin = (await coinBook()).get(key(chain, address)) ?? null
  return json({ coin }, 60)
}
