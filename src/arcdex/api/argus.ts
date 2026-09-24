// ── Argus (Portal 8) — single-launchpad focus ──────────────────────────
// Per https://argus.world/docs/integrate and its linked sub-pages
// (integrate-markets, portal-8-contracts), read directly from the
// browser, 2026-09-24.
//
// Argus has shipped 8 different "Portal" contract versions since 2026,
// each with its own launch-record shape, and the docs are explicit that
// a later Portal never replaces an earlier one — a real integration
// indexes all of them. This file deliberately does NOT do that: it
// covers Portal 8 only, the current, most recently deployed, and most
// thoroughly documented version (its own 5-page doc section, vs. one
// shared page for #1-7). Portals #1-7 are a known gap, not an oversight
// — indexing all 8 correctly (three different record widths, two
// different sign/event conventions, version-specific payout ABIs) is a
// much larger job than "focus on this launchpad first" calls for.
//
// Also deliberately NOT built here, because the docs describe them as
// separate, nontrivial work of their own:
// - Dollar liquidity: StateView.getLiquidity() returns v4 concentrated-
//   liquidity UNITS, not reserves — converting that to a $ figure needs
//   tick-range math the docs treat as its own topic. liquidity is 0.
// - Volume/tx/holder counts: would need indexing PoolManager Swap events
//   per pool id, with v4's sign convention (opposite of v3, which is
//   what arcRpc.ts's existing live-feed already assumes) and dev-buy
//   double-counting to avoid. Left at 0 rather than faked.
// - Live trade feed: same reason — v4 Swap events aren't what
//   arcRpc.ts's SWAP_TOPIC subscription matches today.
//
// What IS covered: discovering every Portal-8 launch, its metadata
// (image/socials), a live price read via StateView (documented formula,
// not guessed), bonding status/progress, and tax rates — all read
// straight from chain, no third party.

import { type Address, type AbiEvent, parseAbi } from 'viem'
import { client } from './launchpad'
import type { ArcToken } from './radardex'

export const PORTAL8_ADDRESS = '0xeed7559B8A6ABf64427dc41Cb5cc6400109C5D93' as Address
export const PORTAL8_DEPLOY_BLOCK = 22_251_758n
export const STATE_VIEW_ADDRESS = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address

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
  inFlight = getArgusTokensInner().finally(() => { inFlight = null })
  return inFlight
}

async function getArgusTokensInner(): Promise<ArcToken[]> {
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
    if (slot0 && quoteMeta) {
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
