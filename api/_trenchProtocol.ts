// The Trenches' live feed (2026-10-12, owner: "make sure that all coins in all chains are fast and show in seconds after
// launch and trades"; "a column showing smart wallets' buys and sells, and the coins smart wallets are buying now"),
// shared by the engine (engine/src/trench) and the site (src/arcdex/api/trenchFeed.ts).
//
// The engine follows each chain itself: Solana's pump.fun and PumpSwap over Solana's own WebSocket, four.meme and
// PancakeSwap on BNB Chain and the listed pools on Robinhood Chain by polling their RPCs every second, and Arc from its
// own stream. WebSocket channels trench_arc, trench_hood, trench_sol and trench_bnb carry:
//   TLAUNCH  a coin launched seconds ago, with its first numbers
//   TTICKS   once a second, each followed coin that traded: buys, sells, their dollars, price, market cap, progress
//   TSMART   a trade by a wallet the engine counts as smart on that chain
//   TMETA    a launch's picture, once its metadata answers
// REST: GET /v1/trench/<chain>: the last launches, and the smart-money view (wallets followed, the coins smart wallets
// are buying now, their latest trades and the best of them).
//
// "Smart" is measured, not labelled: a wallet the engine has seen close enough trades on that chain, mostly won and in
// profit overall, holding longer than a bot's flip (engine/src/trench/book.ts SMART_RULES). It only knows the trades it
// has seen since it started following the chain (`since`).

export const TRENCH_CHAINS = ['arc', 'hood', 'sol', 'bnb'] as const
export type TrenchChain = (typeof TRENCH_CHAINS)[number]
export type TrenchChannel = `trench_${TrenchChain}`
export const trenchChannel = (c: TrenchChain): TrenchChannel => `trench_${c}`
export const isTrenchChain = (v: unknown): v is TrenchChain => typeof v === 'string' && (TRENCH_CHAINS as readonly string[]).includes(v)

/** A coin as the feed knows it: from its launch event and the trades seen since. */
export interface TrenchCoinWire {
  /** Address: Solana's base58 with its case, EVM lower case. */
  a: string
  s: string
  n: string
  i: string | null
  /** Its launchpad (pump.fun, four.meme…). */
  lp: string
  /** The quote it trades against (SOL, BNB, USDT…). */
  q: string
  /** The curve or pool its trades go through, when known. */
  pool: string | null
  /** Launched (ms). */
  c: number
  cr: string | null
  /** Its first price the engine saw (the curve's opening price, or its first trade's), in USD: the change since launch. */
  o: number
  /** Price and market cap in USD, liquidity (what its curve or pool holds) in USD. */
  p: number
  m: number
  l: number
  /** Dollars traded, buys, sells and wallets trading since it launched (as the engine saw them). */
  v: number
  b: number
  x: number
  w: number
  /** 0–100 along its curve; null off a curve. */
  g: number | null
  gr: boolean
}

/** [token, buys, sells, buyUsd, sellUsd, priceUsd, mcapUsd, progress (-1: none), the second's biggest trade in USD (+buy, -sell)] */
export type TrenchTick = [string, number, number, number, number, number, number, number, number]

export interface SmartTradeWire {
  /** Wallet, token, its symbol and picture. */
  w: string
  t: string
  s: string
  i: string | null
  side: 'B' | 'S'
  /** Dollars, time (ms), the coin's market cap then. */
  u: number
  ts: number
  m: number
  /** The wallet's record: closed trades, share won (0–1), realized profit in USD. */
  n: number
  wr: number
  pnl: number
}

export interface SmartWalletWire {
  w: string
  n: number
  wr: number
  pnl: number
  /** Average hold (ms) and coins traded. */
  hold: number
  coins: number
  /** Its last trade (ms). */
  last: number
}

/** A coin smart wallets bought in the last `windowMin`: how many, how much, and when. */
export interface SmartBuyingWire {
  t: string
  s: string
  n: string
  i: string | null
  m: number
  buyers: number
  sellers: number
  buyUsd: number
  sellUsd: number
  first: number
  last: number
  wallets: string[]
}

export interface TrenchSmartView {
  /** Following this chain since (ms): the record covers only trades seen from then. */
  since: number
  /** Wallets with a record, and how many count as smart. */
  followed: number
  smart: number
  windowMin: number
  rule: { minTrades: number; minWinRate: number; minProfitUsd: number; minHoldSec: number }
  top: SmartWalletWire[]
  buying: SmartBuyingWire[]
  trades: SmartTradeWire[]
}

export interface TrenchSnapshot {
  chain: TrenchChain
  at: number
  /** The feed is connected and has heard from its chain in the last minute. */
  live: boolean
  lastEventAt: number
  /** Trades a minute across the chain's followed venues. */
  perMin: number
  launches: TrenchCoinWire[]
  smart: TrenchSmartView
}

export type TrenchMessage =
  | { t: 'TLAUNCH'; c: TrenchChain; d: TrenchCoinWire }
  | { t: 'TTICKS'; c: TrenchChain; d: TrenchTick[] }
  | { t: 'TSMART'; c: TrenchChain; d: SmartTradeWire }
  | { t: 'TMETA'; c: TrenchChain; d: { a: string; i: string | null } }
