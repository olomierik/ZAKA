// ARCDEX Algo, live: a 24/7 agent trading BTC, ETH and SOL futures on the oracle's signed prices
// (perps/service.ts), in paper mode (simulated fills at the next signed price) or on the real
// futures contract on Arc testnet (executor.ts).
//
// Every 5 seconds: prices in (paper fills, targets and stops; testnet: the contract read back),
// the book marked, the drawdown limit watched. Every candle close (15 seconds after it, so late
// prices are in): one decision per market (core.ts), orders for the setups that pass, crises
// closed, escalations to the brain. Labels resolve every minute, the calibration is refit every
// hour, and the review runs once a day at 04:30 UTC, when the day's labels have resolved.
//
// At start it replays the stored candles (up to 3 days) through the same core: that calibrates the
// reflex at once, and the replay's results are shown as what they are.

import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http } from 'viem'
import { ALGO_MARKETS, type AlgoDecisionRow, type AlgoMarket, type AlgoMode, type AlgoReplay, type AlgoReview, type AlgoStatus, type AlgoTrade } from '../../../api/_algoProtocol'
import type { BotWallet, WalletVault } from '../bot/userLive'
import { errMsg, log } from '../log'
import { ARC_TESTNET, TESTNET_RPCS } from '../perps/shared'
import type { PerpsService } from '../perps/service'
import type { PerpsBar } from '../perps/shared'
import { Book, dayStart } from './book'
import { Brain } from './brain'
import { Calibrator } from './calibration'
import { cloneConfig, DEFAULT_CONFIG, type AlgoConfig } from './config'
import { AlgoCore } from './core'
import { TestnetExecutor, viemPerpsChain } from './executor'
import { RuleReflex } from './reflex'
import { replayAsync } from './replay'
import { nightlyReview, calibrationReport } from './review'
import { MIN } from './state'

export interface Settings {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
}

export interface AlgoAgentOptions {
  perps: PerpsService
  settings: Settings
  vault: WalletVault | null
  brain: Brain
  env?: Record<string, string | undefined>
  now?: () => number
  /** How often it ticks (0: never by itself, for tests). */
  tickEveryMs?: number
}

const KEY_STATE = 'algo-state'
const KEY_WALLET = 'algo-agent-wallet'
const REVIEW_AT_MS = 4.5 * 3_600_000 // 04:30 UTC

interface Persisted {
  v: 1
  mode: AlgoMode
  config: AlgoConfig
  configVersion: number
  books: Partial<Record<AlgoMode, ReturnType<Book['toJSON']>>>
  kill: AlgoCore['risk']['kill']
  calibrators: Record<'trend' | 'fade', ReturnType<Calibrator['toJSON']>>
  reviews: AlgoReview[]
  lastReviewDay: string | null
  executor: ReturnType<TestnetExecutor['toJSON']> | null
  escalations: { day: number; count: number }
}

export class AlgoAgent {
  core: AlgoCore
  mode: AlgoMode = 'paper'
  configVersion = 1
  reviews: AlgoReview[] = []
  replay: AlgoReplay | null = null
  executor: TestnetExecutor | null = null
  running = false
  waiting: string | null = 'starting'
  private books: Partial<Record<AlgoMode, Book>> = {}
  private lastStep = 0
  private lastPriceTs: Partial<Record<AlgoMarket, number>> = {}
  private lastLabelsAt = 0
  private lastRefitAt = 0
  private lastSaveAt = 0
  private dirty = false
  private lastReviewDay: string | null = null
  private reviewing = false
  private escalated = new Map<string, number>()
  private escalations = { day: 0, count: 0 }
  private busy = false
  private timer: ReturnType<typeof setInterval> | null = null
  private env: Record<string, string | undefined>

  constructor(private o: AlgoAgentOptions) {
    this.env = o.env ?? process.env
    this.core = new AlgoCore(cloneConfig(DEFAULT_CONFIG), new RuleReflex(), 'paper')
  }

  private now() { return (this.o.now ?? Date.now)() }
  private bars(m: AlgoMarket | string): readonly PerpsBar[] { return this.o.perps.candles.candles(m, '1m', 10_000) }

  async start() {
    await this.load().catch(e => log.warn('algo: state not loaded', { error: errMsg(e) }))
    this.books[this.mode] = this.core.book
    if (this.mode === 'testnet') await this.setupTestnet().catch(e => { this.waiting = `testnet not set up: ${errMsg(e)}` })
    await this.warm()
    if (this.o.tickEveryMs !== 0) this.timer = setInterval(() => void this.tick(), this.o.tickEveryMs ?? 5_000)
    log.info('algo: started', { mode: this.mode, brain: this.o.brain.enabled, replayTrades: this.replay?.stats.trades ?? null })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    void this.save()
  }

