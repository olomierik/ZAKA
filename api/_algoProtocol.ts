// ARCDEX Algo (engine/src/algo): what the engine serves and the site reads, plain types and the
// owner's signed control messages. GET /v1/algo/* and POST /v1/algo/control (engine/src/algo/api.ts).
//
// Two layers, never blurred:
//   the REFLEX  decides on every one-minute candle of BTC, ETH and SOL: one compact numeric
//               snapshot in, one typed decision out (AlgoDecision). Deterministic code by default
//               (engine/src/algo/reflex.ts); any typed-decision model can sit behind the same
//               interface and DECISION_JSON_SCHEMA.
//   the BRAIN   (Claude Opus 5.5, when ANTHROPIC_API_KEY is set) re-reads a position when the
//               reflex loses confidence or the regime turns to crisis, and writes the nightly review.
// Code owns every threshold, size and side effect: the gates, quarter-Kelly sizing and the risk
// layer (drawdown, position, daily loss, kill switch) are never delegated to either model.

export const ALGO_MARKETS = ['BTC', 'ETH', 'SOL'] as const
export type AlgoMarket = (typeof ALGO_MARKETS)[number]

export type AlgoRegime = 'trending' | 'mean_reverting' | 'high_vol' | 'crisis'
export type AlgoDirection = 'long' | 'short' | 'neutral'
export type AlgoRiskState = 'safe' | 'near_limit' | 'reduce'
export type AlgoMode = 'paper' | 'testnet'

/** The typed decision scored on every candle. `confidence` is the calibrated probability that a
 * trade in `direction` reaches its take-profit before its stop-loss (0–1). */
export interface AlgoDecision {
  regime: AlgoRegime
  direction: AlgoDirection
  toxic_flow: boolean
  setup_quality: 0 | 1 | 2 | 3
  risk_state: AlgoRiskState
  confidence: number
}

