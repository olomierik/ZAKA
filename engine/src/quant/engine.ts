// The signal engine (engine/src/quant): event-driven, one market event at a
// time, the same code live and in backtests.
//
//   trade ──▶ tape (5s … 1h windows, holders) ──▶ wallet book (smart money)
//          ──▶ labels, paper fills, open positions' exits
//          ──▶ the coin is marked for evaluation (at most every evalEveryMs)
//   evaluation: features ▶ safety ▶ score ▶ strategies ▶ gates ▶ EV ▶ size ▶ risk
//          ──▶ a signal (stored with every feature and why it was or wasn't traded)
//          ──▶ a paper position, and a live one when the live gate passes
//   tick: market regime, time exits, labels, snapshots, wallet records
//
// Paper never sends a transaction. Live orders need every condition of the
// live gate (quant/risk.ts), which is off by default.

import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import type { QuantRadarRow, QuantSignal } from '../../../api/_quantProtocol'
import type { SafetyReport } from '../intel/scanner'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import { DEFAULT_CONFIG, REGIMES, STRATEGY_IDS, validateConfig, type QuantConfig, type StrategyId } from './config'
import { paperBuy, paperSell, type ExecutionEvent, type FillCosts, type LiveOrders, type OrderResult, type PendingOrder } from './execution'
import { computeFeatures, featureVector, type FeatureResult, type Features } from './features'
import { Labeler } from './labels'
import { costsOf, impactOf, type Costs } from './liquidity'
import { bookStats, manage, type BookStats, type ExitAction, type QPosition } from './positions'
import { tradeQuality, type StrategyRecord } from './quality'
import { regimeOf, type CoinSnapshot, type RegimeView } from './regime'
import { RiskGovernor, type LiveGate, type RiskEvent } from './risk'
import { assessSafety, type SafetyVerdict } from './safety'
import { scoreSignal, type Score } from './score'
import { positionSize, type SizeResult } from './sizing'
import type { QuantStore } from './store'
import { checkStrategies, planFor, type Plan, type StrategyCheck } from './strategies'
import { qtradeOf, TokenTape } from './tape'
import { ramp, round } from './util'
import { WalletBook } from './wallets'

export type Book = 'paper' | 'live' | 'backtest'

export interface QuantDeps {
  store: QuantStore
  /** `live`: the live market feed (a paper book, and live orders once the gate passes). `backtest`: a replay. */
  mode: 'live' | 'backtest'
  meta: (token: string) => LaunchInfo | null
  /** The market engine's view of a coin: its main pool, depth and supply. */
  token: (token: string) => { mainPool: string | null; liquidityUsd: number | null; supply: number | null } | null
  /** The scanner's latest report for a coin (cached; never a network call). */
  safety: (token: string) => SafetyReport | null
  /** Starts a deep scan; its report shows in `safety` once done. */
  requestSafety?: (token: string) => void
  rugAlarm: (token: string, now: number) => string | null
  live?: LiveOrders | null
  liveAllowedByEnv?: boolean
  hasWallet?: boolean
  /** The live wallet's worth (USDC), for live sizing. */
  liveEquity?: () => number | null
  decimals?: (token: string) => number
  config?: QuantConfig
}

/** A signal as served and stored (api/_quantProtocol.ts QuantSignal). */
export type SignalView = QuantSignal & { [k: string]: unknown }

export type RadarRow = QuantRadarRow

const DUST = 1e-9
const SIGNAL_COOLDOWN_MS = 10 * 60_000
const DIST_CACHE_MS = 2_000
const STALE_FILL_MS = 15_000

/** Main pool of each coin in a replay (the deepest seen), when there's no market engine to say. */
export class PoolPicker {
  private best = new Map<string, { pool: string; liq: number }>()
  main(t: Trade): boolean {
    const b = this.best.get(t.token)
    if (t.liquidity !== null && (!b || t.pool === b.pool || t.liquidity > b.liq)) this.best.set(t.token, { pool: t.pool, liq: t.liquidity })
    const now = this.best.get(t.token)
    return !now || now.pool === t.pool
  }
}

export class SignalEngine {
  cfg: QuantConfig
  cfgVersion = 0
  readonly tapes = new Map<string, TokenTape>()
  readonly wallets: WalletBook
  readonly risk: RiskGovernor
  readonly labeler: Labeler
  regime: RegimeView = { regime: 'NEUTRAL', at: 0, coins: 0, breadth: null, median_change_pct: null, buy_pressure: null, median_volatility_pct: null, stress_share: null, volume_usd: 0, why: 'not computed yet' }
  readonly positions: QPosition[] = []
  readonly closed: QPosition[] = []
  readonly signals: SignalView[] = []
  readonly radar = new Map<string, RadarRow>()
  readonly riskLog: RiskEvent[] = []
  readonly execLog: ExecutionEvent[] = []
  private pending: PendingOrder[] = []
  private pendingSell = new Map<string, PendingOrder>()
  private dirty = new Map<string, number>()
  private lastEval = new Map<string, number>()
  private emitted = new Map<string, { at: number; decision: string }>()
  private distCache = new Map<string, { at: number; v: number; turn: boolean }>()
  private lastSnapshot = new Map<string, number>()
  private picker = new PoolPicker()
  private lastRegimeAt = 0
  private lastRegimeSaved = 0
  private lastWalletFlush = 0
  private lastCleanup = 0
  private lastForget = 0
  private lastLabels = 0
  /** Trade ids seen lately (duplicate events dropped before anything counts them). */
  private seen = new Set<string>()
  private seenOrder: string[] = []
  private lastIngestAt = 0
  /** Market time: the newest block time seen (live and replay alike). */
  marketNow = 0
  /** Paper book equity: the start plus realized P&L. */
  paperRealized = 0
  oos: (BookStats & { at: number }) | null = null
  warm = true
  private seq = 0

  constructor(readonly d: QuantDeps) {
    this.cfg = d.config ?? DEFAULT_CONFIG
    this.wallets = new WalletBook(this.cfg.smartMoney)
    this.risk = new RiskGovernor(() => this.cfg, d.liveAllowedByEnv ?? false)
    this.labeler = new Labeler(() => this.cfg.labels.horizonMin)
  }

