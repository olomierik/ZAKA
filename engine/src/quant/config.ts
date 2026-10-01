// The signal engine's settings (engine/src/quant): every weight, threshold,
// band, exit and limit the engine uses, in one validated object. Nothing in
// the engine's logic hard-codes these numbers: they come from here, from
// SIG_CONFIG_JSON at start, and from the owner's signed changes at runtime
// (POST /v1/quant/control), each change kept as a new version
// (arcdex_sig_strategy_parameters).
//
// The defaults are starting points, not findings. The backtester and the
// walk-forward validator (quant/backtest.ts, quant/walkforward.ts) measure
// them, and live trading stays off until those measurements and the paper
// record pass the live gate (quant/risk.ts).

export type StrategyId = 'early_momentum' | 'breakout' | 'smart_money'
export const STRATEGY_IDS: StrategyId[] = ['early_momentum', 'breakout', 'smart_money']
export type Regime = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'HIGH_VOLATILITY' | 'LIQUIDITY_STRESSED'
export const REGIMES: Regime[] = ['BULLISH', 'NEUTRAL', 'BEARISH', 'HIGH_VOLATILITY', 'LIQUIDITY_STRESSED']

/** One profit target: once the price is `gainPct` above the entry, sell `sellPct` of the original position. */
export interface TakeProfit { gainPct: number; sellPct: number }

export interface ExitConfig {
  /** Partial profit taking; what's left after the last target rides the trailing stop. */
  ladder: TakeProfit[]
  /** Initial stop: `volMult` × the coin's recent volatility, kept between minPct and maxPct below the entry. */
  stop: { minPct: number; maxPct: number; volMult: number }
  /** After this many targets the stop moves to break-even (after costs); 0: never. */
  breakevenAfterTp: number
  /** Trailing stop for the rest: armed after `afterTp` targets (or `armGainPct`), `volMult` × volatility, kept between minPct and maxPct under the high. */
  trail: { afterTp: number; armGainPct: number; minPct: number; maxPct: number; volMult: number }
  /** Out after this long whatever happens. */
  maxHoldMin: number
  /** Out if not up `staleGainPct` after `staleMin` minutes (0: off). */
  staleMin: number
  staleGainPct: number
  /** Out when momentum turns (buying gone, price under its 1m VWAP, falling on every short window). */
  momentumExit: boolean
  /** Out when the distribution score reaches this (0–100; 101: off). */
  distributionExit: number
  /** Out when the pool's liquidity falls this far below its level at entry, or its 15-minute high (%). */
  liquidityDropPct: number
}

// Each strategy's `minScore` is its own bar on top of the global gates.minSignalScore (the higher of the two applies; 0: the global bar).
export interface EarlyMomentumConfig {
  enabled: boolean
  maxAgeMin: number
  minLiquidityUsd: number
  minBuyPressure1m: number
  minVolumeAccel: number
  minBuyerGrowth: number
  minUniqueBuyers1m: number
  maxTop10Pct: number
  maxExhaustion: number
  minScore: number
  /** Points added to the score's bar when no smart wallet is in (0: smart money isn't needed). */
  noSmartMoneyPenalty: number
  exits?: Partial<ExitConfig>
}
export interface BreakoutConfig {
  enabled: boolean
  minAgeMin: number
  /** The range before the last minute: its width (high / low − 1) at most this (%). */
  maxRangePct: number
  rangeMin: number
  /** The price at least this far over the range's high (%). */
  minBreakPct: number
  minVolumeAccel: number
  minBuyPressure1m: number
  minLiquidityUsd: number
  maxDistribution: number
  maxExhaustion: number
  minScore: number
  exits?: Partial<ExitConfig>
}
export interface SmartMoneyConfig {
  enabled: boolean
  /** At least this many smart wallets bought within `windowMin`. */
  minWallets: number
  windowMin: number
  /** Not already up this far since the first smart wallet's entry (%). */
  maxRunupPct: number
  minLiquidityUsd: number
  minBuyPressure1m: number
  maxExhaustion: number
  minScore: number
  exits?: Partial<ExitConfig>
}

