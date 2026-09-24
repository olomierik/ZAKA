// ── Argus — Portal 8 (v4) + Portals 1/2 (legacy v3) ─────────────────────
// Per https://argus.world/docs/integrate and its linked sub-pages
// (integrate-markets, portal-8-contracts), and the published
// argus-abi.json bundle (the exact compiler-generated ABI, not
// hand-reconstructed) — read directly from the browser, 2026-09-24.
//
// Argus has shipped 8 Portal contract versions total; this file covers
// three of them: Portal 8 (current, v4-hooked, most thoroughly
// documented) and Portals 1-2 (legacy v3 — added after discovering
// $ARGUS itself, the platform's own flagship token, is a Portal 1
// launch and was invisible under Portal-8-only scope). Portals 3-7 are
// the remaining gap — each has yet another distinct launch-record shape
// (see the Portal registry table on the integrate page), and unlike
// legacy 1/2, they don't share Portal 8's ABI either, so covering them
// is separate work, not a small extension of what's here.
//
// Legacy (1/2) and Portal 8 are different enough architecturally that
// they're genuinely separate code paths below, not just different
// addresses:
// - Legacy: bulk tokenCount()/getTokens() enumeration (checked live:
//   only 59 tokens total across both, so no scanning or capping
//   needed), a direct Uniswap V3 pool per launch (its own slot0(), no
//   shared StateView), and real trade volume — legacy pools emit the
//   standard V3 Swap event, which is exactly what this app's existing
//   live-feed (arcRpc.ts) already knows how to decode (pool-oriented
//   sign convention: positive quote amount = quote flowing into the
//   pool = a buy).
// - Portal 8: event-log backfill for discovery (no bulk enumeration
//   exists), a shared StateView contract keyed by poolId, and no trade
//   volume (v4 Swap events use the opposite, swapper-oriented sign
//   convention — a genuinely separate decode this file doesn't cover).
//
// Also still not built, for Portal 8 specifically (own topic in the
// docs, real additional work): dollar liquidity (v4's concentrated-
// liquidity units need tick-range math to convert) and the live trade
// feed (same v4 Swap-event gap as volume above).

import { type Address, type AbiEvent, parseAbi } from 'viem'
import { client } from './launchpad'
import type { ArcToken } from './radardex'
import { SWAP_TOPIC } from './arcRpc'

export const PORTAL8_ADDRESS = '0xeed7559B8A6ABf64427dc41Cb5cc6400109C5D93' as Address
export const PORTAL8_DEPLOY_BLOCK = 22_251_758n
export const STATE_VIEW_ADDRESS = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address

// Legacy v3 portals — per the published argus-abi.json bundle's own
// addresses.portals list. Portal 1 is "first - still live, its tokens
// still point at it" (2 tokens, including $ARGUS); Portal 2 is what
// that bundle calls "current" for legacy purposes (57 tokens) before
// Portal 8 superseded it as the actual new-launch target.
const LEGACY_PORTALS = [
  '0x0F1C7Cb26D6cD36BD4189E41947658b39437587A',
  '0xBed9880A0ba12722ba4b8791c0B6F8c74338246C',
] as Address[]

const LEGACY_PORTAL_ABI = parseAbi([
  'function tokenCount() view returns (uint256)',
  'function getTokens(uint256 offset, uint256 limit) view returns (address[])',
  'function launches(address token) view returns (address creator, int24 tickStart, int24 tickBond, bool tokenIsToken0, bool bonded, address pool, address processor, address tracker, address locker, uint256 positionId)',
])

const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
])

const TOKEN_LOGO_ABI = parseAbi(['function logo() view returns (string)'])
const LEGACY_TOKEN_TIME_ABI = parseAbi(['function launchedAt() view returns (uint256)'])

const V3_SWAP_EVENT = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
])[0]

const PORTAL8_ABI = parseAbi([
  'event Launched(address indexed token, address indexed creator, address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond)',
  'event LaunchMetadata(address indexed token, string imageURI, string website, string twitter, string telegram, string description)',
  'function launches(address token) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)',
])

