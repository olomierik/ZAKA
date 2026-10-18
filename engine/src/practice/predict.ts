// Practice predictions (2026-10-17): papertrade.xyz's way of trading, on Hyperliquid's prediction markets, with
// virtual USDC. The protocol and its limits are in api/_practiceProtocol.ts.
//
// - An account is reached with a random key kept in the visitor's browser; only its SHA-256 is stored.
// - Every fill is at the side's mid, read here from Hyperliquid (allMids, at most 1.5s old): no slippage, no fee.
//   Buys need the market listed in the latest outcomeMeta, not past its end, and a mid between 1¢ and 99¢.
// - A position is held until sold or settled. Settlement is Hyperliquid's own: `settledOutcome` answers
//   settleFraction, and each contract of the first side pays it, of the second side 1 − it. A held outcome is asked
//   about once it's left outcomeMeta or passed its end, at most once a minute.
// - The leaderboard ranks traders by realized P&L in the window and lists the best trades, from closed trades only.

import { createHash, randomBytes } from 'node:crypto'
import { log, errMsg } from '../log'
import {
  PRACTICE, cleanPracticeName, practiceEndsAt, sideMid,
  type BoardPeriod, type PracticeBoard, type PracticeFill, type PracticePosition, type PracticeRawOutcome, type PracticeRawQuestion,
  type PracticeSide, type PracticeSpec, type PracticeTrade, type PracticeView,
} from '../../../api/_practiceProtocol'

export interface PracticeAccount {
  id: string
  name: string
  createdAt: number
  start: number
  cash: number
  positions: PracticePosition[]
  history: PracticeTrade[]
  realized: number
  trades: number
  wins: number
  resets: number
  /** Every fill, newest last, the last 50 (for the ticker). */
  fills: PracticeFill[]
}

export interface PracticeStore {
  practiceAccounts(): Promise<PracticeAccount[]>
  savePracticeAccount(a: PracticeAccount): void
}

export class MemoryPracticeStore implements PracticeStore {
  private m = new Map<string, PracticeAccount>()
  async practiceAccounts() { return [...this.m.values()].map(a => structuredClone(a)) }
  savePracticeAccount(a: PracticeAccount) { this.m.set(a.id, structuredClone(a)) }
}

/** Hyperliquid's /info, as the engine calls it. */
export type HlInfo = (body: Record<string, unknown>) => Promise<unknown>

export const practiceKeyHash = (key: string) => createHash('sha256').update(key).digest('hex')
const KEY = /^[A-Za-z0-9_-]{32,64}$/
const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const r2 = (n: number) => Math.round(n * 100) / 100

export const PRACTICE_TIMING = { midsMs: 1_500, metaMs: 60_000, settleRecheckMs: 60_000, boardMs: 5_000 }

type Result<T> = T | { error: string }

export class PredictPractice {
  private accounts = new Map<string, PracticeAccount>()
  private meta = new Map<number, PracticeSpec>()
  private metaAt = 0
  private metaLoading: Promise<void> | null = null
  private mids: Record<string, number> = {}
  private midsAt = 0
  private midsLoading: Promise<void> | null = null
  private settleAsked = new Map<number, number>()
  private settled = new Map<number, number>()
  private perIp = new Map<string, number[]>()
  private orders = new Map<string, number[]>()
  private boards = new Map<BoardPeriod, { at: number; board: PracticeBoard }>()

  constructor(private o: { store: PracticeStore; info: HlInfo }) {}

  async load() {
    for (const a of await this.o.store.practiceAccounts()) this.accounts.set(a.id, a)
    log.info('practice predictions: loaded', { accounts: this.accounts.size })
  }

  get size() { return this.accounts.size }

  // ── Hyperliquid ────────────────────────────────────────────────────────