  /** Replays the stored candles: calibration labels now, and a measured record of the agent. */
  private async warm() {
    const now = this.now()
    const bars = Object.fromEntries(ALGO_MARKETS.map(m => [m, this.bars(m)])) as Record<AlgoMarket, readonly PerpsBar[]>
    const first = Math.max(...ALGO_MARKETS.map(m => bars[m][0]?.[0] ?? now))
    if (now - first < 6 * 3_600_000) { this.waiting = 'collecting candles: the replay needs at least 6 hours of prices'; this.running = true; return }
    try {
      const r = await replayAsync({ bars, cfg: this.core.cfg, from: first + 120 * MIN, to: Math.floor(now / MIN) * MIN - MIN })
      this.replay = r.summary
      const have = new Set(this.core.labeler.resolved.map(l => l.id))
      this.core.labeler.resolved.push(...r.core.labeler.resolved.filter(l => !have.has(l.id)))
      this.core.labeler.resolved.sort((a, b) => a.at - b.at)
      this.core.refit(now)
      this.lastRefitAt = now
      log.info('algo: replay done', { trades: r.summary.stats.trades, pnl: r.summary.stats.pnlUsd, labels: this.core.labeler.resolved.length })
    } catch (e) {
      log.warn('algo: replay failed', { error: errMsg(e) })
    }
    this.running = true
    this.waiting = null
  }

  private async setupTestnet() {
    const p = this.o.perps
    const dep = p.deployment
    if (!dep?.perps || !dep.usdc) throw new Error("the futures contract isn't deployed yet")
    if (!this.o.vault) throw new Error('the engine has no wallet secret (BOT_WALLET_SECRET)')
    let w: BotWallet | null = null
    const saved = await this.o.settings.getSetting(KEY_WALLET)
    if (saved) w = JSON.parse(saved) as BotWallet
    if (!w) { w = this.o.vault.create(KEY_WALLET); await this.o.settings.setSetting(KEY_WALLET, JSON.stringify(w)); log.info('algo: agent wallet made', { address: w.address }) }
    const rpcs = this.env.PERPS_RPC?.split(',').map(s => s.trim()).filter(Boolean) ?? [...TESTNET_RPCS]
    const agent = createWalletClient({ account: privateKeyToAccount(this.o.vault.open(w, KEY_WALLET)), chain: ARC_TESTNET, transport: http(rpcs[0], { timeout: 15_000 }) }) as WalletClient<Transport, Chain, Account>
    const access = p.algoAccess()
    if (!access) throw new Error('the futures service has no chain client yet')
    this.executor = new TestnetExecutor(viemPerpsChain({
      client: access.client as PublicClient, agent, keeper: access.keeper, perps: dep.perps as Address, usdc: dep.usdc as Address,
      markets: () => access.markets(), closedTrades: a => p.events?.list(a, 500) ?? [],
    }), {
      filled: (t, entry, positionId, at) => { t.entry = entry; t.positionId = positionId; t.openedAt = at; t.status = 'open'; this.dirty = true },
      closed: (t, exit, at, reason, onChain) => {
        const openFee = t.sizeUsd * (this.core.cfg.costs.openFeeBps / 10_000)
        this.core.closeTrade(t, exit, at, reason, { pnlUsd: onChain.pnlUsd - openFee, feesUsd: onChain.feesUsd + openFee })
        this.dirty = true
      },
      failed: (t, why) => { t.status = 'failed'; t.reason = why; this.dirty = true; log.info('algo: order failed', { trade: t.id, why }) },
    })
    if (this.pendingExecutorState) { this.executor.restore(this.pendingExecutorState); this.pendingExecutorState = null }
  }

  private prices() {
    const snap = this.o.perps.feed.latest()
    const out: Partial<Record<AlgoMarket, { px: number; ts: number; dispersionBps: number | null }>> = {}
    if (!snap) return out
    for (const m of ALGO_MARKETS) {
      const f = snap.feeds[m]
      if (!f) continue
      const vals = f.pkgs.map(p => Number(p.value))
      const med = Number(f.median)
      out[m] = { px: f.price, ts: f.ts, dispersionBps: vals.length > 1 && med > 0 ? ((Math.max(...vals) - Math.min(...vals)) / med) * 10_000 : null }
    }
    return out
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try { await this.tickInner() } catch (e) { log.warn('algo: tick failed', { error: errMsg(e) }) } finally { this.busy = false }
  }

