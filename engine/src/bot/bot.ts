// The signal and paper-trading engine. It watches every coin launched in
// the last 48 hours, from the market engine's own trades:
//
//   each trade   → the coin's tape, its last 3 minutes and 1-minute price
//                  path; the rug guard (bot/rugGuard.ts), whose alarm closes
//                  every position in the coin at once (the bot's, the bot
//                  wallet's, every visitor's bot); exits; at most every 2s,
//                  an evaluation
//   sweep        → every 3s, every coin that traded in the last 3 minutes is
//                  evaluated too, not only when its own next trade arrives
//   evaluation   → the snipe, momentum-scalp and second-leg rules
//                  (signals/rules.ts); a coin that meets one gets a deep
//                  safety scan (probe, holders, funding: at most 6 at once,
//                  cached 2 minutes, 10 for coins over 30 minutes old); if
//                  every hard check passes, a signal, carrying the coin's
//                  numbers (SignalFeatures), and in paper mode a position
//                  (trading/paper.ts). A snipe on a coin that failed only a
//                  risk check (the creator's stake, serial launches, a
//                  copycat) is a fast scalp, as is a momentum burst: sold
//                  fast, out when the creator sells. A coin that raised a rug
//                  alarm isn't bought for 30 minutes
//   open coins   → safety re-checked each minute: a coin that fails (turned
//                  honeypot, creator dumping, …) is closed out, in every
//                  visitor's bot too
//
// Signals and positions go to the store (Postgres on Railway) and to the
// `signals` WebSocket channel. Every signal opens a paper position; in live
// mode (the owner's switch, bot/liveTrader.ts) the bot wallet also trades it.

import { POOL_MANAGER } from '../../../api/_arcSwaps'
import type { LaunchInfo, ServerMessage, Trade } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { PoolInfo, PoolRegistry } from '../dex/pools'
import { clustersOf, type Clusters } from '../intel/clusters'
import { computeFlow, RecentTapes, tapeTrade, Tapes, windowOf, type Flow, type Window } from '../intel/flow'
import { probeHoneypot, type HoneypotResult } from '../intel/honeypot'
import { holdersOf, type Holders } from '../intel/holders'
import { assess, staticFacts, type SafetyReport, type ScanInput, type StaticFacts } from '../intel/scanner'
import { knownLaunchpad, launchpadGate, type LaunchpadOnly } from '../intel/launchpadGate'
import { log, errMsg } from '../log'
import type { EngineObserver, MarketEngine } from '../market/engine'
import { metrics } from '../metrics'
import { PricePath, RULES, scalpReady, secondLegReady, snipeReady, tooCostly } from '../signals/rules'
import type { BotStatus, DollarPlanView, GradeRecordView, LiveRouting, ScanRow, SignalFeatures, SignalGrade, SignalQuality, SignalRule } from '../../../api/_marketProtocol'
import { GRADE_RULES, GRADES, GradeBook, gradeOf, isEarlyCrowd, liveGrade, PRIME_RULES } from '../signals/grades'
import { crowdCap } from './crowd'
import { QUALITY, QualityRank, qualityScore, type RuleRecord } from '../signals/quality'
import { LIVE_GATE, liveKey, LiveSpeedBook, replayAtLiveSpeed, type LiveSpeedRecord, type Replay } from '../signals/liveSpeed'
import { canOpen, closeNow, costPerSide, LIVE_SPEED, onPrice, openPosition, QUICK_EXITS, RISK, STRATEGIES, stats, type ExitReason, type Position, type Strategy, type StrategyParams } from '../trading/paper'
import { DOLLAR_PLAN, dollarParams, dollarPlanText, isDollarStrategy, isDollarTrade, type DollarStrategy } from './dollarPlan'
import type { HistoryStore } from '../store/history'
import { defaultTuning, toParams } from './learner'
import type { LiveTrader } from './liveTrader'
import type { PaperAccounts } from './paperAccounts'
import { PROBATION, probationOf } from './probation'
import { RugWatch } from './rugGuard'
import { LIVE_SIZE, liveTradeSize, type LiveGrowth } from './sizing'
import { boardAdmits, boardParams, platformParams } from './strategyBoard'
import { failing, ScanFeed, OutcomeTally } from './scanFeed'
import type { BotStore } from './store'
import type { Signal } from './types'

const WATCH_MS = 48 * 3_600_000

/** The bot wallet's growth as saved in the settings ('live-growth'), or null. */
function parseGrowth(raw: string | null): { at: number; startUsd: number; pnlUsd: number } | null {
  if (!raw) return null
  try {
    const g = JSON.parse(raw) as { at?: unknown; startUsd?: unknown; pnlUsd?: unknown }
    return typeof g.at === 'number' && typeof g.startUsd === 'number' && typeof g.pnlUsd === 'number' ? { at: g.at, startUsd: g.startUsd, pnlUsd: g.pnlUsd } : null
  } catch { return null }
}
const EVAL_EVERY_MS = 2_000
const DEEP_TTL_MS = 120_000
/** A coin over 30 minutes old changes slowly: its deep scan is kept 10 minutes. */
const DEEP_TTL_OLD_MS = 600_000
/** Deep scans (probe, holders, funding) and contract reads running at once: the RPC's budget. */
const DEEP_AT_ONCE = 6
const STATIC_AT_ONCE = 8
/** Coins a sweep evaluates at most. */
const SWEEP_MAX = 600
const RECHECK_OPEN_MS = 60_000
const SECOND_LEG_REPEAT_MS = RULES.secondLeg.repeatMin * 60_000
/** A signal within 2 minutes (owner, 2026-09-30): each part of a deep scan gets this long, then counts as unknown. */
const DEEP_BUDGET_MS = { honeypot: 10_000, holders: 12_000, clusters: 15_000 }
/** A deep scan missing an answer is tried again this soon, not held for minutes. */
const DEEP_TTL_INCOMPLETE_MS = 15_000
/** A snipe or a dip rebound whose only risks are unknown waits this long for the scan to answer them. */
const UNKNOWN_RISK_WAIT_MS = 45_000
const within = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>(r => setTimeout(() => r(fallback), ms))])
/** Launchpads whose coins trade on their own curve before graduating. */
const CURVES = new Set(['Peach', 'Faze', 'Mercuri', 'SolonPad', 'ARCDEX'])
/** Curves ARCDEX can trade today (the site's curve router): not Peach's or Faze's yet. */
const EXECUTABLE_CURVES = new Set(['Mercuri', 'SolonPad', 'ARCDEX'])
/** Tickers of coins that aren't launches: a launch using one is a copycat. */
const RESERVED = new Set(['usdc', 'usdt', 'eurc', 'eth', 'weth', 'btc', 'wbtc', 'argus', 'arcd', 'arc', 'faze', 'peach', 'virtual'])

export type BotMode = 'paper' | 'live' | 'off'

interface Deep { at: number; honeypot?: HoneypotResult; holders: Holders | null; clusters: Clusters | null; complete: boolean }

/** Runs at most `max` jobs at once; the rest wait their turn. */
class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  get waiting() { return this.queue.length }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(r => this.queue.push(r))
    this.active++
    try { return await fn() } finally { this.active--; this.queue.shift()?.() }
  }
}

/** A rule's numbers, before the safety scan adds its own. */
type RuleFeatures = Pick<SignalFeatures, 'buyers' | 'buySellRatio' | 'runUp' | 'topBuyerPct' | 'launchTopBuyerPct' | 'earlyCrowd'>
const ratio = (buy: number, sell: number) => (sell > 0 ? Math.round((buy / sell) * 100) / 100 : null)
/** A snipe's numbers: the market's own buying, as the rule read it (Flow.organic). */
const flowFeatures = (f: Flow): RuleFeatures => ({ buyers: f.organic.buyers, buySellRatio: ratio(f.organic.buyUsd, f.organic.sellUsd), runUp: f.organic.firstPrice && f.organic.lastPrice ? f.organic.lastPrice / f.organic.firstPrice : null, topBuyerPct: f.organic.topBuyerPct })
const windowFeatures = (w: Window): RuleFeatures => ({ buyers: w.buyers, buySellRatio: ratio(w.buyUsd, w.sellUsd), runUp: w.firstPrice && w.lastPrice ? w.lastPrice / w.firstPrice : null, topBuyerPct: w.topBuyerPct })

/** Why live bots don't trade a kind of signal yet, in words. */
function liveWhy(ls: LiveSpeedRecord): string {
  if (ls.trades < LIVE_GATE.minTrades) return `not traded live until it proves itself at live speed (${ls.trades} of ${LIVE_GATE.minTrades} replays on real trades so far)`
  return `not profitable at live speed: its last ${ls.trades} replays on real trades averaged ${((ls.avgReturn ?? 0) * 100).toFixed(1)}% a trade (${ls.wins} won)`
}

export class Bot implements EngineObserver {
  readonly tapes = new Tapes()
  /** Every watched coin's last 3 minutes, and the rug guard reading them. */
  readonly recent = new RecentTapes()
  readonly rug = new RugWatch(this.recent)
  private deepLimit = new Limiter(DEEP_AT_ONCE)
  private staticLimit = new Limiter(STATIC_AT_ONCE)
  private deepInflight = new Map<string, Promise<Deep>>()
  private paths = new Map<string, PricePath>()
  private statics = new Map<string, Promise<StaticFacts>>()
  private deeps = new Map<string, Deep>()
  private reports = new Map<string, SafetyReport>()
  private lastEval = new Map<string, number>()
  private evaluating = new Set<string>()
  private fired = new Map<string, number>()
  /** Since when a snipe or rebound has waited on unknown risk checks (`${rule}:${token}`). */
  private riskWait = new Map<string, number>()
  private bySymbol = new Map<string, Set<string>>()
  private byCreator = new Map<string, number[]>()
  private recentSignals: Signal[] = []
  /** The last signals' quality scores: the top 80% go to live bots (signals/quality.ts). */
  private qualityRank = new QualityRank()
  positions: Position[] = []
  private lastRecheck = new Map<string, number>()
  private blockedOnce = new Set<string>()
  /** Every coin being watched, where it stands and why (the site's live scanner). */
  readonly scan = new ScanFeed()
  /** What became of its own signals in its paper book (GET /v1/bot/rejections). */
  readonly outcomes = new OutcomeTally()

