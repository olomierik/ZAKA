// Visitors' paper-trading accounts (owner's request, 2026-09-30): deposit
// virtual USDC, choose one or more strategies, press Start, and every signal
// of those strategies opens a position in the account, with the bot's own
// exits and costs. They run on the engine, so an account keeps trading with
// the browser closed. No money is involved anywhere.
//
// An account is reached with a random key the browser keeps (localStorage);
// the engine stores only its SHA-256. Limits keep it cheap: accounts,
// deposits and cash are capped, and each account follows the bot's risk
// rules (open positions, a coin once per 6 hours, a daily loss stop).

import { createHash, randomBytes } from 'node:crypto'
import type { PaperAccountView, PaperAction } from '../../../api/_marketProtocol'
import { log } from '../log'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, stats, type Fill, type Position, type Strategy, type StrategyParams } from '../trading/paper'

export interface PaperAccount {
  id: string
  createdAt: number
  running: boolean
  startedAt: number | null
  strategies: Strategy[]
  /** USD per trade; scalps use a fifth of it, as the bot's do. */
  tradeUsd: number
  cash: number
  deposited: number
  positions: Position[]
  updatedAt: number
}

export const PAPER_LIMITS = { maxAccounts: 20_000, maxDeposit: 100_000, maxCash: 1_000_000, minTrade: 1, maxTrade: 10_000, keepClosed: 200, defaultTradeUsd: 25 }
const STRATEGIES: Strategy[] = ['snipe', 'scalp', 'second-leg']

export interface PaperAccountStore {
  paperAccounts(): Promise<PaperAccount[]>
  savePaperAccount(a: PaperAccount): void
}

export interface PaperSignal { id: string; token: string; symbol: string; launchpad: string; price: number; strategy: Strategy; roundTripPct: number | null; liquidityUsd: number | null }

export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex')
export const sizeFor = (a: Pick<PaperAccount, 'tradeUsd'>, s: Strategy) => (s === 'scalp' ? a.tradeUsd / 5 : a.tradeUsd)

export class PaperAccounts {
  private accounts = new Map<string, PaperAccount>()
  /** token → accounts with a position open in it */
  private byToken = new Map<string, Set<string>>()
  private dirty = new Set<string>()

  constructor(private o: { store: PaperAccountStore; priceOf: (token: string) => number | null; params: (s: Strategy) => StrategyParams }) {}

  async load() {
    for (const a of await this.o.store.paperAccounts()) { this.accounts.set(a.id, a); this.index(a) }
    log.info('paper accounts loaded', { accounts: this.accounts.size, running: this.running })
  }

  get count() { return this.accounts.size }
  get running() { let n = 0; for (const a of this.accounts.values()) if (a.running) n++; return n }

  /** A new account and its key (shown once); null at capacity. */
  create(now = Date.now()): { key: string; account: PaperAccount } | null {
    if (this.accounts.size >= PAPER_LIMITS.maxAccounts) return null
    const key = randomBytes(32).toString('hex')
    const a: PaperAccount = { id: keyHash(key), createdAt: now, running: false, startedAt: null, strategies: ['snipe', 'scalp'], tradeUsd: PAPER_LIMITS.defaultTradeUsd, cash: 0, deposited: 0, positions: [], updatedAt: now }
    this.accounts.set(a.id, a)
    this.save(a)
    return { key, account: a }
  }

  byKey(key: string | null): PaperAccount | null {
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return null
    return this.accounts.get(keyHash(key)) ?? null
  }

  /** Applies a visitor's action; returns why not, or null. */
  act(a: PaperAccount, x: PaperAction, now = Date.now()): string | null {
    switch (x.action) {
      case 'deposit': {
        const amt = Number(x.amount)
        if (!Number.isFinite(amt) || amt <= 0) return 'enter an amount above $0'
        if (amt > PAPER_LIMITS.maxDeposit) return `at most $${PAPER_LIMITS.maxDeposit.toLocaleString()} per deposit`
        if (a.cash + amt > PAPER_LIMITS.maxCash) return `a paper account holds at most $${PAPER_LIMITS.maxCash.toLocaleString()}`
        a.cash += amt; a.deposited += amt
        break
      }
      case 'start':
        if (a.cash < sizeFor(a, 'scalp')) return 'deposit virtual USDC first'
        if (!a.strategies.length) return 'choose at least one strategy'
        a.running = true; a.startedAt = now
        break
      case 'stop': a.running = false; break
      case 'strategies': {
        const list = [...new Set((Array.isArray(x.strategies) ? x.strategies : []).filter((s): s is Strategy => STRATEGIES.includes(s as Strategy)))]
        if (!list.length) return 'choose at least one strategy'
        a.strategies = list
        break
      }
      case 'size': {
        const usd = Number(x.usd)
        if (!Number.isFinite(usd) || usd < PAPER_LIMITS.minTrade || usd > PAPER_LIMITS.maxTrade) return `a trade is $${PAPER_LIMITS.minTrade}–$${PAPER_LIMITS.maxTrade.toLocaleString()}`
        a.tradeUsd = Math.round(usd * 100) / 100
        break
      }
      case 'reset':
        for (const p of a.positions) if (p.status === 'open') this.byToken.get(p.token)?.delete(a.id)
        Object.assign(a, { running: false, startedAt: null, cash: 0, deposited: 0, positions: [] })
        break
      default: return 'unknown action'
    }
    this.save(a, now)
    return null
  }