  get book(): Book { return this.d.mode === 'backtest' ? 'backtest' : 'paper' }

  /** New settings (validated); kept as a new version. */
  async setConfig(c: QuantConfig, by: string, note: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
    const bad = validateConfig(c)
    if (bad) return { ok: false, error: bad }
    const killing = c.risk.killSwitch && !this.cfg.risk.killSwitch
    this.cfg = c
    this.wallets.setConfig(c.smartMoney)
    this.cfgVersion = await this.d.store.saveParams({ at: Date.now(), by, note, config: c }).catch(() => this.cfgVersion + 1)
    this.riskEvent({ at: Date.now(), mode: this.book, kind: 'config', detail: `settings v${this.cfgVersion} by ${by}: ${note}` })
    if (killing) this.emergencyCloseAll('kill switch')
    return { ok: true, version: this.cfgVersion }
  }

  // ── events ────────────────────────────────────────────────────────────

  /** One trade from the market engine (or a replay). `replay`: historical, rebuild state only. */
  ingest(t: Trade, o: { replay?: boolean; now?: number } = {}) {
    const meta = this.d.meta(t.token)
    if (!meta) return
    const ts = t.timestamp
    if (ts > this.marketNow) this.marketNow = ts
    const st = this.d.token(t.token)
    const main = this.d.mode === 'backtest' || !st?.mainPool ? this.picker.main(t) : st.mainPool === t.pool
    const q = qtradeOf(t, main)
    if (!q) return
    if (this.seen.has(q.id)) { metrics.inc('quant_duplicate_events'); return }
    this.seen.add(q.id); this.seenOrder.push(q.id)
    if (this.seenOrder.length > 300_000) for (const id of this.seenOrder.splice(0, 50_000)) this.seen.delete(id)
    // Every launch's trades teach the wallet book; tapes only for the scored launchpads.
    const scored = this.cfg.launchpads.includes(meta.launchpad)
    let tape = this.tapes.get(t.token)
    if (!tape && scored) {
      tape = new TokenTape(t.token, meta.timestamp, meta.creator?.toLowerCase() ?? null, st?.supply ?? (meta.launchpad === 'ARGUS' ? 1e9 : null), meta.launchpad, meta.symbol)
      this.tapes.set(t.token, tape)
    }
    if (tape) {
      if (st?.supply) tape.supply = st.supply
      if (!tape.add(q)) { metrics.inc('quant_duplicate_events'); return }
    }
    this.wallets.onTrade(q.wallet, t.token, q.side, q.usd, q.tokens, ts, meta.timestamp)
    metrics.inc('quant_trades')
    if (o.replay) return
    const now = o.now ?? (this.d.mode === 'backtest' ? ts : Date.now())
    if (this.d.mode === 'live') { metrics.latency('quant_data_latency', Math.max(0, Date.now() - ts)); this.lastIngestAt = Date.now() }
    if (q.price !== null) {
      this.labeler.onPrice(t.token, q.price, ts)
      this.fillDue(t.token, q.price, tape?.lastLiquidity ?? q.liquidity, this.mkt(now))
      this.manageToken(t.token, this.mkt(now))
    }
    if (tape) this.dirty.set(t.token, ts)
  }

  /** Market time for decisions: event time in a replay; live, the newest block time (never ahead of the wall clock). */
  private mkt(now: number) { return this.d.mode === 'backtest' ? now : Math.min(now, Math.max(this.marketNow, now - 5_000)) }

  /** Evaluates the coins that traded since their last evaluation, at most every evalEveryMs each. */
  evaluateDue(now: number) {
    for (const [token] of this.dirty) {
      if (now - (this.lastEval.get(token) ?? 0) < this.cfg.evalEveryMs) continue
      this.dirty.delete(token)
      this.lastEval.set(token, now)
      try { this.evaluate(token, now) } catch (e) { metrics.inc('quant_eval_errors'); log.warn('quant: evaluation failed', { token, error: errMsg(e) }) }
    }
  }

  // ── evaluation ────────────────────────────────────────────────────────

  private recordOf(strategy: StrategyId, book: Book): StrategyRecord {
    const own = this.closed.filter(p => p.strategy === strategy && p.mode === book)
    // Live with little history leans on the paper book's record of the same strategy.
    const src = book === 'live' && own.length < 10 ? this.closed.filter(p => p.strategy === strategy && p.mode === 'paper') : own
    const last = src.slice(-this.cfg.edge.lookbackTrades)
    return { trades: last.length, wins: last.filter(p => (p.pnlUsd ?? 0) > 0).length, returns: last.map(p => (p.returnPct ?? 0) / 100) }
  }

  private profitFactor(strategy: StrategyId, book: Book): number | null {
    const r = this.recordOf(strategy, book)
    if (r.trades < 10) return null
    const gp = r.returns.filter(x => x > 0).reduce((s, x) => s + x, 0), gl = -r.returns.filter(x => x <= 0).reduce((s, x) => s + x, 0)
    return gl > 0 ? gp / gl : 99
  }

  equity(book: Book): number {
    if (book === 'live') return this.d.liveEquity?.() ?? 0
    return this.cfg.sizing.paperEquityUsd + this.paperRealized
  }

  private open(book: Book) { return this.positions.filter(p => p.mode === book && (p.status === 'open' || p.status === 'pending')) }