const HOOK_ABI = parseAbi([
  'function buyTaxBps() view returns (uint16)',
  'function sellTaxBps() view returns (uint16)',
  'function totalFeeBps() view returns (uint256)',
  'function quoteAsset() view returns (address)',
  'function bonded() view returns (bool)',
  'function poolId() view returns (bytes32)',
])

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
])

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])

/** sqrtPriceX96 -> quote-per-token in human units, per the documented
 * formula (integrate-markets): r = sqrtPriceX96^2 / 2^192 is raw
 * currency1-per-currency0; invert if the launch token is currency1;
 * scale by the decimals difference. Uses plain floating point, same
 * precision tier as every other price calc in this app (e.g.
 * launchpad.ts's priceFromCurve) — a display price, not a settlement one. */
function priceFromSqrtPriceX96(sqrtPriceX96: bigint, tokenIsToken0: boolean, tokenDecimals: number, quoteDecimals: number): number {
  const Q96 = 2 ** 96
  const sqrtP = Number(sqrtPriceX96) / Q96
  const r = sqrtP * sqrtP // raw currency1 per raw currency0
  const quotePerTokenRaw = tokenIsToken0 ? r : (r === 0 ? 0 : 1 / r)
  return quotePerTokenRaw * Math.pow(10, tokenDecimals - quoteDecimals)
}

/** Every legitimate Argus launch uses exactly 1e9 tokens
 * (launchConstants.totalSupply in the published bundle) — confirmed
 * directly on chain for one legacy token (a joke/test launch, judging
 * by its name) that totalSupply() can return a raw value that was
 * never actually scaled by the token's own declared decimals(), e.g.
 * reporting decimals()=18 but totalSupply()=1e9 raw (implied human
 * supply ~1e-9) — a creator mistake at launch time, not something this
 * app can correct. The pool still trades in real raw units against
 * that real (tiny) supply, so a price computed by assuming the
 * standard decimals scaling comes out many orders of magnitude off —
 * not a rounding error, an unusable number. "Treat launch metadata as
 * untrusted" is literally the Argus docs' own closing guidance,
 * and totalSupply is launch metadata like anything else the creator
 * set — so rather than display a nonsensical price/market cap for
 * whatever token trips this, price is left at 0 (shown as unavailable)
 * for it instead. */
function hasPlausibleSupply(totalSupplyHuman: number): boolean {
  return totalSupplyHuman > 1_000 && totalSupplyHuman < 1e15
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address

// One getBlock call per TOKEN (272 of them in testing) is what actually
// triggered rpc.mainnet.arc.io's rate limit (429s) during live testing,
// on top of the ~2,700 individual contract reads below — both had to go.
// Block time isn't available from a contract, so it can't go through
// multicall; instead, two getBlock calls (latest + one 10k blocks back)
// give a local blocks-per-ms rate, and every token's age is interpolated
// from its known block number. Approximate (Arc's block time isn't
// perfectly constant) but more than fine for the day-granularity "46d"
// age display this feeds, and it's O(1) regardless of token count.
let blockTimeAnchor: { block: bigint; ms: number; msPerBlock: number } | null = null
async function estimateAgeMs(blockNumber: bigint): Promise<number> {
  if (!blockTimeAnchor) {
    const latest = await withRateLimitRetry(() => client.getBlock())
    const refNumber = latest.number > 10_000n ? latest.number - 10_000n : 0n
    const older = await withRateLimitRetry(() => client.getBlock({ blockNumber: refNumber }))
    const deltaBlocks = latest.number - older.number
    const deltaMs = (Number(latest.timestamp) - Number(older.timestamp)) * 1000
    blockTimeAnchor = { block: latest.number, ms: Number(latest.timestamp) * 1000, msPerBlock: deltaBlocks > 0n ? deltaMs / Number(deltaBlocks) : 0 }
  }
  const blocksAgo = Number(blockTimeAnchor.block - blockNumber)
  const launchedAtMs = blockTimeAnchor.ms - blocksAgo * blockTimeAnchor.msPerBlock
  return Math.max(0, Date.now() - launchedAtMs)
}

// rpc.mainnet.arc.io rejects eth_getLogs over ~10,000 blocks
// ("requested range too large", confirmed directly against the RPC —
// Portal 8's own deploy-to-now span is ~250k blocks, so an unchunked
// query fails outright). 9,000 is empirically confirmed working with
// margin. Cached incrementally: only the delta since the last scan is
// fetched on each call, not the whole history every 15s poll — the
// full backfill (~30 chunks right now) happens once, on first load.
const LOG_CHUNK_BLOCKS = 9_000n

interface LaunchedArgs { token: Address; creator: Address }
interface MetadataArgs { token: Address; imageURI: string; website: string; twitter: string; telegram: string; description: string }

let launchCache: { args: LaunchedArgs; blockNumber: bigint }[] = []
const metaCache = new Map<string, MetadataArgs>()
let lastScannedBlock: bigint | null = null

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

function isRateLimitError(e: unknown): boolean {
  const cause = (e as { cause?: unknown } | undefined)?.cause
  const msg = `${e instanceof Error ? e.message : String(e)} ${cause instanceof Error ? cause.message : ''}`
  return /rate limit|too many requests|limit exceeded|code.*-32005|"code":-32005/i.test(msg)
}

/** rpc.mainnet.arc.io's rate limit turned out to be tighter than fixed
 * pacing alone could reliably stay under — confirmed live: even a 250ms
 * gap between chunk requests still got rate-limited mid-backfill.
 * Real retry-with-backoff on the specific failing chunk, not just
 * spacing between chunks, is what actually recovers from that. */
async function withRateLimitRetry<T>(fn: () => Promise<T>, maxAttempts = 7): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (!isRateLimitError(e)) throw e
      await sleep(Math.min(30_000, 1000 * 2 ** attempt)) // 1s, 2s, 4s, 8s, 16s, 30s, 30s — capped, not unbounded
    }
  }
  throw lastError
}