  private async tickInner() {
    const now = this.now()
    const px = this.prices()
    const core = this.core
    // 1. Prices: paper fills, stops and targets; testnet, the contract read back.
    if (this.mode === 'paper') {
      for (const m of ALGO_MARKETS) {
        const p = px[m]
        if (!p || (this.lastPriceTs[m] ?? 0) >= p.ts) continue
        this.lastPriceTs[m] = p.ts
        if (core.onPrice(m, p.px, p.ts).length) this.dirty = true
      }
    } else if (this.executor) {
      await this.executor.reconcile(core.book.trades.filter(t => t.status === 'pending' || t.status === 'open'), now)
    }
    // 2. The book marked; the drawdown limit closes everything.
    const marks = Object.fromEntries(Object.entries(px).map(([m, p]) => [m, p!.px])) as Partial<Record<AlgoMarket, number>>
    const killNow = core.mark(marks, now)
    if (killNow.length) {
      log.warn('algo: kill switch tripped', { reason: core.risk.kill.reason })
      await this.closeAll('kill switch: ' + (core.risk.kill.reason ?? ''), marks, now)
    }
    // 3. Labels and calibration.
    if (now - this.lastLabelsAt >= MIN) { core.resolveLabels(m => this.bars(m), now); this.lastLabelsAt = now }
    if (now - this.lastRefitAt >= 3_600_000) { core.refit(now); this.lastRefitAt = now; this.dirty = true }
    // 4. The candle close, 15 seconds after it.
    const t = Math.floor((now - 15_000) / MIN) * MIN
    if (this.running && t > this.lastStep) {
      this.lastStep = t
      await this.decide(t, px, marks, now)
    }
    // 5. The nightly review.
    const day = new Date(dayStart(now) - 86_400_000).toISOString().slice(0, 10)
    if (now - dayStart(now) >= REVIEW_AT_MS && this.lastReviewDay !== day && !this.reviewing) void this.review(day)
    if (this.dirty && now - this.lastSaveAt > 30_000) await this.save()
    else if (now - this.lastSaveAt > 10 * MIN) await this.save()
  }

  private async decide(t: number, px: ReturnType<AlgoAgent['prices']>, marks: Partial<Record<AlgoMarket, number>>, now: number) {
    const core = this.core
    const waiting = this.mode === 'testnet' ? (this.executor ? this.executor.missing() : this.waiting) : null
    const r = core.step(t, {
      barsOf: m => this.bars(m),
      dispersionOf: m => px[m]?.dispersionBps ?? null,
      priceAgeOf: m => (px[m] ? now - px[m]!.ts : null),
      minCollateralUsd: this.executor?.view ? Number(this.executor.view.minCollateral) / 1e6 : 1,
    })
    for (const tr of r.opened) {
      this.dirty = true
      log.info('algo: setup', { market: tr.market, side: tr.side, confidence: tr.confidence, size: tr.sizeUsd, mode: this.mode })
      if (this.mode === 'testnet') {
        if (!this.executor || waiting) { tr.status = 'failed'; tr.reason = waiting ?? 'testnet not set up'; continue }
        await this.executor.open(tr)
      }
    }
    for (const c of r.closeNow) await this.closeOne(c.trade, c.reason, marks[c.trade.market], now)
    for (const e of r.escalate) void this.escalate(e.trade, e.row, e.trigger, marks, now)
  }

  private async closeOne(t: AlgoTrade, reason: string, px: number | undefined, now: number) {
    this.dirty = true
    if (t.status === 'pending') {
      if (this.mode === 'paper') { t.status = 'failed'; t.reason = reason }
      return // a testnet request still pending is left to fill or time out; the next candle closes it
    }
    if (this.mode === 'paper') { if (px) this.core.closeTrade(t, px, now, reason) }
    else await this.executor?.close(t, reason)
  }

  private async closeAll(reason: string, marks: Partial<Record<AlgoMarket, number>>, now: number) {
    for (const t of this.core.book.open()) await this.closeOne(t, reason, marks[t.market], now)
  }

