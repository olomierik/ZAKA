// The signal and paper-trading engine. It watches every coin launched in
// the last 48 hours, from the market engine's own trades:
//
//   each trade   → the coin's tape and 1-minute price path; exits for an open
//                  position; at most every 3s, an evaluation
//   evaluation   → the snipe and second-leg rules (signals/rules.ts); a coin
//                  that meets one gets a deep safety scan (probe, holders,
//                  funding), cached 2 minutes; if every hard check passes, a
//                  signal, and in paper mode a position (trading/paper.ts).
//                  A snipe on a coin that failed only a risk check (the
//                  creator's stake, serial launches, a copycat) is a scalp:
//                  small, sold fast, out when the creator sells
//   open coins   → safety re-checked each minute: a coin that fails (turned
//                  honeypot, creator dumping, …) is closed out
//
// Signals and positions go to the store (Postgres on Railway) and to the
// `signals` WebSocket channel. Every signal opens a paper position; in live
// mode (the owner's switch, bot/liveTrader.ts) the bot wallet also trades it.

import { POOL_MANAGER } from '../../../api/_arcSwaps'
import type { LaunchInfo, ServerMessage, Trade } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { PoolInfo, PoolRegistry } from '../dex/pools'
import { clustersOf, type Clusters } from '../intel/clusters'
import { computeFlow, tapeTrade, Tapes } from '../intel/flow'
import { probeHoneypot, type HoneypotResult } from '../intel/honeypot'
import { holdersOf, type Holders } from '../intel/holders'
import { assess, staticFacts, type SafetyReport, type ScanInput, type StaticFacts } from '../intel/scanner'
import { log, errMsg } from '../log'
import type { EngineObserver, MarketEngine } from '../market/engine'
import { metrics } from '../metrics'
import { PricePath, RULES, secondLegReady, snipeReady } from '../signals/rules'
import type { BotStatus } from '../../../api/_marketProtocol'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, STRATEGIES, stats, type Position, type Strategy, type StrategyParams } from '../trading/paper'
import type { LiveTrader } from './liveTrader'
import type { BotStore } from './store'
import type { Signal } from './types'

const WATCH_MS = 48 * 3_600_000
const EVAL_EVERY_MS = 3_000
const DEEP_TTL_MS = 120_000
const RECHECK_OPEN_MS = 60_000
const SECOND_LEG_REPEAT_MS = 6 * 3_600_000
/** Launchpads whose coins trade on their own curve before graduating. */
const CURVES = new Set(['Peach', 'Faze', 'Mercuri', 'SolonPad', 'ARCDEX'])
/** Curves ARCDEX can trade today (the site's curve router): not Peach's or Faze's yet. */
const EXECUTABLE_CURVES = new Set(['Mercuri', 'SolonPad', 'ARCDEX'])
/** Tickers of coins that aren't launches: a launch using one is a copycat. */
const RESERVED = new Set(['usdc', 'usdt', 'eurc', 'eth', 'weth', 'btc', 'wbtc', 'argus', 'arcd', 'arc', 'faze', 'peach', 'virtual'])

export type BotMode = 'paper' | 'live' | 'off'

interface Deep { at: number; honeypot?: HoneypotResult; holders: Holders | null; clusters: Clusters | null }

export class Bot implements EngineObserver {
  readonly tapes = new Tapes()
  private paths = new Map<string, PricePath>()
  private statics = new Map<string, Promise<StaticFacts>>()
  private deeps = new Map<string, Deep>()
  private reports = new Map<string, SafetyReport>()
  private lastEval = new Map<string, number>()
  private evaluating = new Set<string>()
  private fired = new Map<string, number>()
  private bySymbol = new Map<string, Set<string>>()
  private byCreator = new Map<string, number[]>()
  private recentSignals: Signal[] = []
  positions: Position[] = []
  private lastRecheck = new Map<string, number>()
  private blockedOnce = new Set<string>()