  evaluate(token: string, now: number): SignalView | null {
    const tape = this.tapes.get(token)
    const meta = this.d.meta(token)
    if (!tape || !meta || !this.cfg.launchpads.includes(meta.launchpad)) return null
    const t0 = performance.now()
    const c = this.cfg
    const mnow = this.mkt(now)
    // A cheap first look: no trading in the last minute, or a pool far under the minimum, can't qualify.
    const liqNow = tape.lastLiquidity ?? this.d.token(token)?.liquidityUsd ?? null
    if ((liqNow ?? 0) < c.gates.minLiquidityUsd * 0.5 || tape.volume(mnow, 60_000) < 50) { metrics.inc('quant_evals_skipped'); return null }
    const fr = computeFeatures(tape, mnow, { wallets: this.wallets, regime: this.regime.regime, large: c.large, liquidityFallback: this.d.token(token)?.liquidityUsd ?? null })
    const f = fr.f
    metrics.inc('quant_evals')
    if (!f.price) return null
    const report = this.d.safety(token)
    const book = this.book
    // A size to judge the pool and the costs by: the risk budget at the coin's stop, before confidence.
    const checks = checkStrategies(f, c)
    const met = checks.filter(x => x.ok)
    const probeRt = report?.honeypot?.roundTripLossPct ?? null
    const nominal = (s: StrategyId) => {
      const plan = planFor(s, f.price!, f.volatility, c)
      const pre = costsOf(c.sizing.maxPositionUsd, f.liquidity, { probeRoundTripPct: probeRt, buyTaxPct: report?.honeypot?.buyTaxPct ?? null, defaultFeePct: c.execution.defaultFeePct, gasUsdPerTx: c.execution.gasUsdPerTx })
      const size = positionSize({ equityUsd: this.equity(book), exposureUsd: 0, confidence: 1, stopPct: plan.stop.pct, roundTrip: pre.roundTrip, liquidity: f.liquidity, strategyProfitFactor: null }, c)
      return { plan, size: size.usd || c.sizing.minOrderUsd }
    }
    const lead = met[0]?.strategy ?? checks[0]?.strategy ?? 'early_momentum'
    const nom = nominal(lead)
    const impactPct = impactOf(nom.size, f.liquidity) * 100
    const safety = assessSafety({ report, rugAlarm: this.d.rugAlarm(token, mnow), liquidity: f.liquidity, impactPct, top10Pct: f.holder_concentration, creatorLeft: f.creator_left, creatorPct: f.creator_holding_pct, limits: c.gates })
    const score = scoreSignal(f, { safetyScore: safety.safety_score, impactPct }, c)
    const summary = this.summaryOf(f, score, safety, impactPct)
    this.radar.set(token, { token, symbol: tape.symbol, at: now, score: score.signal_score, band: score.band, strategy: met[0]?.strategy ?? null, summary })
    if (this.radar.size > 400) { const oldest = [...this.radar.values()].sort((a, b) => a.at - b.at)[0]; this.radar.delete(oldest.token) }
    this.snapshot(token, now, summary)
    metrics.latency('quant_eval_ms', performance.now() - t0)
    if (!met.length || score.band === 'NO_TRADE' && !score.invalidated) return null
    // A strategy's conditions are met: a signal. The deep scan is asked for if there's none yet.
    if (!report && this.d.requestSafety) this.d.requestSafety(token)
    // The strategy with the most room over its own bar.
    const adj = c.regimeAdjust[this.regime.regime] ?? 0
    const pick = [...met].sort((a, b) => (score.signal_score - b.minScore) - (score.signal_score - a.minScore))[0]
    const view = this.decide(token, tape, meta, f, fr, pick, checks, score, safety, impactPct, adj, now, mnow)
    metrics.latency('quant_signal_ms', performance.now() - t0)
    return view
  }

