// ── Argus market data (GeckoTerminal) + on-chain details + swap routes ──
// GeckoTerminal is the primary source for live coin data — prices, volume,
// liquidity, charts, trades, holders, images — as it is for argus.world
// itself. Arc RPC is used only for what GeckoTerminal doesn't carry:
// creator wallet, which Portal launched it, its hook, its taxes, and the
// Uniswap v4 PoolKey a swap needs.

import { type Address, type Hex, parseAbi, keccak256, encodeAbiParameters } from 'viem'
import { client } from './launchpad'
import type { ArcToken } from './radardex'
import { buildArgusMarket, dedupe, type ArgusPool } from '../../../api/_argusCore'
import { gtGet, gtDirectFetcher } from './gtClient'

export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as Address
export const ARGUS_TOKEN = '0xeCe5cA8bf9220718E5727754026757512212cb3c' as Address

// ── market list ──────────────────────────────────────────────────────

export type { ArgusPool }

// The browser's own rebuild, reused for a minute so the Terminal's 15s
// refresh doesn't spend the visitor's GeckoTerminal quota every time.
let localBuild: { at: number; pools: Promise<ArgusPool[]> } | null = null

// How long to wait on the server's copy before also building in-browser.
// The server answers from its stored list (v4 `arcdex_kv`, built with the
// CoinGecko key) in ~0.6s, so the in-browser build — which spends the
// visitor's own free GeckoTerminal quota, ~30 calls/min — only runs when
// the server fails, comes back partial, or is this slow.
const SERVER_WAIT_MS = 4_000

interface ServerMarket { pools: ArgusPool[]; partial: boolean }

async function fetchServerMarket(): Promise<ServerMarket | null> {
  try {
    const res = await fetch('/api/argus')
    if (!res.ok) return null
    const d = (await res.json()) as { pools?: ArgusPool[]; partial?: boolean }
    return { pools: d.pools ?? [], partial: d.partial === true }
  } catch {
    return null
  }
}

/** @param onPartial only called when this call starts a new build (a build
 * already in flight or finished within the last minute is reused as-is). */
function localMarket(onPartial?: (pools: ArgusPool[]) => void): Promise<ArgusPool[]> {
  if (!localBuild || Date.now() - localBuild.at > 60_000) {
    localBuild = { at: Date.now(), pools: buildArgusMarket(gtDirectFetcher, onPartial).catch(() => []) }
  }
  return localBuild.pools
}

/** The Argus market list, as fast as it can be had. Uses the server's
 * CDN-cached copy; when that's incomplete (GeckoTerminal throttles
 * Vercel's shared IPs) or slow (a cold rebuild), also builds it from the
 * visitor's own IP. Returns the first usable list; anything that lands
 * later — the rest of a partial list, or the slower of two sources — is
 * delivered merged via `onUpdate`. */
export async function getArgusMarket(onUpdate?: (pools: ArgusPool[]) => void): Promise<ArgusPool[]> {
  const pools = await loadArgusMarket(onUpdate && (p => { rememberMarket(p); onUpdate(p) }))
  rememberMarket(pools)
  return pools
}

// The last list this browser saw, so a returning visitor gets it instantly
// (then the fresh one) instead of waiting on the network.
const SNAPSHOT_KEY = 'arcdex:market:v1'
export function cachedArgusMarket(): ArgusPool[] | null {
  try {
    const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null') as { at: number; pools: ArgusPool[] } | null
    return s && Date.now() - s.at < 24 * 3600_000 && Array.isArray(s.pools) && s.pools.length ? s.pools : null
  } catch { return null }
}
function rememberMarket(pools: ArgusPool[]) {
  if (pools.length < 20) return // a throttled fragment, not worth keeping
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), pools })) } catch { /* storage full or blocked */ }
}

