// ── ArcLaunchpad client ───────────────────────────────────────────────
// Reads/writes for the on-chain bonding-curve launchpad. Unlike
// dexscreener.ts/gecko.ts, curve tokens aren't indexed by any third-party
// aggregator (they're not real Uniswap pools), so every read here goes
// straight to Arc mainnet via viem — first-party, no proxy needed.

import { createPublicClient, parseAbi, type Address } from 'viem'
import { arc } from '../wagmi'
import { arcReadTransport } from '../lib/rpc'
import { headBlock, scanLogs, type RawLog } from '../../../api/_arcLogs'
import { CURVE_TRADE, DEPLOY_BLOCKS, TOKEN_LAUNCHED, decodeLaunch, decodeTrade, priceAfter, resolveMeta, statsOf, type Launch, type LaunchStats, type TradeRow } from '../../../api/_launchpadCore'

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

/** Lag-tolerant: a simulation right after an approval retries until the
 * RPC node answering has seen it (lib/rpc.ts). */
// Reads that start together (a page's balances, allowances, supplies) go out
// as one Multicall3 call instead of one request each.
export const client = createPublicClient({ chain: arc, transport: arcReadTransport(), batch: { multicall: true } })

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
  /** 24h volume, trades, traders… from the launchpad index (absent until it has the coin). */
  stats?: LaunchStats
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

// ── launches and trades: the launchpad index ─────────────────────────
// A coin's image, description and socials live only in its TokenLaunched
// event (the contract never stores the metadataURI), and its history is its
// Trade events. /api/launchpad keeps both, indexed server-side and
// CDN-cached. (Reading them here with getLogs failed: the public RPC takes
// ~9k blocks per call, not the whole chain.) If the endpoint can't be
// reached — local dev, an outage — the same logs are scanned from the
// chain in ranges the RPCs accept.

export interface IndexedLaunch extends Launch { stats: LaunchStats }
interface LaunchpadIndex { launches: IndexedLaunch[]; trades?: TradeRow[] }

const INDEX_MAX_AGE_MS = 4_000
const indexCache = new Map<string, { at: number; p: Promise<LaunchpadIndex> }>()

/** The launchpad index (with `token`: plus that coin's trades, oldest first). */
export function launchpadIndex(token?: string): Promise<LaunchpadIndex> {
  const key = token?.toLowerCase() ?? ''
  const hit = indexCache.get(key)
  if (hit && Date.now() - hit.at < INDEX_MAX_AGE_MS) return hit.p
  const p = (async (): Promise<LaunchpadIndex> => {
    try {
      const r = await fetch(`/api/launchpad${key ? `?token=${key}` : ''}`)
      const j = r.ok ? (await r.json()) as LaunchpadIndex & { complete?: boolean } : null
      if (j?.launches && (j.complete || j.launches.length)) return j
    } catch { /* use the chain */ }
    return indexFromChain(key)
  })()
  indexCache.set(key, { at: Date.now(), p })
  p.catch(() => indexCache.delete(key))
  return p
}

// The chain fallback keeps what it scanned and only reads new blocks next time.
let chainLogs: { to: number; launches: Launch[]; trades: TradeRow[] } | null = null
async function indexFromChain(token: string): Promise<LaunchpadIndex> {
  if (!isConfigured()) return { launches: [] }
  const head = await headBlock()
  const lp = LAUNCHPAD_ADDRESS.toLowerCase()
  const state = chainLogs ?? { to: (DEPLOY_BLOCKS[lp] ?? head - 600_000) - 1, launches: [], trades: [] }
  if (state.to < head) {
    const res = await scanLogs<RawLog[]>({ address: lp, topics: [[TOKEN_LAUNCHED, CURVE_TRADE]] }, state.to + 1, head, {
      head, reduce: l => l, deadline: Date.now() + 20_000,
    })
    const known = new Set(state.launches.map(l => l.token))
    for (const l of res.parts.flat()) {
      const launch = decodeLaunch(l)
      if (launch && !known.has(launch.token)) { launch.meta = await resolveMeta(launch.metadataURI); state.launches.push(launch); known.add(launch.token); continue }
      const trade = decodeTrade(l)
      if (trade) state.trades.push(trade)
    }
    state.to = res.scannedTo
  }
  chainLogs = state
  const tradesOf = (t: string) => state.trades.filter(x => x[0] === t)
  return {
    launches: state.launches.map(l => ({ ...l, stats: statsOf(tradesOf(l.token), undefined, l.ts) })),
    ...(token ? { trades: tradesOf(token) } : {}),
  }
}

async function launchOf(token: Address): Promise<IndexedLaunch | null> {
  const t = token.toLowerCase()
  return (await launchpadIndex()).launches.find(l => l.token === t) ?? null
}

type TokenMetadata = import('../lib/mediaUpload').TokenMetadata
const metadataOf = (l: IndexedLaunch | null): TokenMetadata | null =>
  l?.meta ? { name: l.name, symbol: l.symbol, ...l.meta } : null

export async function getAllLaunchpadTokens(includeMetadata = true): Promise<LaunchpadToken[]> {
  if (!isConfigured()) return []
  const [total, index] = await Promise.all([
    client.readContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'tokenCount' }),
    launchpadIndex().catch(() => ({ launches: [] as IndexedLaunch[] })),
  ])
  if (total === 0n) return []
  const addrs = await client.readContract({
    address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'getTokens', args: [0n, total],
  })
  const byToken = new Map(index.launches.map(l => [l.token, l]))

  const results = await Promise.all(addrs.map(async (addr): Promise<LaunchpadToken | null> => {
    try {
      const launch = byToken.get(addr.toLowerCase()) ?? null
      // Name and symbol from the index when it has the coin; the curve is always live.
      const [curve, name, symbol] = await Promise.all([
        getCurve(addr),
        launch ? launch.name : client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'name' }),
        launch ? launch.symbol : client.readContract({ address: addr, abi: ERC20_META_ABI, functionName: 'symbol' }),
      ])
      if (!curve) return null
      return {
        address: addr, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve),
        metadata: includeMetadata ? metadataOf(launch) : undefined, stats: launch?.stats,
      }
    } catch { return null }
  }))
  return results.filter((t): t is LaunchpadToken => t !== null)
}

