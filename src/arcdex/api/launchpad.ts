// ── ArcLaunchpad client ───────────────────────────────────────────────
// Reads/writes for the on-chain bonding-curve launchpad. Unlike
// dexscreener.ts/gecko.ts, curve tokens aren't indexed by any third-party
// aggregator (they're not real Uniswap pools), so every read here goes
// straight to Arc mainnet via viem — first-party, no proxy needed.

import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { arc } from '../wagmi'

export const LAUNCHPAD_ADDRESS = (import.meta.env.VITE_ARC_LAUNCHPAD_ADDRESS ?? '') as Address

// Set once the platform launches its own token through the launchpad, so
// the burn ticker knows which token's burn balance to show. There's no
// on-chain registry for this — buyback-and-burn is a manual, off-contract
// process (the owner trades like anyone else, then calls burn()).
export const PLATFORM_TOKEN_ADDRESS = (import.meta.env.VITE_ARC_PLATFORM_TOKEN_ADDRESS ?? '') as Address

export const LAUNCHPAD_ABI = parseAbi([
  'function createToken(string name, string symbol, string metadataURI, uint256 creatorTaxBps, uint256 initialBuyUsdc) returns (address)',
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut)',
  'function curves(address token) view returns (address creator, uint96 creatorTaxBps, uint64 launchedAt, uint256 vUsdc, uint256 vToken, uint256 rUsdc, uint256 rToken, bool graduated)',
  'function tokenCount() view returns (uint256)',
  'function getTokens(uint256 offset, uint256 limit) view returns (address[])',
  'function currentPrice(address token) view returns (uint256)',
  'function bondingProgressBps(address token) view returns (uint256)',
  'function remainingBlockCapacityUsdc(address token) view returns (uint256)',
  'function platformFeeWallet() view returns (address)',
  'function setPlatformFeeWallet(address newWallet)',
  'function PLATFORM_CREATION_SHARE_BPS() view returns (uint256)',
  'function PLATFORM_SWAP_FEE_BPS() view returns (uint256)',
  'function MAX_CREATOR_TAX_BPS() view returns (uint256)',
  'function CREATOR_TAX_CREATOR_SHARE_BPS() view returns (uint256)',
  'function GRADUATION_THRESHOLD_USDC() view returns (uint256)',
  'function SNIPE_WINDOW_SECONDS() view returns (uint256)',
  'function SNIPE_MAX_BUY_USDC() view returns (uint256)',
  'function MAX_USDC_PER_BLOCK() view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 creatorTaxBps)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 totalFee, uint256 rUsdcAfter, uint256 rTokenAfter)',
  'event Graduated(address indexed token, uint256 rUsdcAtGraduation)',
])

const ERC20_META_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

export const client = createPublicClient({ chain: arc, transport: http(arc.rpcUrls.default.http[0]) })

export interface CurveState {
  creator: Address
  creatorTaxBps: number   // fixed for the token's lifetime, 0-300 (0-3%)
  launchedAt: number      // unix seconds
  vUsdc: bigint
  vToken: bigint
  rUsdc: bigint
  rToken: bigint
  graduated: boolean
}

export interface LaunchpadToken {
  address: Address
  name: string
  symbol: string
  curve: CurveState
  priceUsd: number
  bondingProgress: number // 0-100
}

const GRADUATION_THRESHOLD_USDC = 25_000_000_000n

function isConfigured() { return LAUNCHPAD_ADDRESS.length === 42 }

export async function getCurve(token: Address): Promise<CurveState | null> {
  if (!isConfigured()) return null
  const [creator, creatorTaxBps, launchedAt, vUsdc, vToken, rUsdc, rToken, graduated] = await client.readContract({
    address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'curves', args: [token],
  })
  if (creator === '0x0000000000000000000000000000000000000000') return null
  return { creator, creatorTaxBps: Number(creatorTaxBps), launchedAt: Number(launchedAt), vUsdc, vToken, rUsdc, rToken, graduated }
}

export function priceFromCurve(c: CurveState): number {
  // vUsdc is 6dp, vToken is 18dp → price per whole token in USD
  return Number(c.vUsdc) / 1e6 / (Number(c.vToken) / 1e18)
}

export function bondingProgressFromCurve(c: CurveState): number {
  if (c.graduated) return 100
  return Math.min(100, (Number(c.rUsdc) / Number(GRADUATION_THRESHOLD_USDC)) * 100)
}

export async function getAllLaunchpadTokens(): Promise<LaunchpadToken[]> {
  if (!isConfigured()) return []
  const total = await client.readContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'tokenCount' })
  if (total === 0n) return []
  const addrs = await client.readContract({
    address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'getTokens', args: [0n, total],
  })

  const results = await Promise.all(addrs.map(async (addr): Promise<LaunchpadToken | null> => {
    try {
      const [curve, name, symbol] = await Promise.all([
        getCurve(addr),
        client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'name' }),
        client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'symbol' }),
      ])
      if (!curve) return null
      return { address: addr, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve) }
    } catch { return null }
  }))
  return results.filter((t): t is LaunchpadToken => t !== null)
}