interface ScanResult<T> { items: { args: T; blockNumber: bigint }[]; lastCompletedBlock: bigint | null }

/** Returns whatever it got through, plus how far it actually got, instead
 * of throwing away all progress on a failure partway through. A ~30-chunk
 * backfill that dies on chunk 20 still keeps chunks 1-19 — the next call
 * resumes from there rather than re-fetching the same 20 chunks again
 * (which, against an RPC this rate-limit-sensitive, is how a single bad
 * window turns into a permanent retry loop that never makes progress). */
async function scanChunked<T>(event: AbiEvent, fromBlock: bigint, toBlock: bigint): Promise<ScanResult<T>> {
  const out: { args: T; blockNumber: bigint }[] = []
  let cursor = fromBlock
  let lastCompletedBlock: bigint | null = null
  let first = true
  while (cursor <= toBlock) {
    if (!first) await sleep(400)
    first = false
    const end = cursor + LOG_CHUNK_BLOCKS > toBlock ? toBlock : cursor + LOG_CHUNK_BLOCKS
    try {
      const logs = await withRateLimitRetry(() => client.getLogs({ address: PORTAL8_ADDRESS, event, fromBlock: cursor, toBlock: end }))
      for (const l of logs) out.push({ args: l.args as T, blockNumber: l.blockNumber })
      lastCompletedBlock = end
      cursor = end + 1n
    } catch {
      return { items: out, lastCompletedBlock } // stop here, keep what we have
    }
  }
  return { items: out, lastCompletedBlock }
}

async function refreshDiscoveryCache(): Promise<void> {
  const latest = await withRateLimitRetry(() => client.getBlockNumber())
  const scanFrom = lastScannedBlock !== null ? lastScannedBlock + 1n : PORTAL8_DEPLOY_BLOCK
  if (scanFrom > latest) return

  // Sequential, not Promise.all — two concurrent chunked scans double the
  // request burst rate against an RPC that's already rate-limit-sensitive.
  const launchScan = await scanChunked<LaunchedArgs>(PORTAL8_ABI.find(e => e.type === 'event' && e.name === 'Launched')!, scanFrom, latest)
  const metaScan = await scanChunked<MetadataArgs>(PORTAL8_ABI.find(e => e.type === 'event' && e.name === 'LaunchMetadata')!, scanFrom, latest)
  launchCache.push(...launchScan.items)
  for (const m of metaScan.items) metaCache.set(m.args.token.toLowerCase(), m.args)

  // Only advance the cursor as far as BOTH scans actually completed —
  // otherwise a launch could be recorded without its metadata (or vice
  // versa) ever being fetched for that block range.
  if (launchScan.lastCompletedBlock !== null && metaScan.lastCompletedBlock !== null) {
    const completedTo = launchScan.lastCompletedBlock < metaScan.lastCompletedBlock ? launchScan.lastCompletedBlock : metaScan.lastCompletedBlock
    lastScannedBlock = lastScannedBlock !== null && lastScannedBlock > completedTo ? lastScannedBlock : completedTo
  }
}

