// Every Mercuri and SolonPad coin: the index behind the Terminal's rows for
// both launchpads (/api/curves). (The leading underscore keeps Vercel from
// deploying this file as its own function.)
//
// Neither launchpad's coins reached the Terminal: GeckoTerminal lists DEX
// pools, and a coin on its launchpad's bonding curve has none (nor is a
// graduated coin's plain Uniswap pool filed under a launchpad), while the
// market engine only knows launches since it began indexing them. So this
// keeps, per coin:
//   - its launch: both factories' launch events from their deploy blocks
//     (address-filtered, so the whole history is a few hundred getLogs);
//   - its last day of curve trades, in 10-minute buckets (24h volume, buys,
//     sells, the price 24h ago), from the Buy/Sell events of known curves;
//   - its curve's state, read from the chain: price, the USDC in it, how far
//     it is to graduation, and whether it has graduated;
//   - once graduated, its Uniswap pool's market, from GeckoTerminal.
// SolonPad's instant launches (its default mode: no curve, the coin is born
// in a native-USDC Uniswap v4 pool) come from its InstantLaunchStrategy's
// events; their price and liquidity from Uniswap's StateView, their market
// from GeckoTerminal, like a graduated coin's.
// Pure logic, plus `updateIndex` over injected I/O (the endpoint wires the
// network; scripts/test-curve-index.ts fakes it).

import { keccak256, type Hex } from 'viem'
import type { RawLog } from './_arcLogs'
import { NATIVE, liquidityUsd, priceFromSqrt, topicAddress, word } from './_arcSwaps'
import {
  MERCURI_BUY, MERCURI_DEPLOY_BLOCK, MERCURI_FACTORY, MERCURI_SELL, MERCURI_TOKEN_CREATED, SEL,
  SOLONPAD_DEPLOY_BLOCK, SOLONPAD_FACTORY, SOLON_BUY, SOLON_INSTANT_DEPLOY_BLOCK, SOLON_INSTANT_LAUNCHED,
  SOLON_INSTANT_OPEN_TICK, SOLON_INSTANT_SPLITTER, SOLON_INSTANT_STRATEGY, SOLON_SELL, SOLON_TOKEN_LAUNCHED, STATE_VIEW,
  curveVenueOfTopic, decodeCurveTrade, type CurveVenue,
} from './_curves'
import { abiString, cleanText, resolveMeta, safeUrl, sanitizeMeta } from './_launchpadCore'

/** Trades are bucketed by 10 minutes, and a bucket kept for 26 hours. */
export const BUCKET_S = 600
const KEEP_S = 26 * 3600
const DAY_S = 86_400
/** A coin launched this recently is listed whatever it has done. */
const NEW_S = 3 * DAY_S
/** Otherwise listed with at least this much USDC in its curve (or any 24h volume). */
const MIN_LIQUIDITY_USD = 10
/** Arc's block time, for a log that doesn't carry its block's timestamp. */
const BLOCK_S = 0.5
/** A listed coin's state is re-read at least this often; one without a row
 * (curve trades are seen as they happen; an instant launch's are not) hourly. */
const STATE_TTL_MS = 15 * 60_000
const IDLE_STATE_TTL_MS = 60 * 60_000
/** A graduated coin's pool market is re-read this often. */
const GECKO_TTL_MS = 2 * 60_000
/** A metadata file that didn't answer is retried this often. */
const META_RETRY_MS = 30 * 60_000
/** Blocks of trades read on a first build: a day and a bit (Arc makes ~2 blocks a second). */
export const TRADE_HISTORY_BLOCKS = 200_000
/** The most rows one response lists. */
export const MAX_ROWS = 1_000
/** Calls per JSON-RPC batch (providers cap batches at 100 or so). */
export const BATCH_CALLS = 80
/** An instant launch's opening price, USDC per coin (~$4.2K for the 1B supply). */
export const INSTANT_OPEN_PRICE = 1.0001 ** -SOLON_INSTANT_OPEN_TICK
/** An older, quiet instant launch is listed once it's worth this much (bought well past its opening). */
const INSTANT_MIN_CAP_USD = 10_000
/** A pool market not listed yet is re-read this often (listed ones every GECKO_TTL_MS). */
const GECKO_IDLE_TTL_MS = 30 * 60_000

/** [start (unix s), volume USD, buys, sells, price after the bucket's last trade] */
export type Bucket = [number, number, number, number, number]