async function loadArgusMarket(onUpdate?: (pools: ArgusPool[]) => void): Promise<ArgusPool[]> {
  const server = fetchServerMarket()
  const quick = await Promise.race([server, new Promise<undefined>(r => setTimeout(r, SERVER_WAIT_MS))])

  // Fast and complete — the common case once the CDN is warm.
  if (quick && !quick.partial && quick.pools.length > 0) return quick.pools

  // Otherwise build in-browser too. Its progress streams out as it goes —
  // the first rows resolve `localFirst`, later ones go to `onUpdate` —
  // always merged with whatever the server has delivered by then.
  let serverRows: ArgusPool[] = quick?.pools ?? []
  void server.then(s => { if (s && s.pools.length > 0) serverRows = s.pools })
  let resolveLocalFirst: (p: ArgusPool[]) => void = () => {}
  const localFirst = new Promise<ArgusPool[]>(r => { resolveLocalFirst = r })
  let firstDone = false
  const local = localMarket(partial => {
    const merged = dedupe([...partial, ...serverRows])
    if (!firstDone) { firstDone = true; resolveLocalFirst(merged) } else onUpdate?.(merged)
  })

  // Fast but incomplete: show it now; the in-browser build fills the rest.
  if (quick && quick.pools.length > 0) {
    firstDone = true
    if (onUpdate) void local.then(l => onUpdate(dedupe([...l, ...serverRows])))
    return quick.pools
  }

  // Server slow or failed: take whichever produces rows first — the
  // server's copy, or the in-browser build's first step — and hand over
  // the merge of both once everything has landed.
  const both = Promise.all([server, local]).then(([s, l]) => dedupe([...l, ...(s?.pools ?? [])]))
  const first = await Promise.race([
    localFirst,
    local.then(l => (l.length > 0 ? l : both)),
    server.then(s => (s && s.pools.length > 0 ? s.pools : both)),
  ])
  firstDone = true
  if (onUpdate) void both.then(p => { if (p.length > 0) onUpdate(p) })
  if (first.length === 0) throw new Error('Argus market unavailable')
  return first
}

// Launches are permissionless, so some reuse a real asset's ticker (Argus
// has several "USDC" meme coins trading at fractions of a cent). Flag them
// everywhere they're shown so nobody buys one thinking it's the real asset.
const RESERVED_SYMBOLS: Record<string, string> = {
  USDC: USDC_ADDRESS.toLowerCase(),
  ARGUS: ARGUS_TOKEN.toLowerCase(),
  // The real bridged assets on Arc (see BLUE_CHIPS in lib/tokenMeta).
  WETH: '0x93ffd195481e8c08eb25a158689e4d9e61313111',
  EURC: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
}
// Assets that are never an Argus launch — any Argus token using one of
// these tickers is a copycat by definition.
const IMPERSONATED = new Set(['EURC', 'USDT', 'ETH', 'WETH', 'BTC', 'WBTC'])

/** The real asset this token's ticker imitates, or null. */
export function copycatOf(symbol: string, address: string): string | null {
  const s = symbol.trim().toUpperCase().replace(/^\$/, '')
  const real = RESERVED_SYMBOLS[s]
  if (real) return real === address.toLowerCase() ? null : s
  return IMPERSONATED.has(s) ? s : null
}

export function argusPoolToArcToken(p: ArgusPool): ArcToken {
  const created = p.createdAt ? Date.parse(p.createdAt) : NaN
  const copy = copycatOf(p.token.symbol, p.token.address)
  return {
    address: p.token.address,
    symbol: p.token.symbol,
    name: copy ? `⚠ Not real ${copy} · ${p.token.name}` : p.token.name,
    decimals: 18,
    logoUrl: p.token.image ?? '',
    price: p.priceUsd,
    priceChange5m: p.change.m5,
    priceChange1h: p.change.h1,
    priceChange24h: p.change.h24,
    volume24h: p.volume24h,
    marketCap: p.marketCapUsd ?? p.fdvUsd ?? 0,
    liquidity: p.liquidityUsd,
    ageMs: Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0,
    launchpad: 'Argus',
    poolAddress: p.pool,
    txCount24h: p.txns24h.buys + p.txns24h.sells,
    holderCount: 0,
    buys24h: p.txns24h.buys,
    sells24h: p.txns24h.sells,
    verified: true,
    graduated: false,
    bondingProgress: null,
    spark: [],
    quoteSymbol: p.quote.symbol,
  }
}

// ── GeckoTerminal token detail ───────────────────────────────────────

// Proxy first, direct-to-GeckoTerminal fallback when it's throttled.
function gecko<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  return gtGet<T>(path, params)
}

export interface ArgusTokenInfo {
  address: string
  name: string
  symbol: string
  image: string | null
  banner: string | null
  description: string
  websites: string[]
  twitter: string | null
  telegram: string | null
  discord: string | null
  holders: number | null
  top10Pct: number | null
  gtScore: number | null
  isHoneypot: boolean | null
  verified: boolean
}

