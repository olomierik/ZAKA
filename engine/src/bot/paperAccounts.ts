// Visitors' bots (owner's requests, 2026-09-30): each visitor signs up
// (bot/users.ts), creates bots, gives each a name that is its unique id on
// the platform, picks its strategies, deposits virtual USDC and presses
// Start. Every signal of those strategies opens a position in the bot, with
// its own exits and costs. Bots run on the engine, so they keep trading with
// every device off; the owner signs in from anywhere to see them.
//
//   name      unique across the platform (its slug: "Night Owl" → night-owl),
//             the bot's public id in the marketplace (/bots/night-owl)
//   size      not the visitor's choice: each trade is the smallest amount
//             that nets the strategy's profit target at its take-profit
//             ($1–2 for a fast scalp, $1–5 otherwise; bot/sizing.ts), and
//             is sold in full there ("secure the profit and close"). Never
//             more than 20% of what the bot is worth (paper: cash plus open
//             trades; live: its wallet, read again before each buy): a small
//             bot trades smaller and aims for less
//   learning  each bot has its own settings per strategy; after trades close
//             it reads the losing ones and adjusts them (bot/learner.ts)
//   live      once its paper record is good enough, its owner can switch the
//             same bot to live: its own wallet trades real USDC
//             (bot/userLive.ts)
//   fee       2% of a winning trade's profit goes to the platform (live: sent
//             to the fee wallet; paper: taken virtually); losses pay nothing
//   rugs      the rug guard's alarms (bot/rugGuard.ts) and the creator
//             selling close its positions in the coin at once
//   drain     4 losses in a row pause new trades for 30 minutes; a day's
//             loss over 10% of the deposits (between $10 and $100) stops
//             new trades until the next UTC day; an account down 50% stops
//             (live: back to paper)
//   log       every closed trade is kept (the trade log), with the coin's
//             numbers at entry and why it closed
//
// Older bots were reached with a random key the browser keeps; the engine
// stores only its SHA-256. A signed-in owner claims such a bot into their
// account. Accounts, deposits and cash are capped.

import { createHash, randomBytes } from 'node:crypto'
import type { Address } from 'viem'
import type { LaunchInfo, LearnNote, MarketBot, MarketBotDetail, NewPaperAccount, PaperAccountView, PaperAction, PaperEvent, SignalFeatures } from '../../../api/_marketProtocol'
import type { PoolInfo } from '../dex/pools'
import { errMsg, log } from '../log'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, stats, type Fill, type Position, type RiskRules, type Strategy, type StrategyParams } from '../trading/paper'
import { admits, defaultTuning, learn, relax, toParams, type Tuning } from './learner'
import type { LiveTrader } from './liveTrader'
import type { RugAlarm } from './rugGuard'
import { maxTradeFor, noSizeWhy, SIZE_LIMITS, sizeForTrade, TARGETS } from './sizing'
import type { Signal } from './types'
import { OutcomeTally } from './scanFeed'
import { profitFee, readiness, USER_LIVE, type BotWallet, type UserLive } from './userLive'

export interface PaperAccount {
  id: string
  /** The name its owner gave it: unique on the platform (by its slug). */
  name: string
  slug: string
  /** The signed-in owner (bot/users.ts); null for a bot reached only by its browser key. */
  ownerId: string | null
  createdAt: number
  running: boolean
  startedAt: number | null
  strategies: Strategy[]
  /** paper: virtual USDC; live: its own wallet trades real USDC. */
  mode: 'paper' | 'live'
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
  /** The platform's 2% of paper wins (virtual). */
  feesPaidUsd: number
  /** Its live wallet, once the owner made one. */
  live?: BotWallet | null
  /** Older rows only: the visitor's own trade size, from before sizing became automatic. Ignored. */
  tradeUsd?: number
}

export const PAPER_LIMITS = { maxAccounts: 20_000, maxDeposit: 100_000, maxCash: 1_000_000, keepClosed: 200, keepEvents: 60, keepLearn: 50, keepSkips: 20, maxPerOwner: 5 }
/** What keeps a bot from draining its account. */
export const PROTECT = { pauseAfterLosses: 4, pauseMin: 30, stopBelowPct: 50, dailyLossPct: 10, dailyLossMinUsd: 10, dailyLossMaxUsd: 100, maxOpen: 5, maxOpenScalp: 4 }
/** A typical pool, for the size the page shows ("about $X a trade"). */
const TYPICAL = { roundTripPct: 4, liquidityUsd: 20_000 }
const STRATEGIES: Strategy[] = ['snipe', 'scalp', 'second-leg']
const LABEL: Record<Strategy, string> = { snipe: 'snipe', scalp: 'fast scalp', 'second-leg': 'second leg' }

export interface PaperAccountStore {
  paperAccounts(): Promise<PaperAccount[]>
  savePaperAccount(a: PaperAccount): void
  /** The trade log: every closed trade of a bot, kept for good (saved again when a live fee is sent). */
  savePaperTrade(accountId: string, p: Position): void
  paperTrades(accountId: string, limit: number, before?: number): Promise<Position[]>
}

export interface PaperSignal { id: string; token: string; symbol: string; launchpad: string; price: number; strategy: Strategy; roundTripPct: number | null; liquidityUsd: number | null; features?: SignalFeatures }
/** What a live bot needs to trade a signal: the signal itself, the coin's pool and its launch. */
export interface LiveContext { signal: Signal; pool: PoolInfo | null; meta: LaunchInfo }