export interface CurveCoin {
  launchpad: CurveVenue
  /** SolonPad's instant launches: no curve ('' here); they trade in `pool` from birth. */
  mode?: 'instant'
  token: string
  curve: string
  name: string
  symbol: string
  creator: string | null
  block: number
  /** Launch time, unix seconds (0 if unknown). */
  ts: number
  tx: string
  /** Mercuri: the curve's virtual reserves (18-decimal integers, as strings), which price its trade events. */
  vu?: string
  vt?: string
  /** Its metadata's location (the coin's image): Mercuri's launch event, an instant launch's tokenURI(). */
  uri?: string
  /** SolonPad: native USDC raised at which the curve graduates (18 decimals, as a string). */
  goal?: string
  decimals: number
  /** Opening price, USDC per token (null if unknown). */
  open: number | null
  supply: number | null
  image?: string | null
  metaAt?: number
  // The curve's state, last read at `stateAt` (ms).
  priceUsd?: number | null
  liquidityUsd?: number | null
  progress?: number | null
  graduated?: boolean
  stateAt?: number
  /** Once graduated (an instant launch: from birth), its Uniswap pool, and that pool's market (GeckoTerminal). */
  pool?: string | null
  gecko?: { price: number; mcap: number | null; vol: number; liq: number; chg: number; buys: number; sells: number; at: number }
  /** Its pool's quote token (native USDC unless GeckoTerminal says otherwise). */
  quote?: string
  /** The last day and a bit of trades, oldest first. */
  b?: Bucket[]
  /** The price before the oldest kept bucket (carried when a bucket ages out). */
  pre?: number
  /** Last trade seen, unix seconds. */
  last?: number
}

/** One coin as the Terminal gets it. */
export interface CurveMarketRow {
  token: string
  /** Its bonding curve (null for an instant launch, which has none). */
  curve: string | null
  mode: 'curve' | 'instant'
  /** Where it trades: its curve, or its Uniswap pool (graduated, when known, or an instant launch's). */
  pool: string
  /** That market's quote token: native USDC (0x0) on a curve. */
  quote: string
  launchpad: CurveVenue
  name: string
  symbol: string
  image: string | null
  creator: string | null
  /** ms; 0 = unknown */
  launchedAt: number
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  volume24h: number
  buys24h: number
  sells24h: number
  change24h: number
  /** Share of the way to graduation, 0–1 (null once graduated). */
  progress: number | null
  graduated: boolean
  /** ms, or null if none seen */
  lastTradeAt: number | null
}

const big = (w: string) => (w ? BigInt('0x' + w) : 0n)
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a) && a !== NATIVE
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

// ── launches ─────────────────────────────────────────────────────────

/** Both factories' launch events. */
export const LAUNCH_FILTER = { address: [MERCURI_FACTORY, SOLONPAD_FACTORY], topics: [[MERCURI_TOKEN_CREATED, SOLON_TOKEN_LAUNCHED]] }
/** Where the launch history starts. */
export const FIRST_BLOCK = Math.min(MERCURI_DEPLOY_BLOCK, SOLONPAD_DEPLOY_BLOCK)
/** Every curve's trades (any address: a curve counts once a factory has named it). */
export const TRADE_FILTER = { topics: [[MERCURI_BUY, MERCURI_SELL, SOLON_BUY, SOLON_SELL]] }
/** SolonPad's instant launches. */
export const INSTANT_FILTER = { address: [SOLON_INSTANT_STRATEGY], topics: [[SOLON_INSTANT_LAUNCHED]] }

/** A factory's launch event → the coin, or null for anything else (and for
 * SolonPad curves quoted in another ERC-20, a tokenized stock: not traded here). */
