// Finding any coin on Arc by name, ticker or contract address (owner's
// request, 2026-09-30: "search for a coin by name or contract address and
// get it"). The coins this page already knows answer at once; then, for two
// characters or more:
//   the market engine's search  every launch it has seen, on every launchpad (/v1/search)
//   GeckoTerminal's search      every pool it lists on Arc, by name or token address
//   the chain itself            for a full address nobody lists: the token's own symbol() and name()
// Everything is merged by address and ranked with the Launchpad's matcher
// (exact ticker or address, then prefixes, then contains; bigger coins first).

import { useEffect, useMemo, useState } from 'react'
import { erc20Abi, type Address } from 'viem'
import { searchScore, type SearchHit } from '../../../api/_marketProtocol'
import { searchPools } from '../api/gecko'
import { client } from '../api/launchpad'
import { engineEnabled, engineSearch } from '../api/marketStream'
import { normQuery } from './coinSearch'

export interface FoundCoin {
  address: string
  symbol: string
  name: string
  image: string | null
  pool: string | null
  launchpad: string | null
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  change24h: number | null
  /** Where it was found: only the chain means no list has it (yet). */
  source: 'local' | 'engine' | 'gecko' | 'chain'
}

const isAddress = (q: string) => /^0x[0-9a-f]{40}$/.test(q)
/** No source holds the others back: GeckoTerminal's search took ~10s once (2026-09-30). */
const within = <T,>(p: Promise<T>, ms = 5_000): Promise<T> => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms))])
const cache = new Map<string, { at: number; coins: FoundCoin[] }>()
const TTL = 60_000

const fromHit = (h: SearchHit): FoundCoin => ({ address: h.token.toLowerCase(), symbol: h.symbol, name: h.name, image: h.image, pool: h.pool, launchpad: h.launchpad, priceUsd: h.priceUsd, marketCapUsd: h.marketCapUsd, liquidityUsd: h.liquidityUsd, change24h: null, source: 'engine' })

/** A token contract's own symbol and name, when there is one at `address`. */
async function readToken(address: string): Promise<FoundCoin | null> {
  const [sym, name] = await client.multicall({ allowFailure: true, contracts: [
    { address: address as Address, abi: erc20Abi, functionName: 'symbol' },
    { address: address as Address, abi: erc20Abi, functionName: 'name' },
  ] })
  if (sym.status !== 'success' || !sym.result) return null
  return { address, symbol: String(sym.result), name: name.status === 'success' ? String(name.result) : String(sym.result), image: null, pool: null, launchpad: null, priceUsd: null, marketCapUsd: null, liquidityUsd: null, change24h: null, source: 'chain' }
}

/** The remote sources for one query (cached a minute). */
export async function findCoinsRemote(q: string): Promise<FoundCoin[]> {
  const hit = cache.get(q)
  if (hit && Date.now() - hit.at < TTL) return hit.coins
  const addr = isAddress(q)
  const [engine, gecko, chain] = await Promise.allSettled([
    within(engineEnabled ? engineSearch(q, 20) : Promise.resolve([] as SearchHit[])),
    within(searchPools(q)),
    within(addr ? readToken(q) : Promise.resolve(null)),
  ])
  const out = new Map<string, FoundCoin>()
  if (engine.status === 'fulfilled') for (const h of engine.value) out.set(h.token.toLowerCase(), fromHit(h))
  if (gecko.status === 'fulfilled') {
    for (const p of gecko.value) {
      const a = p.baseAddress?.toLowerCase()
      if (!a) continue
      const prev = out.get(a)
      // GeckoTerminal knows the pool's price and depth; keep the deepest pool per coin.
      if (prev && (prev.liquidityUsd ?? 0) >= p.liquidityUsd && prev.source === 'gecko') continue
      out.set(a, { address: a, symbol: p.baseSymbol, name: p.baseName, image: p.logoUrl ?? prev?.image ?? null, pool: p.address || prev?.pool || null, launchpad: prev?.launchpad ?? p.dexName ?? null,
        priceUsd: p.priceUsd || prev?.priceUsd || null, marketCapUsd: p.marketCapUsd ?? p.fdvUsd ?? prev?.marketCapUsd ?? null, liquidityUsd: p.liquidityUsd || prev?.liquidityUsd || null, change24h: p.priceChange?.h24 ?? null, source: prev ? prev.source : 'gecko' })
    }
  }
  if (chain.status === 'fulfilled' && chain.value && !out.has(q)) out.set(q, chain.value)
  const coins = [...out.values()]
  cache.set(q, { at: Date.now(), coins })
  if (cache.size > 200) cache.clear()
  return coins
}

/** Merges and ranks: best match first, then the bigger coin. */
export function rankCoins(coins: FoundCoin[], q: string, limit = 15): FoundCoin[] {
  const byAddr = new Map<string, FoundCoin>()
  for (const c of coins) {
    const prev = byAddr.get(c.address)
    // What the page knows (live price, image) wins; remote fills the gaps.
    byAddr.set(c.address, prev ? { ...c, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== null && v !== undefined)) } as FoundCoin : c)
  }
  return [...byAddr.values()]
    .map(c => ({ c, s: searchScore({ symbol: c.symbol, name: c.name, address: c.address }, q) || (c.address === q ? 6 : 0) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.c.marketCapUsd ?? b.c.liquidityUsd ?? 0) - (a.c.marketCapUsd ?? a.c.liquidityUsd ?? 0))
    .slice(0, limit)
    .map(x => x.c)
}

/** Coins matching `query`: `local` at once, then the engine, GeckoTerminal and (for an address) the chain. */
export function useCoinFinder(query: string, local: FoundCoin[], limit = 15): { results: FoundCoin[]; searching: boolean; noToken: boolean } {
  const q = normQuery(query)
  const [remote, setRemote] = useState<{ q: string; coins: FoundCoin[] } | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (q.length < 2) { setRemote(null); setSearching(false); return }
    let alive = true
    setSearching(true)
    const id = setTimeout(() => {
      void findCoinsRemote(q).then(coins => { if (alive) setRemote({ q, coins }) }).catch(() => { if (alive) setRemote({ q, coins: [] }) }).finally(() => { if (alive) setSearching(false) })
    }, 250)
    return () => { alive = false; clearTimeout(id) }
  }, [q])

  const results = useMemo(() => {
    if (!q) return []
    return rankCoins([...local, ...(remote?.q === q ? remote.coins : [])], q, limit)
  }, [q, local, remote, limit])

  return { results, searching, noToken: isAddress(q) && !searching && remote?.q === q && results.length === 0 }
}