export async function getLaunchpadToken(address: Address): Promise<LaunchpadToken | null> {
  const curve = await getCurve(address)
  if (!curve) return null
  const [name, symbol] = await Promise.all([
    client.readContract({ address, abi: ERC20_META_ABI, functionName: 'name' }),
    client.readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' }),
  ])
  return { address, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve) }
}

export interface CurveTrade {
  trader: Address
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  blockNumber: bigint
  txHash: `0x${string}`
}

/** Recent trades for a token, read directly from chain logs — no indexer. */
export async function getRecentTrades(token: Address, fromBlock?: bigint): Promise<CurveTrade[]> {
  if (!isConfigured()) return []
  const latest = await client.getBlockNumber()
  const logs = await client.getLogs({
    address: LAUNCHPAD_ADDRESS,
    event: LAUNCHPAD_ABI.find(e => e.type === 'event' && e.name === 'Trade')!,
    args: { token },
    fromBlock: fromBlock ?? (latest > 50_000n ? latest - 50_000n : 0n),
    toBlock: latest,
  })
  return logs.map(l => ({
    trader: l.args.trader as Address,
    isBuy: l.args.isBuy as boolean,
    usdcAmount: l.args.usdcAmount as bigint,
    tokenAmount: l.args.tokenAmount as bigint,
    blockNumber: l.blockNumber,
    txHash: l.transactionHash,
  })).reverse()
}

export interface CurveCandle { time: number; open: number; high: number; low: number; close: number; volume: number }

const RESOLUTION_SECONDS: Record<'1m' | '5m' | '15m' | '1h' | '4h' | '1d', number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
}

/** Builds real OHLC candles from on-chain Trade events — no indexer, no
 * third party. Each trade's own execution price (usdcAmount/tokenAmount)
 * is a data point; block timestamps are fetched once per unique block
 * and cached across calls since a mined block's timestamp never changes. */
const blockTimeCache = new Map<bigint, number>()

export async function getCurveOhlcv(token: Address, resolution: keyof typeof RESOLUTION_SECONDS): Promise<CurveCandle[]> {
  const trades = await getRecentTrades(token)
  if (trades.length === 0) return []

  const uniqueBlocks = [...new Set(trades.map(t => t.blockNumber))].filter(b => !blockTimeCache.has(b))
  if (uniqueBlocks.length > 0) {
    const blocks = await Promise.all(uniqueBlocks.map(b => client.getBlock({ blockNumber: b })))
    blocks.forEach((blk, i) => blockTimeCache.set(uniqueBlocks[i], Number(blk.timestamp)))
  }

  const bucketSec = RESOLUTION_SECONDS[resolution]
  const points = trades
    .map(t => ({
      time: blockTimeCache.get(t.blockNumber)!,
      price: Number(t.usdcAmount) / 1e6 / (Number(t.tokenAmount) / 1e18),
      volume: Number(t.usdcAmount) / 1e6,
    }))
    .sort((a, b) => a.time - b.time)

  const buckets = new Map<number, CurveCandle>()
  for (const p of points) {
    const bucketTime = Math.floor(p.time / bucketSec) * bucketSec
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { time: bucketTime, open: p.price, high: p.price, low: p.price, close: p.price, volume: p.volume })
    } else {
      existing.high = Math.max(existing.high, p.price)
      existing.low = Math.min(existing.low, p.price)
      existing.close = p.price
      existing.volume += p.volume
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

export interface PlatformTokenStats {
  address: Address
  symbol: string
  burned: number       // whole tokens sent to BURN_ADDRESS
  burnedPct: number     // % of total supply burned
}

/** Real, on-chain burn stats for the ticker bar — reads the platform token
 * set via VITE_ARC_PLATFORM_TOKEN_ADDRESS. Buyback itself is manual and
 * off-contract (the owner trades like anyone else, then calls burn()), so
 * there's no on-chain treasury or registry to read beyond the burn
 * balance, which is exactly what the ticker wants to show anyway. */
export async function getPlatformTokenStats(): Promise<PlatformTokenStats | null> {
  if (PLATFORM_TOKEN_ADDRESS.length !== 42) return null

  const [symbol, burnedRaw, totalSupply] = await Promise.all([
    client.readContract({ address: PLATFORM_TOKEN_ADDRESS, abi: ERC20_META_ABI, functionName: 'symbol' }),
    client.readContract({ address: PLATFORM_TOKEN_ADDRESS, abi: ERC20_META_ABI, functionName: 'balanceOf', args: [BURN_ADDRESS] }),
    client.readContract({ address: PLATFORM_TOKEN_ADDRESS, abi: ERC20_META_ABI, functionName: 'totalSupply' }),
  ])

  return {
    address: PLATFORM_TOKEN_ADDRESS,
    symbol,
    burned: Number(burnedRaw) / 1e18,
    burnedPct: totalSupply > 0n ? (Number(burnedRaw) / Number(totalSupply)) * 100 : 0,
  }
}

/** % of a token's fixed supply still held by its creator — a common
 * rug-risk signal ("DEV" badge): high = creator hasn't sold, low/zero =
 * creator has cashed out (or never held any beyond fees). */
export async function getDevHoldingPct(token: Address, creator: Address): Promise<number> {
  const [bal, supply] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'balanceOf', args: [creator] }),
    client.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'totalSupply' }),
  ])
  return supply > 0n ? (Number(bal) / Number(supply)) * 100 : 0
}
