// Robinhood Chain's market list, shared by the browser (src/arcdex/api/robinhoodMarket.ts) and the
// engine (api/rhmarket.ts, served at /api/rhmarket): GeckoTerminal's pools as one row per coin, its
// launchpads, trap pools and wash pools. No browser or chain libraries here, so the engine's image can
// import it.

export const RH_NET = 'robinhood'
export const RH_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
/** Paxos's Global Dollar, Robinhood Chain's dollar (6 decimals). */
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
export const NATIVE = '0x0000000000000000000000000000000000000000'
/** Quotes, never listed as coins of their own. */
export const RH_QUOTES = new Set([USDG, WETH, NATIVE])
export const QUOTE_SYMBOLS: Record<string, string> = { [USDG]: 'USDG', [WETH]: 'WETH', [NATIVE]: 'ETH' }

/** Robinhood's stock tokens name themselves "<Company> • Robinhood Token"
 * ("NVIDIA • Robinhood Token"). */
export const isStockName = (name: string | null | undefined) => /•\s*Robinhood Token/i.test(name ?? '')

/** Every stock token is a beacon proxy on Robinhood's one beacon (EIP-1967's beacon slot). */
export const STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00'
export const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

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
  /** Pons coins (rhmarket.ts `ponsCurves`): 0–100 of the way to graduating, as Pons counts it (ETH raised over its
   * 4.2 ETH threshold), and whether it has. Absent until the chain has answered; other launchpads have no curve. */
  curveProgress?: number | null
  graduated?: boolean
}

// ── GeckoTerminal's shapes ───────────────────────────────────────────────

export interface GtRef { data?: { id: string } | null }
export interface GtTx { buys?: number; sells?: number; buyers?: number; sellers?: number }
export interface GtPool {
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
export interface GtToken { id: string; type: string; attributes: { address: string; name: string; symbol: string; decimals?: number | null; image_url?: string | null } }
export interface GtPools { data?: GtPool[]; included?: GtToken[] }

export const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
export const idAddr = (id: string | undefined) => (id ?? '').replace(/^[a-z0-9_-]+?_(?=0x)/i, '').toLowerCase()
export const isImage = (u: string | null | undefined) => (u && /^https:\/\//.test(u) && !/missing/.test(u) ? u : null)
/** GeckoTerminal sends some names HTML-escaped ("SPDR S&amp;P 500"). */
export const unescape = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

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

export function parsePools(d: GtPools): RhCoin[] {
  const tokens = new Map((d.included ?? []).filter(i => i.type === 'token').map(i => [i.attributes.address.toLowerCase(), i.attributes]))
  return (d.data ?? []).map(p => poolToCoin(p, tokens)).filter((c): c is RhCoin => c !== null)
}

export const INCLUDE = { include: 'base_token,quote_token,dex' }

// ── what's listed: launchpad coins, and Robinhood's stock tokens ────────

/** Whether a coin is listed: from a launchpad, or one of Robinhood's stock tokens. `stockOk` is the
 * chain's answer for a stock-named coin (undefined until asked: it counts until the chain says no). */
export function isListed(c: RhCoin, stockOk: (address: string) => boolean | undefined): boolean {
  if (c.launchpad) return true
  return c.stock && stockOk(c.address) !== false
}

/** The coins to show: listed ones, impostor stock names marked as not stocks. */
export function listed(rows: RhCoin[], stockOk: (address: string) => boolean | undefined): RhCoin[] {
  return rows.filter(c => isListed(c, stockOk)).map(c => (c.stock && stockOk(c.address) === false ? { ...c, stock: false } : c))
}

// ── what a build reads ───────────────────────────────────────────────────

/** Every call a full list reads, in order: the busiest pools and the stock tokens first, then each
 * launchpad's busiest pools (a coin is listed once one of its pools is a launchpad's), then the next
 * page of the busiest, the newest pools and the second page of stock tokens. */
export function rhListPaths(): string[] {
  const q = (params: Record<string, string>) => new URLSearchParams({ ...INCLUDE, ...params }).toString()
  const busiest = (page: string) => `/networks/${RH_NET}/pools?${q({ page, sort: 'h24_volume_usd_desc' })}`
  // Robinhood's stock tokens all carry "• Robinhood Token" in their name.
  const stocks = (page: string) => `/search/pools?${q({ network: RH_NET, query: 'Robinhood Token', page })}`
  const dexes = [...new Set(Object.keys(RH_LAUNCHPADS))]
  return [
    busiest('1'), stocks('1'),
    ...dexes.map(d => `/networks/${RH_NET}/dexes/${d}/pools?${q({ sort: 'h24_volume_usd_desc' })}`),
    busiest('2'), `/networks/${RH_NET}/new_pools?${q({})}`, stocks('2'),
  ]
}