  /** Asks the brain to hold or close; without an answer, the code closes. */
  async escalate(t: AlgoTrade, row: AlgoDecisionRow, trigger: string, marks: Partial<Record<AlgoMarket, number>>, now: number) {
    const last = this.escalated.get(t.id) ?? 0
    if (now - last < this.core.cfg.escalateEveryMs) return
    this.escalated.set(t.id, now)
    const d = dayStart(now)
    if (this.escalations.day !== d) this.escalations = { day: d, count: 0 }
    let answer: { action: 'hold' | 'close'; why: string; by: string } | null = null
    if (this.o.brain.enabled && this.escalations.count < this.core.cfg.maxEscalationsPerDay) {
      this.escalations.count++
      answer = await this.o.brain.escalate({ snapshot: row.snapshot, trade: t, trigger, decision: `${row.decision.regime}, ${row.decision.direction}, quality ${row.decision.setup_quality}, confidence ${row.decision.confidence}${row.decision.toxic_flow ? ', toxic flow' : ''}` })
    }
    // A hold is only kept while the risk layer still says safe.
    const action = answer && !(answer.action === 'hold' && this.core.risk.riskState(this.core.book) !== 'safe') ? answer.action : 'close'
    t.escalations.push({ at: now, trigger, by: answer?.by ?? 'rules', action, why: answer ? answer.why : this.o.brain.enabled ? 'the brain did not answer: the code closes' : 'no brain connected: the code closes' })
    this.dirty = true
    if (action === 'close' && (t.status === 'open' || t.status === 'pending')) await this.closeOne(t, `escalated: ${trigger}`, marks[t.market] ?? this.prices()[t.market]?.px, this.now())
  }

  private async review(day: string) {
    this.reviewing = true
    try {
      const bars = Object.fromEntries(ALGO_MARKETS.map(m => [m, this.bars(m)])) as Record<AlgoMarket, readonly PerpsBar[]>
      const { review, cfg } = await nightlyReview({ core: this.core, brain: this.o.brain, bars, decisions: this.core.decisions, replayDays: 3, now: this.now() })
      this.reviews = [review, ...this.reviews.filter(r => r.day !== review.day)].slice(0, 60)
      if (cfg) {
        this.core.cfg = { ...cfg, gates: this.core.cfg.gates, limits: this.core.cfg.limits }
        this.configVersion++
      }
      this.lastReviewDay = day
      this.dirty = true
      log.info('algo: nightly review', { day, by: review.by, shipped: review.proposals.filter(p => p.status === 'shipped').map(p => p.param) })
    } catch (e) {
      log.warn('algo: review failed', { error: errMsg(e) })
      this.lastReviewDay = day // not again until tomorrow
    } finally {
      this.reviewing = false
    }
  }

  // ─── owner controls ─────────────────────────────────────────────────────

  async setKill(on: boolean, note: string) {
    const now = this.now()
    if (on) {
      this.core.risk.trip(`the owner: ${note}`, now)
      const marks = Object.fromEntries(Object.entries(this.prices()).map(([m, p]) => [m, p!.px])) as Partial<Record<AlgoMarket, number>>
      await this.closeAll('kill switch (owner)', marks, now)
    } else {
      this.core.risk.rearm()
      // Re-armed after a drawdown: the peak starts again from here, so the limit isn't tripped at once.
      this.core.book.peakUsd = this.core.book.markedUsd
    }
    this.dirty = true
    await this.save()
  }

  async setMode(mode: AlgoMode): Promise<string | null> {
    if (mode === this.mode) return null
    if (this.core.book.open().length) return 'close the open positions first (trip the kill switch)'
    if (mode === 'testnet') {
      try { await this.setupTestnet() } catch (e) { return `testnet isn't ready: ${errMsg(e)}` }
    }
    this.books[this.mode] = this.core.book
    this.mode = mode
    this.core.book = this.books[mode] ?? new Book(this.core.cfg.startUsd, mode)
    this.books[mode] = this.core.book
    this.dirty = true
    await this.save()
    return null
  }

  async reset(startUsd: number): Promise<string | null> {
    if (this.core.book.open().length) return 'close the open positions first (trip the kill switch)'
    this.core.book = new Book(startUsd, this.mode)
    this.books[this.mode] = this.core.book
    this.core.risk.rearm()
    this.dirty = true
    await this.save()
    return null
  }

  async setConfig(cfg: AlgoConfig) {
    this.core.cfg = cfg
    this.configVersion++
    this.dirty = true
    await this.save()
  }

  // ─── persistence ────────────────────────────────────────────────────────