  /** A signal: every running account that follows its strategy buys, if its cash and risk rules allow. */
  onSignal(sig: PaperSignal, now = Date.now()) {
    const params = this.o.params(sig.strategy)
    for (const a of this.accounts.values()) {
      if (!a.running || !a.strategies.includes(sig.strategy)) continue
      const size = sizeFor(a, sig.strategy)
      if (a.cash < size) continue
      if (!canOpen(a.positions, sig.token, now, RISK, sig.strategy).ok) continue
      const cost = costPerSide(sig.roundTripPct, size, sig.liquidityUsd)
      const p: Position = { ...openPosition({ id: `${sig.id}:${a.id.slice(0, 12)}`, strategy: sig.strategy, token: sig.token, symbol: sig.symbol, launchpad: sig.launchpad, signalId: sig.id, price: sig.price, cost, now, params: { ...params, sizeUsd: size } }), mode: 'paper' }
      a.cash -= size
      a.positions.push(p)
      this.track(a, p)
      this.save(a, now)
    }
  }

  /** A trade in `token`: exits for the accounts holding it. */
  onPrice(token: string, price: number, now: number, creatorSold: boolean, priced: boolean) {
    const ids = this.byToken.get(token)
    if (!ids?.size) return
    for (const id of [...ids]) {
      const a = this.accounts.get(id)
      if (!a) { ids.delete(id); continue }
      for (const p of a.positions) {
        if (p.status !== 'open' || p.token !== token) continue
        const params = this.o.params(p.strategy)
        const fills: Fill[] = creatorSold && params.exitOnCreatorSell ? closeNow(p, price, now, 'creator') : priced ? onPrice(p, price, now, params) : []
        this.credit(a, p, fills, now)
      }
    }
  }

  /** Every 15s: time exits at the current price, and saving what changed. */
  tick(now = Date.now()) {
    for (const [token, ids] of this.byToken) {
      const price = this.o.priceOf(token)
      if (!price) continue
      for (const id of [...ids]) {
        const a = this.accounts.get(id)
        if (!a) continue
        for (const p of a.positions) if (p.status === 'open' && p.token === token) this.credit(a, p, onPrice(p, price, now, this.o.params(p.strategy)), now)
      }
    }
    this.flush()
  }

  flush() {
    for (const id of this.dirty) { const a = this.accounts.get(id); if (a) this.o.store.savePaperAccount(a) }
    this.dirty.clear()
  }

  view(a: PaperAccount): PaperAccountView {
    let openValue = 0
    for (const p of a.positions) if (p.status === 'open') openValue += p.remaining * (this.o.priceOf(p.token) ?? p.marketEntry) * (1 - p.cost)
    const s = stats(a.positions)
    const shown = [...a.positions.filter(p => p.status === 'open'), ...a.positions.filter(p => p.status === 'closed').sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0)).slice(0, 50)]
    return {
      id: a.id.slice(0, 8), running: a.running, strategies: a.strategies, tradeUsd: a.tradeUsd, cash: a.cash, deposited: a.deposited,
      equity: a.cash + openValue, openValue, createdAt: a.createdAt, startedAt: a.startedAt,
      positions: shown.sort((x, y) => y.openedAt - x.openedAt),
      stats: { closed: s.closed, open: s.open, wins: s.wins, losses: s.losses, winRate: s.winRate, totalPnlUsd: s.totalPnlUsd, profitFactor: s.profitFactor === Infinity ? null : s.profitFactor, expectancyUsd: s.expectancyUsd, maxDrawdownUsd: s.maxDrawdownUsd },
    }
  }

  private credit(a: PaperAccount, p: Position, fills: Fill[], now: number) {
    if (!fills.length) return
    for (const f of fills) a.cash += f.usd
    if (p.status === 'closed') { this.byToken.get(p.token)?.delete(a.id); this.trim(a) }
    this.save(a, now)
  }

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
