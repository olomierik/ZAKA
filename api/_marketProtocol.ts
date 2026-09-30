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
  /** Which rule fired: a scalp comes from a snipe on a risky coin or from a momentum burst (missing on older signals). */
  rule?: SignalRule
  /** The coin at the signal, in numbers: what a bot's learned filters read (missing on older signals). */
  features?: SignalFeatures
  /** The rule's recent paper record is losing: the signal is still measured, but bots don't trade it (2026-10-01). */
  probation?: { why: string } | null
  /** Its quality score and grade (engine/src/signals/quality.ts; missing on older signals). */
  quality?: SignalQuality
}

/** A signal's quality: live-grade (the top 80% of recent signals: every bot may trade it) or paper only; tier A takes 20% of a bot's capital, B 10%. */
export interface SignalQuality {
  score: number
  grade: 'live' | 'paper'
  tier: 'A' | 'B'
  /** The share of the last 50 signals it scores at least as well as (null while there are too few to rank against). */
  rank: number | null
  /** The score's parts, in words. */
  parts: string[]
  /** What this kind of signal made at live speed (replayed on real trades: engine/src/signals/liveSpeed.ts); live bots trade it only while `ok`. */
  liveSpeed?: { trades: number; winRate: number | null; avgPct: number | null; ok: boolean }
}

/** Which rule fired a signal. Momentum bursts count buyers over two minutes, snipes since launch: they're learned apart. */
export type SignalRule = 'snipe' | 'second-leg' | 'momentum'

/** A coin at a signal, in numbers (engine/src/bot/bot.ts). Visitors' bots filter on these and learn from them. */
export interface SignalFeatures {
  ageSec: number
  liquidityUsd: number | null
  marketCapUsd: number | null
  /** Distinct buyers in the rule's window (since launch for a snipe, the last 2 minutes for a momentum scalp). */
  buyers: number
  /** Buy volume ÷ sell volume in that window (null: no sells). */
  buySellRatio: number | null
  /** How far the price has already run in that window (1.2 = +20%). */
  runUp: number | null
  /** The largest buyer's share of buy volume, %. */
  topBuyerPct: number
  /** The safety score, 0–100 (higher is safer). */
  score: number
  /** Risk checks the coin didn't pass (holders, serial, copycat). */
  flags: string[]
  /** What a $1 round trip cost in the honeypot probe, %. */
  roundTripPct: number | null
}

/** The entry filters a visitor's bot has learned, per strategy (engine/src/bot/learner.ts). */
export interface BotFilters {
  minLiquidityUsd: number
  minBuyers: number
  minBuySellRatio: number
  /** Skip a coin whose price already ran more than this in the rule's window. */
  maxRunUp: number
  minScore: number
  maxTopBuyerPct: number
  /** Risk flags it no longer trades. */
  avoidFlags: string[]
  /** It learned to skip this kind of signal altogether (it kept losing on it); tried again later. */
  skip?: boolean
  skippedAt?: number
}

/** A visitor's bot's settings for one strategy: exits, the profit each trade is sized for, and its filters. */
export interface StrategyTuning {
  version: number
  /** Sell everything at this multiple of the entry price (1.15 = +15%). */
  takeProfit: number
  /** Sell everything at this multiple (0.9 = −10%). */
  stopLoss: number
  /** Out after this many minutes unless it's moving, and after `maxHoldMin` whatever happens. */
  timeStopMin: number
  maxHoldMin: number
  /** The profit a winning trade secures: each trade's size is the smallest that nets it at `takeProfit`. */
  targetUsd: number
  /** The strategy-wide filters (open since 2026-10-01: learned filters are per rule, below). */
  filters: BotFilters
  /** Learned filters per kind of signal: a fast scalp comes from momentum bursts and from snipes, which count buyers differently. */
  rules?: Partial<Record<SignalRule, BotFilters>>
  changedAt: number | null
  /** Closed trades and wins behind the version before this one (a change that did worse is rolled back). */
  basis: { trades: number; wins: number } | null
}

/** Something a visitor's bot learned or changed, in words. */
export interface LearnNote {
  at: number
  strategy: 'snipe' | 'second-leg' | 'scalp'
  /** The kind of signal the change is about, when it's about one. */
  rule?: SignalRule
  version: number
  /** `team`: settings taken from the team (a new bot starting from its best teammate's). */
  kind: 'tighten' | 'loosen' | 'exit' | 'revert' | 'team'
  text: string
}

