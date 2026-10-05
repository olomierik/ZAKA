// Solana's market (2026-10-04), as Robinhood Chain's (api/robinhoodMarket.ts): the list from the engine
// (api/solmarket.ts: every launchpad's coins, with their curves and mints read from the chain), else read from the
// visitor's browser; a coin's page calls GeckoTerminal from the browser (gtDirect, its own quota and pace) and reads its
// curve and mint from the chain. The list is kept in this browser for 30 minutes.

import { gtDirect } from './gtClient'
import { siteFetch } from './siteFetch'
import type { Candle } from '../lib/candles'
import type { ChartResolution, ChartSource } from '../components/PriceChart'
import type { TradeRow } from '../components/TokenSocialTabs'
import { isImage as isImageUrl, markPools, num, type GtPool, type GtPools } from '../../../api/_rhCore'
import {
  SOL_NET as NET, SOL_INCLUDE, SOL_RPC_BROWSER, listedSol, mergeSolCoins, parseSolPools, poolToSolCoin, readCurves, readMints, solListPaths,
  type CurveRead, type MintFlags, type SolCoin,
} from '../../../api/_solCore'

export { isWashSol, SOL_LAUNCHPADS, SOL_CURVE_DEXES, type SolCoin, type MintFlags } from '../../../api/_solCore'

const FIRST = { priority: 3 }, CANDLES = { priority: 2 }, TRADES = { priority: 1 }

const CACHE_KEY = 'arcdex:sol-market:v1'
const CACHE_MS = 30 * 60_000
const FRESH_MS = 90_000

function readCache(): { at: number; rows: SolCoin[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; rows: SolCoin[] } | null
    return v && Array.isArray(v.rows) && Date.now() - v.at < CACHE_MS ? v : null
  } catch { return null }
}
function writeCache(rows: SolCoin[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows })) } catch { /* full or blocked */ }
}

export const cachedSolMarket = (): SolCoin[] => readCache()?.rows ?? []

let building: Promise<SolCoin[]> | null = null
let builtAt = 0
let built: SolCoin[] = []
const listeners = new Set<(rows: SolCoin[]) => void>()
let latest: SolCoin[] = []

/** A coin's row from the list already in this browser, so its page can open at once. */
export function solSeed(mint: string, pool?: string | null): SolCoin | null {
  const rows = built.length ? built : cachedSolMarket()
  return rows.find(c => c.address === mint && (!pool || c.pool === pool)) ?? null
}

/** Solana's listed coins: launchpad coins only, one row per coin. From the engine first; without it, the browser reads
 * the busiest launchpads itself. `onRows` gets the list as it comes. Rebuilt at most every 90s. */
export function loadSolMarket(onRows?: (rows: SolCoin[]) => void): Promise<SolCoin[]> {
  if (built.length && Date.now() - builtAt < FRESH_MS) { onRows?.(built); return Promise.resolve(built) }
  if (onRows) { listeners.add(onRows); if (latest.length) onRows(latest) }
  if (building) return building
  const tell = (rows: SolCoin[]) => { latest = rows; listeners.forEach(l => l(rows)) }
  const done = (rows: SolCoin[]) => {
    if (rows.length) { built = rows; builtAt = Date.now(); writeCache(rows) }
    return rows.length ? rows : built
  }
  building = (async () => {
    const fromEngine = await engineList()
    if (fromEngine) { tell(fromEngine); return done(fromEngine) }
    // The finished build carries each coin's curve and mint: every page waiting gets it too.
    const rows = await browserBuild(tell)
    if (rows.length) tell(rows)
    return done(rows)
  })().finally(() => { building = null; listeners.clear(); latest = [] })
  return building
}

