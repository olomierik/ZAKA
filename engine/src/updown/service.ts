// The BTC Up/Down autotrader (2026-11-01, owner: "make this autotrade feature on Polymarket live and working"):
// every live 5- and 15-minute window priced and traded on paper against Polymarket's live books.
//
// Four times a second, for each live window: the Chainlink estimate (feeds.ts), the TWAP fair value (fair.ts), each
// side's best order (strategy.ts), and the paper book's caps (paper.ts). An order fills after the measured book lag plus
// Polymarket's 150 ms taker delay, at the book as it is then. Open positions are checked on the same beat and sold at
// the bid once the market pays their model value (a scalp) or the model says they're worth well under cost (a stop). Windows are found on Gamma, their price to beat and
// result read from Polymarket. Real money isn't placed from here: the owner chose each user's own wallet, offered once
// the paper record clears UPDOWN_READY (two weeks, 300 windows, both weeks positive, model at least as good as the
// market). `UPDOWN=off` stops it.

import { log, errMsg } from '../log'
import {
  UPDOWN_DUR_SEC, takerFee, windowStart, type UpdownDur, type UpdownSide, type UpdownStatus, type UpdownTrade, type UpdownWindowView,
} from '../../../api/_updownProtocol'
import { fairUp, type FairInput } from './fair'
import { SpotFeeds, SpotModel } from './feeds'
import { BookStream, Books, fetchGeoblock, fetchPrice, fetchWindow, type Fetch, type UpWindow } from './markets'
import { PaperBook, freshPaper, heldShares, type PaperState } from './paper'
import { RULES, decide, exitDecision, fillFak, sellFak, sizeUsd, type Intent } from './strategy'

export interface SettingsStore { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }

export const TAKER_DELAY_MS = 150
const DURS: UpdownDur[] = ['5m', '15m']
const KEY = 'updown-paper'

interface Win extends UpWindow { open: number | null; openAskedAt: number; resultAskedAt: number; resolved: boolean; view: UpdownWindowView | null; viewAt: number }

type WsCtor = new (url: string) => WebSocket

export class UpdownService {
  readonly model = new SpotModel()
  readonly books = new Books()
  private stream: BookStream
  private feeds: SpotFeeds
  paper: PaperBook
  private wins = new Map<string, Win>()
  private listErr = new Map<string, number>()
  /** Positions with a sale on its way, so a second isn't sent before it lands. */
  private selling = new Set<string>()
  private geo: { blocked: boolean; country: string } | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private now: () => number
  private f: Fetch

  constructor(private o: { store: SettingsStore; fetch?: Fetch; Ws?: WsCtor; now?: () => number }) {
    this.now = o.now ?? Date.now
    this.f = o.fetch ?? ((u, i) => fetch(u, i))
    this.stream = new BookStream(this.books, o.Ws, this.now)
    this.feeds = new SpotFeeds(this.model, o.Ws)
    this.paper = new PaperBook(freshPaper(this.now()))
  }

  async load() {
    try {
      const raw = await this.o.store.getSetting(KEY)
      if (raw) {
        const j = JSON.parse(raw) as { paper?: PaperState; basis?: Parameters<SpotModel['restore']>[0] }
        if (j.paper?.trades) this.paper = new PaperBook(j.paper)
        this.model.restore(j.basis)
      }
    } catch (e) { log.warn('updown: saved paper book not read', { error: errMsg(e) }) }
    log.info('updown: loaded', { trades: this.paper.s.trades.length, bankroll: this.paper.s.bankroll })
  }

  start() {
    this.feeds.start()
    const t = (ms: number, fn: () => unknown) => this.timers.push(setInterval(() => { try { void Promise.resolve(fn()).catch(e => log.warn('updown: timer failed', { error: errMsg(e) })) } catch (e) { log.warn('updown: timer failed', { error: errMsg(e) }) } }, ms))
    void this.discover()
    t(1_000, () => { this.model.tick(this.now()); this.alignTick() })
    t(250, () => this.decideAll())
    t(5_000, () => this.discover())
    t(3_000, () => this.prices())
    t(10_000, () => this.snapshots())
    t(30_000, () => this.save())
    void fetchGeoblock(this.f).then(g => { this.geo = g })
    t(10 * 60_000, async () => { this.geo = await fetchGeoblock(this.f) })
  }

