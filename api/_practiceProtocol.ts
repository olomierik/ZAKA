// Practice predictions, shared by the engine (engine/src/practice/predict.ts) and the site (lib/predictPractice.ts).
//
// papertrade.xyz's way of trading, on Hyperliquid's prediction markets (HIP-4), with virtual USDC: one tap, filled at
// the market's mid with no slippage and no fee, held until sold or until Hyperliquid settles the market. The engine
// keeps every account, reads the mid itself for each fill and settles from Hyperliquid's own `settledOutcome`, so the
// leaderboard can't be written from a browser.

/** An outcome as Hyperliquid's `outcomeMeta` lists it (kept with each position, so a settled market still has a name). */
export interface PracticeRawOutcome { outcome: number; name: string; description: string; sideSpecs: { name: string }[] }
export interface PracticeRawQuestion { question: number; name: string; description: string; fallbackOutcome: number; namedOutcomes: number[]; settledNamedOutcomes: number[] }
export interface PracticeSpec { o: PracticeRawOutcome; q: PracticeRawQuestion | null }

export const PRACTICE = {
  /** What a new account starts with, and what a reset may start from. */
  startUsd: 10_000,
  resetChoices: [1_000, 10_000, 100_000] as const,
  minOrderUsd: 1,
  /** No buys at a mid outside these: a side that's all but decided isn't a trade. */
  minBuyPx: 0.01,
  maxBuyPx: 0.99,
  maxOpen: 50,
  /** Closed trades kept per account (the leaderboard reads them). */
  history: 300,
  /** New accounts per IP an hour, orders per account a minute. */
  newPerIpHour: 5,
  ordersPerMinute: 120,
  /** A trader needs this many closed trades in the window to be ranked. */
  boardMinTrades: 3,
} as const

export type PracticeSide = 0 | 1
export type BoardPeriod = '24h' | '7d' | 'all'
export const BOARD_PERIODS: BoardPeriod[] = ['24h', '7d', 'all']

export interface PracticePosition {
  outcome: number
  side: PracticeSide
  contracts: number
  /** USDC paid for the contracts still held. */
  cost: number
  openedAt: number
  spec: PracticeSpec
}

export interface PracticeTrade {
  id: string
  outcome: number
  side: PracticeSide
  contracts: number
  entryPx: number
  exitPx: number
  cost: number
  proceeds: number
  pnl: number
  openedAt: number
  closedAt: number
  /** Sold at the mid, or paid out by Hyperliquid's settlement. */
  how: 'sold' | 'settled'
  spec: PracticeSpec
}

export interface PracticeFill { outcome: number; side: PracticeSide; buy: boolean; contracts: number; px: number; usd: number; pnl?: number; at: number }

/** An account as its owner sees it: positions valued at the mids the engine read. */
export interface PracticeView {
  name: string
  createdAt: number
  start: number
  cash: number
  positions: (PracticePosition & { px: number | null; value: number | null })[]
  history: PracticeTrade[]
  /** Cash plus positions at their mids (a position with no mid at its cost). */
  equity: number
  pnl: number
  realized: number
  trades: number
  wins: number
  resets: number
}

export interface BoardTrader { name: string; pnl: number; trades: number; wins: number; best: number }
export interface BoardTrade { name: string; outcome: number; side: PracticeSide; entryPx: number; exitPx: number; cost: number; pnl: number; closedAt: number; how: 'sold' | 'settled'; spec: PracticeSpec }
export interface PracticeBoard {
  period: BoardPeriod
  at: number
  traders: BoardTrader[]
  trades: BoardTrade[]
  /** The latest fills by everyone, newest first (papertrade's ticker). */
  recent: (PracticeFill & { name: string; spec: PracticeSpec })[]
  accounts: number
}

/** A display name: 2–24 letters, digits, spaces or . _ ' -, else none. */
export function cleanPracticeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return /^[\p{L}\p{N} ._'-]{2,24}$/u.test(s) ? s : null
}

/** "k1:v1|k2:v2" → { k1: v1, k2: v2 }. */
export function practiceFields(desc: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of desc.split('|')) {
    const i = part.indexOf(':')
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

const parseTime = (s: string | undefined): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s ?? '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
}

/** When the market stops trading, as its terms say (the same fields the site reads); null when they don't say. */
export function practiceEndsAt(spec: PracticeSpec): number | null {
  const f = { ...(spec.q ? practiceFields(spec.q.description) : {}), ...practiceFields(spec.o.description) }
  return parseTime(f.time ?? f.expiry ?? f.resolutionDeadline ?? f.dateTime ?? f.listingDeadline ?? f.decisionDeadline)
}

/** A side's coin on Hyperliquid: "#<10 × outcome + side>". */
export const sideCoin = (outcome: number, side: PracticeSide) => `#${10 * outcome + side}`

/** A side's price from the mids; the other side's complement when only that one has a book. */
export function sideMid(mids: Readonly<Record<string, number>>, outcome: number, side: PracticeSide): number | null {
  const own = mids[sideCoin(outcome, side)]
  if (own > 0 && own < 1) return own
  const other = mids[sideCoin(outcome, side === 0 ? 1 : 0)]
  return other > 0 && other < 1 ? 1 - other : null
}