  private decide(token: string, tape: TokenTape, meta: LaunchInfo, f: Features, fr: FeatureResult, pick: StrategyCheck, checks: StrategyCheck[], score: Score, safety: SafetyVerdict, impactPct: number, adj: number, now: number, mnow: number): SignalView | null {
    const c = this.cfg
    const s = pick.strategy
    const book = this.book
    const plan = planFor(s, f.price!, f.volatility, c)
    const report = this.d.safety(token)
    const rejected: string[] = [], allowed: string[] = []
    const need = (ok: boolean, yes: string, no: string) => { (ok ? allowed : rejected).push(ok ? yes : no); return ok }
    const bar = Math.max(pick.minScore, c.gates.minSignalScore) + adj
    need(!score.invalidated, 'no distribution event', `invalidated: ${score.invalidated}`)
    const barWhy = `${s} ${pick.minScore}, global ${c.gates.minSignalScore}, regime ${this.regime.regime} ${adj >= 0 ? '+' : ''}${adj}`
    need(score.signal_score >= bar, `score ${score.signal_score} ≥ ${bar} (${barWhy})`, `score ${score.signal_score} under ${bar} (${barWhy})`)
    need(safety.trade_allowed, `safety ${safety.safety_score}: allowed`, `safety: ${safety.critical.join('; ') || 'not allowed'}`)
    need(f.exhaustion_score <= c.gates.maxExhaustion, `exhaustion ${f.exhaustion_score} ≤ ${c.gates.maxExhaustion}`, `exhaustion ${f.exhaustion_score} over ${c.gates.maxExhaustion}: the move may be spent`)
    // Size, costs and the expected edge.
    const confidence = this.confidence(f, score, s)
    const costsAt = (usd: number): Costs => costsOf(usd, f.liquidity, { probeRoundTripPct: report?.honeypot?.roundTripLossPct ?? null, buyTaxPct: report?.honeypot?.buyTaxPct ?? null, defaultFeePct: c.execution.defaultFeePct, gasUsdPerTx: c.execution.gasUsdPerTx })
    const exposure = this.open(book).reduce((x, p) => x + (p.costUsd || p.plannedUsd), 0)
    const size: SizeResult = positionSize({ equityUsd: this.equity(book), exposureUsd: exposure, confidence, stopPct: plan.stop.pct, roundTrip: costsAt(c.sizing.maxPositionUsd).roundTrip, liquidity: f.liquidity, strategyProfitFactor: this.profitFactor(s, book) }, c)
    need(size.usd > 0, `size $${size.usd.toFixed(2)} (limited by ${size.limitedBy})`, `no size: ${size.why[size.why.length - 1]}`)
    const costs = costsAt(Math.max(size.usd, c.sizing.minOrderUsd))
    const record = this.recordOf(s, book)
    const q = tradeQuality({ sizeUsd: Math.max(size.usd, c.sizing.minOrderUsd), costs, stopPct: plan.stop.pct, record, edge: c.edge, explore: book !== 'live' && record.trades < c.edge.exploreTrades })
    need(q.ok, `edge: ${q.why}`, `edge: ${q.why}`)
    if (!rejected.length) {
      const why = this.risk.check({ mode: book, token, sizeUsd: size.usd, equityUsd: this.equity(book), open: this.positions.filter(p => p.mode === book), closedToday: this.closed.filter(p => p.mode === book), score: score.signal_score, safetyScore: safety.safety_score, exhaustion: f.exhaustion_score, liquidity: f.liquidity, slippagePct: costs.entrySlippage * 100 }, now)
      need(!why, 'risk limits: within them', `risk: ${why}`)
      if (why) this.riskEvent({ at: now, mode: book, kind: 'refused', token, detail: why })
    }
    const traded = rejected.length === 0
    // One signal per coin and strategy per cooldown, unless it now trades.
    const key = `${token}:${s}`
    const last = this.emitted.get(key)
    if (last && now - last.at < SIGNAL_COOLDOWN_MS && !(traded && last.decision !== 'traded')) { metrics.inc('quant_duplicate_signals'); return null }
    this.emitted.set(key, { at: now, decision: traded ? 'traded' : 'rejected' })
    const id = `q:${s}:${token}:${now}:${++this.seq}`
    const positions: string[] = []
    if (traded) {
      positions.push(this.openPosition(id, token, tape, s, plan, size.usd, costs, f, now, book).id)
      metrics.inc('quant_signals_traded')
      // Live, beside the paper book, once every condition of the live gate passes.
      if (this.d.mode === 'live' && this.d.live) {
        const gate = this.liveGate(now)
        if (gate.ok) {
          const liveSize = positionSize({ equityUsd: this.equity('live'), exposureUsd: this.open('live').reduce((x, p) => x + (p.costUsd || p.plannedUsd), 0), confidence, stopPct: plan.stop.pct, roundTrip: costs.roundTrip, liquidity: f.liquidity, strategyProfitFactor: this.profitFactor(s, 'live') }, c)
          const why = liveSize.usd > 0 ? this.risk.check({ mode: 'live', token, sizeUsd: liveSize.usd, equityUsd: this.equity('live'), open: this.positions.filter(p => p.mode === 'live'), closedToday: this.closed.filter(p => p.mode === 'live'), score: score.signal_score, safetyScore: safety.safety_score, exhaustion: f.exhaustion_score, liquidity: f.liquidity, slippagePct: costs.entrySlippage * 100 }, now) : 'no live size'
          if (why) this.riskEvent({ at: now, mode: 'live', kind: 'refused', token, detail: why })
          else positions.push(this.openPosition(id, token, tape, s, plan, liveSize.usd, costs, f, now, 'live').id)
        }
      }
    } else metrics.inc('quant_signals_rejected')
    for (const r of rejected) metrics.inc(`quant_reject_${r.split(/[: ]/)[0]}`)
    const triggered = pick.conditions.map(x => x.text)
    const view: SignalView = {
      id, at: now, token, symbol: meta.symbol, launchpad: meta.launchpad, strategy: s, signal_score: score.signal_score, band: score.band,
      decision: traded ? 'traded' : 'rejected', mode: book,
      confidence: round(confidence, 3)!, components: score.components, distribution_penalty: score.distribution_penalty,
      entry_reason: [...triggered, ...this.componentReasons(score)],
      risk_flags: [...safety.risk_flags, ...(f.exhaustion_score > 50 ? ['exhaustion'] : []), ...(f.distribution_score >= c.gates.distributionPenaltyFrom ? ['distribution'] : []), ...(this.regime.regime !== 'NEUTRAL' && this.regime.regime !== 'BULLISH' ? [`regime-${this.regime.regime.toLowerCase()}`] : [])],
      why_signal_triggered: [`${s}: every condition met`, ...triggered, ...checks.filter(x => x.strategy !== s && x.ok).map(x => `also met: ${x.strategy}`)],
      why_trade_allowed: allowed, why_trade_rejected: rejected,
      recommended_entry: plan.entry, recommended_stop: plan.stop, recommended_targets: plan.targets,
      position_size: traded ? size.usd : 0, sizing: size.why,
      trade_quality: q,
      safety: { safety_score: safety.safety_score, risk_flags: safety.risk_flags, critical: safety.critical, trade_allowed: safety.trade_allowed },
      regime: this.regime.regime,
      summary: this.summaryOf(f, score, safety, impactPct),
      latency_ms: { data: this.d.mode === 'live' ? Math.max(0, Date.now() - tape.lastTs) : null, signal: this.d.mode === 'live' && this.lastIngestAt ? Math.max(0, Date.now() - this.lastIngestAt) : null },
      positions,
    }
    this.signals.unshift(view)
    if (this.signals.length > 500) this.signals.length = 500
    const regimeIndex = REGIMES.indexOf(this.regime.regime)
    this.d.store.saveSignal(view, { signalId: id, at: now, token, strategy: s, vector: featureVector(f, { tax: safety.roundTripPct, slippage: round(costs.entrySlippage * 100, 3), signalScore: score.signal_score, regimeIndex }), features: { ...f, exhaustion_parts: fr.exhaustionParts, top_sellers: fr.distribution.top_sellers, smart_wallets: fr.smart?.wallets ?? [] } as unknown as Record<string, unknown> })
    this.labeler.track(id, token, s, mnow, f.price!)
    metrics.inc('quant_signals')
    if (this.d.mode === 'live') log.info('quant signal', { strategy: s, token, symbol: meta.symbol, score: score.signal_score, decision: view.decision, why: traded ? undefined : rejected[0] })
    return view
  }

  private confidence(f: Features, score: Score, s: StrategyId): number {
    const keys: (keyof Features)[] = ['buy_pressure_1m', 'volume_acceleration', 'liquidity', 'volatility', 'holder_concentration', 'price_change_5m']
    const complete = keys.filter(k => f[k] !== null && f[k] !== undefined).length / keys.length
    const pf = this.profitFactor(s, this.book)
    return Math.max(0, Math.min(1, 0.55 * ramp(score.signal_score, this.cfg.bands.candidate - 10, 100) + 0.25 * complete + 0.2 * (pf === null ? 0.5 : ramp(pf, 0.8, 2))))
  }