export async function getLaunchpadToken(address: Address): Promise<LaunchpadToken | null> {
  const curve = await getCurve(address)
  if (!curve) return null
  const launch = await launchOf(address).catch(() => null)
  const [name, symbol] = await Promise.all([
    launch ? launch.name : client.readContract({ address, abi: ERC20_META_ABI, functionName: 'name' }),
    launch ? launch.symbol : client.readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' }),
  ])
  return { address, name, symbol, curve, priceUsd: priceFromCurve(curve), bondingProgress: bondingProgressFromCurve(curve), metadata: metadataOf(launch) }
}

/** A token's `metadataURI`, from its one-time TokenLaunched event (the
 * contract doesn't keep it in state). */
export async function getTokenMetadataUri(token: Address): Promise<string> {
  return (await launchOf(token))?.metadataURI ?? ''
}

/** The exact block a token was created in — where its trading history
 * (and a bundling/cluster check) starts. */
export async function getLaunchBlock(token: Address): Promise<bigint | null> {
  const l = await launchOf(token)
  return l ? BigInt(l.block) : null
}

export interface CurveTrade {
  trader: Address
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  blockNumber: bigint
  txHash: `0x${string}`
  /** unix seconds */
  timestamp: number
  /** Curve price after the trade (USD per token), from its reserves. */
  priceAfter?: number
}

/** A token's trades since `fromBlock` (default: all of them), newest first. */
export async function getRecentTrades(token: Address, fromBlock?: bigint): Promise<CurveTrade[]> {
  if (!isConfigured()) return []
  const rows = (await launchpadIndex(token)).trades ?? []
  return rows
    .filter(t => fromBlock === undefined || BigInt(t[8]) >= fromBlock)
    .map(t => ({
      trader: t[1] as Address, isBuy: t[2] === 1, usdcAmount: BigInt(t[3]), tokenAmount: BigInt(t[4]),
      blockNumber: BigInt(t[8]), txHash: t[10] as `0x${string}`, timestamp: t[9], priceAfter: priceAfter(t),
    }))
    .reverse()
}

/** Maps our own launchpad tokens into the same shape RadarDex tokens use,
 * so they can sit in the unified Terminal table as a real, first-party
 * source — tagged 'ARCDEX' — instead of only existing on a separate page.
 * Volume, trade and trader counts come from the launchpad index. */
export async function getAllLaunchpadTokensAsArcTokens(): Promise<import('./radardex').ArcToken[]> {
  const [tokens, index] = await Promise.all([getAllLaunchpadTokens(), launchpadIndex().catch(() => ({ launches: [] as IndexedLaunch[] }))])
  if (tokens.length === 0) return []
  const statsBy = new Map(index.launches.map(l => [l.token, l.stats]))

  return Promise.all(tokens.map(async (t): Promise<import('./radardex').ArcToken> => {
    const meta = t.metadata
    const s = statsBy.get(t.address.toLowerCase())
    const volume = s?.vol24 ?? 0
    const buys = s?.buys24 ?? 0
    const sells = s?.sells24 ?? 0
    const holderCount = s?.traders ?? 0

    return {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: 18,
      logoUrl: meta?.image ?? '',
      price: t.priceUsd,
      priceChange5m: 0,
      priceChange1h: 0,
      priceChange24h: s?.change24 ?? 0,
      volume24h: volume,
      marketCap: t.priceUsd * 1_000_000_000,
      liquidity: Number(t.curve.rUsdc) / 1e6,
      ageMs: Date.now() - t.curve.launchedAt * 1000,
      launchpad: 'ARCDEX',
      poolAddress: '',
      txCount24h: s?.trades24 ?? 0,
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

/** Creator rewards (fomo's "Creator rewards" tab) for coins `creator`
 * launched on ArcLaunchpad: 60% of each coin's creator tax, paid in USDC
 * on every trade. Rebuilt from each coin's full trade history in the
 * launchpad index, so it matches what the contract paid (to within rounding). */
export async function getCreatorRewards(creator: string): Promise<CreatorReward[]> {
  if (!isConfigured()) return []
  const mine = (await getAllLaunchpadTokens(false)).filter(t => t.curve.creator.toLowerCase() === creator.toLowerCase())
  if (!mine.length) return []
  return Promise.all(mine.map(async t => {
    const rows = (await launchpadIndex(t.address).catch(() => ({ trades: [] as TradeRow[] }))).trades ?? []
    let earned = 0, volume = 0
    for (const r of rows) {
      // Buys: the fee came out of usdcAmount. Sells: usdcAmount is net, the fee is on top.
      const gross = Number(r[2] === 1 ? BigInt(r[3]) : BigInt(r[3]) + BigInt(r[5])) / 1e6
      earned += (gross * t.curve.creatorTaxBps / 10_000) * 0.6
      volume += gross
    }
    return { token: t.address, symbol: t.symbol, creatorTaxBps: t.curve.creatorTaxBps, earnedUsdc: earned, trades: rows.length, volumeUsdc: volume, windowCapped: false }
  }))
}