export function decodeCurveLaunch(l: RawLog): CurveCoin | null {
  const t0 = l.topics[0], at = l.address.toLowerCase()
  const base = {
    block: parseInt(l.blockNumber, 16),
    ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0,
    tx: l.transactionHash.toLowerCase(),
  }
  if (t0 === MERCURI_TOKEN_CREATED && at === MERCURI_FACTORY) {
    // data: deployer, name, symbol, metadataURI (offsets), configHash, then
    // LaunchConfig inline: virtualUsdc, virtualTokens, curveSupply, poolSupply, …
    if (l.topics.length < 4 || l.data.length < 2 + 64 * 16) return null
    const token = topicAddress(l.topics[1]), curve = topicAddress(l.topics[2]), creator = topicAddress(l.topics[3])
    const vu = big(word(l.data, 5)), vt = big(word(l.data, 6))
    if (!isAddr(token) || !isAddr(curve) || vu === 0n || vt === 0n) return null
    const supply = Number(big(word(l.data, 7)) + big(word(l.data, 8))) / 1e18
    return {
      launchpad: 'Mercuri', token, curve, ...base,
      name: cleanText(abiString(l.data, 1) ?? '') || 'Unknown',
      symbol: cleanText(abiString(l.data, 2) ?? '', 24) || '???',
      creator: isAddr(creator) ? creator : null,
      vu: vu.toString(), vt: vt.toString(),
      uri: (abiString(l.data, 3) ?? '').trim().slice(0, 2_000),
      decimals: 18,
      open: Number(vu) / Number(vt),
      supply: supply > 0 ? supply : null,
    }
  }
  if (t0 === SOLON_TOKEN_LAUNCHED && at === SOLONPAD_FACTORY) {
    // data: pairToken (0 = native USDC), launchConfigId, graduationThreshold
    if (l.topics.length < 4 || l.data.length < 2 + 64 * 3) return null
    const token = topicAddress(l.topics[1]), curve = topicAddress(l.topics[2]), deployer = topicAddress(l.topics[3])
    if (!isAddr(token) || !isAddr(curve) || ('0x' + word(l.data, 0).slice(24)).toLowerCase() !== NATIVE) return null
    // Named from the token itself, on the first state read.
    return {
      launchpad: 'SolonPad', token, curve, ...base, name: '', symbol: '',
      creator: isAddr(deployer) ? deployer : null,
      goal: big(word(l.data, 2)).toString(),
      decimals: 18, open: null, supply: null,
    }
  }
  return null
}

/** SolonPad's InstantLaunchStrategy TokenLaunched → the coin, or null for
 * anything else. Its own launches only: the LP position goes to SolonPad's
 * fee splitter, and the pool is native USDC / the coin, 1%, spacing 100, no
 * hooks — the key the event carries, whose hash must be the pool it names. */
export function decodeInstantLaunch(l: RawLog): CurveCoin | null {
  if (l.topics[0] !== SOLON_INSTANT_LAUNCHED || l.address.toLowerCase() !== SOLON_INSTANT_STRATEGY || l.topics.length < 4 || l.data.length !== 2 + 64 * 5) return null
  const pool = l.topics[1].toLowerCase(), token = topicAddress(l.topics[2]), recipient = topicAddress(l.topics[3])
  if (recipient !== SOLON_INSTANT_SPLITTER || !isAddr(token)) return null
  const addr = (i: number) => ('0x' + word(l.data, i).slice(24)).toLowerCase()
  if (addr(0) !== NATIVE || addr(1) !== token || big(word(l.data, 2)) !== 10_000n || big(word(l.data, 3)) !== 100n || addr(4) !== NATIVE) return null
  if (keccak256(l.data.toLowerCase() as Hex) !== pool) return null
  return {
    launchpad: 'SolonPad', mode: 'instant', token, curve: '', pool, quote: NATIVE,
    block: parseInt(l.blockNumber, 16),
    ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0,
    tx: l.transactionHash.toLowerCase(),
    // Named from the token itself, on the first state read.
    name: '', symbol: '', creator: null, decimals: 18,
    open: INSTANT_OPEN_PRICE, supply: 1_000_000_000,
  }
}

// ── trades ───────────────────────────────────────────────────────────

/** A log's time (unix s): its block's timestamp, else estimated from how far behind the head it is. */
export function logTime(l: RawLog, nowSec: number, head?: number): number {
  if (l.blockTimestamp) return parseInt(l.blockTimestamp, 16)
  return head ? Math.round(nowSec - Math.max(0, head - parseInt(l.blockNumber, 16)) * BLOCK_S) : nowSec
}