  private componentReasons(s: Score): string[] {
    const w = this.cfg.weights
    return (Object.keys(s.components) as (keyof Score['components'])[]).map(k => `${k} ${s.components[k]}/${w[k]}`)
  }

  private summaryOf(f: Features, score: Score, safety: SafetyVerdict, impactPct: number): SignalView['summary'] {
    return {
      price: f.price, market_cap: round(f.market_cap, 0), liquidity: round(f.liquidity, 0), age_min: round(f.token_age_sec / 60, 1),
      score: score.signal_score, buy_pressure_1m: round(f.buy_pressure_1m, 3), volume_acceleration: round(f.volume_acceleration, 2),
      organic_flow: round(f.organic_flow_score, 2), smart_money: f.smart_money_count, holders: f.holders,
      holder_health: round(10 * (score.components.holders / Math.max(1, this.cfg.weights.holders)), 1),
      exhaustion: f.exhaustion_score, distribution: f.distribution_score, safety: safety.safety_score, trade_allowed: safety.trade_allowed,
      expected_slippage_pct: round(impactPct, 2), price_change_1m: round(f.price_change_1m, 4), price_change_5m: round(f.price_change_5m, 4), regime: f.market_regime,
    }
  }

  private snapshot(token: string, now: number, summary: SignalView['summary']) {
    if (now - (this.lastSnapshot.get(token) ?? 0) < this.cfg.persistence.snapshotEveryMs) return
    this.lastSnapshot.set(token, now)
    if (this.d.mode === 'live') this.d.store.saveSnapshot(token, now, summary)
  }

  // ── positions ─────────────────────────────────────────────────────────

  private fillCosts(costs: Costs): FillCosts { return { feePerSide: costs.feePerSide, buyTax: costs.buyTax, sellTax: costs.sellTax, gasUsdPerTx: this.cfg.execution.gasUsdPerTx } }

  private openPosition(signalId: string, token: string, tape: TokenTape, s: StrategyId, plan: Plan, usd: number, costs: Costs, f: Features, now: number, book: Book): QPosition {
    const p: QPosition = {
      id: `${signalId}:${book}`, signalId, token, symbol: tape.symbol, strategy: s, mode: book, status: 'pending', openedAt: now, closedAt: null,
      plannedUsd: usd, costUsd: 0, entryPrice: f.price!, tokens: 0, remainingTokens: 0, proceedsUsd: 0, feesUsd: 0, exits: plan.exits,
      breakevenMult: (1 + costs.feePerSide + costs.buyTax) / Math.max(0.01, 1 - costs.feePerSide - costs.sellTax),
      stopPrice: plan.stop.price, stopPct: plan.stop.pct, stopKind: 'initial', highPrice: f.price!, lowPrice: f.price!, tpHit: 0, trailPct: null,
      volatilityPct: f.volatility, liquidityAtEntry: f.liquidity, exitReason: null, fills: [], pnlUsd: null, returnPct: null, maxGainPct: 0, maxDrawdownPct: 0,
    }
    ;(p as QPosition & { costs: FillCosts }).costs = this.fillCosts(costs)
    this.positions.push(p)
    this.d.store.savePosition(p)
    if (book === 'live') this.liveBuy(p, usd)
    else {
      const order: PendingOrder = { key: `${p.id}:buy`, positionId: p.id, token, side: 'BUY', amount: usd, reason: 'entry', createdAt: now, dueAt: now + this.cfg.execution.entryLatencyMs, refPrice: f.price!, staleAt: now + this.cfg.execution.entryLatencyMs + STALE_FILL_MS }
      this.pending.push(order)
      this.exec({ at: now, key: order.key, positionId: p.id, token, mode: book, kind: 'submitted', detail: `paper buy of $${usd.toFixed(2)}` })
    }
    return p
  }

  /** Paper and backtest orders due by now, filled at `price`. */
  private fillDue(token: string, price: number, liquidity: number | null, now: number) {
    if (!this.pending.length) return
    const keep: PendingOrder[] = []
    for (const o of this.pending) {
      if (o.token !== token || now < o.dueAt) { keep.push(o); continue }
      this.fillPaper(o, price, liquidity, now)
    }
    this.pending = keep
  }

  private fillPaper(o: PendingOrder, price: number, liquidity: number | null, now: number) {
    const p = this.positions.find(x => x.id === o.positionId)
    if (!p) return
    const costs = (p as QPosition & { costs?: FillCosts }).costs ?? { feePerSide: this.cfg.execution.defaultFeePct / 100, buyTax: 0, sellTax: 0, gasUsdPerTx: this.cfg.execution.gasUsdPerTx }
    if (o.side === 'BUY') {
      const drift = Math.abs(price / o.refPrice - 1) * 100
      if (drift > this.cfg.execution.maxDriftPct) {
        p.status = 'failed'; p.closedAt = now; p.exitReason = `not bought: the price moved ${drift.toFixed(1)}% before the fill (over ${this.cfg.execution.maxDriftPct}%)`
        this.exec({ at: now, key: o.key, positionId: p.id, token: p.token, mode: p.mode, kind: 'skipped', detail: p.exitReason, latencyMs: now - o.createdAt })
        this.retire(p)
        return
      }
      const fill = paperBuy(o.amount, price, liquidity, costs, now)
      if (!fill) { p.status = 'failed'; p.closedAt = now; p.exitReason = 'not bought: no pool depth'; this.retire(p); return }
      this.applyBuy(p, fill.price, fill.tokens, fill.usd, fill.feesUsd, now, o.reason)
      this.exec({ at: now, key: o.key, positionId: p.id, token: p.token, mode: p.mode, kind: 'filled', detail: `bought ${fill.tokens.toPrecision(4)} at ${fill.price.toPrecision(4)} (slippage ${fill.slippagePct.toFixed(2)}%)`, latencyMs: now - o.createdAt })
      return
    }
    this.pendingSell.delete(p.id)
    const tokens = p.remainingTokens * Math.min(1, o.amount)
    const fill = paperSell(tokens, price, liquidity, costs, now)
    if (!fill) return
    this.applySell(p, fill.tokens, fill.usd, fill.feesUsd, fill.price, now, o.reason)
    this.exec({ at: now, key: o.key, positionId: p.id, token: p.token, mode: p.mode, kind: 'filled', detail: `sold ${(o.amount * 100).toFixed(0)}% of the rest at ${fill.price.toPrecision(4)}: ${o.reason}`, latencyMs: now - o.createdAt })
  }