  stop() { for (const x of this.timers) clearInterval(x); this.timers = []; this.feeds.stop(); this.stream.stop() }

  async save() {
    if (!this.paper.dirty) return
    this.paper.dirty = false
    await this.o.store.setSetting(KEY, JSON.stringify({ paper: this.paper.s, basis: this.model.toJSON() }))
  }

  /** The current and next window of each length, listed once, retried 30 s after a miss. */
  async discover() {
    const nowSec = Math.floor(this.now() / 1000)
    const want: { dur: UpdownDur; start: number }[] = []
    for (const dur of DURS) { const s = windowStart(dur, nowSec); want.push({ dur, start: s }, { dur, start: s + UPDOWN_DUR_SEC[dur] }) }
    await Promise.all(want.map(async ({ dur, start }) => {
      const slug = `btc-updown-${dur}-${start}`
      if (this.wins.has(slug) || this.now() - (this.listErr.get(slug) ?? 0) < 30_000) return
      try {
        const w = await fetchWindow(this.f, dur, start)
        if ('error' in w) { this.listErr.set(slug, this.now()); this.lookupFailed(slug, w.error); return }
        this.wins.set(slug, { ...w, open: null, openAskedAt: 0, resultAskedAt: 0, resolved: false, view: null, viewAt: 0 })
        if (w.start <= nowSec) this.lookupError = null
      } catch (e) { this.listErr.set(slug, this.now()); this.lookupFailed(slug, errMsg(e)) }
    }))
    // Windows over an hour past their end, resolved or never traded, are forgotten.
    const open = new Set(this.paper.openSlugs())
    for (const [slug, w] of this.wins) if (w.end < nowSec - 3_600 && (w.resolved || !open.has(slug))) this.wins.delete(slug)
    this.stream.watch([...this.wins.values()].filter(w => w.end > nowSec).flatMap(w => [w.upToken, w.downToken]))
  }

  /** The last reason a window couldn't be listed, served in the status and logged at most once a minute: on Railway
   *  (US West, 2026-11-01) the engine found no windows at all, and debug logs didn't say why. A window listed later
   *  (the next one isn't on Gamma until shortly before it starts) clears it. */
  lookupError: { at: number; slug: string; why: string } | null = null
  private lookupWarnAt = 0
  private lookupFailed(slug: string, why: string) {
    const now = this.now()
    this.lookupError = { at: now, slug, why }
    if (now - this.lookupWarnAt > 60_000) { this.lookupWarnAt = now; log.warn('updown: window not listed', { slug, why }) }
  }

  /** Prices to beat for started windows, results for ended ones (including positions saved before a restart). */
  async prices() {
    const now = this.now(), nowSec = Math.floor(now / 1000)
    for (const slug of this.paper.openSlugs()) {
      if (this.wins.has(slug)) continue
      const m = /^btc-updown-(5m|15m)-(\d+)$/.exec(slug)
      if (m) this.wins.set(slug, { slug, dur: m[1] as UpdownDur, start: Number(m[2]), end: Number(m[2]) + UPDOWN_DUR_SEC[m[1] as UpdownDur], conditionId: '', upToken: '', downToken: '', tick: 0.01, minSize: 5, feeRate: 0, feeExponent: 1, twapSec: 60, accepting: false, open: null, openAskedAt: 0, resultAskedAt: 0, resolved: false, view: null, viewAt: 0 })
    }
    await Promise.all([...this.wins.values()].map(async w => {
      if (w.start > nowSec) return
      if (w.end <= nowSec) {
        if (w.resolved || now - w.resultAskedAt < 10_000) return
        w.resultAskedAt = now
        const p = await fetchPrice(this.f, w.dur, w.start).catch(() => null)
        if (!p?.completed || p.close === null) return
        w.open ??= p.open
        w.resolved = true
        const settled = this.paper.settle(w.slug, p.close >= (p.open ?? w.open!))
        if (settled.length) log.info('updown: window settled', { slug: w.slug, up: p.close >= (p.open ?? 0), trades: settled.length, pnl: settled.reduce((a, t) => a + (t.pnl ?? 0), 0) })
        return
      }
      if (w.open !== null || now - w.openAskedAt < 3_000) return
      w.openAskedAt = now
      const p = await fetchPrice(this.f, w.dur, w.start).catch(() => null)
      if (p?.open) { w.open = p.open; this.model.learnBasis(w.start, p.open, w.twapSec) }
    }))
  }

