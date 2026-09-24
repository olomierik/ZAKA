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
  metadata?: import('../lib/mediaUpload').TokenMetadata | null
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

/** Metadata (image/website/twitter/telegram) is off-chain — the contract
 * only ever emits a metadataURI once, at creation. Resolving it costs an
 * event-log query plus a JSON fetch, so this is optional per-call and
 * always cached after the first resolution. */
async function resolveMetadata(token: Address): Promise<import('../lib/mediaUpload').TokenMetadata | null> {
  const { fetchTokenMetadata } = await import('../lib/mediaUpload')
  const uri = await getTokenMetadataUri(token).catch(() => '')
  return uri ? fetchTokenMetadata(uri) : null
}

export async function getAllLaunchpadTokens(includeMetadata = true): Promise<LaunchpadToken[]> {
  if (!isConfigured()) return []
  const total = await client.readContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'tokenCount' })
  if (total === 0n) return []
  const addrs = await client.readContract({
    address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'getTokens', args: [0n, total],
  })

  const results = await Promise.all(addrs.map(async (addr): Promise<LaunchpadToken | null> => {
    try {
      const [curve, name, symbol, metadata] = await Promise.all([
        getCurve(addr),
        client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'name' }),
        client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'symbol' }),
        includeMetadata ? resolveMetadata(addr).catch(() => null) : Promise.resolve(undefined),
      ])
      if (!curve) return null
      return { address: addr, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve), metadata }
    } catch { return null }
  }))
  return results.filter((t): t is LaunchpadToken => t !== null)
}

export async function getLaunchpadToken(address: Address): Promise<LaunchpadToken | null> {
  const curve = await getCurve(address)
  if (!curve) return null
  const [name, symbol, metadata] = await Promise.all([
    client.readContract({ address, abi: ERC20_META_ABI, functionName: 'name' }),
    client.readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' }),
    resolveMetadata(address).catch(() => null),
  ])
  return { address, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve), metadata }
}

// token address (lowercase) => its one-time TokenLaunched log, cached
// forever — the event fires exactly once per token and never changes.
const launchLogCache = new Map<string, { metadataURI: string; blockNumber: bigint } | null>()

async function fetchTokenLaunchedLog(token: Address) {
  const key = token.toLowerCase()
  const cached = launchLogCache.get(key)
  if (cached !== undefined) return cached
  if (!isConfigured()) { launchLogCache.set(key, null); return null }

  const logs = await client.getLogs({
    address: LAUNCHPAD_ADDRESS,
    event: LAUNCHPAD_ABI.find(e => e.type === 'event' && e.name === 'TokenLaunched')!,
    args: { token },
    fromBlock: 0n,
    toBlock: 'latest',
  })
  const log = logs[0]
  const result = log ? { metadataURI: (log.args as { metadataURI?: string }).metadataURI ?? '', blockNumber: log.blockNumber } : null
  launchLogCache.set(key, result)
  return result
}

/** Reads a token's `metadataURI` back from its one-time TokenLaunched
 * event log — the contract itself only emits this, it isn't stored in
 * state, so there's no direct view function for it. */
export async function getTokenMetadataUri(token: Address): Promise<string> {
  const log = await fetchTokenLaunchedLog(token)
  return log?.metadataURI ?? ''
}

/** The exact block a token was created in. Needed to scan its true
 * earliest trading activity — `getRecentTrades`'s default lookback window
 * (last ~50k blocks) would silently miss launch-time trades for any token
 * older than that, which is exactly the data a bundling/cluster check
 * needs to be correct. */