export interface QuantConfig {
  /** Launchpads whose coins are scored (the engine's launchpad names; ARGUS by default). */
  launchpads: string[]
  /** A coin is evaluated at most this often (ms); evaluations follow its trades. */
  evalEveryMs: number
  /** A trade is large at max(minUsd, liquidityPct % of the pool's liquidity). */
  large: { minUsd: number; liquidityPct: number }
  weights: { flow: number; momentum: number; volume: number; liquidity: number; smartMoney: number; holders: number; safety: number; regime: number }
  /** Score bands: under `watch` no trade, then watch, weak, trade candidate, high conviction. */
  bands: { watch: number; weak: number; candidate: number; highConviction: number }
  gates: {
    minSignalScore: number
    minSafetyScore: number
    maxExhaustion: number
    /** A distribution score this high invalidates a buy; from `distributionPenaltyFrom` it costs points. */
    distributionInvalidate: number
    distributionPenaltyFrom: number
    minLiquidityUsd: number
    /** The most the planned size may move the price on entry, and what a round trip (taxes, fees, impact) may cost (%). */
    maxPriceImpactPct: number
    maxRoundTripPct: number
  }
  /** Points added to the minimum score in each regime (a large number blocks new entries in it). */
  regimeAdjust: Record<Regime, number>
  /** LIQUIDITY_STRESSED: `stressShare` of active coins with a rug alarm or pool depth down `stressDropPct`% over the window (a pool's depth also moves with its price, so the bar is high). */
  regime: { everyMs: number; windowMin: number; bullBreadth: number; bearBreadth: number; bullMedianPct: number; bearMedianPct: number; highVolPct: number; stressShare: number; stressDropPct: number; minTokens: number }
  strategies: { early_momentum: EarlyMomentumConfig; breakout: BreakoutConfig; smart_money: SmartMoneyConfig }
  exits: ExitConfig
  sizing: {
    /** The paper book's starting equity (virtual USDC). */
    paperEquityUsd: number
    /** What a stop-out may cost, as a share of equity (%). */
    riskPerTradePct: number
    maxPositionUsd: number
    minOrderUsd: number
    maxPortfolioExposurePct: number
    /** The size is capped so its own price impact stays under this (%). */
    maxImpactPct: number
    /** Size multiplier range from confidence (0–1). */
    minConfidenceMult: number
    /** A strategy with a recent profit factor under 1 trades at this share of its size; above 1.5, full. */
    weakStrategyMult: number
  }
  risk: {
    tradingEnabled: boolean
    paperEnabled: boolean
    /** Live orders: also needs SIG_LIVE_ALLOWED=1 on the engine and the live gate passing. Off by default. */
    liveEnabled: boolean
    killSwitch: boolean
    maxDailyLossUsd: { paper: number; live: number }
    maxConcurrent: number
    /** The most slippage an order may accept (%). */
    maxSlippagePct: number
  }
  execution: {
    /** Paper and backtest fills: a buy fills at the first price this long after the order, a sale this long after its trigger. */
    entryLatencyMs: number
    exitLatencyMs: number
    /** A buy is skipped if the price moved more than this between the signal and the fill (%). */
    maxDriftPct: number
    /** Costs when the coin's own round trip isn't known: pool fee a side (%). */
    defaultFeePct: number
    gasUsdPerTx: number
    orderTimeoutMs: number
    buySlippageBps: number
    /** Sales retried at these slippages, in turn. */
    sellSlippageBps: number[]
  }
  /** The expected-value check before an order (quant/quality.ts). */
  edge: {
    minEdgePct: number; minEdgeUsd: number; priorWinRate: number; priorAvgWinPct: number; priorAvgLossPct: number; priorTrades: number; lookbackTrades: number
    /** Paper and backtests only: until a strategy has this many trades in the book, any non-negative expected edge is taken, so it gets measured. Live never explores. */
    exploreTrades: number
  }
  smartMoney: {
    minClosedTrades: number
    minTokens: number
    minWinRate: number
    minProfitFactor: number
    minRealizedUsd: number
    minMedianReturnPct: number
    /** A first buy within this long of a coin's launch is an early entry. */
    earlyEntrySec: number
    /** Wallets buying more coins than this a day are bots (scalpers or sniper farms), never smart money. */
    maxTokensPerDay: number
    /** Smart wallets read over the last `windowMin`; clusters are `clusterMin` of them within `clusterWindowMin`. */
    windowMin: number
    clusterWindowMin: number
    clusterMin: number
    /** Wallets kept in memory (the least active are dropped beyond this). */
    maxWallets: number
  }
  /** What live trading needs first (quant/risk.ts liveGate). */
  liveGate: {
    minOosTrades: number
    minOosProfitFactor: number
    minOosExpectancyPct: number
    maxOosDrawdownPct: number
    maxBacktestAgeHours: number
    minPaperTrades: number
    minPaperDays: number
    minPaperProfitFactor: number
    minPaperExpectancyPct: number
    maxPaperDrawdownPct: number
  }
  persistence: { snapshotEveryMs: number; walletFlushMs: number; regimeEveryMs: number }
  /** Outcome labels for each signal (quant/labels.ts): followed this long after it. */
  labels: { horizonMin: number }
}

