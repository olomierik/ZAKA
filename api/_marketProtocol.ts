// The ARCDEX market engine's wire protocol — shared by the engine (engine/)
// and the frontend (src/arcdex/api/marketStream.ts), so both sides always
// agree. (The leading underscore keeps Vercel from deploying this file as
// its own function.)
//
// WebSocket: wss://api.arcdex.online/ws
//   client → server   {"action":"subscribe","channel":"token","token":"0x…"}
//                     {"action":"subscribe","channel":"candles","token":"0x…","interval":"1m"}
//                     {"action":"subscribe","channel":"new_tokens"}
//                     {"action":"subscribe","channel":"signals"}   trading signals and the bot's positions
//                     {"action":"unsubscribe", …same fields}
//                     {"action":"ping"}
//   server → client   {"t":"TRADE","k":"0x…token","d":{…WireTrade}}
//                     {"t":"PRICE_UPDATE","k":…,"d":{…}}   … see ServerMessage
// Payloads use short keys: they go out on every trade, to every viewer.
// `token` carries everything for one token (TRADE, PRICE, VOLUME, LIQUIDITY
// updates); `trades`/`price`/`volume`/`liquidity` are single-event subsets —
// subscribe to one or the other, or events arrive twice. NEW_TOKEN goes to
// `new_tokens`; `market` carries TICKS (all tokens, once a second).

export const CHANNELS = ['token', 'trades', 'price', 'volume', 'liquidity', 'candles', 'new_tokens', 'market', 'signals', 'scan'] as const
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
  if (m.channel === 'new_tokens' || m.channel === 'market' || m.channel === 'signals' || m.channel === 'scan') return m.channel
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
  /** The contract the launch transaction was sent to (generic v4 launches). */
  entry?: string
  /** Found from the pool's Initialize (engine/src/launchpads/v4Launches.ts),
   * not a launchpad's own adapter; an adapter's report replaces it. */
  generic?: boolean
  image?: string | null
  /** Opening price (the pool's initial price) / latest known, and market cap — when known. */
  priceUsd?: number | null
  marketCapUsd?: number | null
}

/** One safety check of a coin (engine/src/intel/scanner.ts). */
export interface SafetyCheck { id: string; ok: boolean | null; hard: boolean; /** Doesn't block: failing it makes the coin risky (a scalp). */ risk?: boolean; detail: string }

/** A trading signal (engine/src/bot/bot.ts): market rules met and every hard safety check passed.
 * A scalp is a snipe on a coin that failed a risk check: traded small and out fast. */
export interface TradeSignal {
  id: string
  strategy: 'snipe' | 'second-leg' | 'scalp'
  token: string
  symbol: string
  name: string
  launchpad: string
  at: number
  price: number
  marketCapUsd: number | null
  liquidityUsd: number | null
  ageSec: number
  reasons: string[]
  safety: { verdict: 'pass' | 'risky' | 'fail' | 'pending'; score: number; checks: SafetyCheck[] }
  /** Whether ARCDEX can trade it today. */
  executable: boolean
}

/** A (paper) position the bot opened on a signal (engine/src/trading/paper.ts). */
export interface BotPosition {
  id: string
  strategy: 'snipe' | 'second-leg' | 'scalp'
  token: string
  symbol: string
  launchpad: string
  signalId: string
  openedAt: number
  marketEntry: number
  entryPrice: number
  sizeUsd: number
  qty: number
  remaining: number
  cost: number
  peak: number
  tp1Done: boolean
  fills: { at: number; price: number; qty: number; usd: number; reason: string }[]
  status: 'open' | 'closed'
  closedAt: number | null
  exitReason: string | null
  pnlUsd: number | null
  /** paper (missing on older rows) or live: the bot wallet's real trade. */
  mode?: 'paper' | 'live'
  /** Live: its transactions, the gas they cost, and a sale that keeps failing. */
  txs?: { kind: 'buy' | 'approve' | 'sell'; hash: string; at: number; usd?: number; gasUsd?: number }[]
  gasUsd?: number
  stuck?: string | null
}

/** The bot's mode and live wallet (GET /v1/bot/status). */
export interface BotStatus {
  mode: 'paper' | 'live' | 'off'
  /** The wallet whose signature switches modes (BOT_OWNER_ADDRESS); null: nobody can. */
  owner: string | null
  live: {
    available: boolean
    why: string | null
    wallet: string | null
    balanceUsd: number | null
    limits: { maxTradeUsd: number; dailyLossUsd: number; maxOpen: number; maxOpenScalp: number; slippageBps: number; exitSlippageBps: number[]; reserveUsd: number } | null
    todayPnlUsd: number
    open: number
    events: { at: number; kind: string; text: string; token?: string; symbol?: string; hash?: string }[]
  }
}

