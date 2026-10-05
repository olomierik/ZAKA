// BNB Chain's market list (2026-10-05, owner: "go for BNB Chain"), shared by the browser (src/arcdex/api/bscMarket.ts)
// and the engine (api/bscmarket.ts, served at /api/bscmarket): GeckoTerminal's pools as one row per coin, four.meme
// (BNB Chain's launchpad), and what four.meme's own contract says about each coin. Uses viem only (no browser code), so
// the engine's image can import it.
//
// four.meme: its coins' addresses end in 4444 (or ffff). While on its curve, GeckoTerminal's "pool" for it is the coin itself
// (the curve lives in four.meme's TokenManager2); at 800M tokens sold (24 BNB, or 12,000 USDT, raised) it graduates to
// PancakeSwap. Its helper contract, TokenManagerHelper3, answers getTokenInfo(token) for any token: version 0 for one
// four.meme didn't launch, else the quote (BNB or USDT), tokens left for sale, the target and whether it graduated
// (checked on mainnet 2026-10-05). So a coin is listed only once four.meme's contract vouches for it.

import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { bsc } from 'viem/chains'
import { idAddr, isImage, markPools, num, poolFeePct, unescape, isWashPool, type GtPool, type GtPools, type GtToken, type RhCoin } from './_rhCore'

export const BSC_NET = 'bsc'
/** Browsers: publicnode answers them (CORS). */
export const BSC_RPC_BROWSER = 'https://bsc-rpc.publicnode.com'
/** Servers: BNB Chain's own RPC first, publicnode after. */
export const BSC_RPC_SERVER = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com']

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
/** PancakeSwap v2's WBNB/USDT pair (token0 USDT, token1 WBNB): BNB's dollar price, read from the chain. */
export const PANCAKE_WBNB_USDT = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae'
export const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955'
export const BSC_USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
export const BUSD = '0xe9e7cea3dedca5984780bafc599bd69add087d56'
export const FDUSD = '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409'
export const BSC_USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d'
export const BNB_NATIVE = '0x0000000000000000000000000000000000000000'
/** Quotes, never listed as coins of their own. */
export const BSC_QUOTES = new Set([WBNB, BSC_USDT, BSC_USDC, BUSD, FDUSD, BSC_USD1, BNB_NATIVE])
export const BSC_QUOTE_SYMBOLS: Record<string, string> = { [WBNB]: 'BNB', [BNB_NATIVE]: 'BNB', [BSC_USDT]: 'USDT', [BSC_USDC]: 'USDC', [BUSD]: 'BUSD', [FDUSD]: 'FDUSD', [BSC_USD1]: 'USD1' }

/** four.meme's contracts on BNB Chain (its integration docs; checked 2026-10-05). */
export const FOUR = {
  manager: '0x5c952063c7fc8610ffdb798152d69f0b9550762b',
  helper: '0xf251f83e40a78868fcfa3fa4599dad6494e46034',
} as const
const HELPER_ABI = parseAbi(['function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)'])

/** four.meme's venue on GeckoTerminal (its curve). Graduated coins trade on PancakeSwap. */
export const BSC_LAUNCHPADS: Record<string, string> = { 'four-meme': 'four.meme' }
/** four.meme's coin addresses end in 4444 (its standard coins) or ffff (seen on its curve venue, 2026-10-05); either
 * way its contract must still vouch for the coin. */
export const isFourAddress = (a: string) => /(4444|ffff)$/i.test(a)

/** A BNB Chain coin: the Robinhood row's shape, with four.meme's own word on it. */
export interface BscCoin extends RhCoin {
  /** four.meme's getTokenInfo, once read: its quote (BNB or USDT), whether it graduated, tokens sold (0–100). */
  four?: FourInfo
}
export interface FourInfo { quote: string; graduated: boolean; progress: number }

// ── GeckoTerminal's pools as rows ───────────────────────────────────────

export function poolToBscCoin(p: GtPool, tokens: Map<string, GtToken['attributes']>): BscCoin | null {
  const a = p.attributes
  const base = idAddr(p.relationships?.base_token?.data?.id)
  const quote = idAddr(p.relationships?.quote_token?.data?.id)
  if (!/^0x[0-9a-f]{40}$/.test(base) || BSC_QUOTES.has(base)) return null
  const t = tokens.get(base)
  const q = tokens.get(quote)
  const [poolBase = '', poolQuote = ''] = a.name.split(' / ')
  const symbol = unescape(t?.symbol || poolBase.trim() || '?')
  const name = unescape(t?.name || symbol)
  const tx = a.transactions?.h24 ?? {}
  const dex = p.relationships?.dex?.data?.id ?? ''
  return {
    address: base, symbol, name,
    image: isImage(t?.image_url),
    decimals: typeof t?.decimals === 'number' ? t.decimals : null,
    stock: false,
    pool: a.address.toLowerCase(),
    dex, quote,
    quoteSymbol: BSC_QUOTE_SYMBOLS[quote] ?? q?.symbol ?? poolQuote.split(' ')[0] ?? '',
    priceUsd: num(a.base_token_price_usd),
    change5m: num(a.price_change_percentage?.m5),
    change1h: num(a.price_change_percentage?.h1),
    change24h: num(a.price_change_percentage?.h24),
    volume24h: num(a.volume_usd?.h24),
    liquidity: num(a.reserve_in_usd),
    marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
    buys24h: tx.buys ?? 0,
    sells24h: tx.sells ?? 0,
    traders24h: (tx.buyers ?? 0) + (tx.sellers ?? 0),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || 0 : 0,
    feePct: poolFeePct(a.name),
    // four.meme's venue, or a four.meme address on PancakeSwap (a graduate; four.meme's contract confirms it).
    launchpad: BSC_LAUNCHPADS[dex] ?? (isFourAddress(base) ? 'four.meme' : null),
  }
}