export const DEFAULT_EXITS: ExitConfig = {
  ladder: [{ gainPct: 12, sellPct: 20 }, { gainPct: 25, sellPct: 25 }, { gainPct: 50, sellPct: 25 }],
  stop: { minPct: 6, maxPct: 20, volMult: 2.5 },
  breakevenAfterTp: 1,
  trail: { afterTp: 2, armGainPct: 35, minPct: 10, maxPct: 30, volMult: 3 },
  maxHoldMin: 60,
  staleMin: 10,
  staleGainPct: 3,
  momentumExit: true,
  distributionExit: 75,
  liquidityDropPct: 25,
}

export const DEFAULT_CONFIG: QuantConfig = {
  launchpads: ['ARGUS'],
  evalEveryMs: 1_000,
  large: { minUsd: 250, liquidityPct: 1 },
  weights: { flow: 20, momentum: 15, volume: 15, liquidity: 15, smartMoney: 10, holders: 10, safety: 10, regime: 5 },
  bands: { watch: 50, weak: 65, candidate: 75, highConviction: 85 },
  // The bar to trade (minSignalScore) is 60, not the 75 of the "trade candidate" band: replayed on 3.6 days of Argus trades
  // (190 coins), scores clustered at 55–68 and almost nothing reached 75; the walk-forward chose 55–60 on its training
  // windows. A small sample: the validator re-runs the grid every 12 hours and the owner sets the bar (Controls).
  gates: { minSignalScore: 60, minSafetyScore: 60, maxExhaustion: 65, distributionInvalidate: 70, distributionPenaltyFrom: 40, minLiquidityUsd: 5_000, maxPriceImpactPct: 3, maxRoundTripPct: 12 },
  regimeAdjust: { BULLISH: -2, NEUTRAL: 0, BEARISH: 5, HIGH_VOLATILITY: 3, LIQUIDITY_STRESSED: 10 },
  regime: { everyMs: 30_000, windowMin: 15, bullBreadth: 0.55, bearBreadth: 0.4, bullMedianPct: 2, bearMedianPct: -2, highVolPct: 12, stressShare: 0.35, stressDropPct: 50, minTokens: 5 },
  strategies: {
    early_momentum: { enabled: true, maxAgeMin: 30, minLiquidityUsd: 5_000, minBuyPressure1m: 0.6, minVolumeAccel: 1.5, minBuyerGrowth: 1, minUniqueBuyers1m: 5, maxTop10Pct: 50, maxExhaustion: 60, minScore: 0, noSmartMoneyPenalty: 0 },
    breakout: { enabled: true, minAgeMin: 30, maxRangePct: 25, rangeMin: 15, minBreakPct: 0.5, minVolumeAccel: 2, minBuyPressure1m: 0.58, minLiquidityUsd: 8_000, maxDistribution: 40, maxExhaustion: 55, minScore: 0 },
    smart_money: { enabled: true, minWallets: 2, windowMin: 5, maxRunupPct: 30, minLiquidityUsd: 5_000, minBuyPressure1m: 0.55, maxExhaustion: 60, minScore: 0 },
  },
  exits: DEFAULT_EXITS,
  sizing: { paperEquityUsd: 1_000, riskPerTradePct: 1, maxPositionUsd: 50, minOrderUsd: 2, maxPortfolioExposurePct: 30, maxImpactPct: 2, minConfidenceMult: 0.5, weakStrategyMult: 0.5 },
  risk: { tradingEnabled: true, paperEnabled: true, liveEnabled: false, killSwitch: false, maxDailyLossUsd: { paper: 100, live: 20 }, maxConcurrent: 5, maxSlippagePct: 8 },
  execution: { entryLatencyMs: 2_500, exitLatencyMs: 2_000, maxDriftPct: 5, defaultFeePct: 1, gasUsdPerTx: 0.01, orderTimeoutMs: 120_000, buySlippageBps: 800, sellSlippageBps: [800, 1_500, 3_000, 6_000] },
  // The prior (before a strategy has its own record): half its trades win an average +18% across the ladder, the rest
  // lose about 8%, before costs. A coin whose costs eat that is refused from the start; after 20 trades the record leads.
  edge: { minEdgePct: 1.5, minEdgeUsd: 0.05, priorWinRate: 0.5, priorAvgWinPct: 18, priorAvgLossPct: 8, priorTrades: 20, lookbackTrades: 50, exploreTrades: 20 },
  smartMoney: { minClosedTrades: 5, minTokens: 3, minWinRate: 0.55, minProfitFactor: 1.5, minRealizedUsd: 20, minMedianReturnPct: 0, earlyEntrySec: 120, maxTokensPerDay: 40, windowMin: 10, clusterWindowMin: 3, clusterMin: 2, maxWallets: 200_000 },
  liveGate: { minOosTrades: 30, minOosProfitFactor: 1.2, minOosExpectancyPct: 0.5, maxOosDrawdownPct: 25, maxBacktestAgeHours: 48, minPaperTrades: 30, minPaperDays: 2, minPaperProfitFactor: 1.2, minPaperExpectancyPct: 0.5, maxPaperDrawdownPct: 25 },
  persistence: { snapshotEveryMs: 60_000, walletFlushMs: 300_000, regimeEveryMs: 60_000 },
  labels: { horizonMin: 60 },
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `base` with `patch` laid over it (objects merged key by key, arrays and values replaced). Unknown keys are refused. */
export function mergeConfig<T>(base: T, patch: unknown, path = ''): T {
  if (patch === undefined) return base
  if (!isObj(base)) return patch as T
  if (!isObj(patch)) throw new Error(`${path || 'config'}: expected an object`)
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    // Strategy exit overrides are optional keys; everything else must exist.
    if (!(k in out) && k !== 'exits') throw new Error(`${path ? path + '.' : ''}${k}: not a setting`)
    out[k] = k in out && isObj(out[k]) ? mergeConfig(out[k], v, `${path ? path + '.' : ''}${k}`) : v
  }
  return out as T
}