// Bounds full enrichment to the most recently launched tokens, not every
// launch ever. Necessary, not just a nicety: 272 launches x ~9 reads was
// already enough individual RPC calls to get rate-limited before
// multicall batching existed, and that count only grows over time. Most
// recent is also what a live trading terminal's users actually want —
// same instinct as "New pair"/"Trending" already having priority
// elsewhere in this app. Discovery itself (launchCache) still tracks
// every launch, so raising this later is a one-line change, not a
// re-architecture.
const MAX_ENRICHED_TOKENS = 150

type Launch7 = readonly [Address, Address, Address, bigint, number, number, boolean]

// Terminal.tsx polls getArgusTokens() every 15s regardless of whether
// the previous call has finished — confirmed live that a paced backfill
// against this RPC easily takes well over 15s, so without this, every
// tick started a brand-new overlapping discovery+enrichment cycle on
// top of whatever was already running. Each one made the shared RPC
// rate-limiting worse, which made every one of them slower, which
// spawned more overlapping calls — the request count was still climbing
// past 600 with no end in sight before this was added. One in-flight
// call at a time; concurrent callers just await the same promise.
let inFlight: Promise<ArcToken[]> | null = null
export function getArgusTokens(): Promise<ArcToken[]> {
  if (inFlight) return inFlight
  // Sequential, not Promise.all — legacy's own trade-stats scan came
  // back empty for a heavily-traded token (real Swap events confirmed
  // present on chain via a direct check) the one time this ran
  // concurrently with Portal 8's full backfill+enrichment, almost
  // certainly the same doubled-burst-rate problem already fixed once
  // for Portal 8's own two event scans (see scanChunked's caller).
  inFlight = (async () => {
    const legacy = await getArgusLegacyTokens().catch(() => [])
    await sleep(400)
    const p8 = await getPortal8Tokens().catch(() => [])
    return [...legacy, ...p8]
  })().finally(() => { inFlight = null })
  return inFlight
}

