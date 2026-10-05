// BNB Chain's market (2026-10-05), as Solana's (api/solanaMarket.ts): the list from the engine (api/bscmarket.ts:
// four.meme's coins, curve and graduated, with four.meme's own word on each), else read from the visitor's browser; a
// coin's page calls GeckoTerminal from the browser (gtDirect, its own quota and pace) and reads four.meme's contract.
// The list is kept in this browser for 30 minutes.

import { parseAbi, type Address } from 'viem'
import { gtDirect } from './gtClient'
import { siteFetch } from './siteFetch'
import type { Candle } from '../lib/candles'
import type { ChartResolution, ChartSource } from '../components/PriceChart'
import type { TradeRow } from '../components/TokenSocialTabs'
import { isImage as isImageUrl, markPools, num, type GtPool, type GtPools } from '../../../api/_rhCore'
import { bscClient } from '../lib/bsc'
import {
  BSC_NET as NET, BSC_INCLUDE, BSC_RPC_BROWSER, WBNB, PANCAKE_WBNB_USDT, bscListPaths, isFourAddress, listedBsc, mergeBscCoins, parseBscPools, poolToBscCoin, readFour,
  type BscCoin, type FourInfo,
} from '../../../api/_bscCore'

export { isWashBsc, BSC_LAUNCHPADS, BSC_QUOTE_SYMBOLS, BSC_USDT, BNB_NATIVE, WBNB, FOUR, isFourAddress, type BscCoin, type FourInfo } from '../../../api/_bscCore'

const FIRST = { priority: 3 }, CANDLES = { priority: 2 }, TRADES = { priority: 1 }

const CACHE_KEY = 'arcdex:bsc-market:v1'
const CACHE_MS = 30 * 60_000
const FRESH_MS = 90_000

function readCache(): { at: number; rows: BscCoin[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; rows: BscCoin[] } | null
    return v && Array.isArray(v.rows) && Date.now() - v.at < CACHE_MS ? v : null
  } catch { return null }
}
function writeCache(rows: BscCoin[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows })) } catch { /* full or blocked */ }
}

export const cachedBscMarket = (): BscCoin[] => readCache()?.rows ?? []

let building: Promise<BscCoin[]> | null = null
let builtAt = 0
let built: BscCoin[] = []
const listeners = new Set<(rows: BscCoin[]) => void>()
let latest: BscCoin[] = []

/** A coin's row from the list already in this browser, so its page can open at once. */
export function bscSeed(token: string, pool?: string | null): BscCoin | null {
  const rows = built.length ? built : cachedBscMarket()
  const t = token.toLowerCase()
  return rows.find(c => c.address === t && (!pool || c.pool === pool.toLowerCase())) ?? null
}

/** BNB Chain's listed coins: four.meme's, one row per coin. From the engine first; without it, the browser reads the
 * busiest venues itself. `onRows` gets the list as it comes. Rebuilt at most every 90s. */
export function loadBscMarket(onRows?: (rows: BscCoin[]) => void): Promise<BscCoin[]> {
  if (built.length && Date.now() - builtAt < FRESH_MS) { onRows?.(built); return Promise.resolve(built) }
  if (onRows) { listeners.add(onRows); if (latest.length) onRows(latest) }
  if (building) return building
  const tell = (rows: BscCoin[]) => { latest = rows; listeners.forEach(l => l(rows)) }
  const done = (rows: BscCoin[]) => {
    if (rows.length) { built = rows; builtAt = Date.now(); writeCache(rows) }
    return rows.length ? rows : built
  }
  building = (async () => {
    const fromEngine = await engineList()
    if (fromEngine) { tell(fromEngine); return done(fromEngine) }
    const rows = await browserBuild(tell)
    if (rows.length) tell(rows)
    return done(rows)
  })().finally(() => { building = null; listeners.clear(); latest = [] })
  return building
}