  /** What it's doing now: paper, live (paper too, plus the bot wallet's trades), or off. */
  mode: BotMode

  /** `sizeUsd` sizes snipes and second legs; `scalpSizeUsd` sizes scalps. `live` is set when a bot wallet is configured. */
  /** Each kind of signal replayed on its coin's real trades at live speed; live bots trade only the kinds that make money (signals/liveSpeed.ts). */
  readonly liveSpeed = new LiveSpeedBook()
  /** Each grade's signals replayed at live speed with the exits that grade trades with: its public record and its review (signals/grades.ts). */
  readonly grades = new GradeBook()
  /**
   * Every snipe and fast-scalp signal replayed on its coin's real trades at live speed on the dollar plan (bot/
   * dollarPlan.ts), as a closed $2 position: the plan's public record, its probation, and what live bots learn from.
   */
  readonly dollar = new Map<string, Position>()
  private dollarSkipped = new Set<string>()
  /** Coins that had an early crowd (signals/grades.ts): crowd momentum leaves them out. */
  private earlyCrowd = new Set<string>()
  private replaying = false
  /** The paper book's buys waiting for their live-speed fill, by token. */
  private pendingHouse = new Map<string, { signal: Signal; strategy: Strategy; params: StrategyParams; cost: number; features: SignalFeatures; rule: SignalRule; due: number }>()
  private speed: typeof LIVE_SPEED | null
  /** Live bots: every signal not on probation (`all`), or only the proven kinds, not the lowest 20% (`proven`). */
  readonly liveSignals: 'all' | 'proven'
  /**
   * Which signals live bots trade: every snipe and fast scalp on the dollar plan (`dollar`, bot/dollarPlan.ts), the
   * strategy board (`board`, bot/strategyBoard.ts), Prime and grades proven at live speed (`proven`), every grade
   * (`all`), or none (`off`).
   */
  readonly liveGrades: LiveRouting
  /**
   * The bot wallet's growth since it went live (bot/sizing.ts liveTradeSize): its balance then, and its realized
   * live P&L since, kept in the settings so a restart doesn't reset its trade size. Null until the balance is read.
   */
  private growth: { at: number; startUsd: number; pnlUsd: number } | null = null
  /** Launchpad coins only (intel/launchpadGate.ts): `strict` (origin and code), `origin`, or `off`. */
  readonly launchpadOnly: LaunchpadOnly
  /** Closed live positions already in `growth.pnlUsd`. */
  private grown = new Set<string>()

  /** `history`: the coins' stored trades (replays); `speed`: the paper book at live speed (the default; null: at once). */
  constructor(private o: { rpc: Rpc; engine: MarketEngine; pools: PoolRegistry; store: BotStore; publish: (topics: string[], msg: ServerMessage) => void; mode: BotMode; sizeUsd?: number; scalpSizeUsd?: number; live?: LiveTrader | null; owner?: string | null; accounts?: PaperAccounts | null; history?: Pick<HistoryStore, 'trades'> | null; speed?: typeof LIVE_SPEED | null; liveSignals?: 'all' | 'proven'; liveGrades?: LiveRouting; launchpadOnly?: LaunchpadOnly }) {
    this.speed = o.speed === undefined ? LIVE_SPEED : o.speed
    this.liveSignals = o.liveSignals ?? 'proven'
    this.liveGrades = o.liveGrades ?? 'proven'
    this.launchpadOnly = o.launchpadOnly ?? 'off'
    this.mode = o.mode === 'live' && !o.live ? 'paper' : o.mode
    o.live?.setPools(token => { const mp = this.o.engine.tokens.get(token)?.mainPool; return mp ? this.o.pools.get(mp) ?? null : null })
    // Its paper book is one of the strategy board's books, and its live trades count toward live bots' own record there.
    o.accounts?.setHouse({ paper: () => this.positions.filter(p => p.mode !== 'live'), live: () => this.positions.filter(p => p.mode === 'live') })
  }

  /** On the strategy board: whether live bots trade a signal of strategy `st` now (paused: its paper books lost, or live bots' own trades did). */
  private boardLive(st: Strategy, grade: SignalGrade, now: number): { ok: boolean; why: string | null } {
    const acc = this.o.accounts
    if (!acc) return liveGrade(this.grades, grade, now)
    const pick = acc.boardPick(st, now)
    return pick.status === 'paused' ? { ok: false, why: pick.why } : { ok: true, why: null }
  }

  async start() {
    this.positions = await this.o.store.positions(30).catch(e => { log.warn('bot: could not load positions', { error: errMsg(e) }); return [] })
    this.recentSignals = await this.o.store.signals(200).catch(() => [])
    this.scan.seedSignals(this.recentSignals.map(s => s.at))
    // The quality rank picks up where it was: the last signals' scores, oldest first.
    for (const sg of [...this.recentSignals].slice(0, QUALITY.window).reverse()) {
      if (sg.probation) continue
      const score = sg.quality?.score ?? (sg.features && sg.rule ? qualityScore(sg.features, this.ruleRecord(sg.rule, Date.now())).score : null)
      if (score !== null) this.qualityRank.add(score)
    }
    // Its closed paper trades are what visitors' bots with few trades of their own also learn from.
    const ruleOf = new Map(this.recentSignals.map(s => [s.id, s.rule]))
    for (const p of this.positions) if (p.mode !== 'live') { p.rule ??= ruleOf.get(p.signalId); this.o.accounts?.observe(p) }
    // A scalp from a snipe on a risky coin counts as that coin's snipe; a momentum scalp as its scalp.
    for (const s of this.recentSignals) this.fired.set(`${s.rule === 'momentum' ? 'scalp' : s.strategy === 'scalp' ? 'snipe' : s.strategy}:${s.token}`, s.at)
    // The owner's last choice survives a restart (live only while a bot wallet is configured).
    const saved = await this.o.store.getSetting('mode').catch(() => null)
    if (this.mode !== 'off' && (saved === 'paper' || (saved === 'live' && this.o.live))) this.mode = saved
    this.growth = parseGrowth(await this.o.store.getSetting('live-growth').catch(() => null))
    for (const p of this.positions) if (p.mode === 'live' && p.status === 'closed') this.grown.add(p.id)
    if (this.o.live) void this.o.live.refreshBalance().then(() => this.startGrowth(false)).catch(e => log.warn('live: balance read failed', { error: errMsg(e) }))
    log.info('bot started', { mode: this.mode, open: this.positions.filter(p => p.status === 'open').length, store: this.o.store.kind, wallet: this.o.live?.address ?? null })
  }