async function getPortal8Tokens(): Promise<ArcToken[]> {
  await refreshDiscoveryCache()
  if (launchCache.length === 0) return []

  const scoped = [...launchCache].sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, MAX_ENRICHED_TOKENS)

  // Round 1: each launch's record (need the hook address before anything
  // else can be read).
  const launchResults = await withRateLimitRetry(() => client.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: scoped.map(l => ({ address: PORTAL8_ADDRESS, abi: PORTAL8_ABI, functionName: 'launches', args: [l.args.token] } as const)),
  }))
  const withRecord = scoped
    .map((log, i) => ({ log, res: launchResults[i] }))
    .filter((x): x is { log: typeof scoped[number]; res: { status: 'success'; result: Launch7 } } => x.res.status === 'success')
  if (withRecord.length === 0) return []

  // Round 2: hook state + ERC20 token metadata, batched together — one
  // multicall (internally chunked by viem as needed) instead of ~9
  // individual RPC calls per token.
  const READS_PER_TOKEN = 9
  const round2Contracts = withRecord.flatMap(({ log, res }) => {
    const hook = res.result[0]
    const token = log.args.token
    return [
      { address: hook, abi: HOOK_ABI, functionName: 'quoteAsset' } as const,
      { address: hook, abi: HOOK_ABI, functionName: 'bonded' } as const,
      { address: hook, abi: HOOK_ABI, functionName: 'buyTaxBps' } as const,
      { address: hook, abi: HOOK_ABI, functionName: 'sellTaxBps' } as const,
      { address: hook, abi: HOOK_ABI, functionName: 'poolId' } as const,
      { address: token, abi: ERC20_ABI, functionName: 'name' } as const,
      { address: token, abi: ERC20_ABI, functionName: 'symbol' } as const,
      { address: token, abi: ERC20_ABI, functionName: 'decimals' } as const,
      { address: token, abi: ERC20_ABI, functionName: 'totalSupply' } as const,
    ]
  })
  await sleep(400)
  const round2Results = await withRateLimitRetry(() => client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: round2Contracts }))

  interface Stage2 {
    log: typeof withRecord[number]['log']; record: Launch7; hook: Address
    quoteAsset?: Address; bonded: boolean; buyTaxBps: number; sellTaxBps: number; poolId?: `0x${string}`
    name?: string; symbol?: string; decimals?: number; totalSupply?: bigint
  }
  const stage2: Stage2[] = withRecord.map(({ log, res }, i) => {
    const base = i * READS_PER_TOKEN
    const at = (off: number) => round2Results[base + off]
    const ok = <T,>(off: number): T | undefined => { const r = at(off); return r.status === 'success' ? (r.result as T) : undefined }
    return {
      log, record: res.result, hook: res.result[0],
      quoteAsset: ok<Address>(0), bonded: ok<boolean>(1) ?? false,
      buyTaxBps: Number(ok<bigint | number>(2) ?? 0), sellTaxBps: Number(ok<bigint | number>(3) ?? 0),
      poolId: ok<`0x${string}`>(4),
      name: ok<string>(5), symbol: ok<string>(6), decimals: ok<number>(7), totalSupply: ok<bigint>(8),
    }
  }).filter(s => s.name !== undefined && s.symbol !== undefined && s.decimals !== undefined && s.totalSupply !== undefined)

  // Round 3: pool price (per token with a valid poolId) + quote-asset
  // symbol/decimals (deduplicated — nearly every launch shares USDC).
  const withPoolId = stage2.filter(s => s.poolId !== undefined)
  if (withPoolId.length > 0) await sleep(400)
  const slot0Results = withPoolId.length > 0 ? await withRateLimitRetry(() => client.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: withPoolId.map(s => ({ address: STATE_VIEW_ADDRESS, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [s.poolId!] } as const)),
  })) : []
  const slot0ByToken = new Map<string, { sqrtPriceX96: bigint; tick: number }>()
  withPoolId.forEach((s, i) => {
    const r = slot0Results[i]
    if (r.status === 'success') {
      const [sqrtPriceX96, tick] = r.result as readonly [bigint, number, number, number]
      slot0ByToken.set(s.log.args.token.toLowerCase(), { sqrtPriceX96, tick })
    }
  })

  const uniqueQuotes = [...new Set(stage2.map(s => s.quoteAsset).filter((q): q is Address => !!q).map(q => q.toLowerCase()))] as Address[]
  if (uniqueQuotes.length > 0) await sleep(400)
  const quoteResults = uniqueQuotes.length > 0 ? await withRateLimitRetry(() => client.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: uniqueQuotes.flatMap(q => [
      { address: q, abi: ERC20_ABI, functionName: 'symbol' } as const,
      { address: q, abi: ERC20_ABI, functionName: 'decimals' } as const,
    ]),
  })) : []
  const quoteMetaByAddr = new Map<string, { symbol: string; decimals: number }>()
  uniqueQuotes.forEach((q, i) => {
    const symRes = quoteResults[i * 2], decRes = quoteResults[i * 2 + 1]
    if (symRes.status === 'success' && decRes.status === 'success') {
      quoteMetaByAddr.set(q, { symbol: symRes.result as string, decimals: decRes.result as number })
    }
  })

  const results = await Promise.all(stage2.map(async (s): Promise<ArcToken> => {
    const token = s.log.args.token
    const [, , , , tickStart, tickBond, tokenIsToken0] = s.record
    const decimals = s.decimals!
    const meta = metaCache.get(token.toLowerCase())
    const totalSupply = Number(s.totalSupply!) / 10 ** decimals
    const quoteMeta = s.quoteAsset ? quoteMetaByAddr.get(s.quoteAsset.toLowerCase()) : undefined
    const slot0 = slot0ByToken.get(token.toLowerCase())

    let priceUsd = 0
    let bondingProgress: number | null = null
    if (slot0 && quoteMeta && hasPlausibleSupply(totalSupply)) {
      priceUsd = priceFromSqrtPriceX96(slot0.sqrtPriceX96, tokenIsToken0, decimals, quoteMeta.decimals)
      // Display-only progress (integrate-markets: "guard a zero span,
      // clamp only for display, a tick retreat does not clear bonded").
      const span = tickBond - tickStart
      if (span !== 0) {
        bondingProgress = Math.max(0, Math.min(100, ((slot0.tick - tickStart) / span) * 100))
      }
    }

    const result: ArcToken = {
      address: token,
      symbol: s.symbol!, name: s.name!, decimals,
      logoUrl: meta?.imageURI ?? '',
      price: priceUsd,
      priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, // not built yet — no historical snapshots
      volume24h: 0, // not built yet — needs PoolManager Swap-event indexing, see file header
      marketCap: priceUsd * totalSupply,
      liquidity: 0, // not built yet — v4 liquidity units need tick-range math, see file header
      ageMs: await estimateAgeMs(s.log.blockNumber),
      launchpad: 'Argus',
      poolAddress: '', // v4 pools are identified by poolId, not a pool address
      txCount24h: 0, holderCount: 0, buys24h: 0, sells24h: 0, // not built yet
      verified: true, // deployed via Argus's own audited, verified factory contracts
      graduated: s.bonded,
      bondingProgress,
      spark: [],
      website: meta?.website || undefined,
      twitter: meta?.twitter || undefined,
      telegram: meta?.telegram || undefined,
      deployer: s.log.args.creator,
      quoteSymbol: quoteMeta?.symbol ?? 'USDC',
    }
    return result
  }))

  return results
}

