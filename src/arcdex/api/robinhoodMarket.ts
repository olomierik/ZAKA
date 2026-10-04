// Robinhood Chain's market, from GeckoTerminal (network `robinhood`): its
// coins and Robinhood's stock tokens, their prices, trades and candles.
//
// Called directly from the visitor's browser (gtDirect, paced to
// GeckoTerminal's free rate) — never through the app's proxy, whose shared
// quota is Arc's. The list is kept in this browser for 30 minutes, so a
// returning visitor sees it at once while it refreshes.

import { gtDirect } from './gtClient'
import type { Candle } from '../lib/candles'
import type { ChartResolution, ChartSource } from '../components/PriceChart'
import type { TradeRow } from '../components/TokenSocialTabs'
import { isStockName, isStockToken, QUOTE_SYMBOLS, RH_QUOTES } from '../lib/robinhood'

const NET = 'robinhood'
/** The coin page's calls go before any market list's (gtClient's pacing). */
const URGENT = { urgent: true }

/** Robinhood Chain's launchpads, by GeckoTerminal dex id (its venues checked 2026-10-04). Only their
 * coins, and Robinhood's own stock tokens, are listed and can be bought (owner, 2026-10-04: no coins
 * from unknown contracts). Plain DEXes (Uniswap, PancakeSwap, Up V3, Ramses, …) don't count: a coin
 * whose only pools are there came from no launchpad. Pons lists its curve (pons-v2, pons-dot-family)
 * and the DEX its coins graduate to (pons-v2-dex). */
export const RH_LAUNCHPADS: Record<string, string> = {
  'bankr-robinhood': 'Bankr',
  'clanker-robinhood': 'Clanker',
  'clank-trade': 'Clank.trade',
  'virtuals-robinhood': 'Virtuals',
  'pons-dot-family': 'Pons',
  'pons-v2': 'Pons',
  'pons-v2-dex': 'Pons',
  'easya-kickstart-robinhood': 'EasyA Kickstart',
  'mint-club-robinhood': 'Mint Club',
  'o1-launchpad-robinhood': 'o1',
  'frontier-fun': 'Frontier.fun',
  'hoodit': 'Hoodit',
}

export interface RhCoin {
  /** Lower case. */
  address: string
  symbol: string
  name: string
  image: string | null
  decimals: number | null
  /** One of Robinhood's stock tokens (by name here; trading checks the chain). */
  stock: boolean
  /** Its main pool: GeckoTerminal's pool id (a v4 pool's is 32 bytes). */
  pool: string
  dex: string
  quote: string
  quoteSymbol: string
  priceUsd: number
  change5m: number
  change1h: number
  change24h: number
  /** Summed over its pools in the list. */
  volume24h: number
  liquidity: number
  marketCap: number
  buys24h: number
  sells24h: number
  /** Unique wallets buying and selling in 24h, in its main pool. */
  traders24h: number
  /** When its first listed pool opened (ms). */
  createdAt: number
  /** Its pool's fee tier from the pool's name ("SHRINU / USDG 20%" → 20), else null. */
  feePct: number | null
  /** A pool priced far from the coin's market, or with a trap's fee tier: never its main pool, never traded. */
  offMarket?: boolean
  /** The launchpad it came from (one of its pools is on a launchpad's venue), else null. */
  launchpad: string | null
}

// ── GeckoTerminal's shapes ───────────────────────────────────────────────

interface GtRef { data?: { id: string } | null }
interface GtTx { buys?: number; sells?: number; buyers?: number; sellers?: number }
interface GtPool {
  id: string
  attributes: {
    address: string
    name: string
    pool_created_at?: string | null
    base_token_price_usd?: string | null
    quote_token_price_usd?: string | null
    fdv_usd?: string | null
    market_cap_usd?: string | null
    reserve_in_usd?: string | null
    price_change_percentage?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', string | null>>
    transactions?: Partial<Record<'m5' | 'h1' | 'h24', GtTx>>
    volume_usd?: Partial<Record<'m5' | 'h1' | 'h24', string | null>>
  }
  relationships?: { base_token?: GtRef; quote_token?: GtRef; dex?: GtRef }
}
interface GtToken { id: string; type: string; attributes: { address: string; name: string; symbol: string; decimals?: number | null; image_url?: string | null } }
interface GtPools { data?: GtPool[]; included?: GtToken[] }