export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex')

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,22}[\p{L}\p{N}.]$/u
/** A bot's name: 2–24 letters, digits, spaces and . _ ' -; null if it isn't one. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const n = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  return NAME.test(n) ? n : null
}
/** A name's unique id: lower case, anything but letters and digits → one dash. */
export const slugOf = (name: string) => name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')

/** A bot's risk rules: the daily loss limit follows what was deposited. */
export function riskFor(a: Pick<PaperAccount, 'deposited'>): RiskRules {
  const daily = Math.min(PROTECT.dailyLossMaxUsd, Math.max(PROTECT.dailyLossMinUsd, Math.round(a.deposited * PROTECT.dailyLossPct) / 100))
  return { maxOpen: PROTECT.maxOpen, maxOpenScalp: PROTECT.maxOpenScalp, cooldownMin: RISK.cooldownMin, cooldownMinScalp: RISK.cooldownMinScalp, dailyLossUsd: daily }
}

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const move = (m: number) => `${m >= 1 ? '+' : '−'}${Math.abs(Math.round((m - 1) * 100))}%`
const minutes = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`
const isLive = (p: Position) => p.mode === 'live'

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
    case 'manual': return 'Sold on the owner\'s order'
    default: return 'Closed'
  }
}

/** Fills in what older rows lack (named bots, owners, learning, the log and live came later). */
function normalize(a: PaperAccount): PaperAccount {
  const tuning = { ...(a.tuning ?? {}) } as Record<Strategy, Tuning>
  for (const s of STRATEGIES) if (!tuning[s]) tuning[s] = defaultTuning(s)
  const name = cleanName(a.name) ?? `Bot ${a.id.slice(0, 4).toUpperCase()}`
  return {
    ...a,
    name, slug: a.slug || slugOf(name), ownerId: a.ownerId ?? null, mode: a.mode === 'live' ? 'live' : 'paper',
    tuning, learnLog: a.learnLog ?? [], events: a.events ?? [], skips: a.skips ?? [],
    lossStreak: a.lossStreak ?? 0, pausedUntil: a.pausedUntil ?? null, filterSkips: a.filterSkips ?? {}, lastBuyAt: a.lastBuyAt ?? {},
    tradesLogged: a.tradesLogged ?? 0, feesPaidUsd: a.feesPaidUsd ?? 0, live: a.live ?? null,
  }
}

export class PaperAccounts {
  private accounts = new Map<string, PaperAccount>()
  private bySlug = new Map<string, string>()
  /** token → accounts with a position open in it */
  private byToken = new Map<string, Set<string>>()
  private dirty = new Set<string>()
  /** What became of each signal across every bot (GET /v1/bot/rejections). */
  readonly outcomes = new OutcomeTally()
  /** Live positions already settled (fee, log, learning) after closing. */
  private settled = new Set<string>()
  private lastFeeTry = new Map<string, number>()

  constructor(private o: { store: PaperAccountStore; priceOf: (token: string) => number | null; params: (s: Strategy) => StrategyParams; live?: UserLive | null }) {}

  async load() {
    let backfilled = 0
    for (const raw of await this.o.store.paperAccounts()) {
      const a = normalize(raw)
      // Names from before they had to be unique: the later bot gets a number.
      let slug = a.slug, n = 2
      while (this.bySlug.has(slug)) { a.name = `${a.name.slice(0, 20)} ${n}`; slug = slugOf(a.name); n++ }
      a.slug = slug
      this.accounts.set(a.id, a)
      this.bySlug.set(a.slug, a.id)
      this.index(a)
      for (const p of a.positions) if (p.status === 'closed') this.settled.add(p.id)
      if (!a.logged) {
        for (const p of a.positions) if (p.status === 'closed') { this.o.store.savePaperTrade(a.id, p); a.tradesLogged++; backfilled++ }
        a.logged = true
        this.save(a, a.updatedAt)
      }
    }
    this.flush()
    log.info('paper accounts loaded', { accounts: this.accounts.size, running: this.running, live: [...this.accounts.values()].filter(a => a.mode === 'live').length, backfilled })
  }

  get count() { return this.accounts.size }
  get running() { let n = 0; for (const a of this.accounts.values()) if (a.running) n++; return n }

  /** A new bot and its browser key (shown once); an error in words; or null at capacity. `ownerId`: a signed-in owner's. */
  create(now = Date.now(), o: Partial<NewPaperAccount> = {}, ownerId: string | null = null): { key: string; account: PaperAccount } | { error: string } | null {
    if (this.accounts.size >= PAPER_LIMITS.maxAccounts) return null
    const name = o.name === undefined ? null : cleanName(o.name)
    if (o.name !== undefined && !name) return { error: 'name your bot: 2–24 letters, digits or spaces' }
    if (name && this.bySlug.has(slugOf(name))) return { error: `the name "${name}" is taken: every bot's name is its own` }
    if (ownerId && this.ofOwner(ownerId).length >= PAPER_LIMITS.maxPerOwner) return { error: `an account can have ${PAPER_LIMITS.maxPerOwner} bots` }
    const strategies = o.strategies === undefined ? ['scalp', 'snipe'] as Strategy[] : this.strategiesOf(o.strategies)
    if (!strategies.length) return { error: 'choose at least one strategy' }
    const key = randomBytes(32).toString('hex')
    const id = keyHash(key)
    let fallback = `Bot ${id.slice(0, 4).toUpperCase()}`
    for (let i = 2; !name && this.bySlug.has(slugOf(fallback)); i++) fallback = `Bot ${id.slice(0, 4).toUpperCase()} ${i}`
    const a = normalize({
      id, name: name ?? fallback, slug: '', ownerId, createdAt: now, running: false, startedAt: null, strategies, mode: 'paper', cash: 0, deposited: 0, positions: [], updatedAt: now,
      tuning: { snipe: defaultTuning('snipe'), scalp: defaultTuning('scalp'), 'second-leg': defaultTuning('second-leg') },
      learnLog: [], events: [], skips: [], lossStreak: 0, pausedUntil: null, filterSkips: {}, lastBuyAt: {}, tradesLogged: 0, logged: true, feesPaidUsd: 0, live: null,
    })
    this.event(a, { at: now, kind: 'learn', text: `${a.name} is ready: deposit virtual USDC and press Start` })
    this.accounts.set(a.id, a)
    this.bySlug.set(a.slug, a.id)
    this.save(a, now)
    return { key, account: a }
  }

  byKey(key: string | null): PaperAccount | null {
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return null
    return this.accounts.get(keyHash(key)) ?? null
  }
  bySlugOf(slug: string): PaperAccount | null { const id = this.bySlug.get(slug.toLowerCase()); return id ? this.accounts.get(id) ?? null : null }
  ofOwner(ownerId: string): PaperAccount[] { return [...this.accounts.values()].filter(a => a.ownerId === ownerId).sort((x, y) => x.createdAt - y.createdAt) }
  /** The owner's bot by its slug, or null. */
  owned(ownerId: string, slug: string): PaperAccount | null { const a = this.bySlugOf(slug); return a && a.ownerId === ownerId ? a : null }

  /** A bot reached by its browser key joins a signed-in owner's account. */
  claim(key: string | null, ownerId: string, now = Date.now()): PaperAccount | string {
    const a = this.byKey(key)
    if (!a) return 'no bot for this key'
    if (a.ownerId && a.ownerId !== ownerId) return 'this bot belongs to another account'
    if (!a.ownerId && this.ofOwner(ownerId).length >= PAPER_LIMITS.maxPerOwner) return `an account can have ${PAPER_LIMITS.maxPerOwner} bots`
    a.ownerId = ownerId
    this.save(a, now)
    return a
  }

  /** Whether any bot has a position open in `token` (its safety is re-checked, its rugs watched). */
  holds(token: string) { return (this.byToken.get(token)?.size ?? 0) > 0 }

  private strategiesOf(list: unknown): Strategy[] {
    return [...new Set((Array.isArray(list) ? list : []).filter((s): s is Strategy => STRATEGIES.includes(s as Strategy)))]
  }

  /** Applies an action that needs nothing from the chain; returns why not, or null. Live actions: setMode, createWallet, sellLive. */
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
        if (a.mode === 'paper' && a.cash < SIZE_LIMITS.minUsd) return 'deposit virtual USDC first'
        if (!a.strategies.length) return 'choose at least one strategy'
        a.running = true; a.startedAt = now; a.lossStreak = 0; a.pausedUntil = null
        this.event(a, { at: now, kind: 'learn', text: `Started${a.mode === 'live' ? ' LIVE' : ''}: trading ${a.strategies.map(s => LABEL[s]).join(', ')}` })
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
        const slug = slugOf(name)
        const other = this.bySlug.get(slug)
        if (other && other !== a.id) return `the name "${name}" is taken: every bot's name is its own`
        this.bySlug.delete(a.slug)
        a.name = name; a.slug = slug
        this.bySlug.set(slug, a.id)
        break
      }
      case 'size': return 'the amount per trade is set automatically: each trade is the smallest that secures its profit target'
      case 'reset':
        if (a.positions.some(p => isLive(p) && p.status === 'open')) return 'sell its live positions first'
        if (a.mode === 'live') return 'switch it back to paper first'
        for (const p of a.positions) if (p.status === 'open') this.byToken.get(p.token)?.delete(a.id)
        Object.assign(a, {
          running: false, startedAt: null, cash: 0, deposited: 0, positions: [],
          tuning: { snipe: defaultTuning('snipe'), scalp: defaultTuning('scalp'), 'second-leg': defaultTuning('second-leg') },
          learnLog: [], events: [], skips: [], lossStreak: 0, pausedUntil: null, filterSkips: {}, lastBuyAt: {},
        })
        this.event(a, { at: now, kind: 'learn', text: 'Reset: a fresh start (its trade log and live wallet are kept)' })
        break
      default: return 'unknown action'
    }
    this.save(a, now)
    return null
  }

  // ── live ─────────────────────────────────────────────────────────────

  private trader(a: PaperAccount): LiveTrader | null {
    if (!this.o.live || !a.live) return null
    return this.o.live.trader(a.id, a.live, { positions: () => a.positions, params: s => this.o.params(s), save: p => this.liveSaved(a, p) })
  }

  get liveAvailable(): { ok: boolean; why: string | null } { return this.o.live?.available ?? { ok: false, why: 'live trading isn\'t available on this engine' } }

  /** Reads a live bot's wallet balance (cached 15s), so its view is current. */
  async refreshLive(a: PaperAccount) { if (a.live && this.o.live) await this.o.live.balance(a.id, this.trader(a)) }

  /** The owner makes the bot's live wallet (once). */
  createWallet(a: PaperAccount, now = Date.now()): string | null {
    if (!this.o.live) return 'live trading isn\'t available on this engine'
    if (!a.ownerId) return 'sign in: a live bot belongs to an account'
    if (a.live) return null
    const w = this.o.live.createWallet(a.id, now)
    if (typeof w === 'string') return w
    a.live = w
    this.event(a, { at: now, kind: 'learn', text: `Live wallet made: ${w.address}. Send it USDC on Arc to trade live.` })
    this.save(a, now)
    this.flush()
    return null
  }

  /** Paper ↔ live for the same bot. Live needs a signed-in owner with a verified email, a good paper record and a funded wallet. */
  async setMode(a: PaperAccount, mode: 'paper' | 'live', owner: { verified: boolean } | null, now = Date.now()): Promise<string | null> {
    if (mode === 'paper') {
      if (a.mode === 'paper') return null
      a.mode = 'paper'
      this.event(a, { at: now, kind: 'learn', text: 'Back to paper: no new live trades; open live trades are still managed' })
      this.save(a, now)
      return null
    }
    if (a.mode === 'live') return null
    const av = this.o.live?.available ?? { ok: false, why: 'live trading isn\'t available on this engine' }
    if (!av.ok) return av.why
    if (!owner || !a.ownerId) return 'sign in: a live bot belongs to an account'
    if (!owner.verified) return 'verify your email first: it confirms every withdrawal from the bot\'s wallet'
    const r = readiness(a.positions)
    if (!r.ok) return `not ready yet: it needs ${r.need.minTrades}+ closed paper trades (has ${r.trades}), a ${Math.round(r.need.minWinRate * 100)}%+ win rate (${r.winRate === null ? '—' : `${Math.round(r.winRate * 100)}%`}), a profit factor of ${r.need.minProfitFactor}+ (${r.profitFactor === null ? '—' : r.profitFactor.toFixed(2)}) and a net profit (${money(r.pnlUsd)})`
    if (!a.live) return 'make its live wallet first, then send it USDC on Arc'
    const t = this.trader(a)
    const bal = await this.o.live!.balance(a.id, t, true)
    if (bal === null) return 'the wallet\'s balance couldn\'t be read; try again'
    if (bal < USER_LIVE.minBalanceUsd) return `send at least $${USER_LIVE.minBalanceUsd} of USDC on Arc to ${a.live.address} (it has ${money(bal)})`
    a.mode = 'live'
    a.live.since = now
    a.live.startBalanceUsd = bal
    this.event(a, { at: now, kind: 'learn', text: `LIVE: trading real USDC from ${a.live.address} (${money(bal)}), trades up to $${USER_LIVE.maxTradeUsd}` })
    this.save(a, now)
    this.flush()
    return null
  }

  /** Sells every open live position now. */
  sellLive(a: PaperAccount, now = Date.now()): number {
    const t = this.trader(a)
    const open = a.positions.filter(p => isLive(p) && p.status === 'open')
    for (const p of open) t?.closeNow(p, 'manual')
    if (open.length) this.event(a, { at: now, kind: 'sell', text: `Selling all ${open.length} live position(s) on your order` })
    this.save(a, now)
    return open.length
  }

  /** What can be withdrawn now: the wallet's USDC less gas, fees not sent yet and, while trades are open, the reserve their sales need. */
  async withdrawable(a: PaperAccount): Promise<number | null> {
    if (!a.live || !this.o.live) return null
    const bal = await this.o.live.balance(a.id, this.trader(a), true)
    if (bal === null) return null
    const open = a.positions.some(p => isLive(p) && p.status === 'open')
    const owed = a.positions.reduce((s, p) => s + (p.feeDue ?? 0), 0)
    return Math.max(0, Math.floor((bal - (open ? USER_LIVE.reserveUsd : USER_LIVE.reserveUsd / 5) - owed) * 100) / 100)
  }

  /** Sends USDC from the bot's wallet (the owner confirmed it by email). */
  async withdraw(a: PaperAccount, to: Address, usd: number, now = Date.now()): Promise<{ hash: string } | { error: string }> {
    const t = this.trader(a)
    if (!t || !this.o.live) return { error: 'this bot has no live wallet' }
    const max = await this.withdrawable(a)
    if (max === null) return { error: 'the wallet\'s balance couldn\'t be read; try again' }
    if (!(usd > 0) || usd > max) return { error: `at most ${money(max)} can be withdrawn now` }
    try {
      const r = await this.o.live.withdraw(a.id, t, to, usd)
      this.event(a, { at: now, kind: 'stop', text: `Withdrew ${money(usd)} to ${to}` })
      this.save(a, now)
      this.flush()
      return r
    } catch (e) { return { error: `the withdrawal failed: ${errMsg(e).slice(0, 160)}` } }
  }

  /** The live trader saved a position: track it, and settle it once it's closed. */
  private liveSaved(a: PaperAccount, p: Position) {
    const now = Date.now()
    if (p.status === 'open') this.track(a, p)
    if (p.status === 'closed' && !this.settled.has(p.id)) {
      this.settled.add(p.id)
      const fee = profitFee(p.pnlUsd)
      if (fee > 0) { p.feeUsd = fee; p.feeDue = fee; p.pnlUsd = (p.pnlUsd ?? 0) - fee; a.live!.feesPaidUsd = (a.live!.feesPaidUsd ?? 0) + fee }
      this.closed(a, p, now)
      if (fee > 0) void this.sendFee(a, p)
    }
    this.save(a, now)
  }

  private async sendFee(a: PaperAccount, p: Position) {
    const t = this.trader(a)
    if (!t || !this.o.live || !(p.feeDue && p.feeDue > 0)) return
    this.lastFeeTry.set(p.id, Date.now())
    try {
      await this.o.live.payFee(t, p)
      this.o.store.savePaperTrade(a.id, p)
      this.save(a)
    } catch (e) { log.warn('user live: fee not sent yet', { bot: a.slug, error: errMsg(e) }) }
  }

  // ── signals and prices ───────────────────────────────────────────────

  /**
   * A signal: every running bot that follows its strategy buys (paper, or
   * live from its wallet), if its filters, cash and risk rules allow. Every
   * bot that doesn't says why, in its list of signals passed over, and the
   * reasons are counted (GET /v1/bot/rejections): a bot that isn't started or
   * doesn't follow the strategy used to pass over signals without a word.
   */
  onSignal(sig: PaperSignal, now = Date.now(), ctx: LiveContext | null = null) {
    for (const a of this.accounts.values()) {
      const skip = (key: string, why: string) => {
        a.skips = [{ at: now, kind: 'skip' as const, token: sig.token, symbol: sig.symbol, text: `${LABEL[sig.strategy]}: ${why}` }, ...a.skips].slice(0, PAPER_LIMITS.keepSkips)
        this.outcomes.add(sig.id, key, now)
      }
      // A stopped bot that was never funded is someone's abandoned try: left out.
      if (!a.running) { if (a.mode === 'live' || a.cash >= SIZE_LIMITS.minUsd) skip('not-running', 'not traded: the bot is stopped (press Start)'); continue }
      if (!a.strategies.includes(sig.strategy)) { skip('strategy', `not traded: this bot follows ${a.strategies.map(x => LABEL[x]).join(', ')}`); continue }
      if (a.pausedUntil && now < a.pausedUntil) { skip('paused', `paused after ${PROTECT.pauseAfterLosses} losses in a row`); continue }
      const t = a.tuning[sig.strategy]
      const filtered = admits(t, sig.features)
      if (filtered) { a.filterSkips[sig.strategy] = (a.filterSkips[sig.strategy] ?? 0) + 1; skip('filters', filtered); continue }
      // Sized for its target, never over 20% of what the bot is worth; a thinner or costlier
      // pool gets the size for $1 (the low end of the range), a small bot the 20% for what it nets.
      const balanceUsd = this.balanceOf(a)
      const want = { strategy: sig.strategy, targetUsd: t.targetUsd, takeProfit: t.takeProfit, roundTripPct: sig.roundTripPct, liquidityUsd: sig.liquidityUsd, balanceUsd: balanceUsd ?? undefined }
      const sized = sizeForTrade(want)
      if (!sized) { const n = noSizeWhy(want); skip(n.key, n.why); continue }
      const params = toParams(t, sized.sizeUsd)
      if (a.mode === 'live') {
        const trader = this.trader(a)
        if (!trader || !ctx) { skip('live-unavailable', 'live trading is unavailable right now'); continue }
        if (sized.sizeUsd > USER_LIVE.maxTradeUsd) { skip('live-cap', `needs ${money(sized.sizeUsd)}, over the $${USER_LIVE.maxTradeUsd} live cap`); continue }
        a.lastBuyAt[sig.strategy] = now
        a.filterSkips[sig.strategy] = 0
        this.outcomes.add(sig.id, 'live-order', now)
        void trader.open(ctx.signal, sig.strategy, ctx.pool, ctx.meta, { sizeUsd: sized.sizeUsd, idSuffix: a.id.slice(0, 12), extra: { exits: params, targetUsd: sized.targetUsd, tuningVersion: t.version, features: sig.features } })
          .catch(e => log.warn('user live: open failed', { bot: a.slug, error: errMsg(e) }))
        continue
      }
      if (a.cash < sized.sizeUsd) { skip('cash', `needs ${money(sized.sizeUsd)}, has ${money(a.cash)} in cash`); continue }
      const allowed = canOpen(a.positions.filter(p => !isLive(p)), sig.token, now, riskFor(a), sig.strategy)
      if (!allowed.ok) { skip(allowed.key ?? 'max-open', allowed.why); continue }
      const cost = costPerSide(sig.roundTripPct, sized.sizeUsd, sig.liquidityUsd)
      const p: Position = {
        ...openPosition({ id: `${sig.id}:${a.id.slice(0, 12)}`, strategy: sig.strategy, token: sig.token, symbol: sig.symbol, launchpad: sig.launchpad, signalId: sig.id, price: sig.price, cost, now, params }),
        mode: 'paper', exits: params, targetUsd: sized.targetUsd, tuningVersion: t.version, features: sig.features,
      }
      a.cash -= sized.sizeUsd
      a.positions.push(p)
      a.lastBuyAt[sig.strategy] = now
      a.filterSkips[sig.strategy] = 0
      this.outcomes.add(sig.id, 'traded', now)
      this.track(a, p)
      const aim = sized.small ? ` (a small bot: at most ${Math.round(SIZE_LIMITS.maxShareOfBalance * 100)}% of its ${money(balanceUsd ?? 0)} a trade, so aiming for ${money(sized.targetUsd)}, not $${t.targetUsd})`
        : sized.targetUsd < t.targetUsd ? ` (a thin pool: aiming for $${sized.targetUsd}, not $${t.targetUsd})` : ''
      this.event(a, { at: now, kind: 'buy', token: sig.token, symbol: sig.symbol, text: `Bought $${sig.symbol} for ${money(sized.sizeUsd)} (${LABEL[sig.strategy]}): sells all at ${move(t.takeProfit)} to make about ${money(sized.profitUsd)}${aim}, stop at ${move(t.stopLoss)}` })
      this.save(a, now)
    }
  }

  /** A trade in `token`: rug alarms, the creator selling, and exits, for the bots holding it (live ones through their wallet). */
  onPrice(token: string, price: number, now: number, creatorSold: boolean, priced: boolean, rug: RugAlarm | null = null) {
    const ids = this.byToken.get(token)
    if (!ids?.size) return
    for (const id of [...ids]) {
      const a = this.accounts.get(id)
      if (!a) { ids.delete(id); continue }
      for (const p of a.positions) {
        if (p.status !== 'open' || p.token !== token) continue
        if (isLive(p)) {
          const t = this.trader(a)
          if (rug) { p.note = `Rug guard: ${rug.text}`; t?.closeNow(p, 'rug') }
          else if (priced || creatorSold) t?.onPrice(p, price, now, creatorSold)
          continue
        }
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
      for (const p of a.positions) {
        if (p.status !== 'open' || p.token !== token) continue
        if (isLive(p)) { if (note) p.note = note; this.trader(a)?.closeNow(p, reason); continue }
        this.credit(a, p, closeNow(p, price, now, reason, note), now)
      }
    }
  }

  /** Every few seconds: time exits, live bots' wallets and fees, loosening filters that block everything, and saving what changed. */
  tick(now = Date.now()) {
    for (const [token, ids] of this.byToken) {
      const price = this.o.priceOf(token)
      if (!price) continue
      for (const id of [...ids]) {
        const a = this.accounts.get(id)
        if (!a) continue
        for (const p of a.positions) if (p.status === 'open' && p.token === token && !isLive(p)) this.credit(a, p, onPrice(p, price, now, p.exits ?? this.o.params(p.strategy)), now)
      }
    }
    for (const a of this.accounts.values()) {
      if (a.live && (a.mode === 'live' || a.positions.some(p => (isLive(p) && p.status === 'open') || (p.feeDue ?? 0) > 0))) this.tickLive(a, now)
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

  private tickLive(a: PaperAccount, now: number) {
    const t = this.trader(a)
    if (!t) return
    t.tick(now, token => this.o.priceOf(token))
    for (const p of a.positions) if (p.feeDue && p.feeDue > 0 && now - (this.lastFeeTry.get(p.id) ?? 0) > 60_000) void this.sendFee(a, p)
    void this.o.live!.balance(a.id, t).then(bal => {
      if (bal === null || a.mode !== 'live' || !a.live?.startBalanceUsd) return
      let open = 0
      for (const p of a.positions) if (isLive(p) && p.status === 'open') open += p.remaining * (this.o.priceOf(p.token) ?? p.marketEntry)
      if (bal + open < a.live.startBalanceUsd * (1 - USER_LIVE.stopBelowPct / 100)) {
        a.mode = 'paper'
        this.event(a, { at: Date.now(), kind: 'stop', text: `Live stopped: the wallet is down ${Math.round((1 - (bal + open) / a.live.startBalanceUsd) * 100)}% from when it went live. Back to paper; open live trades are still managed.` })
        this.save(a)
      }
    })
  }

  flush() {
    for (const id of this.dirty) { const a = this.accounts.get(id); if (a) this.o.store.savePaperAccount(a) }
    this.dirty.clear()
  }

  /** Every closed trade the bot has made, newest first (the trade log). */
  trades(a: PaperAccount, limit: number, before?: number) { return this.o.store.paperTrades(a.id, limit, before) }

  /**
   * What the bot is worth for sizing: paper, its cash and open paper trades;
   * live, its wallet's USDC (last read, at most 15s old) and what its open live
   * trades cost; null while the wallet hasn't been read (the live trader reads
   * it before the buy and applies the same 20%).
   */
  balanceOf(a: PaperAccount): number | null {
    if (a.mode !== 'live') return this.equity(a).equity
    const bal = this.o.live?.cachedBalance(a.id) ?? null
    if (bal === null) return null
    return bal + a.positions.filter(p => isLive(p) && p.status === 'open').reduce((sum, p) => sum + p.sizeUsd * (p.remaining / (p.qty || 1)), 0)
  }

  /** Paper cash plus open paper positions at the current price. */
  equity(a: PaperAccount) {
    let openValue = 0
    for (const p of a.positions) if (p.status === 'open' && !isLive(p)) openValue += p.remaining * (this.o.priceOf(p.token) ?? p.marketEntry) * (1 - p.cost)
    return { equity: a.cash + openValue, openValue }
  }

  view(a: PaperAccount, now = Date.now()): PaperAccountView {
    const { equity, openValue } = this.equity(a)
    const paper = a.positions.filter(p => !isLive(p))
    const s = stats(paper)
    const shown = [...a.positions.filter(p => p.status === 'open'), ...a.positions.filter(p => p.status === 'closed').sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0)).slice(0, 50)]
    const day = new Date(now).toISOString().slice(0, 10)
    const today = paper.filter(p => p.closedAt && new Date(p.closedAt).toISOString().slice(0, 10) === day).reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0)
    const worth = this.balanceOf(a)
    const tuning = Object.fromEntries(STRATEGIES.map(st => {
      const { prev: _prev, ...t } = a.tuning[st]
      const mine = stats(a.positions.filter(p => p.strategy === st))
      const sized = sizeForTrade({ strategy: st, targetUsd: t.targetUsd, takeProfit: t.takeProfit, ...TYPICAL, balanceUsd: worth !== null && worth > 0 ? worth : undefined })
      return [st, { ...t, sizeUsd: sized?.sizeUsd ?? null, closed: mine.closed, winRate: mine.winRate }]
    })) as PaperAccountView['tuning']
    const trader = a.live && this.o.live ? this.o.live.existing(a.id) : null
    const liveStats = stats(a.positions.filter(isLive))
    return {
      id: a.id.slice(0, 8), name: a.name, slug: a.slug, mode: a.mode, running: a.running, strategies: a.strategies, cash: a.cash, deposited: a.deposited,
      equity, openValue, createdAt: a.createdAt, startedAt: a.startedAt,
      positions: shown.sort((x, y) => y.openedAt - x.openedAt),
      stats: { closed: s.closed, open: s.open, wins: s.wins, losses: s.losses, winRate: s.winRate, totalPnlUsd: s.totalPnlUsd, profitFactor: s.profitFactor === Infinity ? null : s.profitFactor, expectancyUsd: s.expectancyUsd, maxDrawdownUsd: s.maxDrawdownUsd },
      tuning,
      targets: { snipe: TARGETS.snipe.range, scalp: TARGETS.scalp.range, 'second-leg': TARGETS['second-leg'].range },
      learnLog: a.learnLog.slice(0, 30), events: a.events.slice(0, 40), skips: a.skips.slice(0, PAPER_LIMITS.keepSkips),
      protections: {
        pausedUntil: a.pausedUntil && a.pausedUntil > now ? a.pausedUntil : null, lossStreak: a.lossStreak, pauseAfterLosses: PROTECT.pauseAfterLosses,
        dailyLossLimitUsd: riskFor(a).dailyLossUsd, todayPnlUsd: today, stopBelowPct: PROTECT.stopBelowPct,
        maxTradeSharePct: Math.round(SIZE_LIMITS.maxShareOfBalance * 100), maxTradeUsd: worth === null ? null : maxTradeFor(worth),
      },
      tradesLogged: a.tradesLogged,
      feesPaidUsd: a.feesPaidUsd + (a.live?.feesPaidUsd ?? 0),
      ready: readiness(a.positions),
      live: a.live ? {
        wallet: a.live.address, balanceUsd: this.o.live?.cachedBalance(a.id) ?? null,
        pnlUsd: liveStats.totalPnlUsd, closed: liveStats.closed, open: liveStats.open, winRate: liveStats.winRate, feesPaidUsd: a.live.feesPaidUsd ?? 0,
        limits: { maxTradeUsd: USER_LIVE.maxTradeUsd, minBalanceUsd: USER_LIVE.minBalanceUsd, reserveUsd: USER_LIVE.reserveUsd, maxOpen: USER_LIVE.maxOpen, dailyLossUsd: trader?.limits.dailyLossUsd ?? USER_LIVE.dailyLossMinUsd, preflight: true, maxRoundTripPct: USER_LIVE.maxRoundTripPct, maxSharePct: Math.round(USER_LIVE.maxShareOfBalance * 100) },
        events: trader?.events.slice(0, 30) ?? [],
      } : null,
      liveAvailable: this.o.live?.available ?? { ok: false, why: 'live trading isn\'t available on this engine' },
    }
  }

  // ── the marketplace ──────────────────────────────────────────────────

  /** A bot as everyone sees it: name, strategies, P&L, open positions. Never its owner. */
  publicView(a: PaperAccount, now = Date.now()): MarketBot {
    const live = a.mode === 'live' || a.positions.some(isLive)
    const mine = (p: Position) => (a.mode === 'live' ? isLive(p) : !isLive(p))
    const book = a.positions.filter(mine)
    const s = stats(book)
    let pnlUsd: number, pnlPct: number | null
    if (a.mode === 'live') {
      let open = 0
      for (const p of book) if (p.status === 'open') { const pr = this.o.priceOf(p.token); open += pr ? p.remaining * pr - p.sizeUsd * (p.remaining / p.qty) : 0 }
      pnlUsd = s.totalPnlUsd + open
      pnlPct = a.live?.startBalanceUsd ? (pnlUsd / a.live.startBalanceUsd) * 100 : null
    } else {
      pnlUsd = this.equity(a).equity - a.deposited
      pnlPct = a.deposited > 0 ? (pnlUsd / a.deposited) * 100 : null
    }
    const positions = a.positions.filter(p => p.status === 'open').map(p => {
      const price = this.o.priceOf(p.token)
      const value = price ? p.remaining * price * (1 - p.cost) : null
      return { token: p.token, symbol: p.symbol, strategy: p.strategy, mode: (p.mode ?? 'paper') as 'paper' | 'live', sizeUsd: p.sizeUsd, entry: p.marketEntry, price, pnlUsd: value === null ? null : value - p.sizeUsd * (p.remaining / p.qty), openedAt: p.openedAt }
    })
    const paper = a.mode === 'live' ? stats(a.positions.filter(p => !isLive(p))) : s
    return {
      slug: a.slug, name: a.name, strategies: a.strategies, mode: a.mode, running: a.running, createdAt: a.createdAt,
      pnlUsd, pnlPct, winRate: s.winRate, closed: s.closed, positions,
      paper: { pnlUsd: a.mode === 'live' ? this.equity(a).equity - a.deposited : pnlUsd, winRate: paper.winRate, closed: paper.closed },
      learned: a.learnLog.length, ready: readiness(a.positions).ok, wallet: live ? a.live?.address ?? null : null,
    }
  }

  /** Every bot, best first (by P&L, win rate, newest, or live ones first). */
  market(sort: 'pnl' | 'winrate' | 'new' | 'live' = 'pnl', limit = 100, now = Date.now()): { bots: MarketBot[]; total: number } {
    const key = `${sort}:${limit}`
    const hit = this.marketCache.get(key)
    if (hit && now - hit.at < 5_000) return hit.value
    const value = this.marketNow(sort, limit, now)
    this.marketCache.set(key, { at: now, value })
    return value
  }
  private marketCache = new Map<string, { at: number; value: { bots: MarketBot[]; total: number } }>()

  private marketNow(sort: 'pnl' | 'winrate' | 'new' | 'live', limit: number, now: number): { bots: MarketBot[]; total: number } {
    const all = [...this.accounts.values()].filter(a => a.deposited > 0 || a.live || a.positions.length > 0).map(a => this.publicView(a, now))
    const by: Record<typeof sort, (x: MarketBot, y: MarketBot) => number> = {
      pnl: (x, y) => y.pnlUsd - x.pnlUsd,
      winrate: (x, y) => (y.winRate ?? -1) - (x.winRate ?? -1) || y.closed - x.closed,
      new: (x, y) => y.createdAt - x.createdAt,
      live: (x, y) => Number(y.mode === 'live') - Number(x.mode === 'live') || y.pnlUsd - x.pnlUsd,
    }
    return { bots: all.sort(by[sort]).slice(0, limit), total: all.length }
  }

  async publicDetail(slug: string, now = Date.now()): Promise<MarketBotDetail | null> {
    const a = this.bySlugOf(slug)
    if (!a) return null
    const trades = await this.trades(a, 50).catch(() => a.positions.filter(p => p.status === 'closed').slice(-50).reverse())
    const liveStats = stats(a.positions.filter(isLive))
    return {
      ...this.publicView(a, now),
      trades: trades.map(p => ({ ...p, txs: p.txs?.filter(t => t.kind !== 'approve') })),
      learnLog: a.learnLog.slice(0, 30),
      live: a.live ? { pnlUsd: liveStats.totalPnlUsd, closed: liveStats.closed, winRate: liveStats.winRate } : null,
    }
  }

  // ── bookkeeping ──────────────────────────────────────────────────────

  private credit(a: PaperAccount, p: Position, fills: Fill[], now: number) {
    if (!fills.length) return
    for (const f of fills) a.cash += f.usd
    if (p.status === 'closed') {
      // The platform's 2% of a paper win, taken virtually so paper reads like live.
      const fee = profitFee(p.pnlUsd)
      if (fee > 0) { p.feeUsd = fee; p.pnlUsd = (p.pnlUsd ?? 0) - fee; a.cash -= fee; a.feesPaidUsd += fee }
      this.closed(a, p, now)
    }
    this.save(a, now)
  }

  /** A position closed: the log, the loss streak, learning, and the drain guard. */
  private closed(a: PaperAccount, p: Position, now: number) {
    this.byToken.get(p.token)?.delete(a.id)
    if (!p.note) p.note = closeNote(p)
    this.o.store.savePaperTrade(a.id, p)
    a.tradesLogged++
    const won = (p.pnlUsd ?? 0) > 0
    this.event(a, { at: now, kind: p.exitReason === 'rug' ? 'rug' : 'sell', token: p.token, symbol: p.symbol, text: `${isLive(p) ? 'LIVE ' : ''}Sold $${p.symbol}: ${won ? '+' : ''}${money(p.pnlUsd ?? 0)}${p.feeUsd ? ` after the 2% fee (${money(p.feeUsd)})` : ''}. ${p.note}` })
    a.lossStreak = won ? 0 : a.lossStreak + 1
    if (!won && a.lossStreak >= PROTECT.pauseAfterLosses && !(a.pausedUntil && a.pausedUntil > now)) {
      a.pausedUntil = now + PROTECT.pauseMin * 60_000
      this.event(a, { at: now, kind: 'pause', text: `${a.lossStreak} losses in a row: no new trades for ${PROTECT.pauseMin} minutes while it learns from them` })
    }
    this.trim(a)
    const trades = a.positions.filter(x => x.strategy === p.strategy && x.status === 'closed').sort((x, y) => (x.closedAt ?? 0) - (y.closedAt ?? 0))
    const r = learn(a.tuning[p.strategy], p.strategy, trades, now)
    if (r) { a.tuning[p.strategy] = r.tuning; this.learned(a, r.notes, now) }
    if (a.running && a.mode === 'paper' && a.deposited > 0) {
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