  /** The listed outcomes, read again when over a minute old. */
  async refreshMeta(now = Date.now(), force = false) {
    if (!force && now - this.metaAt < PRACTICE_TIMING.metaMs && this.meta.size) return
    if (this.metaLoading) return this.metaLoading
    this.metaLoading = (async () => {
      const r = await this.o.info({ type: 'outcomeMeta' }) as { outcomes?: PracticeRawOutcome[]; questions?: PracticeRawQuestion[] }
      if (!Array.isArray(r?.outcomes)) throw new Error('outcomeMeta: no outcomes')
      const qOf = new Map<number, PracticeRawQuestion>()
      for (const q of r.questions ?? []) for (const id of [...q.namedOutcomes, q.fallbackOutcome]) qOf.set(id, q)
      const next = new Map<number, PracticeSpec>()
      for (const o of r.outcomes) {
        const q = qOf.get(o.outcome) ?? null
        next.set(o.outcome, {
          o: { outcome: o.outcome, name: o.name, description: o.description, sideSpecs: (o.sideSpecs ?? []).slice(0, 2).map(s => ({ name: s.name })) },
          q: q ? { question: q.question, name: q.name, description: q.description, fallbackOutcome: q.fallbackOutcome, namedOutcomes: q.namedOutcomes, settledNamedOutcomes: q.settledNamedOutcomes } : null,
        })
      }
      this.meta = next
      this.metaAt = now
    })().finally(() => { this.metaLoading = null })
    return this.metaLoading
  }

  /** Every mid Hyperliquid streams, read again when over 1.5 seconds old (one read at a time). */
  private async freshMids(now = Date.now()) {
    if (now - this.midsAt < PRACTICE_TIMING.midsMs) return this.mids
    if (!this.midsLoading) {
      this.midsLoading = (async () => {
        const j = await this.o.info({ type: 'allMids' }) as Record<string, string>
        const m: Record<string, number> = {}
        for (const [k, v] of Object.entries(j ?? {})) if (k.startsWith('#')) m[k] = Number(v)
        this.mids = m
        this.midsAt = now
      })().finally(() => { this.midsLoading = null })
    }
    await this.midsLoading
    return this.mids
  }

  // ── accounts ───────────────────────────────────────────────────────────

  /** A new account: its key, once. Five an hour per IP. */
  create(nameRaw: unknown, ip: string, now = Date.now()): Result<{ key: string; account: PracticeView }> {
    const list = (this.perIp.get(ip) ?? []).filter(t => now - t < 3_600_000)
    if (list.length >= PRACTICE.newPerIpHour) return { error: 'too many new accounts from here, try again later' }
    if (this.perIp.size > 50_000) this.perIp.clear()
    this.perIp.set(ip, [...list, now])
    const key = randomBytes(24).toString('base64url')
    const id = practiceKeyHash(key)
    const name = cleanPracticeName(nameRaw) ?? `Trader ${id.slice(0, 4).toUpperCase()}`
    const a: PracticeAccount = { id, name, createdAt: now, start: PRACTICE.startUsd, cash: PRACTICE.startUsd, positions: [], history: [], realized: 0, trades: 0, wins: 0, resets: 0, fills: [] }
    this.accounts.set(id, a)
    this.save(a)
    return { key, account: this.view(a, this.mids) }
  }

  private byKey(key: unknown): PracticeAccount | null {
    if (typeof key !== 'string' || !KEY.test(key)) return null
    return this.accounts.get(practiceKeyHash(key)) ?? null
  }

  async account(key: unknown, now = Date.now()): Promise<PracticeView | null> {
    const a = this.byKey(key)
    if (!a) return null
    const mids = a.positions.length ? await this.freshMids(now).catch(() => this.mids) : this.mids
    return this.view(a, mids)
  }

  private view(a: PracticeAccount, mids: Readonly<Record<string, number>>): PracticeView {
    const positions = a.positions.map(p => {
      const px = sideMid(mids, p.outcome, p.side)
      return { ...p, px, value: px == null ? null : r2(px * p.contracts) }
    })
    const equity = r2(a.cash + positions.reduce((s, p) => s + (p.value ?? p.cost), 0))
    return {
      name: a.name, createdAt: a.createdAt, start: a.start, cash: r2(a.cash), positions, history: a.history.slice(-100).reverse(),
      equity, pnl: r2(equity - a.start), realized: r2(a.realized), trades: a.trades, wins: a.wins, resets: a.resets,
    }
  }

  private save(a: PracticeAccount) {
    try { this.o.store.savePracticeAccount(a) } catch (e) { log.warn('practice: not saved', { error: errMsg(e) }) }
    this.boards.clear()
  }