/** One coin in the signal engine's scan (GET /v1/bot/scan, the `scan` channel). */
export interface ScanRow {
  token: string
  symbol: string
  launchpad: string
  launchedAt: number
  /** new: no trade yet; watching: the market rules aren't met (yet); checking: the
   * safety scan hasn't finished; rejected: a hard safety check failed; signal: it fired. */
  status: 'new' | 'watching' | 'checking' | 'rejected' | 'signal'
  /** Which rule the reasons are about. */
  stage: 'snipe' | 'second-leg' | 'safety'
  /** Why, in words: unmet rules or failing checks (✗ marks a failure). */
  reasons: string[]
  strategy?: 'snipe' | 'second-leg' | 'scalp'
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  /** When it was last evaluated, and how many times. */
  at: number
  evals: number
}

export interface ScanStats {
  /** Coins the engine is watching (launched in the last 48h). */
  watching: number
  /** Evaluations in the last minute, and when the last one ran. */
  evalsPerMin: number
  lastEvalAt: number | null
  signals24h: number
  rejected24h: number
  byStatus: Record<ScanRow['status'], number>
}

/** A coin found by name, ticker or address (GET /v1/search). */
export interface SearchHit {
  token: string
  symbol: string
  name: string
  launchpad: string
  image: string | null
  pool: string | null
  launchedAt: number | null
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  volume24h: number | null
}

/** How well a coin matches a search (0: not at all): the site's Launchpad matcher, shared. */
export function searchScore(c: { symbol: string; name: string; address: string }, q: string): number {
  if (!q) return 0
  const sym = c.symbol.toLowerCase(), name = c.name.toLowerCase(), addr = c.address.toLowerCase()
  if (sym === q || addr === q) return 6
  if (name === q) return 5
  if (sym.startsWith(q)) return 4
  if (name.startsWith(q) || name.split(/\s+/).some(w => w.startsWith(q))) return 3
  if (sym.includes(q) || name.includes(q)) return 2
  if ((/^0x[0-9a-f]{2,}$/.test(q) && addr.startsWith(q)) || (/^[0-9a-f]{6,}$/.test(q) && addr.includes(q))) return 1
  return 0
}

/** A visitor's paper-trading account on the engine (virtual USDC; GET/POST /v1/paper/account). */
export interface PaperAccountView {
  id: string
  running: boolean
  strategies: ('snipe' | 'second-leg' | 'scalp')[]
  /** USD per trade (scalps use a fifth of it). */
  tradeUsd: number
  cash: number
  deposited: number
  /** Cash plus open positions at the current price. */
  equity: number
  openValue: number
  createdAt: number
  startedAt: number | null
  positions: BotPosition[]
  stats: { closed: number; open: number; wins: number; losses: number; winRate: number | null; totalPnlUsd: number; profitFactor: number | null; expectancyUsd: number | null; maxDrawdownUsd: number }
}

/** What a visitor can do with their paper account (POST /v1/paper/account). */
export type PaperAction =
  | { action: 'deposit'; amount: number }
  | { action: 'start' } | { action: 'stop' }
  | { action: 'strategies'; strategies: ('snipe' | 'second-leg' | 'scalp')[] }
  | { action: 'size'; usd: number }
  | { action: 'reset' }

/** What the owner can tell the bot (POST /v1/bot/control, signed). */
export type BotControl = { action: 'mode'; mode: 'paper' | 'live' } | { action: 'close-live' }

/** The exact text the owner's wallet signs for a control (the engine rebuilds it to check the signature). */
export function botControlMessage(c: BotControl, at: number): string {
  const what = c.action === 'mode'
    ? (c.mode === 'live' ? 'Switch the bot to LIVE trading with real money' : 'Switch the bot to paper trading')
    : 'Sell every live position now'
  return `ARCDEX signal bot\n${what}\nAt: ${new Date(at).toISOString()}`
}

export type ServerMessage =
  | { t: 'SCAN'; d: { rows: ScanRow[]; stats: ScanStats } }
  | { t: 'TRADE'; k: string; d: WireTrade }
  | { t: 'PRICE_UPDATE'; k: string; d: { pu: number | null; p: number | null; mc: number | null; b: number; ts: number } }
  | { t: 'VOLUME_UPDATE'; k: string; d: { v: number; bv: number; sv: number; bc: number; sc: number; tc: number } }
  | { t: 'LIQUIDITY_UPDATE'; k: string; d: { lq: number; pl: string; b: number; ts: number } }
  | { t: 'CANDLE_UPDATE'; k: string; i: Interval; d: WireCandle }
  | { t: 'NEW_TOKEN'; k: string; d: LaunchInfo }
  | { t: 'SNAPSHOT'; k: string; d: { stats: TokenStats | null; trades: WireTrade[] } }
  /** signals channel: a new trading signal, and the bot's positions as they open, fill and close */
  | { t: 'SIGNAL'; d: TradeSignal }
  | { t: 'BOT_POSITION'; d: BotPosition }
  /** market channel, once a second: [token, priceUsd, chg24 %, vol24 USD, mcap USD, trades24] for tokens that traded */
  | { t: 'TICKS'; d: [string, number | null, number | null, number, number | null, number][] }
  | { t: 'SUBSCRIBED' | 'UNSUBSCRIBED'; c: string }
  | { t: 'PONG'; ts: number }
  | { t: 'ERROR'; d: { code: string; msg?: string } }
