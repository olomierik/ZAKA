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
  /** The model's chance of Up (calibrated once enough windows have resolved). */
  model: number | null
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
  byLane: Record<UpdownLane, UpdownLaneStats>
  byDur: Record<UpdownDur, UpdownLaneStats>
  /** One row per UTC day, oldest first. */
  days: { day: string; trades: number; pnl: number; staked: number }[]
  /** Windows the engine traded, and windows that resolved while it watched. */
  windowsTraded: number
  windowsSeen: number
  /** Brier scores on the same snapshots: the model against the market's mid (lower is better). */
  brier: { model: number | null; market: number | null; samples: number }
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

export interface UpdownStatus {
  mode: 'paper' | 'off'
  /** Real money: never from the engine; offered per user only once `readiness.ready`. */
  live: false
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
  }
  delayMs: number
  stats: UpdownStats
  readiness: UpdownReadiness
  rules: { orderUsd: number; windowUsd: number; dailyLossUsd: number; marginA: number; marginMid: number; marginB: number }
}