/** One of the coin's curve's Buy/Sell logs into its buckets. False if it isn't one. */
export function addTrade(c: CurveCoin, l: RawLog, nowSec: number, head?: number): boolean {
  if (l.address.toLowerCase() !== c.curve || curveVenueOfTopic(l.topics[0]) !== c.launchpad) return false
  const virtual = c.launchpad === 'Mercuri' && c.vu && c.vt ? { usdc: BigInt(c.vu), tokens: BigInt(c.vt) } : undefined
  const d = decodeCurveTrade(l, c.launchpad, virtual)
  if (!d || !Number.isFinite(d.usdc) || !Number.isFinite(d.price) || d.price <= 0) return false
  const ts = logTime(l, nowSec, head)
  const start = Math.floor(ts / BUCKET_S) * BUCKET_S
  const b = (c.b ??= [])
  // Logs arrive in chain order, so almost always into the newest bucket.
  let i = b.length - 1
  while (i >= 0 && b[i][0] > start) i--
  let bucket = i >= 0 && b[i][0] === start ? b[i] : null
  if (!bucket) {
    bucket = [start, 0, 0, 0, d.price]
    b.splice(i + 1, 0, bucket)
  }
  bucket[1] += d.usdc
  if (d.kind === 'buy') bucket[2]++; else bucket[3]++
  bucket[4] = d.price
  c.last = Math.max(c.last ?? 0, ts)
  return true
}

/** Drops buckets older than the kept window, carrying the last price out. */
export function prune(c: CurveCoin, nowSec: number) {
  const b = c.b
  if (!b) return
  let k = 0
  while (k < b.length && b[k][0] + BUCKET_S <= nowSec - KEEP_S) c.pre = b[k++][4]
  if (k) b.splice(0, k)
  if (!b.length) delete c.b
}

export interface CoinStats { vol24: number; buys24: number; sells24: number; change24: number; price: number | null }

/** 24h volume, buys, sells, the current price and its 24h change. */
export function coinStats(c: CurveCoin, nowSec: number): CoinStats {
  const from = nowSec - DAY_S
  let vol24 = 0, buys24 = 0, sells24 = 0
  let before: number | null = null
  let lastClose: number | null = null
  for (const b of c.b ?? []) {
    lastClose = b[4]
    if (b[0] + BUCKET_S <= from) { before = b[4]; continue }
    vol24 += b[1]; buys24 += b[2]; sells24 += b[3]
  }
  // The curve's state, unless a trade came after it was read.
  const traded = lastClose !== null && (c.last ?? 0) * 1000 > (c.stateAt ?? 0)
  // (Never a graduated coin's opening price: its market has moved to its pool.)
  const price = (traded ? lastClose : null) ?? (c.priceUsd && c.priceUsd > 0 ? c.priceUsd : null) ?? lastClose ?? (c.graduated ? null : c.open)
  // The price 24h ago: after the last trade before the window, else the
  // price before every kept bucket, else (a younger coin) its opening price.
  const then = before ?? c.pre ?? (c.ts && c.ts >= from ? c.open : null)
  const change24 = price && then && then > 0 ? (price / then - 1) * 100 : 0
  return { vol24, buys24, sells24, change24: Number.isFinite(change24) ? change24 : 0, price }
}

// ── the curve's state ────────────────────────────────────────────────

export interface RpcCallSpec { method: string; params: unknown[] }
const ethCall = (to: string, data: string): RpcCallSpec => ({ method: 'eth_call', params: [{ to, data }, 'latest'] })

const decoder = new TextDecoder('utf-8', { fatal: false })
/** An ERC-20 name()/symbol() result: an ABI string, or bytes32 on older tokens. */
export function erc20Text(r: string | null | undefined): string | null {
  if (!r || r === '0x') return null
  const hex = r.slice(2)
  if (hex.length === 64) return decoder.decode(Uint8Array.from((hex.match(/../g) ?? []).map(b => parseInt(b, 16)).filter(b => b !== 0)))
  return abiString(r, 0)
}
const word0 = (r: string | null | undefined) => (r && /^0x[0-9a-fA-F]{64,}$/.test(r) ? BigInt(r.slice(0, 66)) : null)
const quantity = (r: string | null | undefined) => (r && /^0x[0-9a-fA-F]+$/.test(r) ? BigInt(r) : null)

/** The calls that read a coin's state (and, the first time, its supply and
 * name), and how to apply their answers. `apply` is false when the curve
 * didn't answer: the coin keeps its last state and is read again soon. */
