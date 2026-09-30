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
import { log, errMsg } from '../log'
import type { EngineObserver, MarketEngine } from '../market/engine'
import { metrics } from '../metrics'
import { PricePath, RULES, scalpReady, secondLegReady, snipeReady, tooCostly } from '../signals/rules'
import type { BotStatus, ScanRow, SignalFeatures } from '../../../api/_marketProtocol'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, STRATEGIES, stats, type Position, type Strategy, type StrategyParams } from '../trading/paper'
import type { LiveTrader } from './liveTrader'
import type { PaperAccounts } from './paperAccounts'
import { RugWatch } from './rugGuard'
import { failing, ScanFeed, OutcomeTally } from './scanFeed'
import type { BotStore } from './store'
import type { Signal } from './types'

const WATCH_MS = 48 * 3_600_000
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
type RuleFeatures = Pick<SignalFeatures, 'buyers' | 'buySellRatio' | 'runUp' | 'topBuyerPct'>
const ratio = (buy: number, sell: number) => (sell > 0 ? Math.round((buy / sell) * 100) / 100 : null)
/** A snipe's numbers: the market's own buying, as the rule read it (Flow.organic). */
const flowFeatures = (f: Flow): RuleFeatures => ({ buyers: f.organic.buyers, buySellRatio: ratio(f.organic.buyUsd, f.organic.sellUsd), runUp: f.organic.firstPrice && f.organic.lastPrice ? f.organic.lastPrice / f.organic.firstPrice : null, topBuyerPct: f.organic.topBuyerPct })
const windowFeatures = (w: Window): RuleFeatures => ({ buyers: w.buyers, buySellRatio: ratio(w.buyUsd, w.sellUsd), runUp: w.firstPrice && w.lastPrice ? w.lastPrice / w.firstPrice : null, topBuyerPct: w.topBuyerPct })

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
  constructor(private o: { rpc: Rpc; engine: MarketEngine; pools: PoolRegistry; store: BotStore; publish: (topics: string[], msg: ServerMessage) => void; mode: BotMode; sizeUsd?: number; scalpSizeUsd?: number; live?: LiveTrader | null; owner?: string | null; accounts?: PaperAccounts | null }) {
    this.mode = o.mode === 'live' && !o.live ? 'paper' : o.mode
    o.live?.setPools(token => { const mp = this.o.engine.tokens.get(token)?.mainPool; return mp ? this.o.pools.get(mp) ?? null : null })
  }

  async start() {
    this.positions = await this.o.store.positions(30).catch(e => { log.warn('bot: could not load positions', { error: errMsg(e) }); return [] })
    this.recentSignals = await this.o.store.signals(200).catch(() => [])
    this.scan.seedSignals(this.recentSignals.map(s => s.at))
    // A scalp from a snipe on a risky coin counts as that coin's snipe; a momentum scalp as its scalp.
    for (const s of this.recentSignals) this.fired.set(`${s.rule === 'momentum' ? 'scalp' : s.strategy === 'scalp' ? 'snipe' : s.strategy}:${s.token}`, s.at)
    // The owner's last choice survives a restart (live only while a bot wallet is configured).
    const saved = await this.o.store.getSetting('mode').catch(() => null)
    if (this.mode !== 'off' && (saved === 'paper' || (saved === 'live' && this.o.live))) this.mode = saved
    if (this.o.live) void this.o.live.refreshBalance().catch(e => log.warn('live: balance read failed', { error: errMsg(e) }))
    log.info('bot started', { mode: this.mode, open: this.positions.filter(p => p.status === 'open').length, store: this.o.store.kind, wallet: this.o.live?.address ?? null })
  }

  /** The owner's switch (the signature is checked before this). */
  async setMode(mode: 'paper' | 'live'): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === 'off') return { ok: false, error: 'the bot is off on this engine (BOT_MODE=off)' }
    if (mode === 'live' && !this.o.live) return { ok: false, error: 'no bot wallet is configured (BOT_PRIVATE_KEY)' }
    this.mode = mode
    await this.o.store.setSetting('mode', mode)
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
    const held = this.positions.some(p => p.status === 'open' && p.token === t.token) || !!this.o.accounts?.holds(t.token)
    if (alarm && held) { metrics.inc('bot_rug_exits'); log.info('bot: rug guard', { token: t.token, symbol: meta.symbol, alarm: alarm.text }) }
    for (const p of this.positions) {
      if (p.status !== 'open' || p.token !== t.token || !price) continue
      if (p.mode === 'live') {
        if (alarm) this.o.live?.closeNow(p, 'rug')
        else if (priced || creatorSold) this.o.live?.onPrice(p, price, now, creatorSold)
        continue
      }
      if (alarm) this.fills(p, closeNow(p, price, now, 'rug', `Rug guard: ${alarm.text}`))
      else if (creatorSold && this.params(p.strategy).exitOnCreatorSell) this.fills(p, closeNow(p, price, now, 'creator'))
      else if (priced) this.fills(p, onPrice(p, price, now, this.params(p.strategy)))
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
      if (price) this.fills(p, onPrice(p, price, now, this.params(p.strategy)))
    }
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
      if (r?.verdict === 'fail') {
        const failed = r.checks.filter(c => c.ok === false)
        log.info('bot: closing on a safety failure', { token, failed: failed.map(c => c.id) })
        for (const p of openHere) {
          if (p.mode === 'live') this.o.live?.closeNow(p, 'safety')
          else this.fills(p, closeNow(p, st.priceUsd, now, 'safety'))
        }
        this.o.accounts?.closeToken(token, st.priceUsd, now, 'safety', `A safety re-check failed: ${failed.map(c => `${c.id} (${c.detail})`).join('; ').slice(0, 200)}`)
      }
    }
    const ageSec = (now - meta.timestamp) / 1000
    const base = { token, symbol: meta.symbol, launchpad: meta.launchpad, launchedAt: meta.timestamp, priceUsd: st.priceUsd, marketCapUsd: st.stats(now).marketCapUsd, liquidityUsd: st.liquidityUsd }
    // Snipe: once per coin, in its first minutes.
    let snipeWaiting: string[] | null = null
    /** What stops the coin, for counting (GET /v1/bot/rejections). */
    const keys: string[] = []
    if (ageSec <= RULES.snipe.maxAgeSec && !this.fired.has(`snipe:${token}`)) {
      const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
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
      const rule = scalpReady(w, ageSec, st.liquidityUsd)
      if (rule.ok) { this.scan.record(base, await this.tryFire('momentum', token, rule.reasons, ageSec, windowFeatures(w))); return }
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
    const r = await this.report(token, true)
    // A risk that isn't known yet (holders not read, funding not traced in the
    // scan's time) made a snipe a scalp, or a rebound rejected, on missing data
    // (2026-09-30). They wait for the scan now, retried every 15s, for up to
    // UNKNOWN_RISK_WAIT_MS (a snipe no later than the end of its window); after
    // that, as before. A momentum scalp never waits.
    if (r?.verdict === 'risky' && rule !== 'momentum') {
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
    }
    const signal: Signal = {
      id: `${strategy}:${token}:${now}`, strategy, token, symbol: meta.symbol, name: meta.name, launchpad: meta.launchpad, at: now,
      price: st.priceUsd!, marketCapUsd: s.marketCapUsd, liquidityUsd: st.liquidityUsd, ageSec: Math.round(ageSec), reasons,
      safety: { verdict: r.verdict, score: r.score, checks: r.checks },
      executable: pool ? true : EXECUTABLE_CURVES.has(meta.launchpad),
      rule, features,
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
    this.o.accounts?.onSignal({ id: signal.id, token, symbol: meta.symbol, launchpad: meta.launchpad, price: signal.price, strategy, roundTripPct: r.honeypot?.roundTripLossPct ?? null, liquidityUsd: st.liquidityUsd, features }, now, { signal, pool, meta })
    if (this.mode === 'live' && this.o.live) void this.o.live.open(signal, strategy, pool, meta)
    const allowed = canOpen(this.positions.filter(p => p.mode !== 'live'), token, now, RISK, strategy)
    if (!allowed.ok) { this.outcomes.add(signal.id, allowed.key ?? 'max-open', now); log.info('bot: not opening', { token, strategy, why: allowed.why }); return fired }
    this.outcomes.add(signal.id, 'traded', now)
    const params = this.params(strategy)
    const cost = costPerSide(r.honeypot?.roundTripLossPct ?? null, params.sizeUsd, st.liquidityUsd)
    const p: Position = { ...openPosition({ id: `${signal.id}:paper`, strategy, token, symbol: meta.symbol, launchpad: meta.launchpad, signalId: signal.id, price: signal.price, cost, now, params }), mode: 'paper', features, rule }
    this.positions.push(p)
    this.fills(p, [])
    return fired
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
  persist(p: Position) { this.fills(p, [null]) }

  private fills(p: Position, fills: unknown[]) {
    if (fills.length === 0 && p.fills.length > 1) return
    this.o.store.savePosition(p)
    this.o.publish(['signals'], { t: 'BOT_POSITION', d: p })
    if (p.status === 'closed') log.info('bot: position closed', { token: p.token, strategy: p.strategy, reason: p.exitReason, pnlUsd: p.pnlUsd?.toFixed(2) })
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
    const input: ScanInput = { meta, pool, liquidityUsd: st.liquidityUsd, onCurve, flow, biggerSameTicker: this.bigger(meta), creatorLaunches24h: this.creatorLaunches(meta) }
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
    return { mode: this.mode, ...of(paper), byRule, live: of(this.positions.filter(p => p.mode === 'live')), params: { snipe: this.params('snipe'), 'second-leg': this.params('second-leg'), scalp: this.params('scalp') }, risk: RISK, rules: RULES, watching: this.paths.size }
  }

  status(): BotStatus {
    const l = this.o.live
    return {
      mode: this.mode,
      owner: this.o.owner ?? null,
      live: l ? {
        available: true, why: null, wallet: l.address, balanceUsd: l.balance?.usd ?? null, limits: l.limits,
        todayPnlUsd: l.todayPnlUsd(), open: l.live().filter(p => p.status === 'open').length, events: l.events.slice(0, 40),
      } : { available: false, why: 'No bot wallet is configured on the engine (BOT_PRIVATE_KEY).', wallet: null, balanceUsd: null, limits: null, todayPnlUsd: 0, open: 0, events: [] },
    }
  }
  positionsList(status: 'open' | 'closed' | 'all', limit: number) {
    return this.positions.filter(p => status === 'all' || p.status === status).sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
  }
}
