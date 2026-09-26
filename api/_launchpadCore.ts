// ArcLaunchpad index helpers, shared by /api/launchpad and the browser's
// fallback. (The leading underscore keeps Vercel from deploying this file as
// its own function.)
//
//   TokenLaunched(address indexed token, address indexed creator,
//                 string name, string symbol, string metadataURI, uint256 creatorTaxBps)
//   Trade(address indexed token, address indexed trader, bool isBuy,
//         uint256 usdcAmount, uint256 tokenAmount, uint256 totalFee,
//         uint256 rUsdcAfter, uint256 rTokenAfter)
//
// The contract never stores a token's metadataURI (image, description,
// socials): it's only in the TokenLaunched event, so the index keeps it.

import type { RawLog } from './_arcLogs'
import { topicAddress, word } from './_arcSwaps'

export const ARC_LAUNCHPAD = '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67'
/** keccak256 of the event signatures above (checked in scripts/test-launchpad-index.ts). */
export const TOKEN_LAUNCHED = '0x82d0fd386ffcc6b177b384681464c3265136e7ca2c3602aed668a1d641e0934f'
export const CURVE_TRADE = '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3'
/** Where each known launchpad's logs start (its deploy block). */
export const DEPLOY_BLOCKS: Record<string, number> = { [ARC_LAUNCHPAD]: 22_461_045 }

export interface LaunchMeta {
  description?: string
  image?: string
  website?: string
  twitter?: string
  telegram?: string
}

export interface Launch {
  token: string
  creator: string
  name: string
  symbol: string
  metadataURI: string
  creatorTaxBps: number
  block: number
  ts: number // unix seconds
  tx: string
  meta: LaunchMeta | null
}

/** [token, trader, isBuy, usdc, tokens, fee, rUsdcAfter, rTokenAfter, block, ts, tx, logIndex]
 * — amounts are raw integers as strings (USDC 6 decimals, tokens 18). */
export type TradeRow = [string, string, 0 | 1, string, string, string, string, string, number, number, string, number]

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16))

/** The `i`-th head slot of ABI-encoded data, read as a dynamic string. */
function abiString(data: string, i: number): string | null {
  try {
    const off = Number(BigInt('0x' + word(data, i)))
    if (off % 32 !== 0) return null
    const at = off / 32
    const len = Number(BigInt('0x' + word(data, at)))
    if (len > 10_000) return null
    const start = 2 + (at + 1) * 64
    const hex = data.slice(start, start + len * 2)
    if (hex.length !== len * 2) return null
    return new TextDecoder().decode(hexToBytes(hex))
  } catch { return null }
}

/** Control and bidirectional-override characters out, length capped. */
export function cleanText(s: string, max = 64): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max)
}

export function decodeLaunch(l: RawLog): Launch | null {
  if (l.topics[0] !== TOKEN_LAUNCHED || l.topics.length < 3) return null
  const taxWord = word(l.data, 3)
  return {
    token: topicAddress(l.topics[1]),
    creator: topicAddress(l.topics[2]),
    name: cleanText(abiString(l.data, 0) ?? '') || 'Unknown',
    symbol: cleanText(abiString(l.data, 1) ?? '', 24) || '???',
    metadataURI: (abiString(l.data, 2) ?? '').slice(0, 100_000),
    creatorTaxBps: taxWord ? Number(BigInt('0x' + taxWord)) : 0,
    block: parseInt(l.blockNumber, 16),
    ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0,
    tx: l.transactionHash.toLowerCase(),
    meta: null,
  }
}

export function decodeTrade(l: RawLog): TradeRow | null {
  if (l.topics[0] !== CURVE_TRADE || l.topics.length < 3 || l.data.length < 2 + 64 * 6) return null
  const n = (i: number) => BigInt('0x' + word(l.data, i)).toString()
  return [
    topicAddress(l.topics[1]), topicAddress(l.topics[2]), BigInt('0x' + word(l.data, 0)) === 0n ? 0 : 1,
    n(1), n(2), n(3), n(4), n(5),
    parseInt(l.blockNumber, 16), l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0,
    l.transactionHash.toLowerCase(), parseInt(l.logIndex, 16),
  ]
}