// ── Legacy v3 (Portals 1 & 2) ────────────────────────────────────────

type LegacyLaunch = readonly [Address, number, number, boolean, boolean, Address, Address, Address, Address, bigint]
// [creator, tickStart, tickBond, tokenIsToken0, bonded, pool, processor, tracker, locker, positionId]

interface LegacyDiscovered { token: Address; portal: Address }
interface TradeStats { volumeUsd: number; txCount: number; buys: number; sells: number }

// Bulk enumeration is cheap (2 calls per portal) and only 59 tokens
// total exist — no need for the chunked-scan/incremental-cache
// machinery Portal 8 needs. Still cached briefly: legacy portals aren't
// where new launches go anymore, so re-enumerating every 15s poll would
// just be waste, not freshness.
let legacyTokenCache: LegacyDiscovered[] | null = null
let legacyTokenCacheTs = 0
const LEGACY_DISCOVERY_TTL = 5 * 60_000

async function discoverLegacyTokens(): Promise<LegacyDiscovered[]> {
  if (legacyTokenCache && Date.now() - legacyTokenCacheTs < LEGACY_DISCOVERY_TTL) return legacyTokenCache
  const out: LegacyDiscovered[] = []
  for (const portal of LEGACY_PORTALS) {
    try {
      const count = await withRateLimitRetry(() => client.readContract({ address: portal, abi: LEGACY_PORTAL_ABI, functionName: 'tokenCount' }))
      if (count === 0n) continue
      await sleep(300)
      const addrs = await withRateLimitRetry(() => client.readContract({ address: portal, abi: LEGACY_PORTAL_ABI, functionName: 'getTokens', args: [0n, count] }))
      for (const token of addrs) out.push({ token, portal })
      await sleep(300)
    } catch { /* one portal failing to enumerate shouldn't block the other */ }
  }
  legacyTokenCache = out
  legacyTokenCacheTs = Date.now()
  return out
}

