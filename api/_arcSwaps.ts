// Arc DEX swap decoding, shared by the browser (src/arcdex/api/poolSwaps.ts)
// and the market engine (engine/). No dependencies, so it stays tiny in the
// browser bundle. (The leading underscore keeps Vercel from deploying this
// file as its own function.)
//
// ── Blockchain specifics (Arc mainnet, chain 5042) ────────────────────────
// Uniswap v4: every pool lives in the one PoolManager. Its events carry the
//   PoolId (keccak of the PoolKey) as topic1:
//     Swap(PoolId indexed id, address indexed sender, int128 amount0,
//          int128 amount1, uint160 sqrtPriceX96, uint128 liquidity,
//          int24 tick, uint24 fee)
//     Initialize(PoolId indexed id, Currency indexed currency0,
//          Currency indexed currency1, uint24 fee, int24 tickSpacing,
//          IHooks hooks, uint160 sqrtPriceX96, int24 tick)
//   Swap amounts are the SWAPPER's deltas: positive = the swapper received.
// Uniswap v3: each pool contract emits its own
//     Swap(address indexed sender, address indexed recipient, int256 amount0,
//          int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
//   Amounts are the POOL's deltas: positive = the pool received.
// Both put amount0, amount1, sqrtPriceX96, liquidity in data words 0-3.
// Currency address(0) in a v4 pool is Arc's native gas token — USDC, with
// 18 decimals at the native level (the ERC-20 at 0x3600… has 6).

export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
export const POSITION_MANAGER = '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b'
export const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918'
export const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
export const V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
export const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
export const ERC20_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export const NATIVE = '0x0000000000000000000000000000000000000000'
export const USDC = '0x3600000000000000000000000000000000000000'
export const ARGUS = '0xece5ca8bf9220718e5727754026757512212cb3c'
export const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'
export const WETH = '0x93ffd195481e8c08eb25a158689e4d9e61313111'
/** The deep ARGUS/USDC v3 pool — the reference price for ARGUS-quoted coins. */
export const ARGUS_USDC_V3 = '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02'

/** Which side of a pair is the quote (what the token is priced in), most
 * preferred first. Anything else paired with one of these is the base. */
export const QUOTE_PRIORITY = [USDC, NATIVE, EURC, WETH, ARGUS]

export interface SwapLogLike {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockTimestamp?: string
  transactionHash: string
  logIndex: string
  removed?: boolean
}

export const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64)
export const signedWord = (w: string) => BigInt.asIntN(256, BigInt('0x' + w))
export const topicAddress = (t: string) => ('0x' + t.slice(26)).toLowerCase()
const abs = (x: bigint) => (x < 0n ? -x : x)

export const isV4Pool = (pool: string) => pool.length === 66

/** Price of `base` in `quote` units from a sqrtPriceX96 (raw currency1 per
 * raw currency0, squared), scaled by the decimals difference. */
export function priceFromSqrt(sqrtPriceX96: bigint, baseIs0: boolean, baseDecimals: number, quoteDecimals: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96
  const raw1per0 = s * s
  const scale = 10 ** (baseDecimals - quoteDecimals)
  return baseIs0 ? raw1per0 * scale : raw1per0 > 0 ? scale / raw1per0 : 0
}

export interface DecodedSwap {
  side: 'BUY' | 'SELL'
  /** Base token amount, whole units. */
  baseAmount: number
  /** Quote amount, whole units. */
  quoteAmount: number
  /** Pool price after the swap, quote per base. */
  price: number
  /** Raw in-range liquidity after the swap. */
  liquidity: bigint
  sqrtPriceX96: bigint
}

/** Decodes a v4 PoolManager or v3 pool Swap log for a known pair. Returns
 * null for logs that don't validate (wrong shape, removed, zero base leg). */
export function decodeSwapLog(
  l: SwapLogLike,
  pair: { v4: boolean; baseIs0: boolean; baseDecimals: number; quoteDecimals: number },
): DecodedSwap | null {
  if (l.removed || !l.data || l.data.length < 2 + 64 * 4) return null
  const a0 = signedWord(word(l.data, 0))
  const a1 = signedWord(word(l.data, 1))
  const baseLeg = pair.baseIs0 ? a0 : a1
  const quoteLeg = pair.baseIs0 ? a1 : a0
  if (baseLeg === 0n) return null
  // v4: swapper-oriented (base received = BUY). v3: pool-oriented (base
  // paid out by the pool = BUY). Determined from the actual deltas, not
  // from the price move.
  const buy = pair.v4 ? baseLeg > 0n : baseLeg < 0n
  const sqrtPriceX96 = BigInt('0x' + word(l.data, 2))
  return {
    side: buy ? 'BUY' : 'SELL',
    baseAmount: Number(abs(baseLeg)) / 10 ** pair.baseDecimals,
    quoteAmount: Number(abs(quoteLeg)) / 10 ** pair.quoteDecimals,
    price: priceFromSqrt(sqrtPriceX96, pair.baseIs0, pair.baseDecimals, pair.quoteDecimals),
    liquidity: BigInt('0x' + word(l.data, 3)),
    sqrtPriceX96,
  }
}

/** Approximate USD depth of a pool from its in-range liquidity L and price:
 * virtual reserves are L·√P (currency1) and L/√P (currency0). Exact for
 * full-range positions (most Argus launches); for concentrated liquidity
 * it's the depth of the active range. Returns 2 × the quote side in USD. */
export function liquidityUsd(liquidity: bigint, sqrtPriceX96: bigint, quoteIs0: boolean, quoteDecimals: number, quoteUsd: number): number | null {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return null
  const s = Number(sqrtPriceX96) / 2 ** 96
  const L = Number(liquidity)
  const quoteRaw = quoteIs0 ? L / s : L * s
  const v = (2 * quoteRaw / 10 ** quoteDecimals) * quoteUsd
  return Number.isFinite(v) && v >= 0 ? v : null
}