const HTTPS = /^https:\/\/[^\s"'<>]+$/i

/** ipfs:// → a public gateway; anything but https (or ipfs) → dropped. */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined
  const s = u.trim().slice(0, 500)
  if (s.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${s.slice(7).replace(/^ipfs\//, '')}`
  return HTTPS.test(s) ? s : undefined
}

/** Only the fields ARCDEX shows, as plain strings, capped. */
export function sanitizeMeta(j: unknown): LaunchMeta | null {
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? cleanText(v, max) : undefined)
  const handle = (v: unknown) => {
    const s = str(v, 200)
    if (!s) return undefined
    return safeUrl(s) ?? (/^@?[A-Za-z0-9_]{1,40}$/.test(s) ? s : undefined)
  }
  const meta: LaunchMeta = {
    description: typeof o.description === 'string' ? o.description.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 600) || undefined : undefined,
    image: safeUrl(o.image),
    website: safeUrl(o.website),
    twitter: handle(o.twitter),
    telegram: handle(o.telegram),
  }
  return Object.values(meta).some(Boolean) ? meta : null
}

/** A metadataURI's JSON: inline (data:) or hosted (https/ipfs), size- and time-capped. */
export async function resolveMeta(uri: string, fetchImpl: typeof fetch = fetch): Promise<LaunchMeta | null> {
  if (!uri) return null
  try {
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',')
      if (comma < 0 || !/^data:application\/json/i.test(uri)) return null
      const head = uri.slice(0, comma), body = uri.slice(comma + 1)
      const text = /;base64$/i.test(head)
        ? new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0)))
        : decodeURIComponent(body)
      return sanitizeMeta(JSON.parse(text))
    }
    const url = safeUrl(uri)
    if (!url) return null
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000) })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > 64_000) return null
    return sanitizeMeta(JSON.parse(text))
  } catch { return null }
}

export interface LaunchStats {
  vol24: number
  buys24: number
  sells24: number
  trades24: number
  trades: number
  traders: number
  lastPrice: number | null
  lastTradeTs: number | null
  /** Price change over the last 24h in % (since launch for a younger coin). */
  change24?: number
  /** Its price over the same window, oldest first: the opening price, then
   * SPARK_POINTS closes. Optional: responses cached before it existed lack it. */
  spark?: number[]
}

const INITIAL_VIRTUAL_USDC = 8_000_000_000n // $8,000 (6 decimals)
const VIRTUAL_TOKEN_OFFSET = 200_000_000n * 10n ** 18n
const CURVE_TOKENS = 950_000_000n * 10n ** 18n // 95% of the 1B supply opens the curve
export const SPARK_POINTS = 24

/** Curve price (USD per whole token) from real reserves (6 and 18 decimals). */
export function spotPrice(rUsdc: bigint, rToken: bigint): number {
  return Number(INITIAL_VIRTUAL_USDC + rUsdc) / 1e6 / (Number(rToken + VIRTUAL_TOKEN_OFFSET) / 1e18)
}

/** Curve price (USD per whole token) after a trade, from its real reserves. */
export function priceAfter(t: TradeRow): number {
  return spotPrice(BigInt(t[6]), BigInt(t[7]))
}

/** A coin's price before its first trade. */
export const OPENING_PRICE = spotPrice(0n, CURVE_TOKENS)

const sig = (p: number) => Number(p.toPrecision(5))

/** A coin's 24h change and its price line over the last 24h (since launch
 * for a younger coin): the window's opening price, then one close per
 * 1/SPARK_POINTS of it. `trades` in time order, as the index keeps them. */
export function trendOf(trades: TradeRow[], nowSec: number, launchedTs?: number): { change24: number; spark: number[] } {
  const start = Math.max(nowSec - 86_400, launchedTs ?? trades[0]?.[9] ?? 0)
  const span = Math.max(1, nowSec - start)
  let i = 0, price = OPENING_PRICE
  while (i < trades.length && trades[i][9] < start) price = priceAfter(trades[i++])
  const open = price
  const spark = [sig(open)]
  for (let k = 1; k <= SPARK_POINTS; k++) {
    const end = k === SPARK_POINTS ? Infinity : start + (span * k) / SPARK_POINTS
    while (i < trades.length && trades[i][9] <= end) price = priceAfter(trades[i++])
    spark.push(sig(price))
  }
  return { change24: open > 0 ? (price / open - 1) * 100 : 0, spark }
}

export function statsOf(trades: TradeRow[], nowSec = Math.floor(Date.now() / 1000), launchedTs?: number): LaunchStats {
  const day = trades.filter(t => nowSec - t[9] < 86_400)
  const last = trades.length ? trades[trades.length - 1] : null
  return {
    vol24: day.reduce((s, t) => s + Number(t[3]) / 1e6, 0),
    buys24: day.filter(t => t[2] === 1).length,
    sells24: day.filter(t => t[2] === 0).length,
    trades24: day.length,
    trades: trades.length,
    traders: new Set(trades.map(t => t[1])).size,
    lastPrice: last ? priceAfter(last) : null,
    lastTradeTs: last ? last[9] : null,
    ...trendOf(trades, nowSec, launchedTs),
  }
}