export function stateRead(c: CurveCoin): { calls: RpcCallSpec[]; apply: (r: (string | null)[], nowMs: number) => boolean } {
  const needSupply = c.supply == null
  if (c.mode === 'instant') {
    // Its pool, from Uniswap's StateView; the first time also its name and metadata.
    const id = (c.pool ?? '').slice(2)
    const needName = !c.symbol
    const calls = [ethCall(STATE_VIEW, SEL.getSlot0 + id), ethCall(STATE_VIEW, SEL.getLiquidity + id)]
    if (needName) calls.push(ethCall(c.token, SEL.decimals), ethCall(c.token, SEL.name), ethCall(c.token, SEL.symbol), ethCall(c.token, SEL.tokenURI))
    return {
      calls,
      apply(r, nowMs) {
        const sqrtPrice = word0(r[0]), liquidity = word0(r[1])
        if (sqrtPrice === null || sqrtPrice === 0n || liquidity === null) return false
        if (needName) {
          const dec = word0(r[2]), name = erc20Text(r[3]), symbol = erc20Text(r[4]), uri = erc20Text(r[5])
          if (dec === null && !symbol) return false
          if (dec !== null && dec <= 36n) c.decimals = Number(dec)
          c.name = cleanText(name ?? '') || 'Unknown'
          c.symbol = cleanText(symbol ?? '', 24) || '???'
          if (uri && uri.length <= 12_000) c.uri = uri.trim()
        }
        // currency0 is native USDC (18 decimals), currency1 the coin.
        c.priceUsd = priceFromSqrt(sqrtPrice, false, c.decimals, 18)
        c.liquidityUsd = liquidityUsd(liquidity, sqrtPrice, true, 18, 1) ?? 0
        c.stateAt = nowMs
        return true
      },
    }
  }
  if (c.launchpad === 'Mercuri') {
    const calls = [ethCall(c.curve, SEL.phase), ethCall(c.curve, SEL.price), ethCall(c.curve, SEL.progressBps), { method: 'eth_getBalance', params: [c.curve, 'latest'] }]
    if (needSupply) calls.push(ethCall(c.token, SEL.totalSupply))
    return {
      calls,
      apply(r, nowMs) {
        const phase = word0(r[0]), price = word0(r[1]), progress = word0(r[2]), balance = quantity(r[3])
        if (phase === null || price === null || progress === null) return false
        c.graduated = phase === 2n
        c.priceUsd = Number(price) / 1e18 // native wei per whole token
        c.progress = Math.min(1, Number(progress) / 10_000)
        if (balance !== null) c.liquidityUsd = Number(balance) / 1e18
        const s = needSupply ? word0(r[4]) : null
        if (s !== null && s > 0n) c.supply = Number(s) / 1e18
        c.stateAt = nowMs
        return true
      },
    }
  }
  const needName = !c.symbol
  const calls = [ethCall(c.curve, SEL.graduated), ethCall(c.curve, SEL.getReserves), ethCall(c.curve, SEL.realQuoteReserve)]
  if (needName) calls.push(ethCall(c.token, SEL.decimals), ethCall(c.token, SEL.name), ethCall(c.token, SEL.symbol))
  if (needSupply) calls.push(ethCall(c.token, SEL.totalSupply))
  return {
    calls,
    apply(r, nowMs) {
      const graduated = word0(r[0]), reserves = r[1], real = word0(r[2])
      if (graduated === null || real === null || !reserves || reserves.length < 2 + 128) return false
      let k = 3
      if (needName) {
        const dec = word0(r[k]), name = erc20Text(r[k + 1]), symbol = erc20Text(r[k + 2])
        k += 3
        // No answer from the token at all: read it again next time (a
        // token that answers but has no symbol is shown as ???).
        if (dec === null && !symbol) return false
        if (dec !== null && dec <= 36n) c.decimals = Number(dec)
        c.name = cleanText(name ?? '') || 'Unknown'
        c.symbol = cleanText(symbol ?? '', 24) || '???'
      }
      const q = BigInt('0x' + reserves.slice(2, 66)), t = BigInt('0x' + reserves.slice(66, 130))
      const unit = 10 ** c.decimals
      c.graduated = graduated !== 0n
      c.priceUsd = t > 0n ? (Number(q) / 1e18) / (Number(t) / unit) : null
      c.liquidityUsd = Number(real) / 1e18
      const goal = c.goal ? BigInt(c.goal) : 0n
      c.progress = goal > 0n ? Math.min(1, Number(real) / Number(goal)) : null
      if (c.open === null && c.priceUsd && !c.b?.length && !c.last) c.open = c.priceUsd
      const s = needSupply ? word0(r[k]) : null
      if (s !== null && s > 0n) c.supply = Number(s) / unit
      c.stateAt = nowMs
      return true
    },
  }
}