  private rate(a: PracticeAccount, now: number): boolean {
    const list = (this.orders.get(a.id) ?? []).filter(t => now - t < 60_000)
    if (list.length >= PRACTICE.ordersPerMinute) return false
    if (this.orders.size > 50_000) this.orders.clear()
    this.orders.set(a.id, [...list, now])
    return true
  }

  private fill(a: PracticeAccount, f: PracticeFill) {
    a.fills.push(f)
    if (a.fills.length > 50) a.fills.splice(0, a.fills.length - 50)
  }

  /** Buys `usd` of a side at its mid. */
  async buy(key: unknown, outcomeRaw: unknown, sideRaw: unknown, usdRaw: unknown, now = Date.now()): Promise<Result<{ fill: PracticeFill; account: PracticeView }>> {
    const a = this.byKey(key)
    if (!a) return { error: 'no such practice account' }
    const outcome = Number(outcomeRaw), side = Number(sideRaw), usd = r2(Number(usdRaw))
    if (!Number.isInteger(outcome) || outcome < 0 || (side !== 0 && side !== 1)) return { error: 'unknown market' }
    if (!(usd >= PRACTICE.minOrderUsd)) return { error: `the smallest order is $${PRACTICE.minOrderUsd}` }
    if (usd > a.cash + 1e-9) return { error: 'not enough practice USDC' }
    if (!this.rate(a, now)) return { error: 'too many orders, slow down' }
    await this.refreshMeta(now).catch(e => log.warn('practice: outcomeMeta failed', { error: errMsg(e) }))
    const spec = this.meta.get(outcome)
    if (!spec || now - this.metaAt > 5 * 60_000) return { error: 'this market isn’t open' }
    const ends = practiceEndsAt(spec)
    if (ends != null && ends <= now) return { error: 'this market has ended and settles soon' }
    const held = a.positions.find(p => p.outcome === outcome && p.side === side)
    if (!held && a.positions.length >= PRACTICE.maxOpen) return { error: `at most ${PRACTICE.maxOpen} open positions` }
    const px = sideMid(await this.freshMids(now), outcome, side as PracticeSide)
    if (px == null) return { error: 'no price for this side right now' }
    if (px < PRACTICE.minBuyPx || px > PRACTICE.maxBuyPx) return { error: 'this side is all but decided: no buys under 1¢ or over 99¢' }
    const contracts = r6(usd / px)
    a.cash = r2(a.cash - usd)
    if (held) { held.contracts = r6(held.contracts + contracts); held.cost = r2(held.cost + usd); held.spec = spec }
    else a.positions.push({ outcome, side: side as PracticeSide, contracts, cost: usd, openedAt: now, spec })
    const fill: PracticeFill = { outcome, side: side as PracticeSide, buy: true, contracts, px, usd, at: now }
    this.fill(a, fill)
    this.save(a)
    return { fill, account: this.view(a, this.mids) }
  }

  /** Sells a share (0–1] of a held side at its mid. */
  async sell(key: unknown, outcomeRaw: unknown, sideRaw: unknown, fractionRaw: unknown, now = Date.now()): Promise<Result<{ fill: PracticeFill; account: PracticeView }>> {
    const a = this.byKey(key)
    if (!a) return { error: 'no such practice account' }
    const outcome = Number(outcomeRaw), side = Number(sideRaw), fraction = Number(fractionRaw)
    const p = a.positions.find(x => x.outcome === outcome && x.side === side)
    if (!p) return { error: 'you don’t hold this side' }
    if (!(fraction > 0 && fraction <= 1)) return { error: 'bad amount' }
    if (!this.rate(a, now)) return { error: 'too many orders, slow down' }
    const px = sideMid(await this.freshMids(now), outcome, p.side)
    if (px == null) return { error: 'no price for this side right now' }
    const all = fraction >= 0.9999
    const contracts = all ? p.contracts : r6(p.contracts * fraction)
    const cost = all ? p.cost : r2(p.cost * fraction)
    const proceeds = r2(contracts * px)
    const pnl = this.close(a, p, contracts, cost, proceeds, px, 'sold', now)
    const fill: PracticeFill = { outcome, side: p.side, buy: false, contracts, px, usd: proceeds, pnl, at: now }
    this.fill(a, fill)
    this.save(a)
    return { fill, account: this.view(a, this.mids) }
  }

