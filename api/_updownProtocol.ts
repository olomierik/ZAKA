// BTC Up/Down on Polymarket (2026-11-01): what the engine's autotrader (engine/src/updown) serves the site, and the
// rules both sides share. The research behind it: docs/PREDICT-BTC-AUTOTRADE-2026-10.md.
//
// Polymarket lists a BTC market every 5 and every 15 minutes, back to back (slug `btc-updown-<5m|15m>-<unix start>`).
// It resolves Up when the 60-second Chainlink BTC/USD TWAP at the end is at or above the one at the start ("the price
// to beat"). The engine prices every live window, trades the ones its model beats by more than the fee and a margin,
// and, for now, does it on paper against Polymarket's live order books: real money waits for the readiness bar below.

export type UpdownDur = '5m' | '15m'
export type UpdownSide = 'up' | 'down'
/** A: the model beats a stale ask mid-window. B: in the last minute the observed TWAP already all but decides it. */
export type UpdownLane = 'A' | 'B'
/** Why a position was sold before the result: the market paid at least the model's value (a scalp), or the model
 *  said it was worth well under its cost (a stop). */
export type UpdownExit = 'scalp' | 'stop'

export const UPDOWN_DUR_SEC: Record<UpdownDur, number> = { '5m': 300, '15m': 900 }
/** Polymarket's crypto-price endpoint names the windows this way. */
export const UPDOWN_VARIANT: Record<UpdownDur, string> = { '5m': 'fiveminute', '15m': 'fifteen' }
export const updownSlug = (dur: UpdownDur, start: number) => `btc-updown-${dur}-${start}`
export const windowStart = (dur: UpdownDur, nowSec: number) => Math.floor(nowSec / UPDOWN_DUR_SEC[dur]) * UPDOWN_DUR_SEC[dur]

/** Polymarket's taker fee per share at price p: rate · p · (1 − p) for crypto (feeSchedule, exponent 1). */
export const takerFee = (p: number, rate: number, exponent = 1) => rate * Math.pow(p * (1 - p), exponent)

/** The bar the paper record must clear before real money is offered (the research's section 7). */
export const UPDOWN_READY = { days: 14, windows: 300, weeksPositive: 2 }

export interface UpdownBookTop { bid: number | null; ask: number | null; askSize: number }

export interface UpdownWindowView {
  slug: string
  dur: UpdownDur
  start: number
  end: number
  secondsLeft: number
  /** The price to beat: the 60-second Chainlink TWAP before the start, from Polymarket. */
  open: number | null
  /** The engine's Chainlink estimate now (exchange prices plus a learned basis). */
  btc: number | null
  /** The chance of Up it trades on: the market's, moved toward its model as far as it has learned to trust the model. */
  model: number | null
  /** Its model's own chance of Up, before that. */
  raw?: number | null
  /** The market's chance of Up: the Up book's mid. */
  market: number | null
  up: UpdownBookTop
  down: UpdownBookTop
  /** The best edge after fees right now (model − ask − fee), and on which side. */
  edge: { side: UpdownSide; value: number } | null
  /** Why the engine isn't trading it right now, when it isn't. */
  waiting: string | null
  feeRate: number
  url: string
}

export interface UpdownTrade {
  id: string
  slug: string
  dur: UpdownDur
  lane: UpdownLane
  side: UpdownSide
  at: number
  /** When it filled (after the measured latency plus Polymarket's taker delay). */
  filledAt: number
  shares: number
  price: number
  fee: number
  cost: number
  model: number
  edge: number
  secondsLeft: number
  result: 'open' | 'won' | 'lost'
  pnl: number | null
  /** Shares sold before the result, what they paid after the fee, the fee, when, and why (absent on older trades). */
  sold?: number
  proceeds?: number
  exitFee?: number
  exitAt?: number | null
  exit?: UpdownExit | null
  /** What it knew when it bought (absent on trades from before 2026-11-01's learning): the raw model before the
   *  learned trust in it, the market's chance of Up (the Up book's mid), and how far BTC was from the price to beat (bp). */
  raw?: number
  market?: number | null
  awayBp?: number | null
  /** The side's best bid at its highest and lowest while held. */
  hi?: number
  lo?: number
  /** Not traded: a kind of trade it learned to skip, filled and settled on paper outside the balance so it keeps
   *  measuring whether the lesson still holds. The kind's id. */
  shadow?: string
  /** Why it won or lost, in words. */
  lesson?: UpdownLesson
}

/** A sentence keyed by its English text, with its numbers apart (translated on the site). */
export interface UpdownLesson { k: string; v?: Record<string, string> }

/** A change the autotrader made to itself, and why. */
export interface UpdownLearnNote extends UpdownLesson { at: number; kind: 'start' | 'trust' | 'skip' | 'lift' }

/** What the autotrader has learned from its record (engine/src/updown/learn.ts). */
export interface UpdownLearnView {
  /** How far it moves from the market's chance toward its own model (0 = the market's, 1 = the model's), per window
   *  length and part of the window, with how many resolved snapshots back it. */
  trust: { dur: UpdownDur; band: 'mid' | 'end'; weight: number; samples: number }[]
  /** Each kind of trade it watches, its record over the last days, and whether it skips it now. */
  kinds: { id: string; label: string; trades: number; won: number; pnl: number; roi: number; skipped: boolean; since: number | null }[]
  /** Its learning journal, newest first. */
  notes: UpdownLearnNote[]
  rule: { minTrades: number; maxRoi: number; days: number }
}

export interface UpdownLaneStats { trades: number; won: number; staked: number; pnl: number; fees: number }