  /** The owner's switch (the signature is checked before this). */
  async setMode(mode: 'paper' | 'live'): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === 'off') return { ok: false, error: 'the bot is off on this engine (BOT_MODE=off)' }
    if (mode === 'live' && !this.o.live) return { ok: false, error: 'no bot wallet is configured (BOT_PRIVATE_KEY)' }
    this.mode = mode
    await this.o.store.setSetting('mode', mode)
    // Going live starts the trade size over at its base, grown from here by what the live trades make.
    if (mode === 'live') await this.o.live!.refreshBalance().then(() => this.startGrowth(true)).catch(e => log.warn('live: balance read failed', { error: errMsg(e) }))
    this.o.live?.event({ kind: 'mode', text: mode === 'live' ? 'Switched to LIVE: new signals are traded with the bot wallet' : 'Switched to paper: no new live trades (open ones are still managed)' })
    log.info('bot: mode switched', { mode })
    return { ok: true }
  }

  /** The owner's "sell everything" button: every open live position, now. */
  closeLive(): number {
    const open = this.positions.filter(p => p.mode === 'live' && p.status === 'open')
    for (const p of open) this.o.live?.closeNow(p, 'manual')
    this.o.live?.event({ kind: 'mode', text: `Owner: selling all ${open.length} live position(s)` })
    return open.length
  }

  // ── engine events ───────────────────────────────────────────────────

  onLaunch(l: LaunchInfo) {
    if (Date.now() - l.timestamp <= WATCH_MS) this.scan.launch(l)
    this.index(l)
  }

  /** Copycat and serial-launcher checks read these. */
  private index(l: LaunchInfo) {
    const sym = l.symbol.trim().toLowerCase()
    if (sym) this.bySymbol.set(sym, (this.bySymbol.get(sym) ?? new Set()).add(l.token))
    if (l.creator) {
      const seen = this.byCreator.get(l.creator) ?? []
      if (!seen.includes(l.timestamp)) this.byCreator.set(l.creator, [...seen, l.timestamp].slice(-50))
    }
  }

  /**
   * After the engine's warm start (2026-10-01): every launch of the last 48h
   * back on the scanner, with the trades the engine kept (its last 100 each)
   * in the tapes, price paths and rug guard. Before, a restart (every deploy)
   * emptied the scanner until each coin traded again: 4 coins watched right
   * after one, 68 an hour later.
   */
  seed(now = Date.now()) {
    let listed = 0, trades = 0
    for (const [token, meta] of this.o.engine.metas) {
      this.index(meta)
      if (now - meta.timestamp > WATCH_MS) continue
      this.scan.launch(meta)
      listed++
      const mainPool = this.o.engine.tokens.get(token)?.mainPool
      let path = this.paths.get(token)
      if (!path) { path = new PricePath(meta.timestamp); this.paths.set(token, path) }
      for (const w of [...this.o.engine.recentTrades(token, 100)].reverse()) {
        const priced = w.pu !== null && (!mainPool || w.pl === mainPool)
        const side = w.s === 'B' ? 'BUY' as const : w.s === 'S' ? 'SELL' as const : 'UNKNOWN' as const
        const tape = { block: w.b, ts: w.ts, wallet: w.w?.toLowerCase() ?? null, side, usd: w.u ?? 0, tokens: w.ba, price: priced ? w.pu : null }
        this.tapes.add(token, tape)
        this.recent.add(token, tape, now)
        this.rug.onTrade(token, tape, priced ? w.lq : null, priced, w.ts)
        if (priced) path.add(w.ts, w.pu, side, tape.usd)
        trades++
      }
    }
    log.info('bot: scanner seeded after the restart', { coins: listed, trades })
    return listed
  }

  onTrade(t: Trade, ctx: { replay: boolean }) {
    const meta = this.o.engine.metas.get(t.token)
    if (!meta || t.timestamp - meta.timestamp > WATCH_MS) return
    // Only the main pool's trades are the coin's price (a side pool's trade is
    // still a real buyer or seller). Paper stops fired on a side pool's price once.
    const mainPool = this.o.engine.tokens.get(t.token)?.mainPool
    const priced = !mainPool || t.pool === mainPool
    const tape = { ...tapeTrade(t), price: priced ? t.priceUsd : null }
    this.tapes.add(t.token, tape)
    this.recent.add(t.token, tape, ctx.replay ? t.timestamp : Math.max(t.timestamp, Date.now()))
    // Replays rebuild the guard's view too; only a live alarm closes anything.
    const alarm = this.rug.onTrade(t.token, tape, priced ? t.liquidity : null, priced, t.timestamp)
    let path = this.paths.get(t.token)
    if (!path) { path = new PricePath(meta.timestamp); this.paths.set(t.token, path) }
    if (priced) path.add(t.timestamp, t.priceUsd, t.side, t.usdValue ?? 0)
    if (ctx.replay || this.mode === 'off') return
    const now = Date.now()
    // The creator selling, in any pool, closes a scalp (and every visitor's bot) at the coin's price after the sale.
    const creatorSold = t.side === 'SELL' && !!meta.creator && t.wallet?.toLowerCase() === meta.creator.toLowerCase()
    const price = this.o.engine.tokens.get(t.token)?.priceUsd ?? null
    const held = this.positions.some(p => p.status === 'open' && p.token === t.token) || this.pendingHouse.has(t.token) || !!this.o.accounts?.holds(t.token)
    if (priced) this.fillHouse(t.token, price, now)
    if (alarm && held) { metrics.inc('bot_rug_exits'); log.info('bot: rug guard', { token: t.token, symbol: meta.symbol, alarm: alarm.text }) }
    for (const p of this.positions) {
      if (p.status !== 'open' || p.token !== t.token || !price) continue
      if (p.mode === 'live') {
        if (alarm) this.o.live?.closeNow(p, 'rug')
        else if (priced || creatorSold) this.o.live?.onPrice(p, price, now, creatorSold)
        continue
      }
      const lag = this.speed?.exitMs ?? 0
      if (alarm) this.fills(p, closeNow(p, price, now, 'rug', `Rug guard: ${alarm.text}`, lag))
      else if (creatorSold && (p.exits ?? this.params(p.strategy)).exitOnCreatorSell) this.fills(p, closeNow(p, price, now, 'creator', undefined, lag))
      else if (priced) this.fills(p, onPrice(p, price, now, this.params(p.strategy), lag))
    }
    if (price) this.o.accounts?.onPrice(t.token, price, now, creatorSold, priced, alarm)
    if (!priced) return
    // The contract reads start now, so a coin's safety scan is quick once a rule is met.
    if (!this.statics.has(t.token)) void this.staticsOf(t.token).catch(() => {})
    this.kick(t.token, now)
  }

  /** Evaluates a coin now, unless it was a moment ago or still is. */
  private kick(token: string, now: number) {
    if (now - (this.lastEval.get(token) ?? 0) < EVAL_EVERY_MS || this.evaluating.has(token)) return false
    this.lastEval.set(token, now)
    this.evaluating.add(token)
    void this.evaluate(token).catch(e => log.debug('bot: evaluation failed', { token, error: errMsg(e) })).finally(() => this.evaluating.delete(token))
    return true
  }

  /** Every 3s: every coin that traded in the last 3 minutes is evaluated, busy or not. */
  sweep(now = Date.now()) {
    if (this.mode === 'off') return 0
    let n = 0
    for (const token of this.recent.active(now)) {
      if (n >= SWEEP_MAX) break
      if (this.kick(token, now)) n++
    }
    metrics.set('bot_sweep_coins', n)
    metrics.set('bot_deep_waiting', this.deepLimit.waiting)
    return n
  }

  /**
   * A coin's price now, else the last one the bot saw: the engine forgets a
   * coin after a day without trades, and a position in it must still reach
   * its time exits.
   */
  priceOf(token: string): number | null {
    const live = this.o.engine.tokens.get(token)?.priceUsd
    if (live) return live
    const m = this.paths.get(token)?.minutes
    return m?.length ? m[m.length - 1].c : null
  }

  /** Every 15s: time stops, safety re-checks for open coins, forgetting old coins. */
  tick(now = Date.now()) {
    if (this.mode === 'off') return
    for (const p of this.positions) {
      if (p.status !== 'open' || p.mode === 'live') continue
      const price = this.priceOf(p.token)
      if (price) this.fills(p, onPrice(p, price, now, this.params(p.strategy), this.speed?.exitMs ?? 0))
    }
    for (const token of [...this.pendingHouse.keys()]) this.fillHouse(token, this.priceOf(token), now)
    this.o.live?.tick(now, token => this.priceOf(token))
    this.o.accounts?.tick(now)
    for (const [token, path] of this.paths) {
      if (now - path.launchedAt > WATCH_MS && !this.positions.some(p => p.status === 'open' && p.token === token)) {
        this.paths.delete(token); this.tapes.drop(token); this.deeps.delete(token); this.reports.delete(token); this.statics.delete(token); this.lastEval.delete(token)
        this.recent.drop(token); this.rug.forget(token); this.riskWait.delete(`snipe:${token}`); this.riskWait.delete(`second-leg:${token}`)
      }
    }
    for (const [token, r] of this.scan.rows) if (now - r.launchedAt > WATCH_MS) this.scan.drop(token)
    metrics.set('bot_watched', this.paths.size)
  }

  // ── evaluation ──────────────────────────────────────────────────────

  private async evaluate(token: string) {
    const meta = this.o.engine.metas.get(token)
    const st = this.o.engine.tokens.get(token)
    if (!meta || !st?.priceUsd) return
    const now = Date.now()
    const openHere = this.positions.filter(p => p.status === 'open' && p.token === token)
    if ((openHere.length || this.o.accounts?.holds(token)) && now - (this.lastRecheck.get(token) ?? 0) >= RECHECK_OPEN_MS) {
      this.lastRecheck.set(token, now)
      const r = await this.report(token, true)
      // Not being a launchpad coin is a reason not to buy, not to sell one already held (opened before the rule).
      const failed = r?.verdict === 'fail' ? r.checks.filter(c => c.ok === false && c.id !== 'launchpad') : []
      if (failed.length) {
        log.info('bot: closing on a safety failure', { token, failed: failed.map(c => c.id) })
        for (const p of openHere) {
          if (p.mode === 'live') this.o.live?.closeNow(p, 'safety')
          else this.fills(p, closeNow(p, st.priceUsd, now, 'safety', undefined, this.speed?.exitMs ?? 0))
        }
        this.o.accounts?.closeToken(token, st.priceUsd, now, 'safety', `A safety re-check failed: ${failed.map(c => `${c.id} (${c.detail})`).join('; ').slice(0, 200)}`)
      }
    }
    const ageSec = (now - meta.timestamp) / 1000
    const base = { token, symbol: meta.symbol, launchpad: meta.launchpad, launchedAt: meta.timestamp, priceUsd: st.priceUsd, marketCapUsd: st.stats(now).marketCapUsd, liquidityUsd: st.liquidityUsd }
    // Launchpad coins only: a coin no known Arc launchpad launched is never a signal (no rules, no safety scan).
    if (this.launchpadOnly !== 'off' && !knownLaunchpad(meta)) {
      this.scan.record(base, { status: 'rejected', stage: 'safety', reasons: [`✗ launchpad: ${launchpadGate(this.launchpadOnly, meta)}`], keys: ['safety:launchpad'] })
      return
    }
    // Snipe: once per coin, in its first minutes.
    let snipeWaiting: string[] | null = null
    /** What stops the coin, for counting (GET /v1/bot/rejections). */
    const keys: string[] = []
    if (ageSec <= RULES.snipe.maxAgeSec && !this.fired.has(`snipe:${token}`)) {
      const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
      // An early crowd is marked; and a young coin drawing buyers gets its safety scan started now, so its
      // signal isn't held 10-20s waiting for it (the early crowd's edge is in its first seconds).
      if (isEarlyCrowd(flowFeatures(flow), ageSec)) this.earlyCrowd.add(token)
      if (ageSec <= 120 && flow.organic.buyers >= 5) void this.report(token, true).catch(() => {})
      const rule = snipeReady(flow, ageSec)
      if (rule.ok) { this.scan.record(base, await this.tryFire('snipe', token, rule.reasons, ageSec, flowFeatures(flow))); return }
      snipeWaiting = [...failing(rule.reasons), `snipe window: ${Math.max(0, Math.floor(RULES.snipe.maxAgeSec - ageSec))}s left`]
      keys.push(...rule.failed.map(f => `snipe:${f}`))
    }
    // Dip rebound first, after the snipe window (2026-09-30): a rebound is a
    // burst of buying too, and when the momentum rule was checked first it fired
    // a fast scalp, held the coin for 30 minutes, and the rebound was never
    // looked at. A rebound that isn't a signal (a risky coin, a scan still
    // running) leaves the coin to the momentum rule, as before.
    const path = this.paths.get(token)
    const lastLeg = this.fired.get(`second-leg:${token}`) ?? 0
    let legChecked = false, legOutcome: Pick<ScanRow, 'status' | 'stage' | 'reasons' | 'strategy' | 'keys'> | null = null
    let legWaiting: string[] = [], legKeys: string[] = []
    if (!snipeWaiting && path && now - lastLeg >= SECOND_LEG_REPEAT_MS) {
      legChecked = true
      const rule = secondLegReady(path, now)
      if (rule.ok) {
        const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
        const nowMin = Math.floor(now / 60_000)
        const last15 = path.minutes.filter(x => x.m > nowMin - 15)
        const cur = path.minutes[path.minutes.length - 1]?.c ?? null
        const feats: RuleFeatures = {
          buyers: flow.organic.buyers, topBuyerPct: flow.organic.topBuyerPct,
          buySellRatio: ratio(last15.reduce((sum, x) => sum + x.bv, 0), last15.reduce((sum, x) => sum + x.sv, 0)),
          runUp: cur && rule.bottom ? cur / rule.bottom : null,
        }
        const out = await this.tryFire('second-leg', token, rule.reasons, ageSec, feats)
        if (out.status === 'signal') { this.scan.record(base, out); return }
        legOutcome = out
      } else { legWaiting = failing(rule.reasons); legKeys = rule.failed.map(f => `leg:${f}`) }
    }
    // Fast scalp: a burst of buying in the last 2 minutes, on any coin; again after 30 minutes, not right after its snipe or rebound.
    let scalpWaiting: string[] = []
    const lastScalp = Math.max(this.fired.get(`scalp:${token}`) ?? 0, this.fired.get(`snipe:${token}`) ?? 0, lastLeg)
    if (now - lastScalp >= RULES.scalp.repeatMin * 60_000) {
      const w = windowOf(this.recent.window(token, now, RULES.scalp.windowSec * 1_000))
      const rule = scalpReady(w, ageSec, st.liquidityUsd, windowOf(this.recent.window(token, now, RULES.scalp.confirmSec * 1_000)))
      if (rule.ok) {
        // Crowd momentum reads the largest buyer since launch, and leaves out coins that had an early crowd.
        const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
        this.scan.record(base, await this.tryFire('momentum', token, rule.reasons, ageSec, { ...windowFeatures(w), launchTopBuyerPct: flow.organic.topBuyerPct, earlyCrowd: this.earlyCrowd.has(token) }))
        return
      }
      scalpWaiting = failing(rule.reasons).slice(0, 2).map(r => r.replace(/^✗ /, '✗ scalp: '))
      keys.push(...rule.failed.map(f => `scalp:${f}`))
    }
    if (snipeWaiting) { this.scan.record(base, { status: 'watching', stage: 'snipe', reasons: [...snipeWaiting, ...scalpWaiting], keys }); return }
    if (legOutcome) this.scan.record(base, legOutcome)
    else if (legChecked) this.scan.record(base, { status: 'watching', stage: 'second-leg', reasons: ['waiting for a momentum scalp or a dip rebound', ...scalpWaiting, ...legWaiting], keys: [...keys, ...legKeys] })
    else if (scalpWaiting.length) this.scan.record(base, { status: 'watching', stage: 'scalp', reasons: scalpWaiting, keys })
  }

  /** A coin that met a rule: the rug guard and its safety scan decide. Returns what the scanner shows. */
  private async tryFire(rule: 'snipe' | 'second-leg' | 'momentum', token: string, reasons: string[], ageSec: number, feats: RuleFeatures): Promise<Pick<ScanRow, 'status' | 'stage' | 'reasons' | 'strategy' | 'keys'>> {
    const stage = rule === 'momentum' ? 'scalp' as const : rule
    const alarm = this.rug.recentAlarm(token)
    if (alarm) return { status: 'rejected', stage: 'safety', reasons: [`✗ rug guard ${Math.max(1, Math.round((Date.now() - alarm.at) / 60_000))} min ago: ${alarm.text}`], keys: ['safety:rug-guard'] }
    // Its code, before the deep scan: a custom contract from a launchpad whose standard code is known isn't one of its coins.
    if (this.launchpadOnly === 'strict') {
      const meta = this.o.engine.metas.get(token)
      const sf = meta ? await this.staticsOf(token).catch(() => null) : null
      const why = meta && sf ? launchpadGate('strict', meta, sf.template) : null
      if (why) return { status: 'rejected', stage: 'safety', reasons: [`✗ launchpad: ${why}`], keys: ['safety:launchpad'] }
    }
    const r = await this.report(token, true)
    // A risk that isn't known yet (holders not read, funding not traced in the
    // scan's time) made a snipe a scalp, or a rebound rejected, on missing data
    // (2026-09-30). They wait for the scan now, retried every 15s, for up to
    // UNKNOWN_RISK_WAIT_MS (a snipe no later than the end of its window); after
    // that, as before. A momentum scalp never waits, and neither does a coin whose market numbers
    // already make it Prime (2026-10-01): it's traded with Precision either way, and its take-profit
    // came 10-48s after the signal, so waiting for the scan only costs the move.
    const primeNow = gradeOf({ ageSec, liquidityUsd: this.o.engine.tokens.get(token)?.liquidityUsd ?? null, marketCapUsd: null, buyers: feats.buyers, buySellRatio: feats.buySellRatio, runUp: feats.runUp, topBuyerPct: feats.topBuyerPct, score: r?.score ?? 0, flags: [], roundTripPct: r?.honeypot?.roundTripLossPct ?? null }).grade === 'prime'
    if (r?.verdict === 'risky' && rule !== 'momentum' && !primeNow) {
      const unknown = r.checks.filter(c => c.risk && c.ok === null)
      if (unknown.length && !r.checks.some(c => c.risk && c.ok === false)) {
        const key = `${rule}:${token}`, now = Date.now()
        const since = this.riskWait.get(key) ?? now
        this.riskWait.set(key, since)
        const meta = this.o.engine.metas.get(token)
        const until = Math.min(since + UNKNOWN_RISK_WAIT_MS, rule === 'snipe' && meta ? meta.timestamp + RULES.snipe.maxAgeSec * 1_000 - 10_000 : Infinity)
        if (now < until) {
          metrics.inc(`bot_${rule}_waiting_unknown`)
          return { status: 'checking', stage: 'safety', reasons: unknown.map(c => `… ${c.id}: ${c.detail} (checking again)`), keys: unknown.map(c => `pending:${c.id}`) }
        }
      }
    }
    // A snipe on a coin that failed only a risk check is a scalp: small, sold fast. A momentum burst is a scalp either way.
    const strategy: Strategy | null = r?.verdict === 'pass' ? (rule === 'momentum' ? 'scalp' : rule) : r?.verdict === 'risky' && rule !== 'second-leg' ? 'scalp' : null
    if (!r || !strategy) {
      const outcome = (): Pick<ScanRow, 'status' | 'stage' | 'reasons' | 'keys'> => {
        if (!r) return { status: 'checking', stage: 'safety', reasons: ['safety scan unavailable right now'], keys: ['safety:unavailable'] }
        const hardFails = r.checks.filter(c => c.hard && c.ok === false)
        if (hardFails.length) return { status: 'rejected', stage: 'safety', reasons: hardFails.map(c => `✗ ${c.id}: ${c.detail}`), keys: hardFails.map(c => `safety:${c.id}`) }
        const pending = r.checks.filter(c => c.hard && c.ok === null)
        if (pending.length) return { status: 'checking', stage: 'safety', reasons: pending.map(c => `… ${c.id}: ${c.detail}`), keys: pending.map(c => `pending:${c.id}`) }
        // Risky, and a dip rebound needs a clean coin.
        return { status: 'rejected', stage: 'safety', reasons: ['a dip rebound needs a clean coin', ...r.checks.filter(c => c.risk && c.ok !== true).map(c => `✗ ${c.id}: ${c.detail}`)], keys: ['safety:risky-for-rebound'] }
      }
      metrics.inc(`bot_${rule}_blocked_${r?.verdict ?? 'unknown'}`)
      // Which checks stop candidates (tuning): counted once per coin.
      const key = `${rule}:${token}`
      if (r && !this.blockedOnce.has(key)) {
        this.blockedOnce.add(key)
        const stopping = r.checks.filter(c => (c.hard || (c.risk && rule === 'second-leg')) && c.ok !== true)
        for (const c of stopping) metrics.inc(`bot_block_${c.ok === false ? 'fail' : 'pending'}_${c.id}`)
        log.info('bot: candidate blocked', { strategy: rule, token, verdict: r.verdict, checks: stopping.map(c => `${c.id}: ${c.detail}`) })
      }
      return outcome()
    }
    // The cleanest signals (2026-10-01): a coin whose round trip eats the take-profit isn't one.
    const costly = tooCostly(strategy, r.honeypot?.roundTripLossPct ?? null)
    if (costly) { metrics.inc(`bot_${rule}_blocked_costly`); return { status: 'rejected', stage: 'safety', reasons: [`✗ costs: ${costly}`], keys: ['safety:costly'] } }
    if (strategy === 'scalp' && r.verdict === 'risky') reasons = [...reasons, ...r.checks.filter(c => c.risk && c.ok !== true).map(c => `risk (${c.id}): ${c.detail}`)]
    const meta = this.o.engine.metas.get(token)!, st = this.o.engine.tokens.get(token)!
    const now = Date.now()
    const pool = st.mainPool ? this.o.pools.get(st.mainPool) ?? null : null
    const s = st.stats(now)
    const features: SignalFeatures = {
      ageSec: Math.round(ageSec), liquidityUsd: st.liquidityUsd, marketCapUsd: s.marketCapUsd,
      buyers: feats.buyers, buySellRatio: feats.buySellRatio, runUp: feats.runUp === null ? null : Math.round(feats.runUp * 1_000) / 1_000,
      topBuyerPct: Math.round(feats.topBuyerPct * 10) / 10, score: r.score,
      flags: r.checks.filter(c => c.risk && c.ok !== true).map(c => c.id), roundTripPct: r.honeypot?.roundTripLossPct ?? null,
      ...(feats.launchTopBuyerPct != null ? { launchTopBuyerPct: Math.round(feats.launchTopBuyerPct * 10) / 10 } : {}),
      ...(feats.earlyCrowd !== undefined ? { earlyCrowd: feats.earlyCrowd } : {}),
    }
    // Its grade (signals/grades.ts): Prime, Core or Standard, handed out one lower while its own grade's record is under review.
    const graded2 = gradeOf(features, rule)
    const handed = this.grades.effective(graded2.grade, now)
    // A rule whose paper record is losing: still fired and measured here, but no bot trades it (bot/probation.ts).
    // A Prime or Core signal is past it: its own grade's record at live speed, with the exits live bots trade it with,
    // is what decides (the momentum rule's losers were the bursts crowd momentum leaves out; the rule's paper record
    // is kept with other exits). A grade under review is handed out as Standard, and probation applies again.
    // On the dollar plan, every grade: the rule's replays on the plan decide (bot/dollarPlan.ts).
    const dollarMode = this.liveGrades === 'dollar'
    const probation = dollarMode ? this.dollarProbation(rule, now) : handed.grade === 'standard' ? this.probation(rule, now) : null
    if (probation) { reasons = [...reasons, `⚠ on probation: ${probation.why}`]; metrics.inc(`bot_${rule}_probation`) }
    // What this kind of signal makes at live speed (replayed on real trades): live bots trade it only while that's a profit.
    const ls = this.liveSpeed.record(liveKey(rule, strategy), now)
    // Its quality, ranked against the last signals: the top 80% are live-grade, the rest paper only. The rule's record is
    // its live-speed one once it has 5 replays (what a live bot would have got), else the team's.
    const scored = qualityScore(features, ls.trades >= QUALITY.ruleMinTrades ? { trades: ls.trades, winRate: ls.winRate } : this.ruleRecord(rule, now))
    const graded = probation ? { grade: 'paper' as const, tier: 'B' as const, rank: null } : this.qualityRank.grade(scored.score)
    // `all` (the owner's setting): every signal not on probation goes to live bots; the rank still sets the tier (the size).
    const ranked = this.liveSignals === 'all' && !probation ? { ...graded, grade: 'live' as const } : graded
    // Live bots trade Prime and grades proven at live speed (signals/grades.ts liveGrade).
    const forLive = this.liveGrades === 'off' ? { ok: false, why: 'live trading is paused by the platform (no new live buys)' }
      : dollarMode ? (!isDollarStrategy(strategy) ? { ok: false, why: 'live bots trade snipes and fast scalps only' } : probation ? { ok: false, why: probation.why } : { ok: true, why: null })
      : this.liveGrades === 'all' ? { ok: true, why: null }
      : this.liveGrades === 'board' ? this.boardLive(handed.grade === 'prime' ? 'precision' : strategy, handed.grade, now)
      : liveGrade(this.grades, handed.grade, now)
    const quality: SignalQuality = {
      score: scored.score, ...ranked, ...(this.liveSignals === 'proven' && ranked.grade === 'live' && !ls.ok ? { grade: 'paper' as const } : {}), parts: scored.parts,
      liveSpeed: { trades: ls.trades, winRate: ls.winRate, avgPct: ls.avgReturn === null ? null : Math.round(ls.avgReturn * 1_000) / 10, ok: ls.ok },
      level: handed.grade, levelWhy: graded2.why, review: handed.review, liveOk: forLive.ok, liveWhy: forLive.why,
    }
    reasons = [...reasons, `grade: ${handed.grade}${handed.grade !== graded2.grade ? ` (${graded2.grade} under review)` : ''}`]
    metrics.inc(`bot_signals_level_${handed.grade}`)
    reasons = [...reasons, quality.grade === 'live' ? `quality ${quality.score}: live-grade, tier ${quality.tier}`
      : ranked.grade === 'live' ? `quality ${quality.score}: paper only, ${liveWhy(ls)}`
      : `quality ${quality.score}: paper only (the lowest ${Math.round((1 - QUALITY.liveShare) * 100)}% of recent signals)`]
    metrics.inc(`bot_signals_grade_${quality.grade}`)
    const signal: Signal = {
      id: `${strategy}:${token}:${now}`, strategy, token, symbol: meta.symbol, name: meta.name, launchpad: meta.launchpad, at: now,
      price: st.priceUsd!, marketCapUsd: s.marketCapUsd, liquidityUsd: st.liquidityUsd, ageSec: Math.round(ageSec), reasons,
      safety: { verdict: r.verdict, score: r.score, checks: r.checks },
      executable: pool ? true : EXECUTABLE_CURVES.has(meta.launchpad),
      rule, features, probation, quality,
    }
    this.fired.set(`${rule === 'momentum' ? 'scalp' : rule}:${token}`, now)
    this.riskWait.delete(`${rule}:${token}`)
    this.recentSignals = [signal, ...this.recentSignals].slice(0, 500)
    this.o.store.saveSignal(signal)
    this.o.publish(['signals'], { t: 'SIGNAL', d: signal })
    metrics.inc(`bot_signals_${strategy}`)
    log.info('signal', { strategy, rule, token, symbol: meta.symbol, launchpad: meta.launchpad, price: signal.price, score: r.score })
    const fired = { status: 'signal' as const, stage, strategy, reasons }
    if (this.mode === 'off') return fired
    // Visitors' bots that follow this strategy (each with its own learned filters and sizes).
    this.o.accounts?.onSignal({ id: signal.id, token, symbol: meta.symbol, launchpad: meta.launchpad, price: signal.price, strategy, roundTripPct: r.honeypot?.roundTripLossPct ?? null, liquidityUsd: st.liquidityUsd, features, rule, probation, quality }, now, { signal, pool, meta })
    if (this.mode === 'live' && this.o.live) {
      if (probation) this.o.live.event({ kind: 'skip', text: `$${meta.symbol}: not bought live, ${probation.why}` })
      else if (quality.grade === 'paper') this.o.live.event({ kind: 'skip', text: `$${meta.symbol}: not bought live, ${ls.ok ? `quality ${quality.score} is in the lowest ${Math.round((1 - QUALITY.liveShare) * 100)}% of recent signals` : liveWhy(ls)}` })
      else if (!forLive.ok) this.o.live.event({ kind: 'skip', token, symbol: meta.symbol, text: `$${meta.symbol}: not bought live, ${forLive.why}` })
      else {
        // As visitors' live bots trade it: a Prime signal with Precision (all of it at +10%), any other with the quick
        // exits (all of it at +6%; trading/paper.ts QUICK_EXITS).
        // The dollar plan: the signal's own strategy, $2, all of it sold once it makes $1 (bot/dollarPlan.ts).
        const dollar = dollarMode && isDollarStrategy(strategy)
        const liveStrategy: Strategy = dollar ? strategy : handed.grade === 'prime' ? 'precision' : strategy
        // $2, grown in step with what the bot wallet's live trades made (bot/sizing.ts liveTradeSize); $2 flat on the dollar plan.
        const want = dollar ? DOLLAR_PLAN.sizeUsd : this.liveSize().sizeUsd
        // On the strategy board: the settings of the paper book doing best on the strategy (its exits and learned filters).
        const pick = this.liveGrades === 'board' ? this.o.accounts?.boardPick(liveStrategy, now) ?? null : null
        const exits: StrategyParams = dollar ? dollarParams(strategy as DollarStrategy, { costIn: 0, costOut: costPerSide(r.honeypot?.roundTripLossPct ?? null, want, st.liquidityUsd), sizeUsd: want })
          : pick ? boardParams(pick, want) : liveStrategy === 'precision' ? { ...this.params('precision'), sizeUsd: want } : { ...QUICK_EXITS, sizeUsd: want }
        const filtered = pick ? boardAdmits(pick, features, rule) : null
        // Visitors' bots were seated first (bot/crowd.ts): the platform's bot takes only what they left under the cap.
        const capUsd = crowdCap({ liquidityUsd: st.liquidityUsd, takeProfit: exits.tp1Multiple, flags: features.flags })
        const left = this.o.accounts ? this.o.accounts.crowd.leftover(signal.id, capUsd) : capUsd
        if (filtered) this.o.live.event({ kind: 'skip', token, symbol: meta.symbol, text: `$${meta.symbol}: not bought live, ${filtered}` })
        else if (left < 1) this.o.live.event({ kind: 'skip', token, symbol: meta.symbol, text: `$${meta.symbol}: not bought live, visitors' bots filled its crowd cap ($${capUsd.toFixed(2)})` })
        else {
          const size = Math.min(want, left)
          this.o.accounts?.crowd.take(signal.id, capUsd, size)
          void this.o.live.open(signal, liveStrategy, pool, meta, { sizeUsd: size, priceNow: () => this.priceOf(token), extra: { exits: { ...exits, sizeUsd: size }, features, rule, grade: handed.grade, ...(dollar ? { plan: 'dollar' as const, targetUsd: DOLLAR_PLAN.targetUsd } : {}) } })
        }
      }
    }
    // On the strategy board, the engine's paper book trades each signal with the platform's settings, as live bots do
    // until a paper bot does better: a Prime signal with Precision, snipes and fast scalps with the quick exits.
    const board = this.liveGrades === 'board'
    const house: Strategy = board && handed.grade === 'prime' ? 'precision' : strategy
    const allowed = canOpen(this.positions.filter(p => p.mode !== 'live'), token, now, RISK, house)
    if (!allowed.ok) { this.outcomes.add(signal.id, allowed.key ?? 'max-open', now); log.info('bot: not opening', { token, strategy: house, why: allowed.why }); return fired }
    this.outcomes.add(signal.id, 'traded', now)
    const params = board ? platformParams(house, this.params(house).sizeUsd) : this.params(strategy)
    const cost = costPerSide(r.honeypot?.roundTripLossPct ?? null, params.sizeUsd, st.liquidityUsd)
    if (this.speed) { this.pendingHouse.set(token, { signal, strategy: house, params, cost, features, rule, due: now + this.speed.entryMs }); return fired }
    this.openHouse(signal, house, params, cost, features, rule, signal.price, now)
    return fired
  }

  private openHouse(signal: Signal, strategy: Strategy, params: StrategyParams, cost: number, features: SignalFeatures, rule: SignalRule, price: number, now: number) {
    // Its exits are kept on the position (on the board they're the platform's, not the strategy's defaults).
    const p: Position = { ...openPosition({ id: `${signal.id}:paper`, strategy, token: signal.token, symbol: signal.symbol, launchpad: signal.launchpad, signalId: signal.id, price, cost, now, params }), mode: 'paper', features, rule, exits: params }
    this.positions.push(p)
    this.fills(p, [])
  }

  /** The paper book's buy of `token`, once due: at the first price 2.5s after the signal, unless it moved more than 5% by then. */
  private fillHouse(token: string, price: number | null, now: number) {
    const e = this.pendingHouse.get(token)
    if (!e || now < e.due || !this.speed) return
    if (!price) { if (now - e.due > 60_000) this.pendingHouse.delete(token); return }
    this.pendingHouse.delete(token)
    if (Math.abs(price / e.signal.price - 1) > this.speed.maxDrift) { log.info('bot: not bought (moved first)', { token, symbol: e.signal.symbol, move: price / e.signal.price - 1 }); return }
    this.openHouse(e.signal, e.strategy, e.params, e.cost, e.features, e.rule, price, now)
  }

  /**
   * Every minute: signals not yet replayed at live speed are, on their coin's
   * stored trades, a few at a time (the stored signals first, after a restart).
   */
  async replayDue(now = Date.now(), batch = 8) {
    const h = this.o.history
    if (!h || this.replaying) return
    this.replaying = true
    try {
      const due = this.recentSignals.filter(sg => (!this.liveSpeed.has(sg.id) || !this.grades.has(sg.id) || this.dollarDue(sg)) && now - sg.at >= 60_000 && now - sg.at <= LIVE_GATE.days * 86_400_000).slice(0, batch)
      for (const sg of due) {
        if (!(sg.strategy in STRATEGIES)) { this.liveSpeed.skip(sg.id); continue }
        // The exits a new bot trades with (the rule's live-speed record); a grade's record with the exits live bots trade
        // it with: Prime with Precision's, the others with the quick exits (all of it at +6%).
        const exits = toParams(defaultTuning(sg.strategy), 100, sg.strategy)
        const grade: SignalGrade = gradeOf(sg.features, sg.rule).grade
        const gradeExits: StrategyParams = grade === 'prime' ? toParams(defaultTuning('precision'), 100, 'precision') : { ...QUICK_EXITS, sizeUsd: 100 }
        const hold = Math.max(exits.maxHoldMin ?? 60, gradeExits.maxHoldMin ?? 60)
        const until = Math.min(now, sg.at + (hold + 2) * 60_000)
        const rows = await this.tradesBetween(sg.token, sg.at - 5_000, until).catch(() => null)
        if (!rows) continue
        // The dollar plan, as live bots trade it now: $2, all of it sold once it makes $1 (bot/dollarPlan.ts).
        if (this.dollarDue(sg)) {
          const c = (sg.features?.roundTripPct ?? 4) / 200
          const d = replayAtLiveSpeed(rows, { at: sg.at, price: sg.price, roundTripPct: sg.features?.roundTripPct ?? null, exits: dollarParams(sg.strategy as DollarStrategy, { costIn: c, costOut: c }), now })
          if (d.final) this.addDollar(sg, d)
        }
        const r = replayAtLiveSpeed(rows, { at: sg.at, price: sg.price, roundTripPct: sg.features?.roundTripPct ?? null, exits, now })
        if (r.final && !this.liveSpeed.has(sg.id)) {
          if (r.ret === null) this.liveSpeed.skip(sg.id)
          else this.liveSpeed.add({ signalId: sg.id, key: liveKey(sg.rule, sg.strategy), at: sg.at, ret: r.ret })
        }
        // Probation signals aren't handed out: they don't count toward a grade's record (a Core signal stored before
        // 2026-10-01 may carry its rule's probation: it counts, since Core is past it now).
        if (!this.grades.has(sg.id) && (!sg.probation || grade !== 'standard')) {
          const g = gradeExits === exits ? r : replayAtLiveSpeed(rows, { at: sg.at, price: sg.price, roundTripPct: sg.features?.roundTripPct ?? null, exits: gradeExits, now })
          if (g.final && g.ret !== null) this.grades.add(sg.id, grade, sg.at, g.ret)
          else if (g.final) this.grades.skip(sg.id)
        } else if (!this.grades.has(sg.id)) {
          // Never counted: marked done, so it doesn't stay due and fill every batch ahead of signals still to replay.
          this.grades.skip(sg.id)
        }
      }
    } finally { this.replaying = false }
  }

  /** Each grade's record at live speed (GET /v1/tiers, the Signals tab). */
  gradeRecords(now = Date.now()): GradeRecordView[] {
    const exits: Record<SignalGrade, string> = {
      prime: 'Precision: all sold at +10%, stop −10%, 10 minutes at most',
      core: 'quick: all sold at +6%, stop −7%, out after 3 minutes unless up 2%, 10 minutes at most',
      standard: 'quick: all sold at +6%, stop −7%, out after 3 minutes unless up 2%, 10 minutes at most',
    }
    const e = PRIME_RULES.early, m = PRIME_RULES.momentum
    const rules = (g: SignalGrade): string[] => g === 'standard' ? ['every other signal bots may trade (not on probation)'] : g === 'prime' ? [
      `early crowd: 20-${e.maxAgeSec}s after launch (the late crowd was taken out after DEGEN), ${e.minBuyers}+ buyers, none over ${e.maxTopBuyerPct}% of the buying, buys ${e.minBuySellRatio}× sells, up no more than ${Math.round((e.maxRunUp - 1) * 100)}%`,
      `crowd momentum: ${m.minBuyers}+ buyers in 2 minutes, buys ${m.minBuySellRatio}× sells, up ${Math.round((m.minMove - 1) * 100)}-${Math.round((m.maxMove - 1) * 100)}%, no wallet over ${m.maxLaunchTopBuyerPct}% of the buying since launch, not an early-crowd coin`,
      `liquidity $${e.minLiquidityUsd.toLocaleString('en-US')}+, round trip ≤ ${e.maxRoundTripPct}%`,
    ] : (() => {
      const r = GRADE_RULES[g]
      return [`largest buyer ≤ ${r.maxTopBuyerPct}% of the buying`, `${r.minBuyers}+ buyers`, `buys ${r.minBuySellRatio}× sells or more`, `run-up ≤ +${Math.round((r.maxRunUp - 1) * 100)}%`, `round trip ≤ ${r.maxRoundTripPct}%`, `liquidity $${r.minLiquidityUsd.toLocaleString('en-US')}+`]
    })()
    return GRADES.map(g => {
      const r = this.grades.record(g, now)
      // On the strategy board a grade doesn't decide what live bots trade (the strategy does): no live line.
      const live = this.liveGrades === 'board' || this.liveGrades === 'dollar' ? undefined : this.liveGrades !== 'off' && (this.liveGrades === 'all' || liveGrade(this.grades, g, now).ok)
      return { grade: g, trades: r.trades, wins: r.wins, winRate: r.winRate, avgPct: r.avgReturn === null ? null : Math.round(r.avgReturn * 1_000) / 10, review: r.review, exits: exits[g], rules: rules(g), live }
    })
  }

  /** A coin's stored trades between two times, oldest first (paged back from `to`). */
  private async tradesBetween(token: string, from: number, to: number) {
    const out: { ts: number; price: number; creatorSold?: boolean }[] = []
    const creator = this.o.engine.metas.get(token)?.creator?.toLowerCase() ?? null
    let before = to + 1
    for (let page = 0; page < 10; page++) {
      const got = await this.o.history!.trades(token, 500, before)
      for (const t of got) if (t.timestamp >= from && t.timestamp <= to && (t.priceUsd ?? 0) > 0) out.push({ ts: t.timestamp, price: t.priceUsd!, ...(creator && t.side === 'SELL' && t.wallet?.toLowerCase() === creator ? { creatorSold: true } : {}) })
      if (got.length < 500) break
      const oldest = Math.min(...got.map(t => t.timestamp))
      if (oldest <= from) break
      before = oldest
    }
    return out.sort((a, b) => a.ts - b.ts)
  }

  /** Every 2s: the scan rows that changed, and the scan's numbers, to the site. */
  pushScan(now = Date.now()) {
    if (this.mode === 'off') return
    this.o.publish(['scan'], { t: 'SCAN', d: { rows: this.scan.drainChanged(80), stats: this.scan.stats(now) } })
  }

  /** A strategy's exits, with the configured size. */
  params(strategy: Strategy): StrategyParams {
    const size = strategy === 'scalp' ? this.o.scalpSizeUsd : this.o.sizeUsd
    return { ...STRATEGIES[strategy], ...(size ? { sizeUsd: size } : {}) }
  }

  /** Saves a position and tells the site (the live trader calls it after each trade). */
  persist(p: Position) {
    // A closed live trade adds what it made to the bot wallet's growth (what sizes its next trades).
    if (p.mode === 'live' && p.status === 'closed' && !this.grown.has(p.id)) {
      this.grown.add(p.id)
      if (this.growth && (p.closedAt ?? 0) >= this.growth.at) {
        this.growth.pnlUsd += p.pnlUsd ?? 0
        void this.o.store.setSetting('live-growth', JSON.stringify(this.growth)).catch(e => log.warn('bot: growth not saved', { error: errMsg(e) }))
      }
    }
    this.fills(p, [null])
  }

  /** Records the bot wallet's balance as where its growth starts: on going live, or once if it's live with none recorded. */
  private startGrowth(reset: boolean, now = Date.now()) {
    const bal = this.o.live?.balance?.usd
    if (this.mode !== 'live' || bal === undefined || (this.growth && !reset)) return
    this.growth = { at: now, startUsd: bal, pnlUsd: 0 }
    void this.o.store.setSetting('live-growth', JSON.stringify(this.growth)).catch(e => log.warn('bot: growth not saved', { error: errMsg(e) }))
  }

  /** The bot wallet's next live trade: its base ($2), grown in step with what its live trades made since it went live. */
  liveSize(): LiveGrowth & { pnlUsd: number; startUsd: number | null } {
    const l = this.o.live
    if (this.mode === 'live' && !this.growth) this.startGrowth(false)
    const open = l ? l.live().filter(p => p.status === 'open').reduce((sum, p) => sum + p.sizeUsd * (p.remaining / (p.qty || 1)), 0) : 0
    const worth = l?.balance ? l.balance.usd + open : null
    const g = liveTradeSize({ startUsd: this.growth?.startUsd, pnlUsd: this.growth?.pnlUsd ?? 0, worthUsd: worth, baseUsd: l?.limits.minTradeUsd ?? LIVE_SIZE.baseUsd, maxUsd: l?.limits.maxTradeUsd })
    return { ...g, pnlUsd: this.growth?.pnlUsd ?? 0, startUsd: this.growth?.startUsd ?? null }
  }

  private fills(p: Position, fills: unknown[]) {
    if (fills.length === 0 && p.fills.length > 1) return
    this.o.store.savePosition(p)
    this.o.publish(['signals'], { t: 'BOT_POSITION', d: p })
    if (p.status === 'closed') {
      log.info('bot: position closed', { token: p.token, strategy: p.strategy, reason: p.exitReason, pnlUsd: p.pnlUsd?.toFixed(2) })
      if (p.mode !== 'live') this.o.accounts?.observe(p)
    }
  }

  // ── safety ──────────────────────────────────────────────────────────

  /** The coin's safety report; `deep` adds the probe, holders and funding (cached 2 minutes). */
  async report(token: string, deep: boolean): Promise<SafetyReport | null> {
    const meta = this.o.engine.metas.get(token)
    const st = this.o.engine.tokens.get(token)
    if (!meta || !st) return this.reports.get(token) ?? null
    const pool: PoolInfo | null = st.mainPool ? this.o.pools.get(st.mainPool) ?? null : null
    const onCurve = !pool && CURVES.has(meta.launchpad)
    const s = await this.staticsOf(token)
    const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
    const input: ScanInput = { meta, pool, liquidityUsd: st.liquidityUsd, onCurve, flow, biggerSameTicker: this.bigger(meta), creatorLaunches24h: this.creatorLaunches(meta), launchpadOnly: this.launchpadOnly }
    if (deep) {
      const d = await this.deep(token, meta, st.supply, pool, onCurve)
      input.honeypot = d.honeypot
      input.holders = d.holders
      input.clusters = d.clusters
    }
    const r = assess(s, input)
    this.reports.set(token, r)
    return r
  }

  /** Contract and hook facts, read once per coin (a few at a time). */
  private staticsOf(token: string): Promise<StaticFacts> {
    let sf = this.statics.get(token)
    if (!sf) {
      const st = this.o.engine.tokens.get(token)
      const pool = st?.mainPool ? this.o.pools.get(st.mainPool) ?? null : null
      sf = this.staticLimit.run(() => staticFacts(this.o.rpc, token, pool))
      this.statics.set(token, sf)
      sf.catch(() => this.statics.delete(token))
    }
    return sf
  }

  private deep(token: string, meta: LaunchInfo, supply: number | null, pool: PoolInfo | null, onCurve: boolean): Promise<Deep> {
    const hit = this.deeps.get(token)
    const ttl = !hit?.complete ? DEEP_TTL_INCOMPLETE_MS : Date.now() - meta.timestamp > 30 * 60_000 ? DEEP_TTL_OLD_MS : DEEP_TTL_MS
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit)
    const running = this.deepInflight.get(token)
    if (running) return running
    const job = this.deepLimit.run(() => this.deepScan(token, meta, supply, pool, onCurve)).finally(() => this.deepInflight.delete(token))
    this.deepInflight.set(token, job)
    return job
  }

  private async deepScan(token: string, meta: LaunchInfo, supply: number | null, pool: PoolInfo | null, onCurve: boolean): Promise<Deep> {
    const head = parseInt(await this.o.rpc.call<string>('eth_blockNumber', []), 16)
    const tape = this.tapes.get(token)
    const early = [...new Set(tape.filter(t => t.side === 'BUY' && t.wallet && t.wallet !== meta.creator).map(t => t.wallet!))].slice(0, 15)
    const earlyBlock = Math.max(meta.blockNumber, ...tape.filter(t => t.wallet && early.includes(t.wallet)).map(t => t.block))
    const slowProbe: HoneypotResult = { verdict: 'unknown', buyTaxPct: null, transferTaxPct: null, roundTripLossPct: null, error: 'the probe took too long' }
    const [honeypot, holders, clusters] = await Promise.all([
      !onCurve && pool ? within(probeHoneypot(this.o.rpc, pool), DEEP_BUDGET_MS.honeypot, slowProbe) : Promise.resolve(undefined),
      supply ? within(this.holders(token, meta, supply, head), DEEP_BUDGET_MS.holders, null) : Promise.resolve(null),
      early.length >= 3 ? within(clustersOf(this.o.rpc, early, meta.creator, earlyBlock), DEEP_BUDGET_MS.clusters, null) : Promise.resolve({ groups: [], creatorFunded: [], sameSourceAsCreator: [], unknown: 0 }),
    ])
    if (!clusters || !holders || honeypot?.verdict === 'unknown') metrics.inc('bot_deep_incomplete')
    const d: Deep = { at: Date.now(), honeypot, holders, clusters, complete: honeypot?.verdict !== 'unknown' && holders !== null && clusters !== null }
    this.deeps.set(token, d)
    // Insiders for the rug guard: bundled at launch, or funded from a cluster or by the creator.
    const creator = meta.creator?.toLowerCase() ?? null
    const bundled = tape.filter(t => t.side === 'BUY' && t.wallet && t.wallet !== creator && t.block <= meta.blockNumber + 2).map(t => t.wallet!)
    const funded = clusters ? [...clusters.groups.flatMap(g => g.wallets), ...clusters.creatorFunded, ...clusters.sameSourceAsCreator] : []
    this.rug.setInsiders(token, [...bundled, ...funded])
    return d
  }

  /** Holders, leaving out contracts among the largest (pools, curves, escrows, lockers). */
  private async holders(token: string, meta: LaunchInfo, supply: number, head: number): Promise<Holders | null> {
    const infra = new Set([POOL_MANAGER, meta.pool, meta.entry].filter((x): x is string => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)))
    const all = await holdersOf(token, meta.blockNumber, head, supply, meta.decimals, { exclude: infra, creator: meta.creator }).catch(() => null)
    if (!all) return null
    const top = all.top.map(h => h.address)
    const codes = await this.o.rpc.batch<string>(top.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] })))
    const contracts = new Set(top.filter((a, i) => { const c = codes[i]; return !!c && c !== '0x' && !c.startsWith('0xef0100') }))
    if (!contracts.size) return all
    const again = await holdersOf(token, meta.blockNumber, head, supply, meta.decimals, { exclude: new Set([...infra, ...contracts]), creator: meta.creator }).catch(() => null)
    return again ?? all
  }

  private bigger(meta: LaunchInfo): string[] {
    const sym = meta.symbol.trim().toLowerCase()
    if (RESERVED.has(sym)) return [`(reserved ticker $${meta.symbol})`]
    const mine = this.o.engine.tokens.get(meta.token)?.stats()
    return [...(this.bySymbol.get(sym) ?? [])].filter(t => {
      if (t === meta.token) return false
      const other = this.o.engine.metas.get(t)
      const s = this.o.engine.tokens.get(t)?.stats()
      return !!other && other.timestamp < meta.timestamp && !!s && (s.vol24 > (mine?.vol24 ?? 0) || (s.marketCapUsd ?? 0) > (mine?.marketCapUsd ?? 0))
    })
  }

  private creatorLaunches(meta: LaunchInfo): number {
    if (!meta.creator) return 0
    return (this.byCreator.get(meta.creator) ?? []).filter(ts => ts !== meta.timestamp && Math.abs(meta.timestamp - ts) <= 86_400_000).length
  }

  // ── reads (REST) ────────────────────────────────────────────────────

  signals(limit: number) { return this.recentSignals.slice(0, limit) }
  /** A rule's recent record: its last 20 closed trades across the engine's paper book and the team, one per signal, the last 14 days. */
  ruleRecord(rule: SignalRule, now = Date.now()): RuleRecord {
    const ruleOf = new Map(this.recentSignals.map(s => [s.id, s.rule]))
    const seen = new Set<string>()
    const list = [...this.positions.filter(p => p.mode !== 'live'), ...(this.o.accounts?.teamTrades() ?? [])]
      .filter(p => p.status === 'closed' && (p.rule ?? ruleOf.get(p.signalId)) === rule && now - (p.closedAt ?? 0) <= 14 * 86_400_000 && !seen.has(p.signalId) && (seen.add(p.signalId), true))
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .slice(-QUALITY.ruleWindow)
    return { trades: list.length, winRate: list.length ? list.filter(p => (p.pnlUsd ?? 0) > 0).length / list.length : null }
  }

  /** A snipe or fast-scalp signal not yet replayed on the dollar plan. */
  private dollarDue(sg: Signal) { return isDollarStrategy(sg.strategy) && !this.dollar.has(sg.id) && !this.dollarSkipped.has(sg.id) }

  /** A finished replay on the dollar plan, kept as a closed $2 position, and handed to the team live bots learn from. */
  private addDollar(sg: Signal, d: Replay) {
    if (d.ret === null) { this.dollarSkipped.add(sg.id); return }
    const size = DOLLAR_PLAN.sizeUsd
    const reason: ExitReason = d.reason === 'open' || d.reason === 'closed' ? 'time' : d.reason as ExitReason
    const p: Position = {
      id: `${sg.id}:dollar`, mode: 'paper', plan: 'dollar', strategy: sg.strategy, token: sg.token, symbol: sg.symbol, launchpad: sg.launchpad, signalId: sg.id,
      openedAt: d.openedAt ?? sg.at, marketEntry: sg.price, entryPrice: sg.price, sizeUsd: size, qty: 0, remaining: 0, cost: 0, peak: sg.price,
      tp1Done: reason === 'tp1', fills: [], status: 'closed', closedAt: d.closedAt ?? sg.at, exitReason: reason, pnlUsd: Math.round(d.ret * size * 100) / 100,
      rule: sg.rule, features: sg.features,
    }
    this.dollar.set(sg.id, p)
    this.o.accounts?.observeDollar(p)
  }

  /** A rule's trades on the dollar plan: live bots' (real fills) first, then every signal's replay, one per signal. */
  private dollarTrades(rule: SignalRule, now: number): Position[] {
    const live = this.o.accounts?.dollarLive(now) ?? []
    return [...live, ...this.positions.filter(p => p.mode === 'live' && isDollarTrade(p)), ...this.dollar.values()]
      .filter(p => p.status === 'closed' && p.rule === rule && now - (p.closedAt ?? 0) <= PROBATION.maxAgeMs)
  }

  /**
   * On the dollar plan: a rule whose last 20 trades on the plan (live bots' and the replays, one per signal) lost money
   * and won under half is on probation. Until it has 10, the paper book's record decides, as before.
   */
  dollarProbation(rule: SignalRule, now = Date.now()) {
    const list = this.dollarTrades(rule, now)
    const seen = new Set<string>()
    const n = list.filter(p => !seen.has(p.signalId) && (seen.add(p.signalId), true)).length
    if (n < PROBATION.minTrades) return this.probation(rule, now)
    return probationOf(rule, list, p => p.rule, now)
  }

  /** The dollar plan as the site shows it (GET /v1/bot/board): the exits, and each kind's record (replays and live trades). */
  dollarView(now = Date.now()): DollarPlanView {
    const week = 7 * 86_400_000
    const kinds = [['snipe', 'snipe'], ['snipe', 'scalp'], ['momentum', 'scalp']] as const
    const live = (this.o.accounts?.dollarLive(now) ?? []).concat(this.positions.filter(p => p.mode === 'live' && isDollarTrade(p)))
    return {
      sizeUsd: DOLLAR_PLAN.sizeUsd, targetUsd: DOLLAR_PLAN.targetUsd,
      exits: DOLLAR_PLAN.strategies.map(s => ({ strategy: s, stopLoss: DOLLAR_PLAN.exits[s].stopLoss, maxHoldMin: DOLLAR_PLAN.exits[s].maxHoldMin, text: dollarPlanText(s) })),
      kinds: kinds.map(([rule, strategy]) => {
        const rep = [...this.dollar.values()].filter(p => p.rule === rule && p.strategy === strategy && now - (p.closedAt ?? 0) <= week).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)).slice(-PROBATION.window)
        const mine = live.filter(p => p.status === 'closed' && p.rule === rule && p.strategy === strategy && (p.closedAt ?? 0) >= DOLLAR_PLAN.since)
        const pnl = (xs: Position[]) => Math.round(xs.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0) * 100) / 100
        return {
          rule, strategy,
          replays: { trades: rep.length, wins: rep.filter(p => (p.pnlUsd ?? 0) > 0).length, hits: rep.filter(p => p.exitReason === 'tp1').length, avgPct: rep.length ? Math.round((pnl(rep) / rep.length / DOLLAR_PLAN.sizeUsd) * 1_000) / 10 : null, pnlUsd: pnl(rep) },
          live: { trades: mine.length, wins: mine.filter(p => (p.pnlUsd ?? 0) > 0).length, hits: mine.filter(p => p.exitReason === 'tp1').length, pnlUsd: pnl(mine) },
          probation: this.dollarProbation(rule, now)?.why ?? null,
        }
      }),
    }
  }

  /** Why a rule is on probation now, or null. */
  probation(rule: SignalRule, now = Date.now()) {
    const ruleOf = new Map(this.recentSignals.map(s => [s.id, s.rule]))
    // The engine's paper book first, then the team's trades (every bot's, paper and live).
    return probationOf(rule, [...this.positions.filter(p => p.mode !== 'live'), ...(this.o.accounts?.teamTrades() ?? [])], p => p.rule ?? ruleOf.get(p.signalId), now)
  }
  async safety(token: string) { return this.reports.get(token) ?? (await this.report(token, false).catch(() => null)) }
  stats() {
    const of = (list: Position[]) => {
      const by = (s: Strategy) => stats(list.filter(p => p.strategy === s))
      return { all: stats(list), snipe: by('snipe'), secondLeg: by('second-leg'), scalp: by('scalp') }
    }
    // Top level: paper results (every signal); `live`: the bot wallet's real trades.
    // By the rule that fired it: a fast scalp from a momentum burst and one from a snipe on a risky coin read differently.
    const paper = this.positions.filter(p => p.mode !== 'live')
    const ruleOf = new Map(this.recentSignals.map(s => [s.id, s.rule]))
    const byRule = Object.fromEntries((['momentum', 'snipe', 'second-leg'] as const).map(k => [k, stats(paper.filter(p => (p.rule ?? ruleOf.get(p.signalId)) === k))]))
    const probation = Object.fromEntries((['momentum', 'snipe', 'second-leg'] as const).map(k => [k, this.probation(k)?.why ?? null]))
    const liveSpeed = this.liveSpeed.keys().map(k => this.liveSpeed.record(k))
    const routing = { liveSignals: this.liveSignals, paperSignals: this.o.accounts?.paperSignals ?? true, launchpadOnly: this.launchpadOnly }
    return { mode: this.mode, ...of(paper), byRule, probation, liveSpeed, routing, grades: this.gradeRecords(), live: of(this.positions.filter(p => p.mode === 'live')), params: { snipe: this.params('snipe'), 'second-leg': this.params('second-leg'), scalp: this.params('scalp') }, risk: RISK, rules: RULES, watching: this.paths.size }
  }

  status(): BotStatus {
    const l = this.o.live
    return {
      mode: this.mode,
      owner: this.o.owner ?? null,
      live: l ? {
        available: true, why: null, wallet: l.address, balanceUsd: l.balance?.usd ?? null, limits: l.limits,
        sizing: (({ sizeUsd, growthPct, pnlUsd, startUsd }) => ({ tradeUsd: sizeUsd, growthPct, pnlUsd, startUsd }))(this.liveSize()),
        todayPnlUsd: l.todayPnlUsd(), open: l.live().filter(p => p.status === 'open').length, events: l.events.slice(0, 40),
      } : { available: false, why: 'No bot wallet is configured on the engine (BOT_PRIVATE_KEY).', wallet: null, balanceUsd: null, limits: null, todayPnlUsd: 0, open: 0, events: [] },
    }
  }
  positionsList(status: 'open' | 'closed' | 'all', limit: number) {
    return this.positions.filter(p => status === 'all' || p.status === status).sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
  }
}