  private applyBuy(p: QPosition, price: number, tokens: number, usd: number, fees: number, now: number, reason: string, txHash?: string) {
    p.status = 'open'; p.entryPrice = price; p.tokens = tokens; p.remainingTokens = tokens; p.costUsd = usd; p.feesUsd += fees
    p.openedAt = now
    p.stopPrice = price * (1 - p.stopPct / 100); p.highPrice = price; p.lowPrice = price
    p.fills.push({ at: now, side: 'BUY', price, tokens, usd, feesUsd: fees, reason, txHash })
    this.d.store.savePosition(p)
  }

  private applySell(p: QPosition, tokens: number, usd: number, fees: number, price: number, now: number, reason: string, txHash?: string) {
    const sold = Math.min(tokens, p.remainingTokens)
    p.remainingTokens -= sold; p.proceedsUsd += usd; p.feesUsd += fees
    p.fills.push({ at: now, side: 'SELL', price, tokens: sold, usd, feesUsd: fees, reason, txHash })
    p.exitReason = reason
    if (p.remainingTokens <= p.tokens * DUST + 1e-18) this.closePosition(p, now)
    else this.d.store.savePosition(p)
  }

  private closePosition(p: QPosition, now: number) {
    p.status = 'closed'; p.closedAt = now; p.remainingTokens = 0
    p.pnlUsd = round(p.proceedsUsd - p.costUsd, 4)
    p.returnPct = p.costUsd > 0 ? round(((p.proceedsUsd - p.costUsd) / p.costUsd) * 100, 3) : 0
    if (p.mode !== 'live') this.paperRealized += p.pnlUsd ?? 0
    this.retire(p)
    metrics.inc(`quant_closed_${p.mode}`)
    const day = new Date(now).toISOString().slice(0, 10)
    const sameDay = this.closed.filter(x => x.strategy === p.strategy && x.mode === p.mode && new Date(x.closedAt ?? 0).toISOString().slice(0, 10) === day)
    this.d.store.saveStrategyResult({ strategy: p.strategy, mode: p.mode, day, data: bookStats(sameDay, this.equity(p.mode)) as unknown as Record<string, unknown> })
  }

  /** Moves a finished position to the closed list. */
  private retire(p: QPosition) {
    const i = this.positions.indexOf(p)
    if (i >= 0) this.positions.splice(i, 1)
    if (p.status === 'closed') { this.closed.push(p); if (this.closed.length > 5_000) this.closed.splice(0, this.closed.length - 5_000) }
    this.d.store.savePosition(p)
  }

  /** What an open position's coin looks like now (distribution and momentum cached a moment). */
  private marketFor(p: QPosition, price: number, now: number) {
    const tape = this.tapes.get(p.token)
    let d = this.distCache.get(p.token)
    if (tape && (!d || now - d.at >= DIST_CACHE_MS)) {
      const fr = computeFeatures(tape, now, { wallets: null, regime: this.regime.regime, large: this.cfg.large })
      const f = fr.f
      const vwap1m = fr.windows.m1.vwap
      const turn = (f.buy_pressure_30s ?? 1) < 0.4 && vwap1m !== null && price < vwap1m && (f.price_change_30s ?? 0) < 0 && (f.price_change_1m ?? 0) < 0
      d = { at: now, v: f.distribution_score, turn }
      this.distCache.set(p.token, d)
    }
    return {
      now, price, liquidity: tape?.lastLiquidity ?? null, liquidityHigh15m: tape?.liquidityHigh(now, 900_000) ?? null,
      distribution: d?.v ?? 0, momentumTurn: d?.turn ?? false, volatilityPct: p.volatilityPct,
      emergency: this.cfg.risk.killSwitch ? 'kill switch' : this.d.rugAlarm(p.token, now),
    }
  }

  private manageToken(token: string, now: number) {
    for (const p of [...this.positions]) {
      if (p.token !== token || p.status !== 'open') continue
      const price = this.tapes.get(token)?.priceAt(now)
      if (price) this.step(p, price, now)
    }
  }

  private step(p: QPosition, price: number, now: number) {
    p.maxGainPct = Math.max(p.maxGainPct, (price / p.entryPrice - 1) * 100)
    p.maxDrawdownPct = Math.min(p.maxDrawdownPct, (price / p.entryPrice - 1) * 100)
    p.lowPrice = Math.min(p.lowPrice, price)
    const r = manage(p, this.marketFor(p, price, now))
    p.highPrice = r.highPrice; p.stopPrice = r.stopPrice; p.stopKind = r.stopKind; p.trailPct = r.trailPct
    const tpBefore = p.tpHit
    p.tpHit = r.tpHit
    if (!r.actions.length) { if (tpBefore !== p.tpHit) this.d.store.savePosition(p); return }
    // Several actions in one tick (two targets at once, a target then a stop): the combined share of what's left.
    const full = r.actions.some(a => a.fraction >= 1)
    const keep = r.actions.reduce((k, a) => k * (1 - Math.min(1, a.fraction)), 1)
    const fraction = full ? 1 : 1 - keep
    const reason = r.actions.map(a => a.reason).join('; ')
    this.sell(p, fraction, reason, r.actions, now)
  }