  private delayMs() { return (this.books.lagMs() ?? 300) + TAKER_DELAY_MS }

  /** How far (log) the market's prices put Chainlink from the engine's estimate, learned in calm moments. The first
   *  live trades (2026-11-01) showed why: BTC $9 under the open, the market at 17% Up and the raw model at 45%. The
   *  market sees Chainlink's own price; a few basis points of basis error is a 28¢ "edge" that isn't one. */
  shift = 0
  shiftN = 0

  /** Once a second: for each live window in a calm moment (BTC flat over the last 10 s, the book tight, a mid between
   *  15% and 85%, 90 s+ left), the shift that makes the model equal the market's mid, folded into a slow average. */
  alignTick() {
    const now = this.now(), nowSec = Math.floor(now / 1000)
    const est = this.model.estimate(now)
    const then = this.model.priceAt(nowSec - 10)
    if (!est || then === null || this.model.volSamples < 60) return
    if (Math.abs(Math.log(est.price / then)) * 1e4 > 2) return
    for (const w of this.wins.values()) {
      if (w.open === null || w.start > nowSec - 30 || w.end - nowSec < 90 || !w.upToken) continue
      const bid = this.books.bestBid(w.upToken), ask = this.books.bestAsk(w.upToken)?.price ?? null
      if (bid === null || ask === null || ask - bid > 0.04) continue
      const mid = (bid + ask) / 2
      if (mid < 0.15 || mid > 0.85) continue
      const base = { open: w.open, secondsLeft: w.end - now / 1000, sigma: this.model.sigma(), basisSd: this.model.basisSd(), twapSec: w.twapSec }
      // Bisection on the shift: the model rises with the price.
      let lo = -0.003, hi = 0.003
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fairUp({ ...base, now: est.price * Math.exp(m) }) < mid) lo = m; else hi = m }
      const d = (lo + hi) / 2
      if (Math.abs(d) >= 0.0029) continue
      this.shift = this.shiftN === 0 ? d : this.shift + 0.03 * (d - this.shift)
      this.shiftN++
    }
  }

  private fair(w: Win, price: number, left: number, observedAvg: number | null) {
    const k = Math.exp(this.shift)
    const i: FairInput = { open: w.open!, now: price * k, secondsLeft: left, sigma: this.model.sigma(), observedAvg: observedAvg === null ? null : observedAvg * k, basisSd: this.model.basisSd(), twapSec: w.twapSec }
    return fairUp(i)
  }

  private pModel(w: Win, now: number): { p: number; pLag: number | null } | { why: string } {
    if (w.open === null) return { why: 'waiting for the price to beat' }
    const est = this.model.estimate(now)
    if (!est) return { why: 'no fresh BTC price yet' }
    if (est.spreadBp > RULES.maxSpreadBp) return { why: 'exchanges disagree' }
    if (this.model.volSamples < 60) return { why: 'measuring volatility' }
    const nowSec = now / 1000, left = w.end - nowSec
    if (this.shiftN < RULES.alignMin) return { why: 'aligning with the market' }
    let observedAvg: number | null = null
    if (left < w.twapSec) {
      observedAvg = this.model.observedAvg(w.end - w.twapSec, Math.floor(nowSec))
      if (observedAvg === null) return { why: 'missing part of the final minute' }
    }
    // The same model a few seconds ago, for lane A's check that the gap just opened.
    const lagSec = Math.floor(nowSec) - RULES.lagSec
    const then = this.model.priceAt(lagSec)
    const lagLeft = left + (nowSec - lagSec)
    const pLag = then === null ? null : this.fair(w, then, lagLeft, lagLeft < w.twapSec ? this.model.observedAvg(w.end - w.twapSec, lagSec) : null)
    return { p: this.fair(w, est.price, left, observedAvg), pLag }
  }

  decideAll() {
    const now = this.now(), nowSec = now / 1000
    for (const w of this.wins.values()) {
      if (w.start > nowSec || w.end <= nowSec || !w.upToken) continue
      const view = this.viewOf(w, now)
      w.view = view
      w.viewAt = now
      if (view.model !== null && w.accepting && this.bookLive(w, now)) this.exits(w, view.model, view.secondsLeft)
      if (view.waiting || view.model === null) continue
      const elapsed = nowSec - w.start
      const intents: Intent[] = []
      for (const side of ['up', 'down'] as UpdownSide[]) {
        const p = side === 'up' ? view.model : 1 - view.model
        const d = decide({ side, p, asks: this.books.askLevels(side === 'up' ? w.upToken : w.downToken), secondsLeft: view.secondsLeft, elapsed, feeRate: w.feeRate, feeExponent: w.feeExponent })
        if ('lane' in d) intents.push(d)
      }
      if (!intents.length) { view.waiting = 'no edge after fees'; continue }
      const best = intents.sort((a, b) => b.edge - a.edge)[0]
      // The market must have agreed with the model a moment ago (lane A), or be near it (lane B).
      const mkt = view.market
      if (mkt === null) { view.waiting = 'Polymarket’s book isn’t live'; continue }
      const pm = this.pModel(w, now)
      const pLag = 'p' in pm ? pm.pLag : null
      if (best.lane === 'A' ? pLag === null || Math.abs(pLag - mkt) > RULES.agreeLag : Math.abs(view.model - mkt) > RULES.agreeB) { view.waiting = 'model and market disagree'; continue }
      const blocked = this.paper.blocked(w.slug, now)
      if (blocked) { view.waiting = blocked; continue }
      const usd = sizeUsd(best.p, best.ask, w.feeRate, this.paper.s.bankroll, this.paper.windowLeft(w.slug))
      if (usd < Math.max(1, w.minSize * best.ask)) { view.waiting = 'size under Polymarket’s minimum'; continue }
      this.paper.sending(w.slug, now)
      const token = best.side === 'up' ? w.upToken : w.downToken
      const delay = this.delayMs()
      setTimeout(() => this.land(w, best, token, usd, now, view.secondsLeft), delay)
    }
  }

  private land(w: Win, it: Intent, token: string, usd: number, at: number, secondsLeft: number) {
    const fill = fillFak(this.books.askLevels(token), it.worst, usd, w.feeRate, w.feeExponent)
    if (fill.shares < w.minSize || fill.spent < 1) { this.paper.miss(); return }
    const t: Omit<UpdownTrade, 'id' | 'result' | 'pnl'> = {
      slug: w.slug, dur: w.dur, lane: it.lane, side: it.side, at, filledAt: this.now(),
      shares: Math.round(fill.shares * 100) / 100, price: Math.round(fill.avg * 1e4) / 1e4, fee: Math.round(fill.fee * 1e6) / 1e6,
      cost: Math.round((fill.spent + fill.fee) * 1e6) / 1e6, model: Math.round(it.p * 1e4) / 1e4, edge: Math.round(it.edge * 1e4) / 1e4,
      secondsLeft: Math.round(secondsLeft),
    }
    this.paper.record(t)
    log.info('updown: paper fill', { slug: w.slug, lane: it.lane, side: it.side, shares: t.shares, price: t.price, edge: t.edge })
  }

  private bookLive(w: Win, now: number) { return this.stream.connected && now - this.books.lastMsgAt <= RULES.bookStaleMs && this.books.has(w.upToken) }

  /** Open positions in a live window: sold at the bid when the exit rule says so, after the same delay as a buy. */
  private exits(w: Win, model: number, secondsLeft: number) {
    for (const t of this.paper.s.trades) {
      if (t.slug !== w.slug || t.result !== 'open' || this.selling.has(t.id)) continue
      const held = heldShares(t)
      if (held < 0.01) continue
      const token = t.side === 'up' ? w.upToken : w.downToken
      const d = exitDecision({ dur: w.dur, p: t.side === 'up' ? model : 1 - model, costPerShare: t.cost / t.shares, bids: this.books.bidLevels(token), secondsLeft, feeRate: w.feeRate, feeExponent: w.feeExponent })
      if (!('why' in d)) continue
      this.selling.add(t.id)
      const id = t.id
      setTimeout(() => {
        this.selling.delete(id)
        const fill = sellFak(this.books.bidLevels(token), d.floor, held, w.feeRate, w.feeExponent)
        // Polymarket's minimum order, unless it's the whole of what's left; otherwise it's tried again on the next beat.
        if (fill.shares < 0.01 || (fill.shares < w.minSize && fill.shares < held - 0.01)) return
        const done = this.paper.sell(id, fill, d.why, this.now())
        if (done) log.info('updown: paper sale', { slug: w.slug, side: done.side, why: d.why, shares: Math.round(fill.shares * 100) / 100, price: Math.round(fill.avg * 1e4) / 1e4, pnl: done.pnl })
      }, this.delayMs())
    }
  }

  snapshots() {
    for (const w of this.wins.values()) {
      const v = w.view
      if (!v || v.model === null || v.market === null || v.secondsLeft <= 0) continue
      this.paper.snapshot(w.slug, v.model, v.market)
    }
  }

  private viewOf(w: Win, now: number): UpdownWindowView {
    const nowSec = now / 1000
    const top = (token: string) => { const a = this.books.bestAsk(token); return { bid: this.books.bestBid(token), ask: a?.price ?? null, askSize: a?.size ?? 0 } }
    const up = top(w.upToken), down = top(w.downToken)
    const market = up.bid !== null && up.ask !== null ? (up.bid + up.ask) / 2 : null
    const est = this.model.estimate(now)
    const pm = this.pModel(w, now)
    const model = 'p' in pm ? pm.p : null
    let edge: UpdownWindowView['edge'] = null
    if (model !== null) for (const [side, b, p] of [['up', up, model], ['down', down, 1 - model]] as const) {
      if (b.ask === null) continue
      const e = p - b.ask - takerFee(b.ask, w.feeRate, w.feeExponent)
      if (!edge || e > edge.value) edge = { side, value: Math.round(e * 1e4) / 1e4 }
    }
    let waiting: string | null = 'why' in pm ? pm.why : null
    if (!waiting && (!this.stream.connected || now - this.books.lastMsgAt > RULES.bookStaleMs || !this.books.has(w.upToken))) waiting = 'Polymarket’s book isn’t live'
    if (!waiting && !w.accepting) waiting = 'not accepting orders'
    return {
      slug: w.slug, dur: w.dur, start: w.start, end: w.end, secondsLeft: Math.max(0, Math.round((w.end - nowSec) * 10) / 10),
      open: w.open, btc: est ? Math.round(est.price * 100) / 100 : null, model: model === null ? null : Math.round(model * 1e4) / 1e4,
      market, up, down, edge, waiting, feeRate: w.feeRate, url: `https://polymarket.com/event/${w.slug}`,
    }
  }

  status(): UpdownStatus {
    const now = this.now(), nowSec = now / 1000
    const windows = [...this.wins.values()].filter(w => w.upToken && w.end > nowSec).sort((a, b) => a.start - b.start || a.end - b.end)
      .map(w => (w.start > nowSec ? { ...this.viewOf(w, now), waiting: 'starts soon' } : w.view && now - w.viewAt < 1_000 ? w.view : this.viewOf(w, now)))
    return {
      mode: 'paper', live: false, windows,
      feeds: {
        sources: this.model.view(now), bookLagMs: this.books.lagMs(), bookConnected: this.stream.connected,
        volPct: this.model.volSamples >= 60 ? Math.round(this.model.sigma() * Math.sqrt(365 * 86_400) * 1000) / 10 : null,
        geoblock: this.geo,
        marketShiftBp: this.shiftN ? Math.round(this.shift * 1e5) / 10 : null,
        lookupError: this.lookupError,
      },
      delayMs: this.delayMs(),
      stats: this.paper.stats(now),
      readiness: this.paper.readiness(now),
      rules: { orderUsd: RULES.orderUsd, windowUsd: RULES.windowUsd, dailyLossUsd: RULES.dailyLossUsd, marginA: RULES.marginA, marginMid: RULES.marginMid, marginB: RULES.marginB, overpay: RULES.overpay, stop: RULES.stop },
    }
  }

  trades(limit = 100): UpdownTrade[] { return this.paper.s.trades.slice(-Math.min(500, Math.max(1, limit))).reverse() }
}