/** Whose state to read this round, most urgent first: coins never read
 * (newest first), curves that just traded, curves about to graduate, then
 * the stalest live ones. A graduated curve no longer changes. */
export function pickForRefresh(coins: CurveCoin[], traded: Set<string>, nowMs: number, max: number): CurveCoin[] {
  const nowSec = Math.floor(nowMs / 1000)
  const never = coins.filter(c => c.stateAt === undefined).sort((a, b) => b.block - a.block)
  const rest = coins.filter(c => c.stateAt !== undefined && !c.graduated)
  const hot = rest.filter(c => traded.has(c.curve))
  const closing = rest.filter(c => !traded.has(c.curve) && (c.progress ?? 0) >= 0.98)
  const stale = rest.filter(c => !traded.has(c.curve) && (c.progress ?? 0) < 0.98
    && nowMs - (c.stateAt ?? 0) > (isListed(c, nowSec) ? STATE_TTL_MS : IDLE_STATE_TTL_MS))
    .sort((a, b) => (a.stateAt ?? 0) - (b.stateAt ?? 0))
  return [...never, ...hot, ...closing, ...stale].slice(0, max)
}

// ── graduated coins: their pool's market (GeckoTerminal) ─────────────

interface GtRef { id: string; type?: string }
interface GtItem { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: GtRef | GtRef[] }> }
export interface GtTokens { data?: GtItem[]; included?: GtItem[] }

export const geckoPath = (tokens: string[]) => `/networks/arc/tokens/multi/${tokens.join(',')}?include=top_pools`

/** Coins trading in a Uniswap pool (graduated, or instant launches) whose
 * pool market is due for a refresh; one without a row yet less often. */
export function dueForGecko(coins: CurveCoin[], nowMs: number, max: number): CurveCoin[] {
  const nowSec = Math.floor(nowMs / 1000)
  return coins.filter(c => (c.graduated || c.mode === 'instant')
    && (!c.gecko || nowMs - c.gecko.at > (isListed(c, nowSec) ? GECKO_TTL_MS : GECKO_IDLE_TTL_MS)))
    .sort((a, b) => (a.gecko?.at ?? 0) - (b.gecko?.at ?? 0)).slice(0, max)
}

/** GeckoTerminal's tokens/multi answer into the coins (by token). */
export function applyGecko(byToken: Map<string, CurveCoin>, res: GtTokens | null, nowMs: number): number {
  const pools = new Map((res?.included ?? []).filter(i => i.type === 'pool').map(p => [p.id, p]))
  const idAddress = (ref: GtRef | GtRef[] | undefined) => (Array.isArray(ref) ? '' : ref?.id ?? '').replace(/^[^_]*_/, '').toLowerCase()
  let n = 0
  for (const t of res?.data ?? []) {
    const a = t.attributes ?? {}
    const c = byToken.get(str(a.address).toLowerCase())
    if (!c) continue
    const top = t.relationships?.top_pools?.data
    const first = Array.isArray(top) ? top[0] : undefined
    const poolItem = first ? pools.get(first.id) : undefined
    const pool = poolItem?.attributes
    const poolAddr = (str(pool?.address) || (first?.id ?? '').replace(/^[^_]*_/, '')).toLowerCase()
    const quote = idAddress(poolItem?.relationships?.quote_token?.data)
    const tx = ((pool?.transactions as Record<string, Record<string, unknown>> | undefined)?.h24) ?? {}
    const mcap = num(a.market_cap_usd) || num(a.fdv_usd)
    c.gecko = {
      price: num(a.price_usd),
      mcap: mcap > 0 ? mcap : null,
      vol: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      liq: num(a.total_reserve_in_usd),
      chg: num((pool?.price_change_percentage as Record<string, unknown> | undefined)?.h24),
      buys: num(tx.buys), sells: num(tx.sells),
      at: nowMs,
    }
    // (An instant launch keeps the pool it was born in.)
    if (c.mode !== 'instant' && /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(poolAddr)) {
      c.pool = poolAddr
      c.quote = /^0x[0-9a-f]{40}$/.test(quote) ? quote : undefined
    }
    n++
  }
  return n
}

// ── image ────────────────────────────────────────────────────────────

/** A coin's image: its metadata JSON's `image` (hosted, a data: URI, or the
 * JSON itself), or the URI itself when it is one. */