  private sell(p: QPosition, fraction: number, reason: string, actions: ExitAction[], now: number) {
    const had = this.pendingSell.get(p.id)
    if (had) {
      // A sale is already on its way: a full exit replaces a partial one; anything else waits for it.
      if (fraction >= 1 && had.amount < 1) { had.amount = 1; had.reason = `${had.reason}; then ${reason}` }
      return
    }
    if (p.mode === 'live') { this.liveSell(p, fraction, reason); return }
    const o: PendingOrder = { key: `${p.id}:sell:${p.fills.length}:${now}`, positionId: p.id, token: p.token, side: 'SELL', amount: fraction, reason, createdAt: now, dueAt: now + this.cfg.execution.exitLatencyMs, refPrice: p.entryPrice, staleAt: now + this.cfg.execution.exitLatencyMs + STALE_FILL_MS }
    this.pending.push(o)
    this.pendingSell.set(p.id, o)
    this.exec({ at: now, key: o.key, positionId: p.id, token: p.token, mode: p.mode, kind: 'submitted', detail: `sell ${(fraction * 100).toFixed(0)}% of the rest: ${reason}` })
    if (actions.some(a => a.kind === 'emergency')) this.riskEvent({ at: now, mode: p.mode, kind: 'emergency-exit', token: p.token, detail: reason })
  }

  emergencyCloseAll(why: string) {
    const now = this.d.mode === 'backtest' ? this.marketNow : Date.now()
    for (const p of [...this.positions]) if (p.status === 'open') this.sell(p, 1, `emergency: ${why}`, [{ fraction: 1, reason: why, kind: 'emergency' }], now)
    this.riskEvent({ at: now, mode: this.book, kind: 'emergency', detail: `close everything: ${why}` })
  }

  // ── live orders ───────────────────────────────────────────────────────

  private liveBuy(p: QPosition, usd: number) {
    const live = this.d.live
    if (!live) { p.status = 'failed'; p.exitReason = 'no live wallet'; this.retire(p); return }
    const bps = Math.min(this.cfg.execution.buySlippageBps, this.cfg.risk.maxSlippagePct * 100)
    void live.buy(`${p.id}:buy`, p.id, p.token, usd, bps, this.cfg.gates.maxRoundTripPct, this.d.decimals?.(p.token) ?? 18).then(r => this.liveBought(p, r))
  }

  private liveBought(p: QPosition, r: OrderResult) {
    const now = Date.now()
    this.d.store.saveOrder({ key: `${p.id}:buy`, positionId: p.id, token: p.token, side: 'BUY', mode: 'live', status: r.status, at: now, data: { ...r, liveTokens: r.liveTokens?.toString() } })
    if (r.ok && r.tokens && r.usd) {
      p.liveTokens = r.liveTokens?.toString()
      this.applyBuy(p, r.usd / r.tokens, r.tokens, r.usd + (r.gasUsd ?? 0), r.gasUsd ?? 0, now, 'entry', r.txHash)
      return
    }
    if (r.status === 'timeout') { this.riskEvent({ at: now, mode: 'live', kind: 'timeout', token: p.token, detail: `buy unconfirmed: ${r.error}; reconciling from the wallet's balance` }); void this.reconcile(p); return }
    p.status = 'failed'; p.closedAt = now; p.exitReason = `not bought: ${r.error ?? r.status}`
    this.retire(p)
  }

  /** A live buy that timed out: whatever arrived in the wallet is the position. */
  private async reconcile(p: QPosition) {
    const live = this.d.live
    if (!live) return
    const bal = await live.balance(p.token).catch(() => null)
    if (bal && bal > 0n) {
      const dec = this.d.decimals?.(p.token) ?? 18
      const tokens = Number(bal) / 10 ** dec
      p.liveTokens = bal.toString()
      this.applyBuy(p, p.plannedUsd / tokens, tokens, p.plannedUsd, 0, Date.now(), 'entry (reconciled from the balance)')
    } else { p.status = 'failed'; p.closedAt = Date.now(); p.exitReason = 'not bought (no coins arrived)'; this.retire(p) }
  }

  private liveSell(p: QPosition, fraction: number, reason: string) {
    const live = this.d.live
    if (!live || !p.liveTokens) return
    const held = BigInt(p.liveTokens)
    const amount = fraction >= 1 ? held : (held * BigInt(Math.round(fraction * 10_000))) / 10_000n
    if (amount <= 0n) return
    const key = `${p.id}:sell:${p.fills.length}`
    const marker: PendingOrder = { key, positionId: p.id, token: p.token, side: 'SELL', amount: fraction, reason, createdAt: Date.now(), dueAt: Date.now(), refPrice: p.entryPrice, staleAt: Infinity }
    this.pendingSell.set(p.id, marker)
    // An exit must get out: sales step through the configured slippages in turn (entries are held to maxSlippagePct).
    void live.sell(key, p.id, p.token, amount, this.cfg.execution.sellSlippageBps, this.d.decimals?.(p.token) ?? 18).then(r => {
      this.pendingSell.delete(p.id)
      this.d.store.saveOrder({ key, positionId: p.id, token: p.token, side: 'SELL', mode: 'live', status: r.status, at: Date.now(), data: { ...r, liveTokens: r.liveTokens?.toString() } })
      if (r.ok && r.tokens !== undefined) {
        p.liveTokens = (held - amount).toString()
        this.applySell(p, fraction >= 1 ? p.remainingTokens : r.tokens, r.usd ?? 0, r.gasUsd ?? 0, r.price ?? 0, Date.now(), reason, r.txHash)
      } else this.riskEvent({ at: Date.now(), mode: 'live', kind: 'sell-failed', token: p.token, detail: `${reason}: ${r.error ?? r.status} (tried again next tick)` })
    })
  }

  // ── the clock ─────────────────────────────────────────────────────────