/** A line in a visitor's bot's activity log. */
export interface PaperEvent {
  at: number
  kind: 'buy' | 'sell' | 'rug' | 'skip' | 'learn' | 'pause' | 'stop'
  text: string
  token?: string
  symbol?: string
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
  txs?: { kind: 'buy' | 'approve' | 'sell' | 'fee'; hash: string; at: number; usd?: number; gasUsd?: number }[]
  gasUsd?: number
  stuck?: string | null
  /** A visitor's bot: the exits it traded with, the profit its size was chosen to secure, and the tuning version. */
  exits?: { stopLoss: number; tp1Multiple: number; timeStopMin: number; maxHoldMin?: number }
  targetUsd?: number
  tuningVersion?: number
  /** The coin at entry, and the lowest price while open. */
  features?: SignalFeatures
  low?: number
  /** Why it closed, in words. */
  note?: string
  /** A visitor's bot: the platform's 15% of a winning trade's profit (already out of pnlUsd); live, a fee still to send. */
  feeUsd?: number
  feeDue?: number
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
    /** `preflight`: every buy is simulated with its sale first, as the bot wallet (engines from before 2026-09-30 don't say). */
    limits: { maxTradeUsd: number; dailyLossUsd: number; maxOpen: number; maxOpenScalp: number; slippageBps: number; exitSlippageBps: number[]; reserveUsd: number; preflight?: boolean; maxRoundTripPct?: number; maxShareOfBalance?: number } | null
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
  stage: 'snipe' | 'scalp' | 'second-leg' | 'safety'
  /** Why, in words: unmet rules or failing checks (✗ marks a failure). */
  reasons: string[]
  strategy?: 'snipe' | 'second-leg' | 'scalp'
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  /** When it was last evaluated, and how many times. */
  at: number
  evals: number
  /** What stops it, as keys ("snipe:buyers", "safety:honeypot"), for counting (GET /v1/bot/rejections). */
  keys?: string[]
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

/** A visitor's bot: a paper-trading account on the engine (virtual USDC; GET/POST /v1/paper/account). */
export interface PaperAccountView {
  id: string
  /** The name its owner gave it. */
  name: string
  running: boolean
  strategies: ('snipe' | 'second-leg' | 'scalp')[]
  cash: number
  deposited: number
  /** Cash plus open positions at the current price. */
  equity: number
  openValue: number
  createdAt: number
  startedAt: number | null
  positions: BotPosition[]
  stats: { closed: number; open: number; wins: number; losses: number; winRate: number | null; totalPnlUsd: number; profitFactor: number | null; expectancyUsd: number | null; maxDrawdownUsd: number }
  /** Per strategy: its learned settings, what a trade costs now (about), and its own results. */
  tuning: Record<'snipe' | 'second-leg' | 'scalp', StrategyTuning & { sizeUsd: number | null; closed: number; winRate: number | null }>
  /** The profit range each strategy's trades are sized for. */
  targets: Record<'snipe' | 'second-leg' | 'scalp', [number, number]>
  /** What it learned (newest first), its activity, and the signals it passed over lately. */
  learnLog: LearnNote[]
  events: PaperEvent[]
  skips: PaperEvent[]
  /** What keeps the account from being drained. */
  /** `maxTradeUsd`: the most one trade may use now (`maxTradeSharePct` of what the bot is worth; null while a live wallet is unread). Both missing on older engines. */
  protections: { pausedUntil: number | null; lossStreak: number; pauseAfterLosses: number; dailyLossLimitUsd: number; todayPnlUsd: number; stopBelowPct: number; maxTradeSharePct?: number; maxTradeUsd?: number | null; tradeSharePct?: { a: number; b: number }; minTradeUsd?: number }
  /** Every closed trade it has made (GET /v1/paper/trades lists them all). */
  tradesLogged: number
  /** Its unique id on the platform (from its name): /bots/<slug>. */
  slug?: string
  /** paper: virtual USDC; live: its own wallet trades real USDC. */
  mode?: 'paper' | 'live'
  /** The platform's 15% of winning trades' profit: virtual (paper) and sent (live). */
  feesPaidUsd?: number
  /** Whether its paper record is good enough to trade live, and how far it is. */
  ready?: BotReadiness
  /** Its live wallet and results, once it has a wallet. */
  live?: BotLiveView | null
  /** Whether this engine can trade live for visitors' bots at all. */
  liveAvailable?: { ok: boolean; why: string | null }
  /** The team it learns from (missing on older engines). */
  team?: TeamView
}

/** A bot's paper record against what trading live needs (engine/src/bot/userLive.ts READY). */
export interface BotReadiness {
  ok: boolean
  trades: number
  winRate: number | null
  profitFactor: number | null
  pnlUsd: number
  need: { minTrades: number; minWinRate: number; minProfitFactor: number; minOwnWithTeam?: number }
  /** How it qualified: its own record, or the team's with a few trades of its own (null: not yet). */
  via?: 'own' | 'team' | null
  /** The team's record on its strategies, the last 7 days (every bot's trades, paper and live, one per signal). */
  team?: { trades: number; winRate: number | null; profitFactor: number | null; pnlUsd: number; ok: boolean }
}

/** The team: every bot on ARCDEX learning from one another's trades. */
export interface TeamView {
  /** Bots running now. */
  bots: number
  /** The team's record per strategy, the last 7 days (one trade per signal). */
  byStrategy: Partial<Record<'snipe' | 'second-leg' | 'scalp', { trades: number; winRate: number | null; pnlUsd: number }>>
}

/** A bot's live side: its own wallet, balance and results. */
export interface BotLiveView {
  wallet: string
  balanceUsd: number | null
  /** Realized live P&L (after gas and the 15% profit fee), closed and open trades, win rate. */
  pnlUsd: number
  closed: number
  open: number
  winRate: number | null
  feesPaidUsd: number
  limits: { maxTradeUsd: number; minBalanceUsd: number; reserveUsd: number; maxOpen: number; dailyLossUsd: number; preflight?: boolean; maxRoundTripPct?: number; maxSharePct?: number }
  events: { at: number; kind: string; text: string; token?: string; symbol?: string; hash?: string }[]
}

/** A signed-in bot owner (GET /v1/me). */
export interface BotUserView { email: string; verified: boolean; createdAt: number }

export interface MeResponse {
  user: BotUserView
  bots: PaperAccountView[]
  /** Email (Resend) is set up: verification, resets and withdrawal codes work. */
  email: boolean
  maxBots: number
  liveAvailable: { ok: boolean; why: string | null }
  /** The team every bot learns from (missing on older engines). */
  team?: TeamView
  /** Whether paper bots get signals now (false: live bots only, the platform's setting). */
  paperSignals?: boolean
}

/** A bot in the marketplace (GET /v1/bots): public, no owner details. */
/** A winning trade one of an owner's bots closed (GET /v1/me/profits): what a profit notification says. */
export interface BotProfit {
  id: string
  bot: string
  slug: string
  symbol: string
  token: string
  strategy: 'snipe' | 'second-leg' | 'scalp'
  mode: 'paper' | 'live'
  /** After the platform's 15% profit fee. */
  pnlUsd: number
  pnlPct: number | null
  feeUsd: number | null
  closedAt: number
}

export interface MarketBot {
  slug: string
  name: string
  strategies: ('snipe' | 'second-leg' | 'scalp')[]
  mode: 'paper' | 'live'
  running: boolean
  createdAt: number
  /** Paper: account value minus deposits (realized and open); live: realized live P&L plus open trades. */
  pnlUsd: number
  pnlPct: number | null
  winRate: number | null
  closed: number
  /** Its open positions, valued now. */
  positions: { token: string; symbol: string; strategy: 'snipe' | 'second-leg' | 'scalp'; mode: 'paper' | 'live'; sizeUsd: number; entry: number; price: number | null; pnlUsd: number | null; openedAt: number }[]
  /** Its paper record, always (for a live bot, what earned it the switch). */
  paper: { pnlUsd: number; winRate: number | null; closed: number }
  /** Learned changes so far, and whether it could go live. */
  learned: number
  ready: boolean
  wallet: string | null
}

export interface MarketBotDetail extends MarketBot {
  trades: BotPosition[]
  learnLog: LearnNote[]
  live: { pnlUsd: number; closed: number; winRate: number | null } | null
}

/** What became of the last 24 hours' signals: how many were traded, and why the rest weren't. */
export interface SignalOutcomes {
  signals: number
  /** Signals traded (bots: by at least one bot; live bots count when the order went to their wallet). */
  traded: number
  /** Why not, counted once per signal (and, for visitors' bots, once per bot), most common first. */
  reasons: { key: string; label: string; count: number }[]
}

/** Why coins are passed over right now (GET /v1/bot/rejections). */
export interface RejectionStats {
  /** Coins watched in the last 48h that aren't signals, by their main reason. */
  top: { key: string; label: string; coins: number }[]
  watching: number
  at: number
  /** Signals that weren't traded, and why: the engine's own book, and visitors' bots (engines from before 2026-09-30 don't say). */
  signals?: { owner: SignalOutcomes | null; bots: SignalOutcomes | null }
}

/** What a visitor can do with their bot (POST /v1/paper/account). The amount per trade isn't one: each trade is sized for its profit target. */
export type PaperAction =
  | { action: 'deposit'; amount: number }
  | { action: 'start' } | { action: 'stop' }
  | { action: 'strategies'; strategies: ('snipe' | 'second-leg' | 'scalp')[] }
  | { action: 'rename'; name: string }
  | { action: 'reset' }
  /** Signed-in owners only (POST /v1/me/bots/:slug): */
  | { action: 'mode'; mode: 'paper' | 'live' }
  | { action: 'live-wallet' }
  | { action: 'sell-live' }

/** A new bot (POST /v1/paper/accounts). */
export interface NewPaperAccount { name: string; strategies: ('snipe' | 'second-leg' | 'scalp')[] }

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