  /** What it's doing now: paper, live (paper too, plus the bot wallet's trades), or off. */
  mode: BotMode

  /** `sizeUsd` sizes snipes and second legs; `scalpSizeUsd` sizes scalps. `live` is set when a bot wallet is configured. */
  constructor(private o: { rpc: Rpc; engine: MarketEngine; pools: PoolRegistry; store: BotStore; publish: (topics: string[], msg: ServerMessage) => void; mode: BotMode; sizeUsd?: number; scalpSizeUsd?: number; live?: LiveTrader | null; owner?: string | null }) {
    this.mode = o.mode === 'live' && !o.live ? 'paper' : o.mode
    o.live?.setPools(token => { const mp = this.o.engine.tokens.get(token)?.mainPool; return mp ? this.o.pools.get(mp) ?? null : null })
  }

  async start() {
    this.positions = await this.o.store.positions(30).catch(e => { log.warn('bot: could not load positions', { error: errMsg(e) }); return [] })
    this.recentSignals = await this.o.store.signals(200).catch(() => [])
    // A scalp is a snipe on a risky coin: it counts as that coin's snipe.
    for (const s of this.recentSignals) this.fired.set(`${s.strategy === 'scalp' ? 'snipe' : s.strategy}:${s.token}`, s.at)
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
    const sym = l.symbol.trim().toLowerCase()
    if (sym) this.bySymbol.set(sym, (this.bySymbol.get(sym) ?? new Set()).add(l.token))
    if (l.creator) this.byCreator.set(l.creator, [...(this.byCreator.get(l.creator) ?? []), l.timestamp].slice(-50))
  }

  onTrade(t: Trade, ctx: { replay: boolean }) {
    const meta = this.o.engine.metas.get(t.token)
    if (!meta || t.timestamp - meta.timestamp > WATCH_MS) return
    // Only the main pool's trades are the coin's price (a side pool's trade is
    // still a real buyer or seller). Paper stops fired on a side pool's price once.
    const mainPool = this.o.engine.tokens.get(t.token)?.mainPool
    const priced = !mainPool || t.pool === mainPool
    this.tapes.add(t.token, { ...tapeTrade(t), price: priced ? t.priceUsd : null })
    let path = this.paths.get(t.token)
    if (!path) { path = new PricePath(meta.timestamp); this.paths.set(t.token, path) }
    if (priced) path.add(t.timestamp, t.priceUsd, t.side, t.usdValue ?? 0)
    if (ctx.replay || this.mode === 'off') return
    const now = Date.now()
    // The creator selling, in any pool, closes a scalp at the coin's price after the sale.
    const creatorSold = t.side === 'SELL' && !!meta.creator && t.wallet?.toLowerCase() === meta.creator.toLowerCase()
    const price = this.o.engine.tokens.get(t.token)?.priceUsd ?? null
    for (const p of this.positions) {
      if (p.status !== 'open' || p.token !== t.token || !price) continue
      if (p.mode === 'live') { if (priced || creatorSold) this.o.live?.onPrice(p, price, now, creatorSold); continue }
      if (creatorSold && this.params(p.strategy).exitOnCreatorSell) this.fills(p, closeNow(p, price, now, 'creator'))
      else if (priced) this.fills(p, onPrice(p, price, now, this.params(p.strategy)))
    }
    if (!priced) return
    if (now - (this.lastEval.get(t.token) ?? 0) >= EVAL_EVERY_MS && !this.evaluating.has(t.token)) {
      this.lastEval.set(t.token, now)
      this.evaluating.add(t.token)
      void this.evaluate(t.token).catch(e => log.debug('bot: evaluation failed', { token: t.token, error: errMsg(e) })).finally(() => this.evaluating.delete(t.token))
    }
  }