export async function getArgusTokenInfo(token: string): Promise<ArgusTokenInfo> {
  const d = await gecko<{ data?: { attributes?: Record<string, unknown> } }>(`/networks/arc/tokens/${token}/info`)
  const a = d.data?.attributes ?? {}
  const holders = a.holders as { count?: number; distribution_percentage?: { top_10?: string } } | undefined
  const img = a.image_url as string | undefined
  return {
    address: token,
    name: String(a.name ?? ''),
    symbol: String(a.symbol ?? ''),
    image: img && !img.includes('missing') ? img : null,
    banner: (a.banner_image_url as string) || null,
    description: String(a.description ?? ''),
    websites: Array.isArray(a.websites) ? (a.websites as string[]) : [],
    twitter: (a.twitter_handle as string) || null,
    telegram: (a.telegram_handle as string) || null,
    discord: (a.discord_url as string) || null,
    holders: typeof holders?.count === 'number' ? holders.count : null,
    top10Pct: holders?.distribution_percentage?.top_10 ? parseFloat(holders.distribution_percentage.top_10) : null,
    gtScore: typeof a.gt_score === 'number' ? a.gt_score : null,
    isHoneypot: typeof a.is_honeypot === 'boolean' ? a.is_honeypot : null,
    verified: a.gt_verified === true,
  }
}

/** Every pool GeckoTerminal knows for this token, best (deepest) first. */
export async function getArgusTokenPools(token: string): Promise<ArgusPool[]> {
  type R = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } }> }
  const d = await gecko<{ data?: R[]; included?: R[] }>(`/networks/arc/tokens/${token}/pools`, { include: 'base_token,quote_token,dex' })
  const toks = new Map((d.included ?? []).filter(i => i.type === 'token').map(i => [i.id, i.attributes]))
  const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
  const pools: ArgusPool[] = []
  for (const p of d.data ?? []) {
    const base = toks.get(p.relationships?.base_token?.data?.id ?? '')
    const quote = toks.get(p.relationships?.quote_token?.data?.id ?? '')
    if (!base || !quote) continue
    const a = p.attributes
    const pc = (a.price_change_percentage ?? {}) as Record<string, unknown>
    const tx = ((a.transactions ?? {}) as Record<string, Record<string, unknown>>).h24 ?? {}
    const img = base.image_url as string | undefined
    pools.push({
      pool: String(a.address).toLowerCase(),
      dex: p.relationships?.dex?.data?.id ?? '',
      token: { address: String(base.address).toLowerCase(), symbol: String(base.symbol), name: String(base.name), image: img && !img.includes('missing') ? img : null },
      quote: { address: String(quote.address).toLowerCase(), symbol: String(quote.symbol) },
      priceUsd: num(a.base_token_price_usd),
      change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      volume24h: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      marketCapUsd: a.market_cap_usd ? num(a.market_cap_usd) : null,
      fdvUsd: a.fdv_usd ? num(a.fdv_usd) : null,
      txns24h: { buys: num(tx.buys), sells: num(tx.sells) },
      createdAt: (a.pool_created_at as string) ?? null,
    })
  }
  // Only pools where this token is the base, quoted in something a USDC
  // buy can reach (USDC directly, or ARGUS via ARGUS/USDC).
  const tradable = pools.filter(p =>
    p.token.address === token.toLowerCase() &&
    (p.quote.address === USDC_ADDRESS.toLowerCase() || p.quote.address === ARGUS_TOKEN.toLowerCase()))
  return tradable.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}

export interface ArgusTrade {
  txHash: string
  maker: string
  kind: 'buy' | 'sell'
  usd: number
  tokenAmount: number
  priceUsd: number
  timestamp: number
  block: number
  /** The swap's log index, when GeckoTerminal's trade id carries it
   * (…_<tx>_<logIndex>_<time>) — then it matches the chain's own id. */
  logIndex: number | null
}

/** GeckoTerminal's latest trades on a pool (newest first). `proxyOnly` for
 * fast polling: the paid-key proxy or nothing. */
export async function getArgusTrades(pool: string, token: string, opts: { proxyOnly?: boolean } = {}): Promise<ArgusTrade[]> {
  const d = await gtGet<{ data?: { id?: string; attributes: Record<string, string> }[] }>(`/networks/arc/pools/${pool}/trades`, {}, opts)
  const t = token.toLowerCase()
  return (d.data ?? []).map(({ id, attributes: a }) => {
    const buy = a.kind === 'buy'
    // For a buy the token is what came out; for a sell it's what went in.
    const tokenIsTo = a.to_token_address?.toLowerCase() === t
    const li = id ? /_(0x[0-9a-fA-F]{64})_(\d+)_\d+$/.exec(id) : null
    return {
      txHash: a.tx_hash,
      maker: a.tx_from_address,
      kind: buy ? 'buy' : 'sell',
      usd: parseFloat(a.volume_in_usd) || 0,
      tokenAmount: parseFloat(tokenIsTo ? a.to_token_amount : a.from_token_amount) || 0,
      priceUsd: parseFloat(tokenIsTo ? a.price_to_in_usd : a.price_from_in_usd) || 0,
      timestamp: Date.parse(a.block_timestamp),
      block: Number(a.block_number) || 0,
      logIndex: li && li[1].toLowerCase() === a.tx_hash?.toLowerCase() ? Number(li[2]) : null,
    }
  })
}