async function engineList(): Promise<BscCoin[] | null> {
  try {
    const res = await siteFetch('/api/bscmarket', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const j = await res.json() as { rows?: BscCoin[] }
    return Array.isArray(j.rows) && j.rows.length ? j.rows : null
  } catch { return null }
}

/** Without the engine: the first few venues' pools from this browser's own GeckoTerminal quota, stopping at the first
 * refusal; then four.meme's contract is asked about every coin found, and only those it launched are kept. */
async function browserBuild(tell: (rows: BscCoin[]) => void): Promise<BscCoin[]> {
  const raw: BscCoin[] = []
  const before = built.length ? built : cachedBscMarket()
  const paths = bscListPaths().slice(0, 5)
  let read = 0
  for (const path of paths) {
    const ok = await gtDirect<GtPools>(path).then(d => { raw.push(...parseBscPools(d).filter(r => r.launchpad)); return true }, () => false)
    if (!ok) break
    read++
    tell(listedBsc(mergeBscCoins(raw)))
  }
  const rows = listedBsc(mergeBscCoins(raw))
  if (!rows.length) return before
  const four = await readFour(rows.map(c => c.address), [BSC_RPC_BROWSER]).catch(() => new Map<string, FourInfo | null>())
  const fresh = listedBsc(rows, a => (four.has(a) ? four.get(a) !== null : undefined)).map(r => withFour(r, four.get(r.address) ?? undefined))
  // A build GeckoTerminal cut short keeps the coins the last list had that it didn't reach.
  if (read === paths.length) return fresh
  const seen = new Set(fresh.map(r => r.address))
  return [...fresh, ...before.filter(r => !seen.has(r.address))]
}

export const withFour = (r: BscCoin, f?: FourInfo): BscCoin =>
  f ? { ...r, four: f, graduated: f.graduated, curveProgress: f.graduated ? 100 : f.progress } : r

/** Listed coins matching a name, ticker or address on BNB Chain. */
export async function searchBsc(query: string): Promise<BscCoin[]> {
  const d = await gtDirect<GtPools>('/search/pools', { ...BSC_INCLUDE, network: NET, query })
  return listedBsc(mergeBscCoins(parseBscPools(d)))
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

export interface BscCoinDetail extends BscCoin {
  supply: number | null
  pools: BscCoin[]
}

/** A coin's price, supply and pools (GeckoTerminal's token page). */
export async function getBscCoin(token: string, pool?: string | null): Promise<BscCoinDetail | null> {
  const addr = token.toLowerCase()
  const d = await gtDirect<GtTokenDetail>(`/networks/${NET}/tokens/${addr}`, { include: 'top_pools' }, FIRST)
  const t = d.data?.attributes
  if (!t) return null
  const tokens = new Map([[t.address.toLowerCase(), t]])
  const pools = (d.included ?? []).map(p => poolToBscCoin(p, tokens)).filter((c): c is BscCoin => !!c && c.address === addr)
  const ranked = markPools(pools) as BscCoin[]
  const best = ranked[0]
  const named = pool ? ranked.find(p => p.pool === pool.toLowerCase() && !p.offMarket) : undefined
  const main = named ?? best
  const price = (best && best.traders24h > 0 ? best.priceUsd : 0) || num(t.price_usd) || best?.priceUsd || 0
  const base: BscCoin = main ?? {
    address: addr, symbol: t.symbol, name: t.name, image: isImageUrl(t.image_url), decimals: t.decimals ?? null,
    stock: false, pool: '', dex: '', quote: '', quoteSymbol: '', priceUsd: price, change5m: 0, change1h: 0, change24h: 0,
    volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0, traders24h: 0, createdAt: 0, feePct: null,
    launchpad: isFourAddress(addr) ? 'four.meme' : null,
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
    launchpad: (ranked.find(p => p.launchpad && !p.offMarket) ?? ranked.find(p => p.launchpad))?.launchpad ?? base.launchpad,
  }
}

/** four.meme's word on a coin, read from the chain now: null for one it didn't launch, undefined if no answer. */
export async function bscCoinFour(token: string): Promise<FourInfo | null | undefined> {
  const t = token.toLowerCase()
  const r = await readFour([t], [BSC_RPC_BROWSER]).catch(() => new Map<string, FourInfo | null>())
  return r.has(t) ? r.get(t)! : undefined
}

interface GtTrade {
  attributes: {
    tx_hash: string; tx_from_address?: string | null; kind?: string; block_timestamp: string
    volume_in_usd?: string | null; from_token_amount?: string | null; to_token_amount?: string | null
    from_token_address?: string | null; to_token_address?: string | null
  }
}

/** A pool's latest trades (up to 300, last 24h), as the trades list's rows. */
export async function getBscTrades(pool: string, token: string): Promise<TradeRow[]> {
  const t = token.toLowerCase()
  const d = await gtDirect<{ data?: GtTrade[] }>(`/networks/${NET}/pools/${pool}/trades`, {}, TRADES)
  return (d.data ?? []).map(x => {
    const a = x.attributes
    const bought = (a.to_token_address ?? '').toLowerCase() === t
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
export const BSC_RESOLUTIONS = Object.keys(RES) as ChartResolution[]

export async function getBscCandles(pool: string, token: string, res: ChartResolution, limit = 300): Promise<Candle[]> {
  const r = RES[res]
  if (!r) return []
  const d = await gtDirect<{ data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } }>(
    `/networks/${NET}/pools/${pool}/ohlcv/${r.timeframe}`,
    { aggregate: String(r.aggregate), limit: String(limit), currency: 'usd', token: token.toLowerCase() },
    CANDLES,
  )
  return (d.data?.attributes?.ohlcv_list ?? [])
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

/** `fromChain`: the page reads the pool's swaps from the chain, so 15s candles are drawn from them (GeckoTerminal has
 * nothing under a minute). */
export function bscChartSource(pool: string, token: string, fromChain = false): ChartSource {
  return { id: `bsc:${pool}:${token}`, load: res => getBscCandles(pool, token, res), refreshMs: 30_000, resolutions: fromChain ? ['15s', ...BSC_RESOLUTIONS] : BSC_RESOLUTIONS }
}

// ── BNB's price (the guard values BNB going in or out at it) ─────────────

const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 at)'])
let bnbPrice: { at: number; usd: number } | null = null
let bnbPricing: Promise<number> | null = null
/** BNB in dollars, kept a minute: PancakeSwap's WBNB/USDT pair (its deepest, read from the chain), else GeckoTerminal. */
export function bnbUsd(): Promise<number> {
  if (bnbPrice && Date.now() - bnbPrice.at < 60_000) return Promise.resolve(bnbPrice.usd)
  if (bnbPricing) return bnbPricing
  const fromPair = () => bscClient.readContract({ address: PANCAKE_WBNB_USDT as Address, abi: PAIR_ABI, functionName: 'getReserves' })
    .then(([usdt, wbnb]) => (wbnb > 0n ? Number((usdt * 1_000_000n) / wbnb) / 1e6 : 0))
  const fromGt = () => gtDirect<{ data?: { attributes?: { token_prices?: Record<string, string | null> } } }>(`/simple/networks/${NET}/token_price/${WBNB}`, {}, FIRST)
    .then(d => Number(Object.values(d.data?.attributes?.token_prices ?? {})[0]) || 0)
  bnbPricing = fromPair().catch(() => 0).then(v => (v > 0 ? v : fromGt().catch(() => 0)))
    .then(v => { if (v > 0) bnbPrice = { at: Date.now(), usd: v }; return bnbPrice?.usd ?? 0 })
    .finally(() => { bnbPricing = null })
  return bnbPricing
}