  /** Every 15s: time stops, safety re-checks for open coins, forgetting old coins. */
  tick(now = Date.now()) {
    if (this.mode === 'off') return
    for (const p of this.positions) {
      if (p.status !== 'open' || p.mode === 'live') continue
      const price = this.o.engine.tokens.get(p.token)?.priceUsd
      if (price) this.fills(p, onPrice(p, price, now, this.params(p.strategy)))
    }
    this.o.live?.tick(now, token => this.o.engine.tokens.get(token)?.priceUsd ?? null)
    for (const [token, path] of this.paths) {
      if (now - path.launchedAt > WATCH_MS && !this.positions.some(p => p.status === 'open' && p.token === token)) {
        this.paths.delete(token); this.tapes.drop(token); this.deeps.delete(token); this.reports.delete(token); this.statics.delete(token); this.lastEval.delete(token)
      }
    }
    metrics.set('bot_watched', this.paths.size)
  }

  // ── evaluation ──────────────────────────────────────────────────────

  private async evaluate(token: string) {
    const meta = this.o.engine.metas.get(token)
    const st = this.o.engine.tokens.get(token)
    if (!meta || !st?.priceUsd) return
    const now = Date.now()
    const open = this.positions.filter(p => p.status === 'open' && p.token === token)
    if (open.length && now - (this.lastRecheck.get(token) ?? 0) >= RECHECK_OPEN_MS) {
      this.lastRecheck.set(token, now)
      const r = await this.report(token, true)
      if (r?.verdict === 'fail') {
        log.info('bot: closing on a safety failure', { token, failed: r.checks.filter(c => c.ok === false).map(c => c.id) })
        for (const p of open) {
          if (p.mode === 'live') this.o.live?.closeNow(p, 'safety')
          else this.fills(p, closeNow(p, st.priceUsd, now, 'safety'))
        }
      }
    }
    const ageSec = (now - meta.timestamp) / 1000
    // Snipe: once per coin, in its first minutes.
    if (ageSec <= RULES.snipe.maxAgeSec && !this.fired.has(`snipe:${token}`)) {
      const flow = computeFlow(this.tapes.get(token), { launchBlock: meta.blockNumber, creator: meta.creator, supply: st.supply })
      const rule = snipeReady(flow, ageSec)
      if (rule.ok) await this.tryFire('snipe', token, rule.reasons, ageSec)
    }
    // Second leg: a coin that ran 10×, fell and is coming back.
    const path = this.paths.get(token)
    const lastLeg = this.fired.get(`second-leg:${token}`) ?? 0
    if (path && now - lastLeg >= SECOND_LEG_REPEAT_MS) {
      const rule = secondLegReady(path, now)
      if (rule.ok) await this.tryFire('second-leg', token, rule.reasons, ageSec)
    }
  }