  tick(now: number) {
    const mnow = this.mkt(now)
    // Orders that found no trade after them: filled at the last price.
    if (this.pending.length) {
      const keep: PendingOrder[] = []
      for (const o of this.pending) {
        if (mnow < o.staleAt) { keep.push(o); continue }
        const tape = this.tapes.get(o.token)
        const price = tape?.lastPrice
        if (price) this.fillPaper(o, price, tape!.lastLiquidity, mnow)
        else keep.push(o)
      }
      this.pending = keep
    }
    // Time exits need no trade.
    for (const p of [...this.positions]) {
      if (p.status !== 'open') continue
      const price = this.tapes.get(p.token)?.lastPrice
      if (price) this.step(p, price, mnow)
    }
    if (mnow - this.lastLabels >= 5_000) { this.lastLabels = mnow; for (const o of this.labeler.due(mnow)) this.d.store.saveOutcome(o) }
    if (mnow - this.lastRegimeAt >= this.cfg.regime.everyMs) { this.lastRegimeAt = mnow; this.updateRegime(mnow) }
    if (this.d.mode === 'live') {
      if (now - this.lastWalletFlush >= this.cfg.persistence.walletFlushMs) { this.lastWalletFlush = now; this.flushWallets(now) }
      if (now - this.lastCleanup >= 3_600_000) { this.lastCleanup = now; void this.d.store.cleanup() }
      metrics.set('quant_stale_sec', this.lastIngestAt ? Math.round((Date.now() - this.lastIngestAt) / 1000) : null)
      metrics.set('quant_tapes', this.tapes.size); metrics.set('quant_wallets', this.wallets.wallets.size); metrics.set('quant_open', this.positions.length)
    }
    this.forget(mnow)
  }

  /** Tapes of coins quiet for over an hour (and holding nothing) are dropped. */
  private forget(now: number) {
    if (now - this.lastForget < 60_000) return
    this.lastForget = now
    for (const [token, t] of this.tapes) {
      if (now - t.lastTs > 3_900_000 && !this.positions.some(p => p.token === token)) { this.tapes.delete(token); this.radar.delete(token); this.distCache.delete(token); this.lastEval.delete(token) }
    }
  }

  private updateRegime(now: number) {
    const win = this.cfg.regime.windowMin * 60_000
    const coins: CoinSnapshot[] = []
    for (const [token, t] of this.tapes) {
      if (now - t.lastTs > win) continue
      const w = t.window(now, win, this.cfg.large)
      const volume = w.buyUsd + w.sellUsd
      if (!(volume > 0)) continue
      const bars = t.buckets(now, 60_000, this.cfg.regime.windowMin)
      const rets: number[] = []
      for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c))
      const m = rets.length > 1 ? rets.reduce((s, x) => s + x, 0) / rets.length : 0
      const vol = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) * 100 : null
      const liqThen = t.liquidityAt(now - win)
      coins.push({
        volume, change: w.open && w.close ? w.close / w.open - 1 : null, buyPressure: volume > 0 ? w.buyUsd / volume : null, volatility: vol,
        // Only a liquidity pull counts as stress (the guard's crash alarms fire on ordinary meme-coin dumps).
        liquidityChange: liqThen && t.lastLiquidity !== null ? t.lastLiquidity / liqThen - 1 : null, alarm: /^liquidity fell/.test(this.d.rugAlarm(token, now) ?? ''),
      })
    }
    const before = this.regime.regime
    this.regime = regimeOf(coins, this.cfg.regime, now)
    if (this.regime.regime !== before) this.riskEvent({ at: now, mode: this.book, kind: 'regime', detail: `${before} → ${this.regime.regime}: ${this.regime.why}` })
    if (this.d.mode === 'live' && now - this.lastRegimeSaved >= this.cfg.persistence.regimeEveryMs) { this.lastRegimeSaved = now; this.d.store.saveRegime(this.regime) }
    metrics.set('quant_regime', this.regime.regime)
  }

  private flushWallets(now: number) {
    const rows = [], positions = []
    for (const w of this.wallets.changed) {
      const s = this.wallets.stats(w, now)
      if (s && s.trade_count >= 3) { rows.push(s); for (const p of this.wallets.positionsOf(w)) positions.push({ ...p, wallet: w }) }
      if (rows.length >= 5_000) break
    }
    for (const r of rows) this.wallets.changed.delete(r.wallet)
    this.wallets.changed.clear()
    if (rows.length) this.d.store.saveWallets(rows)
    if (positions.length) this.d.store.saveWalletPositions(positions.slice(0, 20_000))
  }

  // ── records ───────────────────────────────────────────────────────────

  private exec(e: ExecutionEvent) {
    this.execLog.unshift(e); if (this.execLog.length > 300) this.execLog.length = 300
    if (this.d.mode === 'live') this.d.store.saveExecutionEvent(e)
  }
  /** Execution events from the live order manager. */
  onLiveEvent(e: ExecutionEvent) { this.exec(e); if (e.kind === 'duplicate') metrics.inc('quant_duplicate_orders') }

  riskEvent(e: RiskEvent) {
    this.riskLog.unshift(e); if (this.riskLog.length > 300) this.riskLog.length = 300
    if (this.d.mode === 'live') this.d.store.saveRiskEvent(e)
  }

  stats(book: Book): Record<string, BookStats> & { all: BookStats } {
    const eq = book === 'live' ? (this.d.liveEquity?.() ?? 0) : this.cfg.sizing.paperEquityUsd
    const out: Record<string, BookStats> = { all: bookStats(this.closed.filter(p => p.mode === book), eq) }
    for (const s of STRATEGY_IDS) out[s] = bookStats(this.closed.filter(p => p.mode === book && p.strategy === s), eq)
    return out as Record<string, BookStats> & { all: BookStats }
  }

  liveGate(now = Date.now()): LiveGate {
    const paperClosed = this.closed.filter(p => p.mode === 'paper')
    return this.risk.liveGate({ hasWallet: !!this.d.hasWallet && !!this.d.live, oos: this.oos, paper: { ...bookStats(paperClosed, this.cfg.sizing.paperEquityUsd), firstAt: paperClosed[0]?.openedAt ?? null } }, now)
  }

  /** Positions and history after a restart. */
  restore(positions: QPosition[]) {
    for (const p of positions) {
      if (p.status === 'closed') { this.closed.push(p); if (p.mode !== 'live') this.paperRealized += p.pnlUsd ?? 0 }
      else if (p.status === 'open') this.positions.push(p)
      // A paper order cut off by the restart never filled.
      else if (p.status === 'pending' && p.mode !== 'live') { p.status = 'failed'; p.exitReason = 'not bought: the engine restarted before the fill'; this.d.store.savePosition(p) }
      else if (p.status === 'pending') { this.positions.push(p); void this.reconcile(p) }
    }
    this.closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  }
}