// ── on-chain details (creator, portal, hook, taxes) ──────────────────

const LEGACY_V3 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, int24 tickBond, bool tokenIsToken0, bool bonded, address pool, address processor, address tracker, address locker, uint256 positionId)'])
const HOOKED_9 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId)'])
const HOOKED_10 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond)'])
const HOOKED_11 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)'])
const PORTAL8 = parseAbi(['function launches(address) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)'])
const HOOK = parseAbi(['function bonded() view returns (bool)', 'function buyTaxBps() view returns (uint16)', 'function sellTaxBps() view returns (uint16)'])
const LEGACY_TOKEN = parseAbi(['function currentTaxes() view returns (uint16 buyTaxBps, uint16 sellTaxBps)'])
const CREATOR_REGISTRY = parseAbi(['function payoutOf(address) view returns (address)'])

// Each Portal is decoded with its own record width — the docs are explicit
// that word count alone can't tell #6 from #7, or legacy from 10-word v4,
// so dispatch is by address, never by guessing from the returned length.
const PORTALS = [
  { n: 1, address: '0x0F1C7Cb26D6cD36BD4189E41947658b39437587A' as Address, abi: LEGACY_V3, kind: 'legacy' },
  { n: 2, address: '0xBed9880A0ba12722ba4b8791c0B6F8c74338246C' as Address, abi: LEGACY_V3, kind: 'legacy' },
  { n: 3, address: '0x7A17Ab0106C46C0be30623F3EB7F299CC0058338' as Address, abi: HOOKED_9, kind: 'hooked' },
  { n: 4, address: '0xa36c443A797771Df82533B8B4A86F0AFfd970862' as Address, abi: HOOKED_10, kind: 'hooked' },
  { n: 5, address: '0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E' as Address, abi: HOOKED_10, kind: 'hooked' },
  { n: 6, address: '0xA5628A11c412596E1f63b75a2C0284F843C549d6' as Address, abi: HOOKED_11, kind: 'hooked' },
  { n: 7, address: '0xB021Be536808f551b31789422Fd28a6c9c6e97Da' as Address, abi: HOOKED_11, kind: 'hooked' },
  { n: 8, address: '0xeed7559B8A6ABf64427dc41Cb5cc6400109C5D93' as Address, abi: PORTAL8, kind: 'portal8' },
] as const
const CREATOR_REGISTRY_ADDRESS = '0x986B478bE2F05b44b47c61E26a0BbcBcC07610eD' as Address
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

export interface ArgusOnchain {
  portal: number | null
  creator: string | null
  creatorLabel: 'Creator' | 'Creator payout wallet'
  hook: string | null
  buyTaxBps: number | null
  sellTaxBps: number | null
  bonded: boolean | null
}

/** Checks every Portal (a token only has a record in the one that created
 * it). An all-zero record from one Portal isn't "not Argus" — the docs are
 * explicit that absence has to be proven across all of them. */
