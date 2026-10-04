// Robinhood Chain's market, from GeckoTerminal (network `robinhood`): its
// coins and Robinhood's stock tokens, their prices, trades and candles.
//
// The list comes from the engine (api/rhmarket.ts, read a little at a time on
// its own budget), else from the visitor's browser. A coin's page calls
// GeckoTerminal from the browser (gtDirect, paced to its free rate), never
// through the app's proxy, whose shared quota is Arc's. The list is kept in
// this browser for 30 minutes, so a returning visitor sees it at once while
// it refreshes.

import { gtDirect } from './gtClient'
import { siteFetch } from './siteFetch'
import type { Candle } from '../lib/candles'
import type { ChartResolution, ChartSource } from '../components/PriceChart'
import type { TradeRow } from '../components/TokenSocialTabs'
import { isStockToken } from '../lib/robinhood'
import {
  INCLUDE, RH_NET as NET, isImage, isStockName, listed, isListed, markPools, mergeCoins, num, parsePools, poolToCoin, rhListPaths,
  type GtPool, type GtPools, type RhCoin,
} from '../../../api/_rhCore'

export { RH_LAUNCHPADS, TRAP_FEE_PCT, isWashPool, markPools, mergeCoins, poolFeePct, poolToCoin, rankPools, type RhCoin } from '../../../api/_rhCore'
/** The coin page's calls go before any market list's (gtClient's pacing): the
 * coin itself (price, stats, pools) first, then its candles, then its trades
 * (the chain gives the live ones; these add older trades and makers). */
const FIRST = { priority: 3 }, CANDLES = { priority: 2 }, TRADES = { priority: 1 }

// ── what's listed: launchpad coins, and Robinhood's stock tokens ────────

/** Stock tokens checked on the chain (Robinhood's beacon), by address: false for an impostor. */
const stockCheck = new Map<string, boolean>()
const checking = new Set<string>()

/** Checks the stock-named coins the chain hasn't been asked about yet; `done` runs once any answer. */
function checkStocks(rows: RhCoin[], done: () => void) {
  const todo = rows.filter(r => r.stock && !stockCheck.has(r.address) && !checking.has(r.address)).slice(0, 40)
  if (!todo.length) return
  todo.forEach(r => checking.add(r.address))
  void Promise.all(todo.map(r => isStockToken(r.address).then(ok => { stockCheck.set(r.address, ok) }).catch(() => {}).finally(() => checking.delete(r.address))))
    .then(done)
}

/** Whether a coin is listed: from a launchpad, or one of Robinhood's stock tokens (a stock name the
 * chain hasn't vouched for yet counts until it answers; an impostor never does). */
export const isListedRh = (c: RhCoin): boolean => isListed(c, a => stockCheck.get(a))

/** The coins to show: listed ones, impostor stock names marked as not stocks. */
export const listedRh = (rows: RhCoin[]): RhCoin[] => listed(rows, a => stockCheck.get(a))

// ── the market list ──────────────────────────────────────────────────────

// v3 (2026-10-04): launchpad coins and stock tokens only; v2 listed any coin, v1's main pools could be traps.
const CACHE_KEY = 'arcdex:rh-market:v3'
const CACHE_MS = 30 * 60_000
const FRESH_MS = 90_000

function readCache(): { at: number; rows: RhCoin[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; rows: RhCoin[] } | null
    return v && Array.isArray(v.rows) && Date.now() - v.at < CACHE_MS ? v : null
  } catch { return null }
}
function writeCache(rows: RhCoin[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows })) } catch { /* full or blocked */ }
}

/** The last list this browser built (≤30 minutes old), shown while a new one loads. */
export const cachedRhMarket = (): RhCoin[] => readCache()?.rows ?? []

/** A coin's row from the market list already in this browser (the last build,
 * else the stored one), so its page can show it and start reading its pool's
 * swaps at once. Only when it's the pool asked for. */
export function rhSeed(address: string, pool?: string | null): RhCoin | null {
  const a = address.toLowerCase(), p = pool?.toLowerCase()
  const rows = built.length ? built : cachedRhMarket()
  return rows.find(c => c.address === a && (!p || c.pool === p)) ?? null
}

let building: Promise<RhCoin[]> | null = null
let builtAt = 0
let built: RhCoin[] = []
/** Who's waiting on the build in progress, and the rows it has so far. */
const listeners = new Set<(rows: RhCoin[]) => void>()
let latest: RhCoin[] = []

/** Robinhood Chain's listed coins: launchpad coins and Robinhood's stock tokens, one row per coin.
 * From the engine first (api/rhmarket.ts: every launchpad's coins at once, read a little at a time
 * on its own GeckoTerminal budget). Without it, the browser reads the list itself (below). `onRows`
 * gets the list as it comes. Rebuilt at most every 90s however many pages ask. */