export async function coinImage(uri: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!uri) return null
  if (/^\s*\{/.test(uri)) { try { return sanitizeMeta(JSON.parse(uri))?.image ?? null } catch { return null } }
  const direct = safeUrl(uri)
  if (direct && /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(direct)) return direct
  return (await resolveMeta(uri, fetchImpl))?.image ?? null
}

/** Listed coins still without an image. */
export function dueForImage(coins: CurveCoin[], nowSec: number, nowMs: number, max: number): CurveCoin[] {
  return coins.filter(c => c.uri && !c.image && (!c.metaAt || nowMs - c.metaAt > META_RETRY_MS) && isListed(c, nowSec))
    .sort((a, b) => b.block - a.block).slice(0, max)
}

// ── the list ─────────────────────────────────────────────────────────

/** Worth a row: named, and graduated, traded in the last day, holding $10
 * or more, or launched in the last three days. An instant launch (always
 * holding its whole supply in its pool): launched in the last three days,
 * traded in the last day, or worth $10K or more. */
export function isListed(c: CurveCoin, nowSec: number): boolean {
  if (!c.symbol) return false
  if (c.mode === 'instant') {
    if (c.ts > 0 && nowSec - c.ts < NEW_S) return true
    if ((c.gecko?.vol ?? 0) > 0) return true
    const price = (c.gecko?.price ?? 0) || (c.priceUsd ?? 0)
    return price * (c.supply ?? 0) >= INSTANT_MIN_CAP_USD
  }
  if (c.graduated) return true
  if (coinStats(c, nowSec).vol24 > 0) return true
  if ((c.liquidityUsd ?? 0) >= MIN_LIQUIDITY_USD) return true
  return c.ts > 0 && nowSec - c.ts < NEW_S
}

export function toRow(c: CurveCoin, nowSec: number): CurveMarketRow {
  const s = coinStats(c, nowSec)
  const instant = c.mode === 'instant'
  const g = c.graduated || instant ? c.gecko : undefined
  const price = g && g.price > 0 ? g.price : s.price
  const cap = g?.mcap ?? (price && c.supply ? price * c.supply : null)
  return {
    token: c.token,
    curve: instant ? null : c.curve,
    mode: instant ? 'instant' : 'curve',
    pool: instant ? c.pool ?? '' : (c.graduated && c.pool) || c.curve,
    quote: !instant && c.graduated && c.pool && c.quote ? c.quote : NATIVE,
    launchpad: c.launchpad,
    name: c.name,
    symbol: c.symbol,
    image: c.image ?? null,
    creator: c.creator,
    launchedAt: c.ts * 1000,
    priceUsd: price,
    marketCapUsd: cap,
    liquidityUsd: g ? g.liq : c.liquidityUsd ?? null,
    volume24h: s.vol24 + (g?.vol ?? 0),
    buys24h: s.buys24 + (g?.buys ?? 0),
    sells24h: s.sells24 + (g?.sells ?? 0),
    change24h: g ? g.chg : s.change24,
    progress: c.graduated || instant ? null : c.progress ?? null,
    graduated: !!c.graduated,
    lastTradeAt: c.last ? c.last * 1000 : null,
  }
}

/** The listed coins, busiest first. */
export function listRows(coins: CurveCoin[], nowSec: number): CurveMarketRow[] {
  return coins.filter(c => isListed(c, nowSec)).map(c => toRow(c, nowSec))
    .sort((a, b) => b.volume24h - a.volume24h || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || b.launchedAt - a.launchedAt)
    .slice(0, MAX_ROWS)
}

// ── one update ───────────────────────────────────────────────────────

export interface IndexState {
  /** Last block of the launch history read (FIRST_BLOCK - 1 before any). */
  launchesTo: number
  /** Last block of SolonPad's instant launches read (absent in an index from before they were). */
  instantTo?: number
  /** Last block of curve trades read. */
  tradesTo: number
  coins: CurveCoin[]
  head: number
  updatedAt: number
}

export interface IndexIO {
  head(): Promise<number>
  /** Logs in [from, to]; `scannedTo` = the last block of the contiguous prefix read. */
  scan(filter: { address?: string[]; topics: (string | string[])[] }, from: number, to: number, head: number, deadline: number): Promise<{ logs: RawLog[]; scannedTo: number }>
  /** Answers in order; a failed call is null. */
  batch(calls: RpcCallSpec[]): Promise<(string | null)[]>
  gecko?(path: string): Promise<GtTokens | null>
  image?(uri: string): Promise<string | null>
}