/** Real trade volume via the standard Uniswap V3 Swap event — legacy
 * Argus pools are plain V3 pools, so this is the exact same event
 * (and sign convention: positive quote-leg amount = quote flowing INTO
 * the pool = a buy) that arcRpc.ts's existing live feed already
 * decodes for the rest of this app. Portal 8's v4 pools use the
 * opposite convention and a different event entirely, so this doesn't
 * extend to them.
 *
 * Confirmed live against rpc.mainnet.arc.io: its "too large" rejection
 * isn't just a block-range cap (LOG_CHUNK_BLOCKS already handles that)
 * — it's a combined budget with the number of addresses in the filter.
 * 59 pool addresses at even a 200-block range was rejected; 20
 * addresses at the full 9,000-block chunk size succeeded. So pools are
 * batched (15, for margin under the confirmed 20-address success
 * point) on top of the existing block chunking, not passed as one
 * all-59 filter. */
const LEGACY_TRADE_LOOKBACK_BLOCKS = 50_000n
const POOL_BATCH_SIZE = 15

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function getLegacyTradeStats(pools: Address[], quoteIsToken0ByPool: Map<string, boolean>): Promise<Map<string, TradeStats>> {
  const stats = new Map<string, TradeStats>()
  if (pools.length === 0) return stats

  try {
    const latest = await withRateLimitRetry(() => client.getBlockNumber())
    const fromBlock = latest > LEGACY_TRADE_LOOKBACK_BLOCKS ? latest - LEGACY_TRADE_LOOKBACK_BLOCKS : 0n

    for (const poolBatch of chunk(pools, POOL_BATCH_SIZE)) {
      let cursor = fromBlock
      let first = true
      while (cursor <= latest) {
        if (!first) await sleep(400)
        first = false
        const end = cursor + LOG_CHUNK_BLOCKS > latest ? latest : cursor + LOG_CHUNK_BLOCKS
        let logs
        try {
          logs = await withRateLimitRetry(() => client.getLogs({ address: poolBatch, event: V3_SWAP_EVENT, fromBlock: cursor, toBlock: end }))
        } catch {
          break // keep whatever stats were gathered from earlier chunks/batches
        }
        for (const log of logs) {
          const poolKey = log.address.toLowerCase()
          const quoteIsToken0 = quoteIsToken0ByPool.get(poolKey)
          if (quoteIsToken0 === undefined) continue
          const args = log.args as { amount0: bigint; amount1: bigint }
          const quoteAmount = quoteIsToken0 ? args.amount0 : args.amount1
          const isBuy = quoteAmount > 0n
          const volumeUsd = Number(quoteAmount < 0n ? -quoteAmount : quoteAmount) / 1e6
          const existing = stats.get(poolKey) ?? { volumeUsd: 0, txCount: 0, buys: 0, sells: 0 }
          existing.volumeUsd += volumeUsd
          existing.txCount += 1
          if (isBuy) existing.buys += 1; else existing.sells += 1
          stats.set(poolKey, existing)
        }
        cursor = end + 1n
      }
    }
  } catch { /* no trade stats is fine — fields already default to 0 */ }

  return stats
}