export function loadRhMarket(onRows?: (rows: RhCoin[]) => void): Promise<RhCoin[]> {
  if (built.length && Date.now() - builtAt < FRESH_MS) { onRows?.(built); return Promise.resolve(built) }
  // Every caller gets the rows as they come, not only the one that started the build: a page that
  // asks while a build runs (two pages, or React running an effect twice) used to wait for the whole
  // build, a minute when GeckoTerminal throttles.
  if (onRows) { listeners.add(onRows); if (latest.length) onRows(latest) }
  if (building) return building
  const tell = (rows: RhCoin[]) => { latest = rows; listeners.forEach(l => l(rows)) }
  const done = (rows: RhCoin[]) => {
    if (rows.length) { built = rows; builtAt = Date.now(); writeCache(rows) }
    return rows.length ? rows : built
  }
  building = (async () => {
    const fromEngine = await engineList()
    if (fromEngine) { const now = Date.now(); fromEngine.forEach(r => seenAt.set(r.address, now)); tell(fromEngine); return done(fromEngine) }
    return done(await browserBuild(tell))
  })().finally(() => { building = null; listeners.clear(); latest = [] })
  return building
}

/** The engine's list, or null when it can't be had (no engine, or an engine without the route). */
async function engineList(): Promise<RhCoin[] | null> {
  try {
    const res = await siteFetch('/api/rhmarket', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const j = await res.json() as { rows?: RhCoin[] }
    return Array.isArray(j.rows) && j.rows.length ? j.rows : null
  } catch { return null }
}

/** When each coin was last read, so one a build didn't reach is kept only so long. */
const seenAt = new Map<string, number>()
const KEEP_UNSEEN_MS = 60 * 60_000
const CURSOR_KEY = 'arcdex:rh-cursor'
const readCursor = () => { try { return Number(localStorage.getItem(CURSOR_KEY)) || 1 } catch { return 1 } }
const saveCursor = (i: number) => { try { localStorage.setItem(CURSOR_KEY, String(i)) } catch { /* storage blocked */ } }

/** The list read from this browser, on its own GeckoTerminal quota, which allows about five calls
 * before it throttles (measured 2026-10-04). So: the busiest pools first, then the rest of the round
 * (`rhListPaths`) from where the last build stopped, stopping at the first refusal, and the coins the
 * last list had that this one didn't reach are kept. Over a few builds every launchpad comes in. */
async function browserBuild(tell: (rows: RhCoin[]) => void): Promise<RhCoin[]> {
  const raw: RhCoin[] = []
  const before = built.length ? built : cachedRhMarket()
  const cachedAt = readCache()?.at ?? 0
  // A coin the last list had and this build hasn't reached stays, for an hour after it was last read.
  const withBefore = (rows: RhCoin[]) => {
    const have = new Set(rows.map(r => r.address))
    const now = Date.now()
    return [...rows, ...before.filter(r => !have.has(r.address) && now - (seenAt.get(r.address) ?? cachedAt) < KEEP_UNSEEN_MS)]
  }
  const emit = () => {
    const now = Date.now()
    for (const r of raw) seenAt.set(r.address, now)
    const merged = mergeCoins(raw)
    checkStocks(merged, () => { tell(withBefore(listedRh(mergeCoins(raw)))) })
    tell(withBefore(listedRh(merged)))
  }
  const step = (path: string) => gtDirect<GtPools>(path).then(d => { raw.push(...parsePools(d)); emit(); return true }, () => false)
  const paths = rhListPaths()
  const start = Math.min(Math.max(1, readCursor()), paths.length - 1)
  const rest = [...paths.keys()].slice(1)
  const order = [...rest.slice(start - 1), ...rest.slice(0, start - 1)]
  await step(paths[0])
  let stopped = false
  for (const i of order) {
    if (!(await step(paths[i]))) { saveCursor(i); stopped = true; break }
  }
  if (!stopped) saveCursor(1)
  return withBefore(listedRh(mergeCoins(raw)))
}

/** Listed coins matching a name, ticker or address on Robinhood Chain. */
export async function searchRh(query: string): Promise<RhCoin[]> {
  const d = await gtDirect<GtPools>('/search/pools', { ...INCLUDE, network: NET, query })
  return listedRh(mergeCoins(parsePools(d)))
}

// ── one coin ─────────────────────────────────────────────────────────────

interface GtTokenDetail {
  data?: {
    attributes: {
      address: string; name: string; symbol: string; decimals?: number | null; image_url?: string | null
      price_usd?: string | null; fdv_usd?: string | null; market_cap_usd?: string | null; normalized_total_supply?: string | null
    }
    relationships?: { top_pools?: { data?: { id: string }[] } }
  }
  included?: GtPool[]
}

export interface RhCoinDetail extends RhCoin {
  /** Tokens in existence, for the chart's market cap. */
  supply: number | null
  /** Its pools, the best market first (`markPools`), off-market ones marked. */
  pools: RhCoin[]
}

/** A coin's price, supply and pools (GeckoTerminal's token page). `pool`
 * picks the main pool when the link named one (never an off-market pool).
 * The price is always its best market's, whichever pool the page shows. */
export async function getRhCoin(address: string, pool?: string | null): Promise<RhCoinDetail | null> {
  const d = await gtDirect<GtTokenDetail>(`/networks/${NET}/tokens/${address.toLowerCase()}`, { include: 'top_pools' }, FIRST)
  const t = d.data?.attributes
  if (!t) return null
  const tokens = new Map([[t.address.toLowerCase(), t]])
  const pools = (d.included ?? []).map(p => poolToCoin(p, tokens)).filter((c): c is RhCoin => !!c && c.address === t.address.toLowerCase())
  const ranked = markPools(pools)
  const best = ranked[0]
  const named = pool ? ranked.find(p => p.pool === pool.toLowerCase() && !p.offMarket) : undefined
  const main = named ?? best
  const price = (best && best.traders24h > 0 ? best.priceUsd : 0) || num(t.price_usd) || best?.priceUsd || 0
  const base: RhCoin = main ?? {
    address: t.address.toLowerCase(), symbol: t.symbol, name: t.name, image: isImage(t.image_url), decimals: t.decimals ?? null,
    stock: isStockName(t.name), pool: '', dex: '', quote: '', quoteSymbol: '', priceUsd: price, change5m: 0, change1h: 0, change24h: 0,
    volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0, traders24h: 0, createdAt: 0, feePct: null, launchpad: null,
  }
  return {
    ...base,
    symbol: t.symbol || base.symbol,
    name: t.name || base.name,
    image: isImage(t.image_url) ?? base.image,
    decimals: typeof t.decimals === 'number' ? t.decimals : base.decimals,
    stock: isStockName(t.name),
    priceUsd: price,
    marketCap: num(t.market_cap_usd) || num(t.fdv_usd) || base.marketCap,
    volume24h: ranked.filter(p => !p.offMarket).reduce((s, p) => s + p.volume24h, 0) || base.volume24h,
    supply: num(t.normalized_total_supply) || null,
    pools: ranked,
    launchpad: (ranked.find(p => p.launchpad && !p.offMarket) ?? ranked.find(p => p.launchpad))?.launchpad ?? null,
  }
}

interface GtTrade {
  attributes: {
    tx_hash: string; tx_from_address?: string | null; kind?: string; block_timestamp: string
    volume_in_usd?: string | null; from_token_amount?: string | null; to_token_amount?: string | null
    from_token_address?: string | null; to_token_address?: string | null
  }
}

/** A pool's latest trades (up to 300, last 24h), as the trades list's rows.
 * The side is read from which way the coin moved, so it's right whichever
 * side of the pool the coin sits on. */
export async function getRhTrades(pool: string, coin: string): Promise<TradeRow[]> {
  const d = await gtDirect<{ data?: GtTrade[] }>(`/networks/${NET}/pools/${pool}/trades`, {}, TRADES)
  const c = coin.toLowerCase()
  return (d.data ?? []).map(t => {
    const a = t.attributes
    const bought = (a.to_token_address ?? '').toLowerCase() === c
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
export const RH_RESOLUTIONS = Object.keys(RES) as ChartResolution[]

/** A pool's candles in the coin's own price (USD), oldest first. */
export async function getRhCandles(pool: string, coin: string, res: ChartResolution, limit = 300): Promise<Candle[]> {
  const r = RES[res]
  if (!r) return []
  const d = await gtDirect<{ data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } }>(
    `/networks/${NET}/pools/${pool}/ohlcv/${r.timeframe}`,
    { aggregate: String(r.aggregate), limit: String(limit), currency: 'usd', token: coin.toLowerCase() },
    CANDLES,
  )
  return (d.data?.attributes?.ohlcv_list ?? [])
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

/** The chart's source for a coin's pool (refreshed every 30s: GeckoTerminal's
 * free rate is shared with the trades list). With the pool's swaps read from the
 * chain (`fromChain`, api/rhSwaps.ts) it also has 15s, as fomo does: drawn from
 * those swaps alone (GeckoTerminal has nothing under a minute). */
export function rhChartSource(pool: string, coin: string, fromChain = false): ChartSource {
  return { id: `rh:${pool}:${coin.toLowerCase()}`, load: res => getRhCandles(pool, coin, res), refreshMs: 30_000, resolutions: fromChain ? ['15s', ...RH_RESOLUTIONS] : RH_RESOLUTIONS }
}