  /** Takes `contracts` out of a position into a closed trade; the realized P&L. */
  private close(a: PracticeAccount, p: PracticePosition, contracts: number, cost: number, proceeds: number, exitPx: number, how: 'sold' | 'settled', now: number): number {
    const pnl = r2(proceeds - cost)
    a.cash = r2(a.cash + proceeds)
    a.realized = r2(a.realized + pnl)
    a.trades++
    if (pnl > 0) a.wins++
    a.history.push({
      id: `${now.toString(36)}-${a.trades}`, outcome: p.outcome, side: p.side, contracts, entryPx: p.contracts ? r6(p.cost / p.contracts) : exitPx,
      exitPx, cost, proceeds, pnl, openedAt: p.openedAt, closedAt: now, how, spec: p.spec,
    })
    if (a.history.length > PRACTICE.history) a.history.splice(0, a.history.length - PRACTICE.history)
    p.contracts = r6(p.contracts - contracts)
    p.cost = r2(p.cost - cost)
    if (p.contracts <= 1e-6) a.positions = a.positions.filter(x => x !== p)
    return pnl
  }

  reset(key: unknown, startRaw: unknown, now = Date.now()): Result<PracticeView> {
    const a = this.byKey(key)
    if (!a) return { error: 'no such practice account' }
    const start = Number(startRaw ?? PRACTICE.startUsd)
    if (!(PRACTICE.resetChoices as readonly number[]).includes(start)) return { error: 'bad starting balance' }
    Object.assign(a, { start, cash: start, positions: [], history: [], realized: 0, trades: 0, wins: 0, resets: a.resets + 1, fills: [], createdAt: now })
    this.save(a)
    return this.view(a, this.mids)
  }

  rename(key: unknown, nameRaw: unknown): Result<PracticeView> {
    const a = this.byKey(key)
    if (!a) return { error: 'no such practice account' }
    const name = cleanPracticeName(nameRaw)
    if (!name) return { error: 'a name is 2–24 letters, digits, spaces or . _ \' -' }
    a.name = name
    this.save(a)
    return this.view(a, this.mids)
  }

  // ── settlement ─────────────────────────────────────────────────────────

  /** Pays out positions in markets Hyperliquid has settled. Held outcomes no longer listed (or past their end) are
   *  asked about at most once a minute. The number of positions settled. */
  async settleTick(now = Date.now()): Promise<number> {
    await this.refreshMeta(now).catch(e => log.warn('practice: outcomeMeta failed', { error: errMsg(e) }))
    const held = new Map<number, PracticeSpec>()
    for (const a of this.accounts.values()) for (const p of a.positions) held.set(p.outcome, p.spec)
    for (const [outcome, spec] of held) {
      if (this.settled.has(outcome)) continue
      const ends = practiceEndsAt(spec)
      const listed = this.meta.has(outcome) && this.metaAt > 0
      if (listed && (ends == null || ends > now)) continue
      await this.askSettlement(outcome, now)
    }
    let n = 0
    for (const a of this.accounts.values()) {
      let changed = false
      for (const p of [...a.positions]) {
        const f = this.settled.get(p.outcome)
        if (f === undefined) continue
        const px = p.side === 0 ? f : 1 - f
        this.close(a, p, p.contracts, p.cost, r2(p.contracts * px), px, 'settled', now)
        changed = true
        n++
      }
      if (changed) this.save(a)
    }
    if (this.settled.size > 20_000) this.settled.clear()
    return n
  }

  /** Asks Hyperliquid whether an outcome has settled, at most once a minute (the answer is kept). */
  private async askSettlement(outcome: number, now: number) {
    if (this.settled.has(outcome) || now - (this.settleAsked.get(outcome) ?? 0) < PRACTICE_TIMING.settleRecheckMs) return
    this.settleAsked.set(outcome, now)
    try {
      const r = await this.o.info({ type: 'settledOutcome', outcome }) as { settleFraction?: string | number } | null
      const f = r == null ? NaN : Number(r.settleFraction)
      if (Number.isFinite(f) && f >= 0 && f <= 1) this.settled.set(outcome, f)
    } catch (e) { log.warn('practice: settledOutcome failed', { outcome, error: errMsg(e) }) }
  }