async function engineList(): Promise<SolCoin[] | null> {
  try {
    const res = await siteFetch('/api/solmarket', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const j = await res.json() as { rows?: SolCoin[] }
    return Array.isArray(j.rows) && j.rows.length ? j.rows : null
  } catch { return null }
}

/** Without the engine: the first few launchpads' pools, from this browser's own GeckoTerminal quota (it throttles after
 * about five calls), stopping at the first refusal. Curves and mints are then read for the coins found. */
async function browserBuild(tell: (rows: SolCoin[]) => void): Promise<SolCoin[]> {
  const raw: SolCoin[] = []
  const before = built.length ? built : cachedSolMarket()
  const paths = solListPaths().slice(0, 5)
  let read = 0
  for (const path of paths) {
    const ok = await gtDirect<GtPools>(path).then(d => { raw.push(...parseSolPools(d)); return true }, () => false)
    if (!ok) break
    read++
    tell(listedSol(mergeSolCoins(raw)))
  }
  const rows = listedSol(mergeSolCoins(raw))
  if (!rows.length) return before
  const [curves, mints] = await Promise.all([
    readCurves(rows.map(c => ({ address: c.address, pool: c.pool })), [SOL_RPC_BROWSER], new Map()).catch(() => new Map<string, CurveRead>()),
    readMints(rows.map(c => c.address), [SOL_RPC_BROWSER]).catch(() => new Map<string, MintFlags>()),
  ])
  const fresh = rows.map(r => withChain(r, curves.get(r.address), mints.get(r.address)))
  // A build GeckoTerminal cut short keeps the coins the last list had that it didn't reach.
  if (read === paths.length) return fresh
  const seen = new Set(fresh.map(r => r.address))
  return [...fresh, ...before.filter(r => !seen.has(r.address))]
}

const withChain = (r: SolCoin, c?: CurveRead, m?: MintFlags): SolCoin => ({
  ...r,
  ...(c ? { curveProgress: c.graduated ? 100 : c.progress, graduated: c.graduated } : r.dex === 'pumpswap' ? { graduated: true, curveProgress: 100 } : {}),
  ...(m ? { mint: m } : {}),
})

/** Listed coins matching a name, ticker or address on Solana. */
export async function searchSol(query: string): Promise<SolCoin[]> {
  const d = await gtDirect<GtPools>('/search/pools', { ...SOL_INCLUDE, network: NET, query })
  return listedSol(mergeSolCoins(parseSolPools(d)))
}

// ── one coin ─────────────────────────────────────────────────────────────

interface GtTokenDetail {
  data?: {
    id: string
    attributes: {
      address: string; name: string; symbol: string; decimals?: number | null; image_url?: string | null
      price_usd?: string | null; fdv_usd?: string | null; market_cap_usd?: string | null; normalized_total_supply?: string | null
    }
  }
  included?: GtPool[]
}

export interface SolCoinDetail extends SolCoin {
  supply: number | null
  pools: SolCoin[]
}

/** A coin's price, supply and pools (GeckoTerminal's token page). */
export async function getSolCoin(mint: string, pool?: string | null): Promise<SolCoinDetail | null> {
  const d = await gtDirect<GtTokenDetail>(`/networks/${NET}/tokens/${mint}`, { include: 'top_pools' }, FIRST)
  const t = d.data?.attributes
  if (!t) return null
  const tokens = new Map([[t.address, t]])
  const pools = (d.included ?? []).map(p => poolToSolCoin(p, tokens)).filter((c): c is SolCoin => !!c && c.address === t.address)
  const ranked = markPools(pools) as SolCoin[]
  const best = ranked[0]
  const named = pool ? ranked.find(p => p.pool === pool && !p.offMarket) : undefined
  const main = named ?? best
  const price = (best && best.traders24h > 0 ? best.priceUsd : 0) || num(t.price_usd) || best?.priceUsd || 0
  const base: SolCoin = main ?? {
    address: t.address, symbol: t.symbol, name: t.name, image: isImageUrl(t.image_url), decimals: t.decimals ?? null,
    stock: false, pool: '', dex: '', quote: '', quoteSymbol: '', priceUsd: price, change5m: 0, change1h: 0, change24h: 0,
    volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0, traders24h: 0, createdAt: 0, feePct: null, launchpad: null,
  }
  return {
    ...base,
    symbol: t.symbol || base.symbol,
    name: t.name || base.name,
    image: isImageUrl(t.image_url) ?? base.image,
    decimals: typeof t.decimals === 'number' ? t.decimals : base.decimals,
    priceUsd: price,
    marketCap: num(t.market_cap_usd) || num(t.fdv_usd) || base.marketCap,
    volume24h: ranked.filter(p => !p.offMarket).reduce((s, p) => s + p.volume24h, 0) || base.volume24h,
    supply: num(t.normalized_total_supply) || null,
    pools: ranked,
    launchpad: (ranked.find(p => p.launchpad && !p.offMarket) ?? ranked.find(p => p.launchpad))?.launchpad ?? null,
  }
}

/** A coin's launch curve and mint, read from the chain now. */
export async function solCoinChain(mint: string, pool: string | null): Promise<{ curve: CurveRead | null; mint: MintFlags | null }> {
  const [curves, mints] = await Promise.all([
    pool ? readCurves([{ address: mint, pool }], [SOL_RPC_BROWSER], new Map()).catch(() => new Map<string, CurveRead>()) : Promise.resolve(new Map<string, CurveRead>()),
    readMints([mint], [SOL_RPC_BROWSER]).catch(() => new Map<string, MintFlags>()),
  ])
  return { curve: curves.get(mint) ?? null, mint: mints.get(mint) ?? null }
}

interface GtTrade {
  attributes: {
    tx_hash: string; tx_from_address?: string | null; kind?: string; block_timestamp: string
    volume_in_usd?: string | null; from_token_amount?: string | null; to_token_amount?: string | null
    from_token_address?: string | null; to_token_address?: string | null
  }
}

/** A pool's latest trades (up to 300, last 24h), as the trades list's rows. */
export async function getSolTrades(pool: string, mint: string): Promise<TradeRow[]> {
  const d = await gtDirect<{ data?: GtTrade[] }>(`/networks/${NET}/pools/${pool}/trades`, {}, TRADES)
  return (d.data ?? []).map(t => {
    const a = t.attributes
    const bought = (a.to_token_address ?? '') === mint
    return {
      txHash: a.tx_hash,
      maker: a.tx_from_address ?? null,
      kind: bought ? 'buy' as const : 'sell' as const,
      usd: num(a.volume_in_usd),
      tokenAmount: num(bought ? a.to_token_amount : a.from_token_amount),
      timestamp: Date.parse(a.block_timestamp) || 0,
      live: false,
    }
  }).filter(r => r.timestamp > 0)
}

const RES: Partial<Record<ChartResolution, { timeframe: 'day' | 'hour' | 'minute'; aggregate: number }>> = {
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
}
export const SOL_RESOLUTIONS = Object.keys(RES) as ChartResolution[]

export async function getSolCandles(pool: string, mint: string, res: ChartResolution, limit = 300): Promise<Candle[]> {
  const r = RES[res]
  if (!r) return []
  const d = await gtDirect<{ data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } }>(
    `/networks/${NET}/pools/${pool}/ohlcv/${r.timeframe}`,
    { aggregate: String(r.aggregate), limit: String(limit), currency: 'usd', token: mint },
    CANDLES,
  )
  return (d.data?.attributes?.ohlcv_list ?? [])
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

export function solChartSource(pool: string, mint: string): ChartSource {
  return { id: `sol:${pool}:${mint}`, load: res => getSolCandles(pool, mint, res), refreshMs: 30_000, resolutions: SOL_RESOLUTIONS }
}

// ── SOL's price (the swap guard values SOL going in or out at it) ────────

let solPrice: { at: number; usd: number } | null = null
let solPricing: Promise<number> | null = null
/** SOL in dollars (GeckoTerminal's wSOL price, kept a minute). */
export function solUsd(): Promise<number> {
  if (solPrice && Date.now() - solPrice.at < 60_000) return Promise.resolve(solPrice.usd)
  if (solPricing) return solPricing
  solPricing = gtDirect<{ data?: { attributes?: { token_prices?: Record<string, string | null> } } }>(`/simple/networks/${NET}/token_price/So11111111111111111111111111111111111111112`, {}, FIRST)
    .then(d => { const v = Number(Object.values(d.data?.attributes?.token_prices ?? {})[0]); if (v > 0) solPrice = { at: Date.now(), usd: v }; return solPrice?.usd ?? 0 })
    .catch(() => solPrice?.usd ?? 0)
    .finally(() => { solPricing = null })
  return solPricing
}