async function getArgusLegacyTokens(): Promise<ArcToken[]> {
  const discovered = await discoverLegacyTokens()
  if (discovered.length === 0) return []

  await sleep(300)
  const launchResults = await withRateLimitRetry(() => client.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: discovered.map(d => ({ address: d.portal, abi: LEGACY_PORTAL_ABI, functionName: 'launches', args: [d.token] } as const)),
  }))
  const withRecord = discovered
    .map((d, i) => ({ d, res: launchResults[i] }))
    .filter((x): x is { d: LegacyDiscovered; res: { status: 'success'; result: LegacyLaunch } } => x.res.status === 'success')
  if (withRecord.length === 0) return []

  // ERC20 metadata + logo() (exposed directly on the token contract —
  // no event backfill needed for the image) + the pool's own slot0() +
  // launchedAt() (also a direct token getter — gives a real, exact
  // timestamp with zero extra RPC cost, unlike Portal 8's block-time
  // interpolation, which exists only because v4's hook doesn't expose
  // one directly).
  const READS_PER_TOKEN = 7
  const round2Contracts = withRecord.flatMap(({ d, res }) => {
    const pool = res.result[5]
    return [
      { address: d.token, abi: ERC20_ABI, functionName: 'name' } as const,
      { address: d.token, abi: ERC20_ABI, functionName: 'symbol' } as const,
      { address: d.token, abi: ERC20_ABI, functionName: 'decimals' } as const,
      { address: d.token, abi: ERC20_ABI, functionName: 'totalSupply' } as const,
      { address: d.token, abi: TOKEN_LOGO_ABI, functionName: 'logo' } as const,
      { address: d.token, abi: LEGACY_TOKEN_TIME_ABI, functionName: 'launchedAt' } as const,
      { address: pool, abi: V3_POOL_ABI, functionName: 'slot0' } as const,
    ]
  })
  await sleep(300)
  const round2Results = await withRateLimitRetry(() => client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: round2Contracts }))

  type Slot0Result = readonly [bigint, number, number, number, number, number, boolean]
  interface Stage2 {
    d: LegacyDiscovered; record: LegacyLaunch
    name?: string; symbol?: string; decimals?: number; totalSupply?: bigint; logo?: string
    launchedAt?: bigint; slot0?: Slot0Result
  }
  const stage2: Stage2[] = withRecord.map(({ d, res }, i) => {
    const base = i * READS_PER_TOKEN
    const at = (off: number) => round2Results[base + off]
    const ok = <T,>(off: number): T | undefined => { const r = at(off); return r.status === 'success' ? (r.result as T) : undefined }
    return {
      d, record: res.result,
      name: ok<string>(0), symbol: ok<string>(1), decimals: ok<number>(2), totalSupply: ok<bigint>(3),
      logo: ok<string>(4), launchedAt: ok<bigint>(5), slot0: ok<Slot0Result>(6),
    }
  }).filter(s => s.name !== undefined && s.symbol !== undefined && s.decimals !== undefined && s.totalSupply !== undefined)

  const quoteIsToken0ByPool = new Map<string, boolean>()
  for (const s of stage2) quoteIsToken0ByPool.set(s.record[5].toLowerCase(), !s.record[3])
  await sleep(300)
  const tradeStats = await getLegacyTradeStats(stage2.map(s => s.record[5]), quoteIsToken0ByPool)

  return stage2.map((s): ArcToken => {
    const decimals = s.decimals!
    const totalSupply = Number(s.totalSupply!) / 10 ** decimals
    const [creator, tickStart, tickBond, tokenIsToken0, bonded, pool] = s.record

    let priceUsd = 0
    let bondingProgress: number | null = null
    if (s.slot0 && hasPlausibleSupply(totalSupply)) {
      priceUsd = priceFromSqrtPriceX96(s.slot0[0], tokenIsToken0, decimals, 6) // legacy quote is always USDC (launchConstants), 6dp
      const span = tickBond - tickStart
      if (span !== 0) bondingProgress = Math.max(0, Math.min(100, ((s.slot0[1] - tickStart) / span) * 100))
    }
    const stats = tradeStats.get(pool.toLowerCase())

    return {
      address: s.d.token,
      symbol: s.symbol!, name: s.name!, decimals,
      logoUrl: s.logo || '',
      price: priceUsd,
      priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, // not built yet — no historical snapshots
      volume24h: stats?.volumeUsd ?? 0,
      marketCap: priceUsd * totalSupply,
      liquidity: 0, // not built yet — same as Portal 8, see file header
      ageMs: s.launchedAt !== undefined ? Math.max(0, Date.now() - Number(s.launchedAt) * 1000) : 0,
      launchpad: 'Argus',
      poolAddress: pool,
      txCount24h: stats?.txCount ?? 0, holderCount: 0, buys24h: stats?.buys ?? 0, sells24h: stats?.sells ?? 0,
      verified: true, // deployed via Argus's own audited, verified factory contracts
      graduated: bonded,
      bondingProgress,
      spark: [],
      // website/twitter/telegram aren't exposed as a getter on legacy
      // tokens or portals — only recoverable from the original
      // TokenCreated event, which for Portal 1/2 sits somewhere across
      // several million blocks of history. Left undefined rather than
      // paying for that backfill just for social links.
      website: undefined, twitter: undefined, telegram: undefined,
      deployer: creator,
      quoteSymbol: 'USDC',
    }
  })
}