export function emptyState(head: number): IndexState {
  return { launchesTo: FIRST_BLOCK - 1, instantTo: SOLON_INSTANT_DEPLOY_BLOCK - 1, tradesTo: Math.max(FIRST_BLOCK, head - TRADE_HISTORY_BLOCKS) - 1, coins: [], head, updatedAt: 0 }
}

/** Launches and trades up to the chain's head, then state reads, pool
 * markets and images as time allows. Mutates and returns `s`. */
export async function updateIndex(s: IndexState, io: IndexIO, budgetMs: number, now = () => Date.now()): Promise<IndexState> {
  const start = now()
  const left = () => start + budgetMs - now()
  const head = await io.head()
  s.head = Math.max(s.head, head)

  // 1. Launches (the whole history on a first build, in steps): the curve
  // factories', then SolonPad's instant launches (on a cursor of their own).
  const known = new Set(s.coins.map(c => c.token))
  const addLaunches = (logs: RawLog[], decode: (l: RawLog) => CurveCoin | null) => {
    const nowSec = Math.floor(now() / 1000)
    for (const l of logs) {
      const c = decode(l)
      if (!c || known.has(c.token)) continue
      if (!c.ts) c.ts = logTime(l, nowSec, head)
      s.coins.push(c)
      known.add(c.token)
    }
  }
  if (s.launchesTo < head) {
    const r = await io.scan(LAUNCH_FILTER, s.launchesTo + 1, head, head, start + budgetMs * 0.6)
    addLaunches(r.logs, decodeCurveLaunch)
    s.launchesTo = Math.max(s.launchesTo, r.scannedTo)
  }
  const instantTo = s.instantTo ?? SOLON_INSTANT_DEPLOY_BLOCK - 1
  s.instantTo = instantTo
  if (instantTo < head && left() > 1_500) {
    const r = await io.scan(INSTANT_FILTER, instantTo + 1, head, head, start + budgetMs * 0.65)
    addLaunches(r.logs, decodeInstantLaunch)
    s.instantTo = Math.max(instantTo, r.scannedTo)
  }

  // 2. Trades, once every curve they could come from is known.
  const traded = new Set<string>()
  const nowSec = Math.floor(now() / 1000)
  if (s.launchesTo >= head && s.tradesTo < head && left() > 1_500) {
    const byCurve = new Map(s.coins.map(c => [c.curve, c]))
    const r = await io.scan(TRADE_FILTER, s.tradesTo + 1, head, head, start + budgetMs * 0.8)
    for (const l of r.logs) {
      const c = byCurve.get(l.address.toLowerCase())
      if (c && addTrade(c, l, nowSec, head)) traded.add(c.curve)
    }
    s.tradesTo = Math.max(s.tradesTo, r.scannedTo)
  }
  for (const c of s.coins) prune(c, nowSec)

  // 3. Curve state, in batches of at most BATCH_CALLS calls, for as long as time allows.
  const reads = pickForRefresh(s.coins, traded, now(), 200).map(stateRead)
  for (let i = 0; i < reads.length && left() > 1_000;) {
    const group = [reads[i++]]
    let n = group[0].calls.length
    while (i < reads.length && n + reads[i].calls.length <= BATCH_CALLS) { n += reads[i].calls.length; group.push(reads[i++]) }
    const res = await io.batch(group.flatMap(g => g.calls)).catch(() => null)
    if (!res) break
    let k = 0
    const t = now()
    for (const g of group) { g.apply(res.slice(k, k + g.calls.length), t); k += g.calls.length }
  }

  // 4. Pool markets: graduated coins and instant launches.
  if (io.gecko && left() > 1_500) {
    const due = dueForGecko(s.coins, now(), 60)
    const byToken = new Map(due.map(c => [c.token, c]))
    for (let i = 0; i < due.length && left() > 1_000; i += 30) {
      const res = await io.gecko(geckoPath(due.slice(i, i + 30).map(c => c.token))).catch(() => null)
      applyGecko(byToken, res, now())
    }
  }

  // 5. Images for listed coins with metadata (Mercuri, instant launches).
  if (io.image && left() > 2_000) {
    const due = dueForImage(s.coins, nowSec, now(), 6)
    await Promise.all(due.map(async c => {
      const img = await io.image!(c.uri!).catch(() => null)
      c.metaAt = now()
      if (img) { c.image = img; delete c.uri }
    }))
  }

  s.updatedAt = now()
  return s
}