const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const idAddr = (id: string | undefined) => (id ?? '').replace(/^[a-z0-9_-]+?_(?=0x)/i, '').toLowerCase()
const isImage = (u: string | null | undefined) => (u && /^https:\/\//.test(u) && !/missing/.test(u) ? u : null)
/** GeckoTerminal sends some names HTML-escaped ("SPDR S&amp;P 500"). */
const unescape = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/** One pool as a row for its base token, or null when the base is a quote (USDG/WETH/ETH). */
export function poolToCoin(p: GtPool, tokens: Map<string, GtToken['attributes']>): RhCoin | null {
  const a = p.attributes
  const base = idAddr(p.relationships?.base_token?.data?.id)
  const quote = idAddr(p.relationships?.quote_token?.data?.id)
  if (!/^0x[0-9a-f]{40}$/.test(base) || RH_QUOTES.has(base)) return null
  const t = tokens.get(base)
  const q = tokens.get(quote)
  const [poolBase = '', poolQuote = ''] = a.name.split(' / ')
  const symbol = unescape(t?.symbol || poolBase.trim() || '?')
  const name = unescape(t?.name || symbol)
  const tx = a.transactions?.h24 ?? {}
  return {
    address: base,
    symbol,
    name,
    image: isImage(t?.image_url),
    decimals: typeof t?.decimals === 'number' ? t.decimals : null,
    stock: isStockName(name),
    pool: a.address.toLowerCase(),
    dex: p.relationships?.dex?.data?.id ?? '',
    quote,
    quoteSymbol: QUOTE_SYMBOLS[quote] ?? q?.symbol ?? poolQuote.split(' ')[0] ?? '',
    priceUsd: num(a.base_token_price_usd),
    change5m: num(a.price_change_percentage?.m5),
    change1h: num(a.price_change_percentage?.h1),
    change24h: num(a.price_change_percentage?.h24),
    volume24h: num(a.volume_usd?.h24),
    liquidity: num(a.reserve_in_usd),
    // GeckoTerminal leaves a pool's market cap empty when it can't verify the
    // circulating supply; the fully diluted value stands in, as on its own pages.
    marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
    buys24h: tx.buys ?? 0,
    sells24h: tx.sells ?? 0,
    traders24h: (tx.buyers ?? 0) + (tx.sellers ?? 0),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || 0 : 0,
    feePct: poolFeePct(a.name),
    launchpad: RH_LAUNCHPADS[p.relationships?.dex?.data?.id ?? ''] ?? null,
  }
}

/** A pool's fee tier from its GeckoTerminal name ("SHRINU / USDG 20%" → 20), else null. */
export function poolFeePct(name: string): number | null {
  const m = / (\d+(?:\.\d+)?)%\s*$/.exec(name)
  return m ? Number(m[1]) : null
}

/** Pools charging this much a swap are traps, not markets. Seen on Robinhood
 * Chain: SHRINU / USDG at 20% and 55%, priced ~300× under its real pool, with
 * $800K of "liquidity" and a few dollars of trades. Real pools charge 0.01–3%. */
export const TRAP_FEE_PCT = 10
/** A pool more than 1.5× off the coin's main pool, either way, is off the market. */
const OFF_MARKET = 1.5

const trapFee = (r: RhCoin) => r.feePct !== null && r.feePct >= TRAP_FEE_PCT

/** A coin's pools, the best market first: pools without a trap's fee, then by
 * the wallets trading them, their volume, a USDG/WETH/ETH quote, and depth.
 * Depth comes last: a trap pool can show more "liquidity" than the real one. */
export function rankPools(list: RhCoin[]): RhCoin[] {
  return list.slice().sort((a, b) =>
    (Number(trapFee(a)) - Number(trapFee(b)))
    || (b.traders24h - a.traders24h)
    || (b.volume24h - a.volume24h)
    || (Number(RH_QUOTES.has(b.quote)) - Number(RH_QUOTES.has(a.quote)))
    || (b.liquidity - a.liquidity))
}

/** Ranks a coin's pools and marks those off the market: a trap's fee, or a
 * price more than 1.5× away from the best pool's. */
export function markPools(list: RhCoin[]): RhCoin[] {
  const ranked = rankPools(list)
  const ref = ranked[0]?.priceUsd ?? 0
  return ranked.map((r, i) => ({
    ...r,
    offMarket: i > 0 && (trapFee(r) || (ref > 0 && r.priceUsd > 0 && Math.max(r.priceUsd / ref, ref / r.priceUsd) > OFF_MARKET)),
  }))
}

/** A pool whose big day is one or two wallets trading with themselves (seen
 * on Robinhood Chain: $68M of "volume" from 1 buyer and 1 seller). A quiet
 * pool isn't wash, and young pools get a pass: their first trades come from
 * few wallets. */
export function isWashPool(c: RhCoin, now = Date.now()): boolean {
  const young = c.createdAt > 0 && now - c.createdAt < 2 * 3600_000
  return !young && c.traders24h < 4 && c.volume24h > 10_000
}

/** One row per coin: its main pool is its best market (`rankPools`), and its
 * volume and trades are the sum of its pools, off-market pools left out. */
export function mergeCoins(rows: RhCoin[]): RhCoin[] {
  const by = new Map<string, RhCoin[]>()
  for (const r of rows) {
    const list = by.get(r.address)
    if (!list) by.set(r.address, [r])
    else if (!list.some(x => x.pool === r.pool)) list.push(r)
  }
  const out: RhCoin[] = []
  for (const list of by.values()) {
    const marked = markPools(list)
    const pick = marked[0]
    const real = marked.filter(r => !r.offMarket)
    const first = Math.min(...list.map(r => r.createdAt || Infinity))
    out.push({
      ...pick,
      launchpad: (real.find(r => r.launchpad) ?? list.find(r => r.launchpad))?.launchpad ?? null,
      image: pick.image ?? list.find(r => r.image)?.image ?? null,
      volume24h: real.reduce((s, r) => s + r.volume24h, 0),
      buys24h: real.reduce((s, r) => s + r.buys24h, 0),
      sells24h: real.reduce((s, r) => s + r.sells24h, 0),
      createdAt: Number.isFinite(first) ? first : 0,
    })
  }
  return out
}

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
export function isListedRh(c: RhCoin): boolean {
  if (c.launchpad) return true
  return c.stock && stockCheck.get(c.address) !== false
}

/** The coins to show: listed ones, impostor stock names marked as not stocks. */
export function listedRh(rows: RhCoin[]): RhCoin[] {
  return rows.filter(isListedRh).map(c => (c.stock && stockCheck.get(c.address) === false ? { ...c, stock: false } : c))
}

function parsePools(d: GtPools): RhCoin[] {
  const tokens = new Map((d.included ?? []).filter(i => i.type === 'token').map(i => [i.attributes.address.toLowerCase(), i.attributes]))
  return (d.data ?? []).map(p => poolToCoin(p, tokens)).filter((c): c is RhCoin => c !== null)
}

const INCLUDE = { include: 'base_token,quote_token,dex' }

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

/** Robinhood Chain's listed coins: launchpad coins (each launchpad's busiest pools, the busiest
 * pools of the day and the newest) and Robinhood's stock tokens, one row per coin. `onRows` gets the
 * list as each call lands (the first within a second or two). Rebuilt at most every 90s however many
 * pages ask. */
export function loadRhMarket(onRows?: (rows: RhCoin[]) => void): Promise<RhCoin[]> {
  if (built.length && Date.now() - builtAt < FRESH_MS) { onRows?.(built); return Promise.resolve(built) }
  // Every caller gets the rows as each call lands, not only the one that started the build: a page
  // that asks while a build runs (two pages, or React running an effect twice) used to wait for the
  // whole build, a minute when GeckoTerminal throttles.
  if (onRows) { listeners.add(onRows); if (latest.length) onRows(latest) }
  if (building) return building
  const raw: RhCoin[] = []
  const tell = (rows: RhCoin[]) => { latest = rows; listeners.forEach(l => l(rows)) }
  const emit = () => {
    const merged = mergeCoins(raw)
    checkStocks(merged, () => { tell(listedRh(mergeCoins(raw))) })
    const rows = listedRh(merged)
    tell(rows)
    return rows
  }
  const step = (path: string, params: Record<string, string> = {}) =>
    gtDirect<GtPools>(path, { ...INCLUDE, ...params }).then(d => { raw.push(...parsePools(d)); emit() }).catch(() => {})
  building = (async () => {
    const busiest = (page: string) => step(`/networks/${NET}/pools`, { page, sort: 'h24_volume_usd_desc' })
    // Robinhood's stock tokens all carry "• Robinhood Token" in their name.
    const stocks = (page: string) => step('/search/pools', { network: NET, query: 'Robinhood Token', page })
    // Each launchpad's busiest pools: a coin is listed once one of its pools is a launchpad's.
    const launchpad = (dex: string) => step(`/networks/${NET}/dexes/${dex}/pools`, { sort: 'h24_volume_usd_desc' })
    const dexes = [...new Set(Object.keys(RH_LAUNCHPADS))]
    await busiest('1'); await stocks('1')
    for (const d of dexes) await launchpad(d)
    await busiest('2'); await step(`/networks/${NET}/new_pools`); await stocks('2')
    const rows = listedRh(mergeCoins(raw))
    if (rows.length) { built = rows; builtAt = Date.now(); writeCache(rows) }
    return rows.length ? rows : built
  })().finally(() => { building = null; listeners.clear(); latest = [] })
  return building
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
  const d = await gtDirect<GtTokenDetail>(`/networks/${NET}/tokens/${address.toLowerCase()}`, { include: 'top_pools' }, URGENT)
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
  const d = await gtDirect<{ data?: GtTrade[] }>(`/networks/${NET}/pools/${pool}/trades`, {}, URGENT)
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
    URGENT,
  )
  return (d.data?.attributes?.ohlcv_list ?? [])
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

/** The chart's source for a coin's pool (refreshed every 30s: GeckoTerminal's
 * free rate is shared with the trades list). */
export function rhChartSource(pool: string, coin: string): ChartSource {
  return { id: `rh:${pool}:${coin.toLowerCase()}`, load: res => getRhCandles(pool, coin, res), refreshMs: 30_000, resolutions: RH_RESOLUTIONS }
}
