// What the signal engine (engine/src/quant) serves, shared by the engine and
// the site's Signal engine dashboard: plain types and the owner's signed
// control messages. GET /v1/quant/* and POST /v1/quant/control
// (engine/src/quant/api.ts).

export type QuantStrategy = 'early_momentum' | 'breakout' | 'smart_money'
export type QuantRegime = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'HIGH_VOLATILITY' | 'LIQUIDITY_STRESSED'
export type QuantBand = 'NO_TRADE' | 'WATCH' | 'WEAK' | 'TRADE_CANDIDATE' | 'HIGH_CONVICTION'
export type QuantBook = 'paper' | 'live' | 'backtest'

export interface QuantComponents { flow: number; momentum: number; volume: number; liquidity: number; smartMoney: number; holders: number; safety: number; regime: number }

export interface QuantTradeQuality {
  p_win: number
  expected_price_move_pct: number
  entry_slippage_pct: number
  exit_slippage_pct: number
  buy_tax_pct: number
  sell_tax_pct: number
  gas_usd: number
  price_impact_pct: number
  round_trip_cost_pct: number
  expected_net_return_pct: number
  expected_value_usd: number
  ok: boolean
  why: string
}

/** One signal: a strategy's conditions met, scored, and traded or not, with every reason. */
export interface QuantSignal {
  id: string
  at: number
  token: string
  symbol: string
  launchpad: string | null
  strategy: QuantStrategy
  signal_score: number
  band: QuantBand
  decision: 'traded' | 'rejected' | 'watch'
  mode: QuantBook
  confidence: number
  components: QuantComponents
  distribution_penalty: number
  entry_reason: string[]
  risk_flags: string[]
  why_signal_triggered: string[]
  why_trade_allowed: string[]
  why_trade_rejected: string[]
  recommended_entry: { price: number; maxSlippagePct: number } | null
  recommended_stop: { price: number; pct: number } | null
  recommended_targets: { price: number; gainPct: number; sellPct: number }[]
  position_size: number
  sizing: string[]
  trade_quality: QuantTradeQuality | null
  safety: { safety_score: number; risk_flags: string[]; critical: string[]; trade_allowed: boolean }
  regime: QuantRegime | string
  /** Price, market cap, liquidity, age (min), buy pressure, volume acceleration, smart money, holder health, exhaustion, safety, expected slippage … */
  summary: Record<string, number | string | boolean | null>
  latency_ms: { data: number | null; signal: number | null }
  /** The positions it opened (paper, and live once allowed). */
  positions: string[]
}

export interface QuantRadarRow { token: string; symbol: string; at: number; score: number; band: QuantBand | string; strategy: QuantStrategy | null; summary: Record<string, number | string | boolean | null> }

export interface QuantFill { at: number; side: 'BUY' | 'SELL'; price: number; tokens: number; usd: number; feesUsd: number; reason: string; txHash?: string; gasUsd?: number }

export interface QuantPosition {
  id: string
  signalId: string
  token: string
  symbol: string
  strategy: QuantStrategy
  mode: QuantBook
  status: 'pending' | 'open' | 'closed' | 'failed'
  openedAt: number
  closedAt: number | null
  plannedUsd: number
  costUsd: number
  entryPrice: number
  tokens: number
  remainingTokens: number
  proceedsUsd: number
  feesUsd: number
  stopPrice: number
  stopPct: number
  stopKind: 'initial' | 'breakeven' | 'trailing'
  highPrice: number
  tpHit: number
  trailPct: number | null
  exitReason: string | null
  fills: QuantFill[]
  pnlUsd: number | null
  returnPct: number | null
  maxGainPct: number
  maxDrawdownPct: number
}

export interface QuantBookStats {
  trades: number
  wins: number
  losses: number
  win_rate: number
  profit_factor: number | null
  gross_profit: number
  gross_loss: number
  net_pnl: number
  average_trade: number
  average_winner: number
  average_loser: number
  expectancy_pct: number
  max_drawdown_usd: number
  max_drawdown_pct: number
  average_hold_min: number
  tp_hit_rates: number[]
  stop_rate: number
  exit_reasons: Record<string, number>
}

export interface QuantRegimeView { regime: QuantRegime; at: number; coins: number; breadth: number | null; median_change_pct: number | null; buy_pressure: number | null; median_volatility_pct: number | null; stress_share: number | null; volume_usd: number; why: string }

export interface QuantGate { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] }

export interface QuantStatus {
  enabled: boolean
  at: number
  /** Settings version and the settings themselves (every threshold the engine uses). */
  version: number
  config: Record<string, unknown>
  controls: { tradingEnabled: boolean; paperEnabled: boolean; liveEnabled: boolean; killSwitch: boolean; liveAllowedByEnv: boolean; hasWallet: boolean }
  liveGate: QuantGate
  regime: QuantRegimeView
  warm: { done: boolean; trades: number; detail: string }
  counts: { coins: number; wallets: number; smartWallets: number; openPaper: number; openLive: number; pendingLabels: number }
  equity: { paper: number; live: number | null }
  stats: { paper: Record<string, QuantBookStats>; live: Record<string, QuantBookStats> }
  latencyMs: Record<string, { p50: number; p90: number; p99: number; n: number } | null>
  validation: { running: boolean; last: QuantValidationRun | null; next: number | null }
}

export interface QuantWallet { wallet: string; class: string; quality: number; trade_count: number; win_rate: number; profit_factor: number | null; median_return: number; realized_profit: number; realized_loss: number; tokens_traded: number; average_hold_ms: number; early_entry_frequency: number }

export interface QuantValidationRun { id: string; at: number; kind: 'backtest' | 'walkforward'; ok: boolean; summary: string; oos: QuantBookStats | null; folds?: { fold: number; chosen: string; why: string; test: QuantBookStats }[]; error?: string }

/** The owner's signed controls (POST /v1/quant/control). */
export type QuantControl =
  | { action: 'settings'; patch: string; note: string }
  | { action: 'kill'; on: boolean }
  | { action: 'validate' }

/** The exact text the owner's wallet signs (the engine rebuilds it to check the signature). */
export function quantControlMessage(c: QuantControl, at: number): string {
  const what = c.action === 'settings' ? `Change its settings: ${c.patch}\nWhy: ${c.note}`
    : c.action === 'kill' ? (c.on ? 'Turn the kill switch ON: no new trades, and sell every open position' : 'Turn the kill switch off')
    : 'Run the walk-forward validation now'
  return `ARCDEX signal engine\n${what}\nAt: ${new Date(at).toISOString()}`
}
