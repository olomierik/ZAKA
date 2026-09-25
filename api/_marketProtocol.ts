// The ARCDEX market engine's wire protocol — shared by the engine (engine/)
// and the frontend (src/arcdex/api/marketStream.ts), so both sides always
// agree. (The leading underscore keeps Vercel from deploying this file as
// its own function.)
//
// WebSocket: wss://api.arcdex.online/ws
//   client → server   {"action":"subscribe","channel":"token","token":"0x…"}
//                     {"action":"subscribe","channel":"candles","token":"0x…","interval":"1m"}
//                     {"action":"subscribe","channel":"new_tokens"}
//                     {"action":"unsubscribe", …same fields}
//                     {"action":"ping"}
//   server → client   {"t":"TRADE","k":"0x…token","d":{…WireTrade}}
//                     {"t":"PRICE_UPDATE","k":…,"d":{…}}   … see ServerMessage
// Payloads use short keys: they go out on every trade, to every viewer.
// `token` carries everything for one token (TRADE, PRICE, VOLUME, LIQUIDITY
// updates); `trades`/`price`/`volume`/`liquidity` are single-event subsets —
// subscribe to one or the other, or events arrive twice. NEW_TOKEN goes to
// `new_tokens`; `market` carries TICKS (all tokens, once a second).

export const CHANNELS = ['token', 'trades', 'price', 'volume', 'liquidity', 'candles', 'new_tokens', 'market'] as const
export type Channel = (typeof CHANNELS)[number]
/** Channels that need a token address. */
export const TOKEN_CHANNELS: readonly Channel[] = ['token', 'trades', 'price', 'volume', 'liquidity', 'candles']

export const INTERVALS = { '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 } as const
export type Interval = keyof typeof INTERVALS
export const INTERVAL_LIST = Object.keys(INTERVALS) as Interval[]

export const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
export const isInterval = (v: unknown): v is Interval => typeof v === 'string' && Object.prototype.hasOwnProperty.call(INTERVALS, v)

export interface ClientMessage {
  action: 'subscribe' | 'unsubscribe' | 'ping'
  channel?: Channel
  token?: string
  interval?: Interval
}

/** Validates a raw client message. Returns the message or an error code. */
export function parseClientMessage(raw: unknown): ClientMessage | { error: string } {
  if (typeof raw !== 'string' || raw.length > 1024) return { error: 'too_large' }
  let m: unknown
  try { m = JSON.parse(raw) } catch { return { error: 'bad_json' } }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'bad_message' }
  const o = m as Record<string, unknown>
  if (o.action === 'ping') return { action: 'ping' }
  if (o.action !== 'subscribe' && o.action !== 'unsubscribe') return { error: 'bad_action' }
  if (typeof o.channel !== 'string' || !(CHANNELS as readonly string[]).includes(o.channel)) return { error: 'bad_channel' }
  const channel = o.channel as Channel
  const out: ClientMessage = { action: o.action, channel }
  if (TOKEN_CHANNELS.includes(channel)) {
    if (!isAddress(o.token)) return { error: 'bad_token' }
    out.token = o.token.toLowerCase()
  }
  if (channel === 'candles') {
    if (!isInterval(o.interval)) return { error: 'bad_interval' }
    out.interval = o.interval
  }
  return out
}

/** The pub/sub topic a subscription maps to. */
export function topicOf(m: { channel: Channel; token?: string; interval?: string }): string {
  if (m.channel === 'new_tokens' || m.channel === 'market') return m.channel
  if (m.channel === 'candles') return `candles:${m.token}:${m.interval}`
  return `${m.channel}:${m.token}`
}

// ── normalized objects ───────────────────────────────────────────────────

/** One normalized trade (REST form — full field names). */
export interface Trade {
  tradeId: string          // txHash:logIndex — the dedupe key
  chain: 'ARC'
  token: string            // the base token being traded
  pair: string             // "<token>/<quote>"
  pool: string             // v4 PoolId, v3 pool address, or launchpad contract
  quote: string            // quote token address (0x0 = native USDC)
  side: 'BUY' | 'SELL' | 'UNKNOWN'
  baseAmount: number       // = tokenAmount
  quoteAmount: number
  tokenAmount: number
  price: number            // quote per token, pool price right after the trade
  priceUsd: number | null
  usdValue: number | null
  wallet: string | null    // the transaction's sender
  txHash: string
  blockNumber: number
  logIndex: number
  timestamp: number        // ms (block time)
  dex: string              // uniswap-v4 | uniswap-v3 | arc-launchpad
  launchpad: string | null // ARGUS | ARCDEX | null
  liquidity: number | null // USD depth of the pool, when calculable
}