export function parseBscPools(d: GtPools): BscCoin[] {
  const tokens = new Map((d.included ?? []).filter(i => i.type === 'token').map(i => [i.attributes.address.toLowerCase(), i.attributes]))
  return (d.data ?? []).map(p => poolToBscCoin(p, tokens)).filter((c): c is BscCoin => c !== null)
}

/** One row per coin: its best pool leads, volume and trades summed over its pools. */
export function mergeBscCoins(rows: BscCoin[]): BscCoin[] {
  const by = new Map<string, BscCoin[]>()
  for (const r of rows) {
    const list = by.get(r.address)
    if (!list) by.set(r.address, [r])
    else if (!list.some(x => x.pool === r.pool)) list.push(r)
  }
  const out: BscCoin[] = []
  for (const list of by.values()) {
    const marked = markPools(list) as BscCoin[]
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

/** Launchpad coins only: four.meme's, and once its contract has answered, only those it vouches for. */
export const listedBsc = (rows: BscCoin[], vouched?: (a: string) => boolean | undefined): BscCoin[] =>
  rows.filter(c => c.launchpad && (vouched?.(c.address) ?? true))

export const isWashBsc = (c: BscCoin, now = Date.now()) => isWashPool(c, now) || (c.liquidity < 100 && c.volume24h > 50_000)

export const BSC_INCLUDE = { include: 'base_token,quote_token,dex' }

/** Every call a full list reads: four.meme's busiest curves, PancakeSwap's busiest pools (where four.meme's graduates
 * trade: only 4444 coins are kept), and the newest pools. */
export function bscListPaths(): string[] {
  const q = (params: Record<string, string>) => new URLSearchParams({ ...BSC_INCLUDE, ...params }).toString()
  const dex = (d: string, page = '1') => `/networks/${BSC_NET}/dexes/${d}/pools?${q({ sort: 'h24_volume_usd_desc', page })}`
  return [
    dex('four-meme'), dex('pancakeswap_v2'), dex('pancakeswap-v3-bsc'), dex('four-meme', '2'), dex('pancakeswap-infinity-clmm'),
    dex('pancakeswap_v2', '2'), dex('four-meme', '3'), dex('pancakeswap-v3-bsc', '2'), dex('pancakeswap_v2', '3'),
    `/networks/${BSC_NET}/new_pools?${q({})}`,
  ]
}

// ── four.meme's word ────────────────────────────────────────────────────

/** Tokens sold of the 800M for sale: four.meme's progress (as pump.fun counts it). */
export function fourProgress(offers: bigint, maxOffers: bigint): number {
  if (maxOffers <= 0n) return 0
  const sold = offers > maxOffers ? 0n : maxOffers - offers
  return Math.max(0, Math.min(100, Number((sold * 10_000n) / maxOffers) / 100))
}

/** four.meme's getTokenInfo for each token, 150 a multicall: null for one it didn't launch (version 0); tokens no RPC
 * answers for are left out, to be asked again. */
export async function readFour(tokens: string[], rpcs: string[]): Promise<Map<string, FourInfo | null>> {
  const out = new Map<string, FourInfo | null>()
  for (const url of rpcs) {
    const todo = tokens.filter(t => !out.has(t))
    if (!todo.length) break
    const client = createPublicClient({ chain: bsc, transport: http(url, { timeout: 12_000 }) })
    for (let i = 0; i < todo.length; i += 150) {
      const chunk = todo.slice(i, i + 150)
      try {
        const res = await client.multicall({ contracts: chunk.map(t => ({ address: FOUR.helper as Address, abi: HELPER_ABI, functionName: 'getTokenInfo' as const, args: [t as Address] as const })), allowFailure: true })
        res.forEach((r, n) => {
          if (r.status !== 'success') return
          const [version, , quote, , , , , offers, maxOffers, , , liquidityAdded] = r.result as readonly [bigint, string, string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean]
          out.set(chunk[n], version === 0n ? null : { quote: quote.toLowerCase(), graduated: liquidityAdded, progress: liquidityAdded ? 100 : fourProgress(offers, maxOffers) })
        })
      } catch { /* the next RPC tries what's left */ }
    }
  }
  return out
}