/** Why `c` can't be used, or null. Ranges are wide on purpose: they catch typos, not choices. */
export function validateConfig(c: QuantConfig): string | null {
  const bad: string[] = []
  const num = (p: string, v: unknown, lo: number, hi: number) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) bad.push(`${p} must be a number from ${lo} to ${hi}`) }
  const bool = (p: string, v: unknown) => { if (typeof v !== 'boolean') bad.push(`${p} must be true or false`) }
  if (!Array.isArray(c.launchpads) || !c.launchpads.length || c.launchpads.some(l => typeof l !== 'string')) bad.push('launchpads must list at least one launchpad')
  num('evalEveryMs', c.evalEveryMs, 100, 60_000)
  num('large.minUsd', c.large.minUsd, 0, 1e7); num('large.liquidityPct', c.large.liquidityPct, 0, 100)
  const w = c.weights
  for (const [k, v] of Object.entries(w)) num(`weights.${k}`, v, 0, 100)
  const total = Object.values(w).reduce((s, v) => s + (Number(v) || 0), 0)
  if (Math.abs(total - 100) > 1e-6) bad.push(`weights must add up to 100 (they add up to ${total})`)
  const b = c.bands
  if (!(b.watch <= b.weak && b.weak <= b.candidate && b.candidate <= b.highConviction)) bad.push('bands must rise: watch ≤ weak ≤ candidate ≤ highConviction')
  for (const [k, v] of Object.entries(b)) num(`bands.${k}`, v, 0, 100)
  const g = c.gates
  num('gates.minSignalScore', g.minSignalScore, 0, 100); num('gates.minSafetyScore', g.minSafetyScore, 0, 100); num('gates.maxExhaustion', g.maxExhaustion, 0, 100)
  num('gates.distributionInvalidate', g.distributionInvalidate, 0, 101); num('gates.distributionPenaltyFrom', g.distributionPenaltyFrom, 0, 100)
  num('gates.minLiquidityUsd', g.minLiquidityUsd, 0, 1e9); num('gates.maxPriceImpactPct', g.maxPriceImpactPct, 0.01, 100); num('gates.maxRoundTripPct', g.maxRoundTripPct, 0, 100)
  for (const r of Object.keys(c.regimeAdjust)) num(`regimeAdjust.${r}`, c.regimeAdjust[r as Regime], -100, 1_000)
  num('regime.everyMs', c.regime.everyMs, 1_000, 3_600_000); num('regime.windowMin', c.regime.windowMin, 1, 240)
  const checkExits = (p: string, e: Partial<ExitConfig>) => {
    if (e.ladder !== undefined) {
      if (!Array.isArray(e.ladder)) bad.push(`${p}.ladder must be a list`)
      else {
        let last = 0, sold = 0
        for (const [i, t] of e.ladder.entries()) {
          num(`${p}.ladder[${i}].gainPct`, t?.gainPct, 0.1, 10_000); num(`${p}.ladder[${i}].sellPct`, t?.sellPct, 0.1, 100)
          if (t && t.gainPct <= last) bad.push(`${p}.ladder must rise`)
          last = t?.gainPct ?? last; sold += t?.sellPct ?? 0
        }
        if (sold > 100 + 1e-9) bad.push(`${p}.ladder sells more than 100%`)
      }
    }
    if (e.stop) { num(`${p}.stop.minPct`, e.stop.minPct, 0.5, 90); num(`${p}.stop.maxPct`, e.stop.maxPct, 0.5, 95); num(`${p}.stop.volMult`, e.stop.volMult, 0, 50); if (e.stop.minPct > e.stop.maxPct) bad.push(`${p}.stop.minPct over maxPct`) }
    if (e.trail) { num(`${p}.trail.minPct`, e.trail.minPct, 0.5, 95); num(`${p}.trail.maxPct`, e.trail.maxPct, 0.5, 99); num(`${p}.trail.volMult`, e.trail.volMult, 0, 50); num(`${p}.trail.afterTp`, e.trail.afterTp, 0, 20); num(`${p}.trail.armGainPct`, e.trail.armGainPct, 0, 10_000) }
    if (e.maxHoldMin !== undefined) num(`${p}.maxHoldMin`, e.maxHoldMin, 0.1, 7 * 24 * 60)
    if (e.liquidityDropPct !== undefined) num(`${p}.liquidityDropPct`, e.liquidityDropPct, 1, 100)
    if (e.distributionExit !== undefined) num(`${p}.distributionExit`, e.distributionExit, 0, 101)
    if (e.momentumExit !== undefined) bool(`${p}.momentumExit`, e.momentumExit)
  }
  checkExits('exits', c.exits)
  for (const id of STRATEGY_IDS) {
    const s = c.strategies[id]
    if (!s) { bad.push(`strategies.${id} is missing`); continue }
    bool(`strategies.${id}.enabled`, s.enabled)
    num(`strategies.${id}.minScore`, s.minScore, 0, 100)
    if (s.exits) checkExits(`strategies.${id}.exits`, s.exits)
  }
  const z = c.sizing
  num('sizing.paperEquityUsd', z.paperEquityUsd, 1, 1e9); num('sizing.riskPerTradePct', z.riskPerTradePct, 0.01, 100)
  num('sizing.maxPositionUsd', z.maxPositionUsd, 0.1, 1e9); num('sizing.minOrderUsd', z.minOrderUsd, 0, 1e9)
  num('sizing.maxPortfolioExposurePct', z.maxPortfolioExposurePct, 0.1, 100); num('sizing.maxImpactPct', z.maxImpactPct, 0.01, 100)
  num('sizing.minConfidenceMult', z.minConfidenceMult, 0, 1); num('sizing.weakStrategyMult', z.weakStrategyMult, 0, 1)
  if (z.minOrderUsd > z.maxPositionUsd) bad.push('sizing.minOrderUsd is over maxPositionUsd')
  const r = c.risk
  bool('risk.tradingEnabled', r.tradingEnabled); bool('risk.paperEnabled', r.paperEnabled); bool('risk.liveEnabled', r.liveEnabled); bool('risk.killSwitch', r.killSwitch)
  num('risk.maxDailyLossUsd.paper', r.maxDailyLossUsd.paper, 0, 1e9); num('risk.maxDailyLossUsd.live', r.maxDailyLossUsd.live, 0, 1e9)
  num('risk.maxConcurrent', r.maxConcurrent, 0, 1_000); num('risk.maxSlippagePct', r.maxSlippagePct, 0.1, 99)
  const x = c.execution
  num('execution.entryLatencyMs', x.entryLatencyMs, 0, 600_000); num('execution.exitLatencyMs', x.exitLatencyMs, 0, 600_000)
  num('execution.maxDriftPct', x.maxDriftPct, 0, 100); num('execution.defaultFeePct', x.defaultFeePct, 0, 50); num('execution.gasUsdPerTx', x.gasUsdPerTx, 0, 100)
  num('execution.orderTimeoutMs', x.orderTimeoutMs, 1_000, 3_600_000); num('execution.buySlippageBps', x.buySlippageBps, 1, 9_900)
  if (!Array.isArray(x.sellSlippageBps) || !x.sellSlippageBps.length) bad.push('execution.sellSlippageBps must list at least one slippage')
  else x.sellSlippageBps.forEach((v, i) => num(`execution.sellSlippageBps[${i}]`, v, 1, 9_900))
  const e = c.edge
  num('edge.minEdgePct', e.minEdgePct, -100, 100); num('edge.minEdgeUsd', e.minEdgeUsd, -1e6, 1e6); num('edge.priorWinRate', e.priorWinRate, 0, 1)
  num('edge.priorAvgWinPct', e.priorAvgWinPct, 0, 10_000); num('edge.priorAvgLossPct', e.priorAvgLossPct, 0, 100); num('edge.priorTrades', e.priorTrades, 0, 10_000); num('edge.lookbackTrades', e.lookbackTrades, 1, 100_000); num('edge.exploreTrades', e.exploreTrades, 0, 100_000)
  const m = c.smartMoney
  num('smartMoney.minClosedTrades', m.minClosedTrades, 1, 10_000); num('smartMoney.minWinRate', m.minWinRate, 0, 1); num('smartMoney.minProfitFactor', m.minProfitFactor, 0, 1_000)
  num('smartMoney.windowMin', m.windowMin, 0.1, 1_440); num('smartMoney.clusterMin', m.clusterMin, 1, 1_000); num('smartMoney.maxWallets', m.maxWallets, 100, 10_000_000)
  num('labels.horizonMin', c.labels.horizonMin, 1, 7 * 24 * 60)
  return bad.length ? bad.join('; ') : null
}

/** A strategy's exits: the engine's, with the strategy's own overrides laid over them. */
export function exitsFor(c: QuantConfig, s: StrategyId): ExitConfig {
  const own = c.strategies[s]?.exits
  return own ? mergeConfig(c.exits, own) : c.exits
}

/** The settings at start: the defaults with SIG_CONFIG_JSON laid over them (refused with a clear error when invalid). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): QuantConfig {
  let c = DEFAULT_CONFIG
  const launchpads = env.SIG_LAUNCHPADS?.split(',').map(s => s.trim()).filter(Boolean)
  if (launchpads?.length) c = { ...c, launchpads }
  if (env.SIG_CONFIG_JSON?.trim()) c = mergeConfig(c, JSON.parse(env.SIG_CONFIG_JSON))
  const bad = validateConfig(c)
  if (bad) throw new Error(`signal engine settings: ${bad}`)
  return c
}