/** Compact wire form of a Trade. */
export interface WireTrade {
  id: string; k: string; pl: string; q: string; s: 'B' | 'S' | 'U'
  ba: number; qa: number; p: number; pu: number | null; u: number | null
  w: string | null; tx: string; b: number; li: number; ts: number
  dx: string; lp: string | null; lq: number | null
}

export function toWire(t: Trade): WireTrade {
  return {
    id: t.tradeId, k: t.token, pl: t.pool, q: t.quote, s: t.side === 'BUY' ? 'B' : t.side === 'SELL' ? 'S' : 'U',
    ba: t.baseAmount, qa: t.quoteAmount, p: t.price, pu: t.priceUsd, u: t.usdValue,
    w: t.wallet, tx: t.txHash, b: t.blockNumber, li: t.logIndex, ts: t.timestamp,
    dx: t.dex, lp: t.launchpad, lq: t.liquidity,
  }
}

export function fromWire(w: WireTrade): Trade {
  return {
    tradeId: w.id, chain: 'ARC', token: w.k, pair: `${w.k}/${w.q}`, pool: w.pl, quote: w.q,
    side: w.s === 'B' ? 'BUY' : w.s === 'S' ? 'SELL' : 'UNKNOWN',
    baseAmount: w.ba, quoteAmount: w.qa, tokenAmount: w.ba, price: w.p, priceUsd: w.pu, usdValue: w.u,
    wallet: w.w, txHash: w.tx, blockNumber: w.b, logIndex: w.li, timestamp: w.ts,
    dex: w.dx, launchpad: w.lp, liquidity: w.lq,
  }
}

/** [bucket start (unix s), open, high, low, close, volume USD, trades] — prices in USD. */
export type WireCandle = [number, number, number, number, number, number, number]

export interface TokenStats {
  priceUsd: number | null
  price: number | null          // in the quote of its main pool
  marketCapUsd: number | null
  liquidityUsd: number | null
  vol24: number; buyVol24: number; sellVol24: number
  buys24: number; sells24: number; trades24: number
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null }
  latestBlock: number
  latestTs: number
}

export interface LaunchInfo {
  token: string
  name: string
  symbol: string
  decimals: number
  creator: string | null
  txHash: string
  blockNumber: number
  timestamp: number             // ms
  pool: string | null
  quote: string | null
  launchpad: string             // ARGUS | ARCDEX | …
  chain: 'ARC'
  status: 'LIVE'
  portal?: number
  image?: string | null
  /** Opening price (the pool's initial price) / latest known, and market cap — when known. */
  priceUsd?: number | null
  marketCapUsd?: number | null
}

export type ServerMessage =
  | { t: 'TRADE'; k: string; d: WireTrade }
  | { t: 'PRICE_UPDATE'; k: string; d: { pu: number | null; p: number | null; mc: number | null; b: number; ts: number } }
  | { t: 'VOLUME_UPDATE'; k: string; d: { v: number; bv: number; sv: number; bc: number; sc: number; tc: number } }
  | { t: 'LIQUIDITY_UPDATE'; k: string; d: { lq: number; pl: string; b: number; ts: number } }
  | { t: 'CANDLE_UPDATE'; k: string; i: Interval; d: WireCandle }
  | { t: 'NEW_TOKEN'; k: string; d: LaunchInfo }
  | { t: 'SNAPSHOT'; k: string; d: { stats: TokenStats | null; trades: WireTrade[] } }
  /** market channel, once a second: [token, priceUsd, chg24 %, vol24 USD, mcap USD, trades24] for tokens that traded */
  | { t: 'TICKS'; d: [string, number | null, number | null, number, number | null, number][] }
  | { t: 'SUBSCRIBED' | 'UNSUBSCRIBED'; c: string }
  | { t: 'PONG'; ts: number }
  | { t: 'ERROR'; d: { code: string; msg?: string } }