  // ── for the testnet pool (engine/src/predictpool) ──────────────────────

  /** A listed outcome's spec, as the last outcomeMeta read had it. */
  specOf(outcome: number): PracticeSpec | null {
    return this.meta.get(outcome) ?? null
  }

  /** A side's mid, by the rules buys follow here: the outcome listed in an outcomeMeta under five minutes old, not past
   *  its end. Null otherwise, or with no book on either side. */
  async tradeableMid(outcome: number, side: PracticeSide, now = Date.now()): Promise<number | null> {
    await this.refreshMeta(now).catch(e => log.warn('practice: outcomeMeta failed', { error: errMsg(e) }))
    const spec = this.meta.get(outcome)
    if (!spec || now - this.metaAt > 5 * 60_000 || this.settled.has(outcome)) return null
    const ends = practiceEndsAt(spec)
    if (ends != null && ends <= now) return null
    return sideMid(await this.freshMids(now), outcome, side)
  }

  /** Hyperliquid's settleFraction for an outcome, once it has one. Asked only once the outcome has left outcomeMeta or
   *  passed its end (`known`: a spec kept from when it was listed), at most once a minute. */
  async settlementOf(outcome: number, known: PracticeSpec | null, now = Date.now()): Promise<number | null> {
    const hit = this.settled.get(outcome)
    if (hit !== undefined) return hit
    await this.refreshMeta(now).catch(e => log.warn('practice: outcomeMeta failed', { error: errMsg(e) }))
    const spec = this.meta.get(outcome) ?? known
    const ends = spec ? practiceEndsAt(spec) : null
    if (this.meta.has(outcome) && this.metaAt > 0 && (ends == null || ends > now)) return null
    await this.askSettlement(outcome, now)
    return this.settled.get(outcome) ?? null
  }

  // ── the leaderboard ────────────────────────────────────────────────────

  board(periodRaw: unknown, now = Date.now()): PracticeBoard {
    const period: BoardPeriod = periodRaw === '24h' || periodRaw === '7d' ? periodRaw : 'all'
    const hit = this.boards.get(period)
    if (hit && now - hit.at < PRACTICE_TIMING.boardMs) return hit.board
    const since = period === '24h' ? now - 86_400_000 : period === '7d' ? now - 7 * 86_400_000 : 0
    const traders: PracticeBoard['traders'] = []
    const trades: PracticeBoard['trades'] = []
    const recent: PracticeBoard['recent'] = []
    for (const a of this.accounts.values()) {
      const closed = a.history.filter(t => t.closedAt >= since)
      if (closed.length >= PRACTICE.boardMinTrades) {
        traders.push({ name: a.name, pnl: r2(closed.reduce((s, t) => s + t.pnl, 0)), trades: closed.length, wins: closed.filter(t => t.pnl > 0).length, best: Math.max(...closed.map(t => t.pnl)) })
      }
      for (const t of closed) if (t.pnl > 0) trades.push({ name: a.name, outcome: t.outcome, side: t.side, entryPx: t.entryPx, exitPx: t.exitPx, cost: t.cost, pnl: t.pnl, closedAt: t.closedAt, how: t.how, spec: t.spec })
      for (const f of a.fills.slice(-10)) {
        const spec = a.positions.find(p => p.outcome === f.outcome)?.spec ?? a.history.find(t => t.outcome === f.outcome)?.spec ?? this.meta.get(f.outcome)
        if (spec) recent.push({ ...f, name: a.name, spec })
      }
    }
    traders.sort((x, y) => y.pnl - x.pnl)
    trades.sort((x, y) => y.pnl - x.pnl)
    recent.sort((x, y) => y.at - x.at)
    const board: PracticeBoard = { period, at: now, traders: traders.slice(0, 50), trades: trades.slice(0, 30), recent: recent.slice(0, 30), accounts: this.accounts.size }
    this.boards.set(period, { at: now, board })
    return board
  }
}