/** The same schema as JSON Schema, for a typed-decision model behind the reflex interface. */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['regime', 'direction', 'toxic_flow', 'setup_quality', 'risk_state', 'confidence'],
  properties: {
    regime: { type: 'string', enum: ['trending', 'mean_reverting', 'high_vol', 'crisis'] },
    direction: { type: 'string', enum: ['long', 'short', 'neutral'] },
    toxic_flow: { type: 'boolean' },
    setup_quality: { type: 'integer', enum: [0, 1, 2, 3] },
    risk_state: { type: 'string', enum: ['safe', 'near_limit', 'reduce'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

/** The deterministic state of one market at one candle close: everything the reflex sees.
 * Percentages are percent (0.12 = 0.12%); sigmas are the market's own volatility units. */
export interface AlgoState {
  market: AlgoMarket
  /** The candle close the state is taken at (ms). Nothing after it is used. */
  t: number
  /** The latest time of any input used (ms); never after `t`. */
  srcMaxTs: number
  px: number
  r5m: number | null
  r15m: number | null
  r1h: number | null
  r4h: number | null
  r24h: number | null
  /** Realized volatility of one-minute returns, % a minute: the last hour and the last day. */
  rv1h: number | null
  rv24h: number | null
  /** rv1h / rv24h: above 1, volatility is expanding. */
  volRatio: number | null
  /** 5-minute EMA20 − EMA60, in hourly sigmas. */
  trend: number | null
  /** Distance from the hour's mean, in hourly sigmas. */
  z1h: number | null
  /** The last minute's return, in one-minute sigmas. */
  jump: number | null
  /** Where the price sits in the last 24 hours' range (0 = low, 1 = high). */
  range24: number | null
  /** The other majors' last hour (BTC for ETH and SOL, ETH for BTC), %. */
  refR1h: number | null
  /** How far the oracle's signers disagree, basis points (live only). */
  dispersionBps: number | null
  /** The agent's own position here. */
  inventory: { side: 'long' | 'short'; uPnlPct: number; ageMin: number } | null
  /** The agent's drawdown from its peak equity, and today's P&L, %. */
  drawdownPct: number
  dayPnlPct: number
  /** One horizon's volatility (σ over the hold time), %: the unit of the take-profit and stop. */
  sigmaH: number | null
}

export interface AlgoGate {
  passed: boolean
  /** Every check, in order, with its result. */
  checks: { id: string; ok: boolean; detail: string }[]
}

/** One candle's decision for one market, with why it did or didn't trade. */
export interface AlgoDecisionRow {
  id: string
  at: number
  market: AlgoMarket
  decision: AlgoDecision
  /** The reflex's uncalibrated score (0–1), before calibration. */
  raw: number
  why: string[]
  gate: AlgoGate
  action: 'open' | 'close' | 'hold' | 'none' | 'escalate'
  /** The compact snapshot the reflex read (under 400 tokens). */
  snapshot: string
  provider: string
  latencyMs: number
  /** Planned trade when the gate passed. */
  plan: AlgoPlan | null
}

export interface AlgoPlan {
  side: 'long' | 'short'
  entry: number
  tp: number
  sl: number
  tpPct: number
  slPct: number
  /** Full Kelly from the calibrated probability and the net payoff, and the fraction used. */
  kelly: number
  fraction: number
  riskUsd: number
  sizeUsd: number
  collateralUsd: number
  leverage: number
  expectedValuePct: number
}

export interface AlgoTrade {
  id: string
  mode: AlgoMode
  market: AlgoMarket
  side: 'long' | 'short'
  status: 'pending' | 'open' | 'closed' | 'failed'
  decisionId: string
  openedAt: number
  entry: number
  tp: number
  sl: number
  /** Target and stop as distances from the entry, %: they follow the real fill price. */
  tpPct: number
  slPct: number
  sizeUsd: number
  collateralUsd: number
  leverage: number
  confidence: number
  kelly: number
  regime: AlgoRegime
  closedAt: number | null
  exit: number | null
  pnlUsd: number | null
  /** P&L over the collateral, %. */
  pnlPct: number | null
  feesUsd: number
  reason: string | null
  /** Testnet only: the contract's position, and the transactions. */
  positionId: string | null
  txOpen: string | null
  txClose: string | null
  escalations: AlgoEscalation[]
}

export interface AlgoEscalation {
  at: number
  trigger: string
  by: string
  action: 'hold' | 'close'
  why: string
}

export interface AlgoCalibrationBin { lo: number; hi: number; n: number; predicted: number; observed: number }

export interface AlgoCalibration {
  /** Labeled decisions the calibration was fit on, and the test window's. */
  n: number
  nTest: number
  /** Brier score on the held-out window (lower is better), and the base rate's Brier for scale. */
  brier: number | null
  brierBaseRate: number | null
  /** 1 − brier / brierBaseRate: above 0 means the confidence beats always saying the base rate. */
  skill: number | null
  /** Expected calibration error on the held-out window. */
  ece: number | null
  baseRate: number | null
  bins: AlgoCalibrationBin[]
  fittedAt: number | null
}

export interface AlgoStats {
  trades: number
  wins: number
  winRate: number | null
  pnlUsd: number
  pnlPct: number
  profitFactor: number | null
  avgWinUsd: number | null
  avgLossUsd: number | null
  maxDrawdownPct: number
  feesUsd: number
}

export interface AlgoLimits {
  maxDrawdownPct: number
  maxDailyLossPct: number
  maxPositionPct: number
  maxRiskPerTradePct: number
  maxLeverage: number
  maxOpen: number
}

export interface AlgoRisk {
  limits: AlgoLimits
  equityUsd: number
  startUsd: number
  peakUsd: number
  drawdownPct: number
  dayStartUsd: number
  dayPnlPct: number
  open: number
  risk_state: AlgoRiskState
  killSwitch: { tripped: boolean; reason: string | null; at: number | null }
}

export interface AlgoGates {
  minSetupQuality: number
  minConfidence: number
  escalateBelow: number
  kellyFraction: number
}

export interface AlgoProposal {
  param: string
  from: number
  to: number
  why: string
  status: 'shipped' | 'rejected'
  test: { tradesBefore: number; tradesAfter: number; expectancyBefore: number | null; expectancyAfter: number | null; brierBefore: number | null; brierAfter: number | null; detail: string }
}

/** The nightly review: the day's fills and misses, calibration, and what changed. */
export interface AlgoReview {
  id: string
  at: number
  /** The UTC day reviewed (YYYY-MM-DD). */
  day: string
  by: string
  stats: AlgoStats
  decisions: number
  setups: number
  calibration: AlgoCalibration
  summary: string
  lessons: string[]
  proposals: AlgoProposal[]
}

export interface AlgoReplay {
  at: number
  from: number
  to: number
  stats: AlgoStats
  decisions: number
  setups: number
  note: string
}

export interface AlgoMarketView {
  state: AlgoState | null
  last: AlgoDecisionRow | null
  price: number | null
  priceTs: number | null
}

export interface AlgoStatus {
  enabled: boolean
  at: number
  mode: AlgoMode
  running: boolean
  /** What's missing before it can trade, in words (null when nothing is). */
  waiting: string | null
  reflex: { provider: string; calibrated: boolean; labels: number }
  brain: { enabled: boolean; model: string | null; escalationsToday: number; lastReviewAt: number | null }
  gates: AlgoGates
  geometry: { horizonMin: number; tpSigma: number; slSigma: number }
  markets: Partial<Record<AlgoMarket, AlgoMarketView>>
  risk: AlgoRisk
  stats: AlgoStats
  calibration: AlgoCalibration
  replay: AlgoReplay | null
  wallet: { address: string | null; gasUsdc: number | null; usdc: number | null } | null
  configVersion: number
}

export type AlgoControl =
  | { action: 'kill'; on: boolean; note: string }
  | { action: 'mode'; mode: AlgoMode }
  | { action: 'reset'; startUsd: number }
  | { action: 'gates'; patch: string; note: string }

export function algoControlMessage(c: AlgoControl, at: number): string {
  const what = c.action === 'kill' ? (c.on ? `Trip the kill switch: no new trades, and close every open position\nWhy: ${c.note}` : `Re-arm the agent (kill switch off)\nWhy: ${c.note}`)
    : c.action === 'mode' ? `Trade in ${c.mode} mode`
    : c.action === 'reset' ? `Reset the book to ${c.startUsd} USDC`
    : `Change the gates: ${c.patch}\nWhy: ${c.note}`
  return `ARCDEX Algo\n${what}\nAt: ${new Date(at).toISOString()}`
}