  private async tryFire(rule: 'snipe' | 'second-leg', token: string, reasons: string[], ageSec: number) {
    const r = await this.report(token, true)
    // A snipe on a coin that failed only a risk check is a scalp: small, sold fast.
    const strategy: Strategy | null = r?.verdict === 'pass' ? rule : r?.verdict === 'risky' && rule === 'snipe' ? 'scalp' : null
    if (!r || !strategy) {
      metrics.inc(`bot_${rule}_blocked_${r?.verdict ?? 'unknown'}`)
      // Which checks stop candidates (tuning): counted once per coin.
      const key = `${rule}:${token}`
      if (r && !this.blockedOnce.has(key)) {
        this.blockedOnce.add(key)
        const stopping = r.checks.filter(c => (c.hard || (c.risk && rule === 'second-leg')) && c.ok !== true)
        for (const c of stopping) metrics.inc(`bot_block_${c.ok === false ? 'fail' : 'pending'}_${c.id}`)
        log.info('bot: candidate blocked', { strategy: rule, token, verdict: r.verdict, checks: stopping.map(c => `${c.id}: ${c.detail}`) })
      }
      return
    }
    if (strategy === 'scalp') reasons = [...reasons, ...r.checks.filter(c => c.risk && c.ok !== true).map(c => `risk (${c.id}): ${c.detail}`)]
    const meta = this.o.engine.metas.get(token)!, st = this.o.engine.tokens.get(token)!
    const now = Date.now()
    const pool = st.mainPool ? this.o.pools.get(st.mainPool) ?? null : null
    const s = st.stats(now)
    const signal: Signal = {
      id: `${strategy}:${token}:${now}`, strategy, token, symbol: meta.symbol, name: meta.name, launchpad: meta.launchpad, at: now,
      price: st.priceUsd!, marketCapUsd: s.marketCapUsd, liquidityUsd: st.liquidityUsd, ageSec: Math.round(ageSec), reasons,
      safety: { verdict: r.verdict, score: r.score, checks: r.checks },
      executable: pool ? true : EXECUTABLE_CURVES.has(meta.launchpad),
    }
    this.fired.set(`${rule}:${token}`, now)
    this.recentSignals = [signal, ...this.recentSignals].slice(0, 500)
    this.o.store.saveSignal(signal)
    this.o.publish(['signals'], { t: 'SIGNAL', d: signal })
    metrics.inc(`bot_signals_${strategy}`)
    log.info('signal', { strategy, token, symbol: meta.symbol, launchpad: meta.launchpad, price: signal.price, score: r.score })
    if (this.mode === 'off') return
    if (this.mode === 'live' && this.o.live) void this.o.live.open(signal, strategy, pool, meta)
    const allowed = canOpen(this.positions.filter(p => p.mode !== 'live'), token, now, RISK, strategy)
    if (!allowed.ok) { log.info('bot: not opening', { token, strategy, why: allowed.why }); return }
    const params = this.params(strategy)
    const cost = costPerSide(r.honeypot?.roundTripLossPct ?? null, params.sizeUsd, st.liquidityUsd)
    const p: Position = { ...openPosition({ id: `${signal.id}:paper`, strategy, token, symbol: meta.symbol, launchpad: meta.launchpad, signalId: signal.id, price: signal.price, cost, now, params }), mode: 'paper' }
    this.positions.push(p)
    this.fills(p, [])
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
    let sf = this.statics.get(token)
    if (!sf) {
      sf = staticFacts(this.o.rpc, token, pool)
      this.statics.set(token, sf)
      sf.catch(() => this.statics.delete(token))
    }
    const s = await sf
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

  private async deep(token: string, meta: LaunchInfo, supply: number | null, pool: PoolInfo | null, onCurve: boolean): Promise<Deep> {
    const hit = this.deeps.get(token)
    if (hit && Date.now() - hit.at < DEEP_TTL_MS) return hit
    const head = parseInt(await this.o.rpc.call<string>('eth_blockNumber', []), 16)
    const tape = this.tapes.get(token)
    const early = [...new Set(tape.filter(t => t.side === 'BUY' && t.wallet && t.wallet !== meta.creator).map(t => t.wallet!))].slice(0, 15)
    const earlyBlock = Math.max(meta.blockNumber, ...tape.filter(t => t.wallet && early.includes(t.wallet)).map(t => t.block))
    const [honeypot, holders, clusters] = await Promise.all([
      !onCurve && pool ? probeHoneypot(this.o.rpc, pool) : Promise.resolve(undefined),
      supply ? this.holders(token, meta, supply, head) : Promise.resolve(null),
      early.length >= 3 ? clustersOf(this.o.rpc, early, meta.creator, earlyBlock).catch(() => null) : Promise.resolve({ groups: [], creatorFunded: [], sameSourceAsCreator: [], unknown: 0 }),
    ])
    const d: Deep = { at: Date.now(), honeypot, holders, clusters }
    this.deeps.set(token, d)
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
    return { mode: this.mode, ...of(this.positions.filter(p => p.mode !== 'live')), live: of(this.positions.filter(p => p.mode === 'live')), params: { snipe: this.params('snipe'), 'second-leg': this.params('second-leg'), scalp: this.params('scalp') }, risk: RISK, rules: RULES, watching: this.paths.size }
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