export async function getArgusOnchain(token: Address): Promise<ArgusOnchain> {
  const empty: ArgusOnchain = { portal: null, creator: null, creatorLabel: 'Creator', hook: null, buyTaxBps: null, sellTaxBps: null, bonded: null }
  const res = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: PORTALS.map(p => ({ address: p.address, abi: p.abi, functionName: 'launches', args: [token] } as const)),
  })

  for (let i = 0; i < PORTALS.length; i++) {
    const r = res[i]
    if (r.status !== 'success') continue
    const p = PORTALS[i]
    const rec = r.result as readonly unknown[]
    if (p.kind === 'legacy') {
      if (rec[0] === ZERO) continue
      const taxes = await client.readContract({ address: token, abi: LEGACY_TOKEN, functionName: 'currentTaxes' }).catch(() => null)
      return { portal: p.n, creator: rec[0] as string, creatorLabel: 'Creator', hook: null, buyTaxBps: taxes ? Number(taxes[0]) : null, sellTaxBps: taxes ? Number(taxes[1]) : null, bonded: rec[4] as boolean }
    }
    if (p.kind === 'hooked') {
      if (rec[0] === ZERO) continue
      const hook = rec[4] as Address
      const bonded = await client.readContract({ address: hook, abi: HOOK, functionName: 'bonded' }).catch(() => null)
      return { portal: p.n, creator: rec[0] as string, creatorLabel: 'Creator', hook, buyTaxBps: Number(rec[6]), sellTaxBps: Number(rec[7]), bonded }
    }
    // Portal 8 records carry no creator — the creator registry's payout
    // address is the closest on-chain answer, and is labelled as such.
    const hook = rec[0] as Address
    if (hook === ZERO) continue
    const [creator, buy, sell, bonded] = await Promise.all([
      client.readContract({ address: CREATOR_REGISTRY_ADDRESS, abi: CREATOR_REGISTRY, functionName: 'payoutOf', args: [token] }).catch(() => null),
      client.readContract({ address: hook, abi: HOOK, functionName: 'buyTaxBps' }).catch(() => null),
      client.readContract({ address: hook, abi: HOOK, functionName: 'sellTaxBps' }).catch(() => null),
      client.readContract({ address: hook, abi: HOOK, functionName: 'bonded' }).catch(() => null),
    ])
    return { portal: 8, creator: creator && creator !== ZERO ? creator : null, creatorLabel: 'Creator payout wallet', hook, buyTaxBps: buy === null ? null : Number(buy), sellTaxBps: sell === null ? null : Number(sell), bonded }
  }
  return empty
}

// ── swap routes ───────────────────────────────────────────────────────

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export type SwapRoute =
  | { kind: 'v4'; buyKeys: PoolKey[]; sellKeys: PoolKey[]; via: 'USDC' | 'ARGUS' }
  | { kind: 'v3'; fee: number }

const POSITION_MANAGER = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B' as Address
const PM_ABI = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
const V3_POOL = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)'])
const POOLKEY_TYPE = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }] as const

// ARGUS/USDC main v4 pool (poolId 0xb3f441e8…00cc) — the hop every
// ARGUS-quoted launch routes through. Verified to hash to that PoolId.
export const ARGUS_USDC_KEY: PoolKey = { currency0: USDC_ADDRESS, currency1: ARGUS_TOKEN, fee: 9850, tickSpacing: 99, hooks: ZERO as Address }

async function v4KeyFor(poolId: Hex): Promise<PoolKey | null> {
  const r = await client.readContract({ address: POSITION_MANAGER, abi: PM_ABI, functionName: 'poolKeys', args: [poolId.slice(0, 52) as Hex] })
  const key: PoolKey = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }
  if (key.currency0 === ZERO && key.currency1 === ZERO) return null
  // Never trust a key we can't prove is the pool GeckoTerminal named.
  if (keccak256(encodeAbiParameters(POOLKEY_TYPE, [key])).toLowerCase() !== poolId.toLowerCase()) return null
  return key
}

/** How to buy `token` with USDC through `pool` (and sell back). null when
 * the pool can't be routed safely — the UI says so rather than guess. */
export async function buildSwapRoute(token: string, pool: string): Promise<SwapRoute | null> {
  const t = token.toLowerCase()
  const usdc = USDC_ADDRESS.toLowerCase()
  const argus = ARGUS_TOKEN.toLowerCase()

  if (pool.length === 42) {
    const [t0, t1, fee] = await Promise.all([
      client.readContract({ address: pool as Address, abi: V3_POOL, functionName: 'token0' }),
      client.readContract({ address: pool as Address, abi: V3_POOL, functionName: 'token1' }),
      client.readContract({ address: pool as Address, abi: V3_POOL, functionName: 'fee' }),
    ])
    const pair = [t0.toLowerCase(), t1.toLowerCase()]
    if (!pair.includes(t) || !pair.includes(usdc)) return null
    return { kind: 'v3', fee: Number(fee) }
  }

  const key = await v4KeyFor(pool as Hex)
  if (!key) return null
  const sides = [key.currency0.toLowerCase(), key.currency1.toLowerCase()]
  if (!sides.includes(t)) return null
  if (sides.includes(usdc)) return { kind: 'v4', buyKeys: [key], sellKeys: [key], via: 'USDC' }
  if (sides.includes(argus)) return { kind: 'v4', buyKeys: [ARGUS_USDC_KEY, key], sellKeys: [key, ARGUS_USDC_KEY], via: 'ARGUS' }
  return null
}