export interface UpdownStats {
  since: number
  bankroll: number
  start: number
  trades: number
  open: number
  won: number
  lost: number
  staked: number
  fees: number
  pnl: number
  /** Orders the engine wanted that found nothing left at its price after the delay. */
  missed: number
  /** Positions closed by a sale before the result. */
  exits: Record<UpdownExit, number>
  byLane: Record<UpdownLane, UpdownLaneStats>
  byDur: Record<UpdownDur, UpdownLaneStats>
  /** One row per UTC day, oldest first. */
  days: { day: string; trades: number; pnl: number; staked: number }[]
  /** Windows the engine traded, and windows that resolved while it watched. */
  windowsTraded: number
  windowsSeen: number
  /** Brier scores on the same snapshots: the model against the market's mid (lower is better). */
  brier: { model: number | null; market: number | null; samples: number; used?: number | null; usedSamples?: number }
  /** Kinds of trade it skipped by a lesson, filled and settled on paper outside the balance. */
  shadow?: { trades: number; won: number; pnl: number }
  todayPnl: number
  stoppedToday: boolean
}

export interface UpdownReadiness {
  ready: boolean
  days: number
  windows: number
  weeksPositive: number
  modelBeatsMarket: boolean | null
  why: string[]
}

/** A decision the engine pushes on the `updown` channel the moment it makes it (2026-11-03): a buy it wants (never a
 *  kind it learned to skip), or a sale of a side it signalled before (a scalp or a stop). The live autotrader in each
 *  user's browser acts on these with the user's own wallet; the engine places no real order itself. */
export interface UpdownSignal {
  id: string
  kind: 'buy' | 'sell'
  slug: string
  dur: UpdownDur
  conditionId: string
  side: UpdownSide
  /** The outcome token (CLOB asset id) to trade. */
  asset: string
  /** When the engine decided (ms), and when the window ends (unix seconds). */
  at: number
  end: number
  /** Buy: the most to pay a share. Sell: the least to take. */
  price: number
  tick: number
  minSize: number
  /** Buy only: the chance it trades on, the best ask, the edge after the fee, and the lane. */
  p?: number
  ask?: number
  edge?: number
  lane?: UpdownLane
  /** Sell only: why. */
  why?: UpdownExit
}

/** Live trading for a small account (2026-11-03, owner: "make it trade small capital like 50 and 100 and be smart not
 *  to burn the account"). Shares of the capital the user starts with; the engine's live-speed paper book uses the
 *  same numbers on $100. */
export const LIVE_RULES = {
  /** An order is at most this share of the capital, less when the edge is thin (a quarter of Kelly). */
  orderShare: 0.06,
  kellyShare: 0.25,
  /** Polymarket's smallest useful order. */
  minOrderUsd: 1,
  /** At most this share of the capital in one window, and this many positions open at once. */
  windowShare: 0.12,
  maxOpen: 2,
  /** No new order for the rest of the UTC day once the day has lost this share. */
  dailyLossShare: 0.15,
  /** Stops for good (until the user starts it again) once the account is this share under where it started. */
  drawdownStop: 0.3,
  /** A pause after this many losses in a row. */
  lossStreak: 4,
  pauseMs: 60 * 60_000,
  /** A signal older than this when it reaches the browser isn't traded. */
  maxSignalAgeMs: 2_000,
  /** The engine's live-speed paper book: what a browser far from London adds to the engine's own delay. */
  extraDelayMs: 900,
  simCapital: 100,
  /** The capital a user can start with. */
  capitals: [50, 100] as const,
}

/** One live order's size for a small account: a quarter of Kelly on the all-in cost, within the order share. */
export function liveOrderUsd(capital: number, p: number, ask: number, feeRate: number): number {
  const c = ask + takerFee(ask, feeRate)
  const f = c >= 1 ? 0 : Math.max(0, (p - c) / (1 - c))
  const usd = Math.min(capital * LIVE_RULES.orderShare, capital * f * LIVE_RULES.kellyShare)
  return usd >= LIVE_RULES.minOrderUsd ? Math.floor(usd * 100) / 100 : 0
}

export interface UpdownStatus {
  mode: 'paper' | 'off'
  /** Real money: never from the engine; each user's own browser trades their own wallet (UpdownSignal). */
  live: false
  /** The engine's live-speed paper book: $100 on the small-account rules, filled as late as a browser's order lands. */
  liveSim?: UpdownStats & { capital: number; extraDelayMs: number; halted: string | null }
  windows: UpdownWindowView[]
  feeds: {
    sources: { name: string; ageMs: number | null; basisBp: number | null }[]
    /** The engine's estimate of Polymarket's book lag (ms, median of message delay). */
    bookLagMs: number | null
    bookConnected: boolean
    /** Annualised volatility the model uses now (%). */
    volPct: number | null
    /** Polymarket's verdict on the engine's own IP (orders are checked by the sending IP). */
    geoblock: { blocked: boolean; country: string } | null
    /** How far the market's prices put Chainlink from the engine's exchange-based estimate (bp), learned in calm moments. */
    marketShiftBp: number | null
    /** Why the last window couldn't be listed (cleared once a live window is). */
    lookupError: { at: number; slug: string; why: string } | null
  }
  delayMs: number
  stats: UpdownStats
  readiness: UpdownReadiness
  learn?: UpdownLearnView
  rules: { orderUsd: number; windowUsd: number; dailyLossUsd: number; marginA: number; marginMid: number; marginB: number; overpay: Record<UpdownDur, number>; stop: number }
}
