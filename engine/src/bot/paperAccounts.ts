// Visitors' bots (owner's requests, 2026-09-30): each visitor creates a bot,
// names it and picks its strategies, deposits virtual USDC and presses
// Start. Every signal of those strategies opens a position in the bot, with
// its own exits and costs. Bots run on the engine, so they keep trading with
// the browser closed. No money is involved anywhere.
//
//   size      not the visitor's choice: each trade is the smallest amount
//             that nets the strategy's profit target at its take-profit
//             ($1–2 for a fast scalp, $1–4 otherwise; bot/sizing.ts), and
//             is sold in full there ("secure the profit and close")
//   learning  each bot has its own settings per strategy; after trades close
//             it reads the losing ones and adjusts them (bot/learner.ts),
//             saying what it changed and why
//   rugs      the rug guard's alarms (bot/rugGuard.ts) and the creator
//             selling close its positions in the coin at once
//   drain     4 losses in a row pause new trades for 30 minutes; a day's
//             loss over 10% of the deposits (between $10 and $100) stops
//             new trades until the next UTC day; an account down 50% stops
//   log       every closed trade is kept (GET /v1/paper/trades), with the
//             coin's numbers at entry and why it closed
//
// A bot is reached with a random key the browser keeps (localStorage); the
// engine stores only its SHA-256. Accounts, deposits and cash are capped.

import { createHash, randomBytes } from 'node:crypto'
import type { LearnNote, NewPaperAccount, PaperAccountView, PaperAction, PaperEvent, SignalFeatures } from '../../../api/_marketProtocol'
import { log } from '../log'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, stats, type Fill, type Position, type RiskRules, type Strategy, type StrategyParams } from '../trading/paper'
import { admits, defaultTuning, learn, relax, toParams, type Tuning } from './learner'
import type { RugAlarm } from './rugGuard'
import { SIZE_LIMITS, sizeForTarget, TARGETS } from './sizing'

export interface PaperAccount {
  id: string
  /** The name its owner gave it. */
  name: string
  createdAt: number
  running: boolean
  startedAt: number | null
  strategies: Strategy[]
  cash: number
  deposited: number
  positions: Position[]
  updatedAt: number
  /** Its own settings per strategy (bot/learner.ts). */
  tuning: Record<Strategy, Tuning>
  learnLog: LearnNote[]
  events: PaperEvent[]
  /** Signals it passed over lately, and why (kept in memory; saved with the next change). */
  skips: PaperEvent[]
  lossStreak: number
  pausedUntil: number | null
  /** Per strategy: signals its learned filters passed over since its last buy, and when it last bought. */
  filterSkips: Partial<Record<Strategy, number>>
  lastBuyAt: Partial<Record<Strategy, number>>
  /** Closed trades written to the trade log. Older rows are backfilled once (`logged`). */
  tradesLogged: number
  logged?: boolean
  /** Older rows only: the visitor's own trade size, from before sizing became automatic. Ignored. */
  tradeUsd?: number
}

export const PAPER_LIMITS = { maxAccounts: 20_000, maxDeposit: 100_000, maxCash: 1_000_000, keepClosed: 200, keepEvents: 60, keepLearn: 50, keepSkips: 20 }
/** What keeps a bot from draining its account. */
export const PROTECT = { pauseAfterLosses: 4, pauseMin: 30, stopBelowPct: 50, dailyLossPct: 10, dailyLossMinUsd: 10, dailyLossMaxUsd: 100, maxOpen: 5, maxOpenScalp: 4 }
/** A typical pool, for the size the page shows ("about $X a trade"). */
const TYPICAL = { roundTripPct: 4, liquidityUsd: 20_000 }
const STRATEGIES: Strategy[] = ['snipe', 'scalp', 'second-leg']
const LABEL: Record<Strategy, string> = { snipe: 'snipe', scalp: 'fast scalp', 'second-leg': 'second leg' }

export interface PaperAccountStore {
  paperAccounts(): Promise<PaperAccount[]>
  savePaperAccount(a: PaperAccount): void
  /** The trade log: every closed trade of a bot, kept for good. */
  savePaperTrade(accountId: string, p: Position): void
  paperTrades(accountId: string, limit: number, before?: number): Promise<Position[]>
}