  private async load() {
    const raw = await this.o.settings.getSetting(KEY_STATE)
    if (!raw) return
    const p = JSON.parse(raw) as Persisted
    if (p.v !== 1) return
    this.mode = p.mode
    this.core.cfg = { ...cloneConfig(DEFAULT_CONFIG), ...p.config, gates: { ...DEFAULT_CONFIG.gates, ...p.config.gates }, limits: { ...DEFAULT_CONFIG.limits, ...p.config.limits }, reflex: { ...DEFAULT_CONFIG.reflex, ...p.config.reflex }, geometry: { ...DEFAULT_CONFIG.geometry, ...p.config.geometry }, costs: { ...DEFAULT_CONFIG.costs, ...p.config.costs } }
    this.configVersion = p.configVersion
    for (const [m, b] of Object.entries(p.books)) if (b) this.books[m as AlgoMode] = Book.from(b)
    this.core.book = this.books[this.mode] ?? new Book(this.core.cfg.startUsd, this.mode)
    this.core.risk.kill = p.kill
    this.core.calibrators = { trend: Calibrator.from(p.calibrators.trend), fade: Calibrator.from(p.calibrators.fade) }
    this.reviews = p.reviews ?? []
    this.lastReviewDay = p.lastReviewDay
    this.escalations = p.escalations ?? { day: 0, count: 0 }
    if (p.executor) this.pendingExecutorState = p.executor
    // Paper trades still pending at the restart never filled.
    for (const t of this.core.book.trades) if (t.status === 'pending' && t.mode === 'paper') { t.status = 'failed'; t.reason = 'the engine restarted before the fill' }
  }

  private pendingExecutorState: Persisted['executor'] = null

  private async save() {
    this.lastSaveAt = this.now()
    this.dirty = false
    const books: Persisted['books'] = {}
    for (const [m, b] of Object.entries({ ...this.books, [this.mode]: this.core.book })) if (b) books[m as AlgoMode] = b.toJSON()
    const p: Persisted = {
      v: 1, mode: this.mode, config: this.core.cfg, configVersion: this.configVersion, books, kill: this.core.risk.kill,
      calibrators: { trend: this.core.calibrators.trend.toJSON(), fade: this.core.calibrators.fade.toJSON() },
      reviews: this.reviews.slice(0, 60), lastReviewDay: this.lastReviewDay, executor: this.executor?.toJSON() ?? this.pendingExecutorState,
      escalations: this.escalations,
    }
    await this.o.settings.setSetting(KEY_STATE, JSON.stringify(p)).catch(e => log.warn('algo: state not saved', { error: errMsg(e) }))
  }

  // ─── views ──────────────────────────────────────────────────────────────

  status(): AlgoStatus {
    const now = this.now()
    const core = this.core
    const px = this.prices()
    const markets: AlgoStatus['markets'] = {}
    for (const m of ALGO_MARKETS) {
      const last = [...core.decisions].reverse().find(d => d.market === m) ?? null
      markets[m] = { state: null, last, price: px[m]?.px ?? null, priceTs: px[m]?.ts ?? null }
    }
    const cal = calibrationReport(core.labeler.resolved, now - 86_400_000, now, core.cfg.thinMin, now)
    const labels = core.calibrators.trend.n + core.calibrators.fade.n
    const ex = this.executor
    let waiting = this.waiting
    if (!waiting && !core.calibrated('trend') && !core.calibrated('fade')) waiting = `calibrating: ${labels} of ${core.cfg.minLabels} labeled decisions so far (no trades until then)`
    if (!waiting && this.mode === 'testnet') waiting = ex ? ex.missing() : 'testnet not set up'
    return {
      enabled: true, at: now, mode: this.mode, running: this.running, waiting,
      reflex: { provider: core.reflex.provider, calibrated: core.calibrated('trend') || core.calibrated('fade'), labels },
      brain: { enabled: this.o.brain.enabled, model: this.o.brain.enabled ? this.o.brain.model : null, escalationsToday: this.escalations.day === dayStart(now) ? this.escalations.count : 0, lastReviewAt: this.reviews[0]?.at ?? null },
      gates: core.cfg.gates,
      geometry: core.cfg.geometry,
      markets,
      risk: core.risk.view(core.book),
      stats: core.book.stats(),
      calibration: cal,
      replay: this.replay,
      wallet: ex ? { address: ex.address, gasUsdc: ex.view ? Number(ex.view.gasWei) / 1e18 : null, usdc: ex.view ? Number(ex.view.usdc) / 1e6 : null } : null,
      configVersion: this.configVersion,
    }
  }

  decisions(limit: number, market: string | null): AlgoDecisionRow[] {
    const out: AlgoDecisionRow[] = []
    for (let i = this.core.decisions.length - 1; i >= 0 && out.length < limit; i--) {
      const d = this.core.decisions[i]
      if (!market || d.market === market) out.push(d)
    }
    return out
  }

  trades(limit: number): AlgoTrade[] {
    return [...this.core.book.trades].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
  }

  health() {
    return { mode: this.mode, running: this.running, open: this.core.book.open().length, killed: this.core.risk.kill.tripped, brain: this.o.brain.enabled }
  }
}