export async function getLaunchBlock(token: Address): Promise<bigint | null> {
  const log = await fetchTokenLaunchedLog(token)
  return log?.blockNumber ?? null
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

/** Maps our own launchpad tokens into the same shape RadarDex tokens use,
 * so they can sit in the unified Terminal table as a real, first-party
 * source — tagged 'ARCDEX' — instead of only existing on a separate page.
 * Volume/tx/holder counts are derived from on-chain Trade logs directly
 * (no indexer for our own contract), over the same lookback window
 * `getRecentTrades` already uses. */
export async function getAllLaunchpadTokensAsArcTokens(): Promise<import('./radardex').ArcToken[]> {
  const tokens = await getAllLaunchpadTokens() // already resolves metadata per token
  if (tokens.length === 0) return []

  return Promise.all(tokens.map(async (t): Promise<import('./radardex').ArcToken> => {
    const trades = await getRecentTrades(t.address).catch(() => [])
    const meta = t.metadata
    const volume = trades.reduce((s, tr) => s + Number(tr.usdcAmount) / 1e6, 0)
    const buys = trades.filter(tr => tr.isBuy).length
    const sells = trades.length - buys
    const holderCount = new Set(trades.map(tr => tr.trader.toLowerCase())).size

    return {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: 18,
      logoUrl: meta?.image ?? '',
      price: t.priceUsd,
      priceChange5m: 0,
      priceChange1h: 0,
      priceChange24h: 0,
      volume24h: volume,
      marketCap: t.priceUsd * 1_000_000_000,
      liquidity: Number(t.curve.rUsdc) / 1e6,
      ageMs: Date.now() - t.curve.launchedAt * 1000,
      launchpad: 'ARCDEX',
      poolAddress: '',
      txCount24h: trades.length,
      holderCount,
      buys24h: buys,
      sells24h: sells,
      verified: true,
      graduated: t.curve.graduated,
      bondingProgress: t.bondingProgress,
      spark: [],
      website: meta?.website,
      twitter: meta?.twitter,
      telegram: meta?.telegram,
      deployer: t.curve.creator,
      quoteSymbol: 'USDC',
    }
  }))
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

export interface CreatorReward { token: Address; symbol: string; creatorTaxBps: number; earnedUsdc: number; trades: number; volumeUsdc: number; windowCapped: boolean }

const LOG_SPAN = 9_000n     // Arc RPC's max getLogs range
const MAX_SPANS = 60        // ~3 days of blocks, scanned 6 at a time

/** Creator rewards (fomo's "Creator rewards" tab) for coins `creator`
 * launched on ArcLaunchpad: 60% of each coin's creator tax, paid in USDC
 * on every trade. Rebuilt from the launchpad's own Trade events, so it
 * matches what the contract actually paid (to within rounding). */
export async function getCreatorRewards(creator: string): Promise<CreatorReward[]> {
  if (!isConfigured()) return []
  const mine = (await getAllLaunchpadTokens(false)).filter(t => t.curve.creator.toLowerCase() === creator.toLowerCase())
  if (!mine.length) return []
  const latest = await client.getBlockNumber()
  const tradeEvent = LAUNCHPAD_ABI.find(e => e.type === 'event' && e.name === 'Trade')!
  return Promise.all(mine.map(async t => {
    const launch = (await getLaunchBlock(t.address).catch(() => null)) ?? 0n
    const spans: [bigint, bigint][] = []
    for (let to = latest; to >= launch && spans.length < MAX_SPANS; to -= LOG_SPAN) spans.push([to - LOG_SPAN + 1n > launch ? to - LOG_SPAN + 1n : launch, to])
    let earned = 0, volume = 0, trades = 0
    for (let i = 0; i < spans.length; i += 6) {
      const batch = await Promise.all(spans.slice(i, i + 6).map(([fromBlock, toBlock]) =>
        client.getLogs({ address: LAUNCHPAD_ADDRESS, event: tradeEvent, args: { token: t.address }, fromBlock, toBlock }).catch(() => [])))
      for (const l of batch.flat()) {
        const a = l.args as { isBuy: boolean; usdcAmount: bigint; totalFee: bigint }
        const gross = Number(a.isBuy ? a.usdcAmount : a.usdcAmount + a.totalFee) / 1e6
        earned += (gross * t.curve.creatorTaxBps / 10_000) * 0.6
        volume += gross
        trades++
      }
    }
    const capped = spans.length === MAX_SPANS && spans[spans.length - 1][0] > launch
    return { token: t.address, symbol: t.symbol, creatorTaxBps: t.curve.creatorTaxBps, earnedUsdc: earned, trades, volumeUsdc: volume, windowCapped: capped }
  }))
}