export interface PaperSignal { id: string; token: string; symbol: string; launchpad: string; price: number; strategy: Strategy; roundTripPct: number | null; liquidityUsd: number | null; features?: SignalFeatures }

export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex')

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,22}[\p{L}\p{N}.]$/u
/** A bot's name: 2–24 letters, digits, spaces and . _ ' -; null if it isn't one. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const n = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  return NAME.test(n) ? n : null
}

/** A bot's risk rules: the daily loss limit follows what was deposited. */
export function riskFor(a: Pick<PaperAccount, 'deposited'>): RiskRules {
  const daily = Math.min(PROTECT.dailyLossMaxUsd, Math.max(PROTECT.dailyLossMinUsd, Math.round(a.deposited * PROTECT.dailyLossPct) / 100))
  return { maxOpen: PROTECT.maxOpen, maxOpenScalp: PROTECT.maxOpenScalp, cooldownMin: RISK.cooldownMin, cooldownMinScalp: RISK.cooldownMinScalp, dailyLossUsd: daily }
}

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const move = (m: number) => `${m >= 1 ? '+' : '−'}${Math.abs(Math.round((m - 1) * 100))}%`
const minutes = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`

/** Why a position closed, in words. */
export function closeNote(p: Position): string {
  const last = p.fills[p.fills.length - 1]
  const m = p.marketEntry > 0 && last ? last.price / p.entryPrice : 1
  const held = minutes((p.closedAt ?? p.openedAt) - p.openedAt)
  switch (p.exitReason) {
    case 'tp1': return `Took the profit at ${move(m)} after ${held}`
    case 'stop': return `Stopped out at ${move(m)} after ${held}`
    case 'time': return `Time limit: ${held} without reaching the target`
    case 'trail': return `Trailing stop after ${held}`
    case 'safety': return 'A safety re-check failed: out at once'
    case 'creator': return 'The creator sold: out at once'
    case 'rug': return 'Rug guard: out at once'
    default: return 'Closed'
  }
}

/** Fills in what older rows lack (named bots, learning and the log came later). */
function normalize(a: PaperAccount): PaperAccount {
  const tuning = { ...(a.tuning ?? {}) } as Record<Strategy, Tuning>
  for (const s of STRATEGIES) if (!tuning[s]) tuning[s] = defaultTuning(s)
  return {
    ...a,
    name: cleanName(a.name) ?? `Bot ${a.id.slice(0, 4).toUpperCase()}`,
    tuning, learnLog: a.learnLog ?? [], events: a.events ?? [], skips: a.skips ?? [],
    lossStreak: a.lossStreak ?? 0, pausedUntil: a.pausedUntil ?? null, filterSkips: a.filterSkips ?? {}, lastBuyAt: a.lastBuyAt ?? {},
    tradesLogged: a.tradesLogged ?? 0,
  }
}

export class PaperAccounts {
  private accounts = new Map<string, PaperAccount>()
  /** token → accounts with a position open in it */
  private byToken = new Map<string, Set<string>>()
  private dirty = new Set<string>()

  constructor(private o: { store: PaperAccountStore; priceOf: (token: string) => number | null; params: (s: Strategy) => StrategyParams }) {}

  async load() {
    let backfilled = 0
    for (const raw of await this.o.store.paperAccounts()) {
      const a = normalize(raw)
      this.accounts.set(a.id, a)
      this.index(a)
      // Closed trades from before the trade log: written to it once.
      if (!a.logged) {
        for (const p of a.positions) if (p.status === 'closed') { this.o.store.savePaperTrade(a.id, p); a.tradesLogged++; backfilled++ }
        a.logged = true
        this.save(a, a.updatedAt)
      }
    }
    this.flush()
    log.info('paper accounts loaded', { accounts: this.accounts.size, running: this.running, backfilled })
  }

  get count() { return this.accounts.size }
  get running() { let n = 0; for (const a of this.accounts.values()) if (a.running) n++; return n }

  /** A new bot and its key (shown once); an error in words; or null at capacity. */
  create(now = Date.now(), o: Partial<NewPaperAccount> = {}): { key: string; account: PaperAccount } | { error: string } | null {
    if (this.accounts.size >= PAPER_LIMITS.maxAccounts) return null
    const name = o.name === undefined ? null : cleanName(o.name)
    if (o.name !== undefined && !name) return { error: 'name your bot: 2–24 letters, digits or spaces' }
    const strategies = o.strategies === undefined ? ['scalp', 'snipe'] as Strategy[] : this.strategiesOf(o.strategies)
    if (!strategies.length) return { error: 'choose at least one strategy' }
    const key = randomBytes(32).toString('hex')
    const id = keyHash(key)
    const a = normalize({
      id, name: name ?? '', createdAt: now, running: false, startedAt: null, strategies, cash: 0, deposited: 0, positions: [], updatedAt: now,
      tuning: { snipe: defaultTuning('snipe'), scalp: defaultTuning('scalp'), 'second-leg': defaultTuning('second-leg') },
      learnLog: [], events: [], skips: [], lossStreak: 0, pausedUntil: null, filterSkips: {}, lastBuyAt: {}, tradesLogged: 0, logged: true,
    })
    this.event(a, { at: now, kind: 'learn', text: `${a.name} is ready: deposit virtual USDC and press Start` })
    this.accounts.set(a.id, a)
    this.save(a, now)
    return { key, account: a }
  }

  /** Whether any bot has a position open in `token` (its safety is re-checked, its rugs watched). */
  holds(token: string) { return (this.byToken.get(token)?.size ?? 0) > 0 }

  byKey(key: string | null): PaperAccount | null {
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return null
    return this.accounts.get(keyHash(key)) ?? null
  }

  private strategiesOf(list: unknown): Strategy[] {
    return [...new Set((Array.isArray(list) ? list : []).filter((s): s is Strategy => STRATEGIES.includes(s as Strategy)))]
  }

  /** Applies a visitor's action; returns why not, or null. */
  act(a: PaperAccount, x: PaperAction | { action: string; [k: string]: unknown }, now = Date.now()): string | null {
    switch (x.action) {
      case 'deposit': {
        const amt = Number((x as { amount?: unknown }).amount)
        if (!Number.isFinite(amt) || amt <= 0) return 'enter an amount above $0'
        if (amt > PAPER_LIMITS.maxDeposit) return `at most $${PAPER_LIMITS.maxDeposit.toLocaleString()} per deposit`
        if (a.cash + amt > PAPER_LIMITS.maxCash) return `a paper account holds at most $${PAPER_LIMITS.maxCash.toLocaleString()}`
        a.cash += amt; a.deposited += amt
        break
      }
      case 'start':
        if (a.cash < SIZE_LIMITS.minUsd) return 'deposit virtual USDC first'
        if (!a.strategies.length) return 'choose at least one strategy'
        a.running = true; a.startedAt = now; a.lossStreak = 0; a.pausedUntil = null
        this.event(a, { at: now, kind: 'learn', text: `Started: trading ${a.strategies.map(s => LABEL[s]).join(', ')}` })
        break
      case 'stop':
        a.running = false
        this.event(a, { at: now, kind: 'stop', text: 'Stopped by you: no new trades; open ones are still managed' })
        break
      case 'strategies': {
        const list = this.strategiesOf((x as { strategies?: unknown }).strategies)
        if (!list.length) return 'choose at least one strategy'
        a.strategies = list
        break
      }
      case 'rename': {
        const name = cleanName((x as { name?: unknown }).name)
        if (!name) return 'a name is 2–24 letters, digits or spaces'
        a.name = name
        break
      }
      case 'size': return 'the amount per trade is set automatically: each trade is the smallest that secures its profit target'
      case 'reset':
        for (const p of a.positions) if (p.status === 'open') this.byToken.get(p.token)?.delete(a.id)
        Object.assign(a, {
          running: false, startedAt: null, cash: 0, deposited: 0, positions: [],
          tuning: { snipe: defaultTuning('snipe'), scalp: defaultTuning('scalp'), 'second-leg': defaultTuning('second-leg') },
          learnLog: [], events: [], skips: [], lossStreak: 0, pausedUntil: null, filterSkips: {}, lastBuyAt: {},
        })
        this.event(a, { at: now, kind: 'learn', text: 'Reset: a fresh start (its trade log is kept)' })
        break
      default: return 'unknown action'
    }
    this.save(a, now)
    return null
  }

  /** A signal: every running bot that follows its strategy buys, if its filters, cash and risk rules allow. */
  onSignal(sig: PaperSignal, now = Date.now()) {
    for (const a of this.accounts.values()) {
      if (!a.running || !a.strategies.includes(sig.strategy)) continue
      const skip = (why: string) => {
        a.skips = [{ at: now, kind: 'skip' as const, token: sig.token, symbol: sig.symbol, text: `${LABEL[sig.strategy]}: ${why}` }, ...a.skips].slice(0, PAPER_LIMITS.keepSkips)
      }
      if (a.pausedUntil && now < a.pausedUntil) { skip(`paused after ${PROTECT.pauseAfterLosses} losses in a row`); continue }
      const t = a.tuning[sig.strategy]
      const filtered = admits(t, sig.features)
      if (filtered) { a.filterSkips[sig.strategy] = (a.filterSkips[sig.strategy] ?? 0) + 1; skip(filtered); continue }
      const sized = sizeForTarget({ targetUsd: t.targetUsd, takeProfit: t.takeProfit, roundTripPct: sig.roundTripPct, liquidityUsd: sig.liquidityUsd })
      if (!sized) { skip(`the pool is too thin to net $${t.targetUsd} at ${move(t.takeProfit)}`); continue }
      if (a.cash < sized.sizeUsd) { skip(`needs ${money(sized.sizeUsd)}, has ${money(a.cash)} in cash`); continue }
      const allowed = canOpen(a.positions, sig.token, now, riskFor(a), sig.strategy)
      if (!allowed.ok) { skip(allowed.why); continue }
      const params = toParams(t, sized.sizeUsd)
      const cost = costPerSide(sig.roundTripPct, sized.sizeUsd, sig.liquidityUsd)
      const p: Position = {
        ...openPosition({ id: `${sig.id}:${a.id.slice(0, 12)}`, strategy: sig.strategy, token: sig.token, symbol: sig.symbol, launchpad: sig.launchpad, signalId: sig.id, price: sig.price, cost, now, params }),
        mode: 'paper', exits: params, targetUsd: t.targetUsd, tuningVersion: t.version, features: sig.features,
      }
      a.cash -= sized.sizeUsd
      a.positions.push(p)
      a.lastBuyAt[sig.strategy] = now
      a.filterSkips[sig.strategy] = 0
      this.track(a, p)
      this.event(a, { at: now, kind: 'buy', token: sig.token, symbol: sig.symbol, text: `Bought $${sig.symbol} for ${money(sized.sizeUsd)} (${LABEL[sig.strategy]}): sells all at ${move(t.takeProfit)} to make about ${money(sized.profitUsd)}, stop at ${move(t.stopLoss)}` })
      this.save(a, now)
    }
  }

  /** A trade in `token`: rug alarms, the creator selling, and exits, for the bots holding it. */
  onPrice(token: string, price: number, now: number, creatorSold: boolean, priced: boolean, rug: RugAlarm | null = null) {
    const ids = this.byToken.get(token)
    if (!ids?.size) return
    for (const id of [...ids]) {
      const a = this.accounts.get(id)
      if (!a) { ids.delete(id); continue }
      for (const p of a.positions) {
        if (p.status !== 'open' || p.token !== token) continue
        const params = p.exits ?? this.o.params(p.strategy)
        const fills: Fill[] = rug ? closeNow(p, price, now, 'rug', `Rug guard: ${rug.text}`)
          : creatorSold && params.exitOnCreatorSell ? closeNow(p, price, now, 'creator')
          : priced ? onPrice(p, price, now, params) : []
        this.credit(a, p, fills, now)
      }
    }
  }

  /** Closes a coin's positions in every bot (a failed safety re-check). */
  closeToken(token: string, price: number, now: number, reason: 'safety' | 'rug', note?: string) {
    const ids = this.byToken.get(token)
    if (!ids?.size) return
    for (const id of [...ids]) {
      const a = this.accounts.get(id)
      if (!a) continue
      for (const p of a.positions) if (p.status === 'open' && p.token === token) this.credit(a, p, closeNow(p, price, now, reason, note), now)
    }
  }

  /** Every few seconds: time exits at the current price, loosening filters that block everything, and saving what changed. */
  tick(now = Date.now()) {
    for (const [token, ids] of this.byToken) {
      const price = this.o.priceOf(token)
      if (!price) continue
      for (const id of [...ids]) {
        const a = this.accounts.get(id)
        if (!a) continue
        for (const p of a.positions) if (p.status === 'open' && p.token === token) this.credit(a, p, onPrice(p, price, now, p.exits ?? this.o.params(p.strategy)), now)
      }
    }
    for (const a of this.accounts.values()) {
      if (!a.running) continue
      for (const s of a.strategies) {
        const skipped = a.filterSkips[s] ?? 0
        if (skipped < 1) continue
        const r = relax(a.tuning[s], s, skipped, a.lastBuyAt[s] ?? a.startedAt, now)
        if (r) { a.tuning[s] = r.tuning; a.filterSkips[s] = 0; this.learned(a, r.notes, now) }
      }
    }
    this.flush()
  }

  flush() {
    for (const id of this.dirty) { const a = this.accounts.get(id); if (a) this.o.store.savePaperAccount(a) }
    this.dirty.clear()
  }

  /** Every closed trade the bot has made, newest first (the trade log). */
  trades(a: PaperAccount, limit: number, before?: number) { return this.o.store.paperTrades(a.id, limit, before) }

  equity(a: PaperAccount) {
    let openValue = 0
    for (const p of a.positions) if (p.status === 'open') openValue += p.remaining * (this.o.priceOf(p.token) ?? p.marketEntry) * (1 - p.cost)
    return { equity: a.cash + openValue, openValue }
  }

  view(a: PaperAccount, now = Date.now()): PaperAccountView {
    const { equity, openValue } = this.equity(a)
    const s = stats(a.positions)
    const shown = [...a.positions.filter(p => p.status === 'open'), ...a.positions.filter(p => p.status === 'closed').sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0)).slice(0, 50)]
    const day = new Date(now).toISOString().slice(0, 10)
    const today = a.positions.filter(p => p.closedAt && new Date(p.closedAt).toISOString().slice(0, 10) === day).reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0)
    const tuning = Object.fromEntries(STRATEGIES.map(st => {
      const { prev: _prev, ...t } = a.tuning[st]
      const mine = stats(a.positions.filter(p => p.strategy === st))
      const sized = sizeForTarget({ targetUsd: t.targetUsd, takeProfit: t.takeProfit, ...TYPICAL })
      return [st, { ...t, sizeUsd: sized?.sizeUsd ?? null, closed: mine.closed, winRate: mine.winRate }]
    })) as PaperAccountView['tuning']
    return {
      id: a.id.slice(0, 8), name: a.name, running: a.running, strategies: a.strategies, cash: a.cash, deposited: a.deposited,
      equity, openValue, createdAt: a.createdAt, startedAt: a.startedAt,
      positions: shown.sort((x, y) => y.openedAt - x.openedAt),
      stats: { closed: s.closed, open: s.open, wins: s.wins, losses: s.losses, winRate: s.winRate, totalPnlUsd: s.totalPnlUsd, profitFactor: s.profitFactor === Infinity ? null : s.profitFactor, expectancyUsd: s.expectancyUsd, maxDrawdownUsd: s.maxDrawdownUsd },
      tuning,
      targets: { snipe: TARGETS.snipe.range, scalp: TARGETS.scalp.range, 'second-leg': TARGETS['second-leg'].range },
      learnLog: a.learnLog.slice(0, 30), events: a.events.slice(0, 40), skips: a.skips.slice(0, PAPER_LIMITS.keepSkips),
      protections: {
        pausedUntil: a.pausedUntil && a.pausedUntil > now ? a.pausedUntil : null, lossStreak: a.lossStreak, pauseAfterLosses: PROTECT.pauseAfterLosses,
        dailyLossLimitUsd: riskFor(a).dailyLossUsd, todayPnlUsd: today, stopBelowPct: PROTECT.stopBelowPct,
      },
      tradesLogged: a.tradesLogged,
    }
  }

  private credit(a: PaperAccount, p: Position, fills: Fill[], now: number) {
    if (!fills.length) return
    for (const f of fills) a.cash += f.usd
    if (p.status === 'closed') this.closed(a, p, now)
    this.save(a, now)
  }

  /** A position closed: the log, the loss streak, learning, and the drain guard. */
  private closed(a: PaperAccount, p: Position, now: number) {
    this.byToken.get(p.token)?.delete(a.id)
    if (!p.note) p.note = closeNote(p)
    this.o.store.savePaperTrade(a.id, p)
    a.tradesLogged++
    const won = (p.pnlUsd ?? 0) > 0
    this.event(a, { at: now, kind: p.exitReason === 'rug' ? 'rug' : 'sell', token: p.token, symbol: p.symbol, text: `Sold $${p.symbol}: ${won ? '+' : ''}${money(p.pnlUsd ?? 0)}. ${p.note}` })
    a.lossStreak = won ? 0 : a.lossStreak + 1
    if (!won && a.lossStreak >= PROTECT.pauseAfterLosses && !(a.pausedUntil && a.pausedUntil > now)) {
      a.pausedUntil = now + PROTECT.pauseMin * 60_000
      this.event(a, { at: now, kind: 'pause', text: `${a.lossStreak} losses in a row: no new trades for ${PROTECT.pauseMin} minutes while it learns from them` })
    }
    this.trim(a)
    const trades = a.positions.filter(x => x.strategy === p.strategy && x.status === 'closed').sort((x, y) => (x.closedAt ?? 0) - (y.closedAt ?? 0))
    const r = learn(a.tuning[p.strategy], p.strategy, trades, now)
    if (r) { a.tuning[p.strategy] = r.tuning; this.learned(a, r.notes, now) }
    if (a.running && a.deposited > 0) {
      const { equity } = this.equity(a)
      if (equity < a.deposited * (1 - PROTECT.stopBelowPct / 100)) {
        a.running = false
        this.event(a, { at: now, kind: 'stop', text: `Stopped: the account is down ${Math.round((1 - equity / a.deposited) * 100)}% from what was deposited. Open trades are still managed; press Start to go on.` })
      }
    }
  }

  private learned(a: PaperAccount, notes: LearnNote[], now: number) {
    a.learnLog = [...notes, ...a.learnLog].slice(0, PAPER_LIMITS.keepLearn)
    for (const n of notes) this.event(a, { at: now, kind: 'learn', text: `Learned (${LABEL[n.strategy]}, v${n.version}): ${n.text}` })
  }

  private event(a: PaperAccount, e: PaperEvent) { a.events = [e, ...a.events].slice(0, PAPER_LIMITS.keepEvents) }

  private trim(a: PaperAccount) {
    const closed = a.positions.filter(p => p.status === 'closed')
    if (closed.length <= PAPER_LIMITS.keepClosed) return
    const drop = new Set(closed.sort((x, y) => (x.closedAt ?? 0) - (y.closedAt ?? 0)).slice(0, closed.length - PAPER_LIMITS.keepClosed).map(p => p.id))
    a.positions = a.positions.filter(p => !drop.has(p.id))
  }

  private index(a: PaperAccount) { for (const p of a.positions) if (p.status === 'open') this.track(a, p) }
  private track(a: PaperAccount, p: Position) { (this.byToken.get(p.token) ?? this.byToken.set(p.token, new Set()).get(p.token)!).add(a.id) }
  private save(a: PaperAccount, now = Date.now()) { a.updatedAt = now; this.dirty.add(a.id) }
}
