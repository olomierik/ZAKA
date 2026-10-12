// Paper trading on Hyperliquid's markets (2026-10-12; the build pack's Strategy Lab starts with "alerts and paper
// trading"). Anyone can practise with virtual USDC, no wallet needed, against Hyperliquid's real prices:
//
// - Market orders fill against the live order book, level by level, and are refused when the book can't fill them
//   within the chosen price move. Fees are Hyperliquid's base fees plus ARCDEX's builder fee, as a real order pays.
// - Limit orders that would cross fill the same way (post-only ones are refused, as on Hyperliquid); the rest wait,
//   holding back their margin, and fill at their price, at the maker fee, once the price reaches it.
// - Take-profits and stop-losses close the whole position when the price crosses them.
// - Margin is isolated: a position's loss stops at its margin, and it's liquidated when its equity falls to the
//   maintenance margin (half the initial margin at the market's maximum leverage, Hyperliquid's rule).
// - Funding is Hyperliquid's own hourly rate for each market (fundingHistory), paid from the position's margin.
// - Nothing is missed while the page is closed: the account remembers when it was last checked, and on return the
//   candles in between are replayed (open → the side against the bar → the other side → close), so a stop fires at its
//   price, a resting order fills, and funding is paid, as the exchange would have done.
// - Left out, and said so on the page: the market impact of the paper orders themselves, and partial fills.
//
// Everything here is labelled PAPER on the page. Nothing is sent to Hyperliquid; the account lives in this browser.

import { useCallback, useEffect, useRef, useState } from 'react'
import { N_ } from '../lib/i18n'
import { hlInfo } from './client'
import { barsFor, fundingFor, type Bar, type FundingEntry } from './history'

export { intervalFor, type Bar, type FundingEntry } from './history'

export const PAPER = {
  start: 10_000,
  /** Hyperliquid's base fees (its first volume tier). The page adds ARCDEX's builder fee: paperFees(). */
  taker: 0.00045, maker: 0.00015,
  minOrder: 10, keepFills: 300,
  /** Unwatched for longer than this, the candles in between are replayed before the account is checked again. */
  gapMs: 15_000,
}
const HOUR = 3_600_000

export interface PaperFees { taker: number; maker: number }
/** What a paper order pays: Hyperliquid's base fee plus ARCDEX's builder fee (a rate, e.g. 0.0005 for 0.05%). */
export const paperFees = (builder: number): PaperFees => ({ taker: PAPER.taker + builder, maker: PAPER.maker + builder })

export interface PaperPos {
  coin: string; szi: number; entryPx: number; lev: number; margin: number; maxLev: number; at: number
  /** Funding paid since it opened (received, if negative). */
  funding: number
}
export interface PaperOrder {
  oid: number; coin: string; isBuy: boolean; sz: number; at: number
  kind: 'limit' | 'tp' | 'sl'
  /** Limit price, or the trigger for tp/sl. */
  px: number
  reduceOnly: boolean; lev: number; maxLev: number
  /** Take-profit and stop-loss to set once a limit order fills. */
  tp: number | null; sl: number | null
  /** The fee rates it pays when it fills: maker when a limit fills, taker for take-profits and stop-losses. */
  fees: PaperFees
}
export interface PaperFill { tid: number; coin: string; isBuy: boolean; px: number; sz: number; fee: number; closedPnl: number; time: number; dir: string }
export interface PaperState {
  v: 1; cash: number; deposited: number; positions: PaperPos[]; orders: PaperOrder[]; fills: PaperFill[]; next: number; since: number
  /** Prices are applied up to here; anything after it is replayed from candles before the next check. */
  checked: number
  /** Funding is paid for every hour up to here. */
  fundedTo: number
  fundingPaid: number
  feesPaid: number
}
export interface Level { px: number; sz: number }
export interface PaperBook { bids: Level[]; asks: Level[] }

export class PaperError extends Error {}

export function freshPaper(now: number, amount = PAPER.start): PaperState {
  return { v: 1, cash: amount, deposited: amount, positions: [], orders: [], fills: [], next: 1, since: now, checked: now, fundedTo: Math.floor(now / HOUR) * HOUR, fundingPaid: 0, feesPaid: 0 }
}

/** The average price of filling `sz` against one side of the book, best level first; null if the book runs out. */
export function walkBook(levels: Level[], sz: number): { avg: number; worst: number } | null {
  let left = sz, cost = 0, worst = 0
  for (const l of levels) {
    if (left <= 1e-12) break
    const take = Math.min(left, l.sz)
    cost += take * l.px
    left -= take
    worst = l.px
  }
  if (left > 1e-9 * Math.max(1, sz)) return null
  return { avg: cost / sz, worst }
}

/** The price at which a position's equity meets its maintenance margin. */
export function liqPrice(p: Pick<PaperPos, 'szi' | 'entryPx' | 'margin' | 'maxLev'>): number {
  const s = Math.abs(p.szi), mm = 1 / (2 * p.maxLev)
  const px = p.szi > 0 ? (p.entryPx - p.margin / s) / (1 - mm) : (p.entryPx + p.margin / s) / (1 + mm)
  return Math.max(0, px)
}

const clone = (s: PaperState): PaperState => ({ ...s, positions: s.positions.map(p => ({ ...p })), orders: s.orders.map(o => ({ ...o })), fills: [...s.fills] })

/** The part of an order that would open or add to a position (the rest closes the one held the other way). */
export function opening(s: PaperState, coin: string, isBuy: boolean, sz: number): number {
  const pos = s.positions.find(p => p.coin === coin)
  if (!pos || Math.sign(pos.szi) === (isBuy ? 1 : -1)) return sz
  return Math.max(0, sz - Math.abs(pos.szi))
}
/** Leverage a fill opens at: the position's own when it adds to one. */
const levFor = (s: PaperState, coin: string, isBuy: boolean, lev: number) => {
  const pos = s.positions.find(p => p.coin === coin)
  return pos && Math.sign(pos.szi) === (isBuy ? 1 : -1) ? pos.lev : lev
}

/** Margin and fees held back for resting limit orders, as Hyperliquid holds them. */
export function reserved(s: PaperState): number {
  let r = 0
  for (const o of s.orders) {
    if (o.kind !== 'limit' || o.reduceOnly) continue
    const open = opening(s, o.coin, o.isBuy, o.sz)
    if (open > 0) r += (open * o.px) / levFor(s, o.coin, o.isBuy, o.lev) + o.sz * o.px * o.fees.maker
  }
  return r
}
export const available = (s: PaperState) => Math.max(0, s.cash - reserved(s))

function checkLev(lev: number, maxLev: number) {
  if (!(lev >= 1 && lev <= maxLev)) throw new PaperError(N_('That leverage isn’t allowed for this market.'))
}

interface FillIn { coin: string; isBuy: boolean; sz: number; px: number; feeRate: number; lev: number; maxLev: number; time: number }

/** Applies one fill to a copy of the account: opens or adds to a position, reduces or closes it, or closes it and
 * opens the rest the other way. Throws (leaving the account as it was) when there isn't the margin for it. The fills
 * come back; keep() records them. */
export function applyFill(s0: PaperState, f: FillIn): { state: PaperState; fills: PaperFill[] } {
  const s = clone(s0)
  const out: PaperFill[] = []
  const dir = f.isBuy ? 1 : -1
  const i = s.positions.findIndex(p => p.coin === f.coin)
  const pos = i >= 0 ? s.positions[i] : null
  if (!pos || Math.sign(pos.szi) === dir) {
    const lev = pos ? pos.lev : f.lev
    const notional = f.sz * f.px
    const fee = notional * f.feeRate
    const add = notional / lev
    if (s.cash < add + fee - 1e-9) throw new PaperError(N_('Not enough paper USDC for this order.'))
    s.cash -= add + fee
    s.feesPaid += fee
    if (pos) {
      const held = Math.abs(pos.szi)
      pos.entryPx = (held * pos.entryPx + f.sz * f.px) / (held + f.sz)
      pos.szi += dir * f.sz
      pos.margin += add
    } else {
      s.positions.push({ coin: f.coin, szi: dir * f.sz, entryPx: f.px, lev, margin: add, maxLev: f.maxLev, at: f.time, funding: 0 })
    }
    out.push({ tid: s.next++, coin: f.coin, isBuy: f.isBuy, px: f.px, sz: f.sz, fee, closedPnl: 0, time: f.time, dir: f.isBuy ? 'Open Long' : 'Open Short' })
    return { state: s, fills: out }
  }
  const held = Math.abs(pos.szi)
  const wasLong = pos.szi > 0
  const closeSz = Math.min(f.sz, held)
  const released = pos.margin * (closeSz / held)
  // Isolated margin: closing can't lose more than the margin it frees.
  const back = Math.max(0, released + (f.px - pos.entryPx) * closeSz * (wasLong ? 1 : -1))
  const fee = closeSz * f.px * f.feeRate
  s.cash += back - fee
  s.feesPaid += fee
  pos.szi += dir * closeSz
  pos.margin -= released
  out.push({ tid: s.next++, coin: f.coin, isBuy: f.isBuy, px: f.px, sz: closeSz, fee, closedPnl: back - released, time: f.time, dir: wasLong ? 'Close Long' : 'Close Short' })
  if (Math.abs(pos.szi) <= 1e-12 * Math.max(1, held)) {
    s.positions.splice(i, 1)
    s.orders = s.orders.filter(o => !(o.coin === f.coin && (o.kind !== 'limit' || o.reduceOnly)))
  }
  const rest = f.sz - closeSz
  if (rest > 1e-12 * Math.max(1, f.sz)) {
    const next = applyFill(s, { ...f, sz: rest })
    return { state: next.state, fills: [...out, ...next.fills] }
  }
  return { state: s, fills: out }
}

/** Records fills, newest first. */
const keep = (s: PaperState, fills: PaperFill[]): PaperState => ({ ...s, fills: [...fills.slice().reverse(), ...s.fills].slice(0, PAPER.keepFills) })

export interface MarketIn {
  coin: string; isBuy: boolean; sz: number; lev: number; maxLev: number; reduceOnly: boolean; slippage: number
  mid: number; book: PaperBook; time: number; fees: PaperFees; tp?: number | null; sl?: number | null
}

/** A market order against the live book. */
export function placeMarket(s: PaperState, o: MarketIn): { state: PaperState; fills: PaperFill[]; avg: number; sz: number } {
  if (!(o.mid > 0)) throw new PaperError(N_('There’s no price for this market right now.'))
  if (!o.reduceOnly) checkLev(o.lev, o.maxLev)
  let sz = o.sz
  if (o.reduceOnly) {
    const pos = s.positions.find(p => p.coin === o.coin)
    if (!pos || Math.sign(pos.szi) === (o.isBuy ? 1 : -1)) throw new PaperError(N_('Reduce only: there’s no position to reduce.'))
    sz = Math.min(sz, Math.abs(pos.szi))
  }
  if (!(sz > 0)) throw new PaperError(N_('That size is under the smallest lot for this market.'))
  const walked = walkBook(o.isBuy ? o.book.asks : o.book.bids, sz)
  if (!walked) throw new PaperError(N_('The order book isn’t deep enough for this size.'))
  const cap = o.isBuy ? o.mid * (1 + o.slippage) : o.mid * (1 - o.slippage)
  if (o.isBuy ? walked.worst > cap : walked.worst < cap) throw new PaperError(N_('The book can’t fill this size within your max price move.'))
  if (!o.reduceOnly && sz * walked.avg < PAPER.minOrder) throw new PaperError(N_('Hyperliquid’s smallest order is $10.'))
  const open = opening(s, o.coin, o.isBuy, sz)
  if (open > 0 && available(s) < (open * walked.avg) / levFor(s, o.coin, o.isBuy, o.lev) + sz * walked.avg * o.fees.taker - 1e-9) {
    throw new PaperError(N_('Not enough paper USDC for this order.'))
  }
  const r = applyFill(s, { coin: o.coin, isBuy: o.isBuy, sz, px: walked.avg, feeRate: o.fees.taker, lev: o.lev, maxLev: o.maxLev, time: o.time })
  let state = keep(r.state, r.fills)
  if ((o.tp || o.sl) && state.positions.some(p => p.coin === o.coin)) state = setTpSl(state, o.coin, o.tp ?? null, o.sl ?? null, o.time, o.fees)
  return { state, fills: r.fills, avg: walked.avg, sz }
}

export interface LimitIn extends Omit<MarketIn, 'slippage'> { px: number; postOnly: boolean }

/** A limit order: fills now against the book if its price allows (refused if post-only), else waits. */
export function placeLimit(s: PaperState, o: LimitIn): { state: PaperState; fills: PaperFill[]; resting: boolean } {
  if (!(o.px > 0)) throw new PaperError(N_('Enter a price.'))
  if (!o.reduceOnly) checkLev(o.lev, o.maxLev)
  const crosses = o.isBuy ? (o.book.asks[0]?.px ?? Infinity) <= o.px : (o.book.bids[0]?.px ?? 0) >= o.px
  if (crosses) {
    if (o.postOnly) throw new PaperError(N_('Post only: this price would fill at once.'))
    const levels = (o.isBuy ? o.book.asks : o.book.bids).filter(l => (o.isBuy ? l.px <= o.px : l.px >= o.px))
    const depth = levels.reduce((a, l) => a + l.sz, 0)
    // Paper keeps orders whole: one that can only partly fill at its price now is refused, not left to fill later at
    // a better price than the book offered.
    if (depth + 1e-12 < o.sz) throw new PaperError(N_('The book can’t fill all of this at your price right now.'))
    const r = placeMarket(s, { ...o, slippage: Infinity, book: o.isBuy ? { bids: o.book.bids, asks: levels } : { bids: levels, asks: o.book.asks } })
    return { state: r.state, fills: r.fills, resting: false }
  }
  if (o.reduceOnly) {
    const pos = s.positions.find(p => p.coin === o.coin)
    if (!pos || Math.sign(pos.szi) === (o.isBuy ? 1 : -1)) throw new PaperError(N_('Reduce only: there’s no position to reduce.'))
  } else if (o.sz * o.px < PAPER.minOrder) throw new PaperError(N_('Hyperliquid’s smallest order is $10.'))
  const open = o.reduceOnly ? 0 : opening(s, o.coin, o.isBuy, o.sz)
  if (open > 0 && available(s) < (open * o.px) / levFor(s, o.coin, o.isBuy, o.lev) + o.sz * o.px * o.fees.maker - 1e-9) {
    throw new PaperError(N_('Not enough paper USDC for this order.'))
  }
  const st = clone(s)
  st.orders.push({ oid: st.next++, coin: o.coin, isBuy: o.isBuy, sz: o.sz, at: o.time, kind: 'limit', px: o.px, reduceOnly: o.reduceOnly, lev: o.lev, maxLev: o.maxLev, tp: o.tp ?? null, sl: o.sl ?? null, fees: o.fees })
  return { state: st, fills: [], resting: true }
}

/** Sets (or clears, with null) a position's take-profit and stop-loss, replacing any it had. */
export function setTpSl(s: PaperState, coin: string, tp: number | null, sl: number | null, time: number, fees: PaperFees): PaperState {
  const pos = s.positions.find(p => p.coin === coin)
  if (!pos) throw new PaperError(N_('There’s no position in this market.'))
  const isLong = pos.szi > 0
  const st = clone(s)
  st.orders = st.orders.filter(o => !(o.coin === coin && o.kind !== 'limit'))
  for (const [kind, px] of [['tp', tp], ['sl', sl]] as const) {
    if (px && px > 0) st.orders.push({ oid: st.next++, coin, isBuy: !isLong, sz: Math.abs(pos.szi), at: time, kind, px, reduceOnly: true, lev: pos.lev, maxLev: pos.maxLev, tp: null, sl: null, fees })
  }
  return st
}

export function cancelPaper(s: PaperState, oids: number[]): PaperState {
  const drop = new Set(oids)
  return { ...clone(s), orders: s.orders.filter(o => !drop.has(o.oid)) }
}

// ── watching the price ───────────────────────────────────────────────────

export type PaperEvent =
  | { kind: 'filled'; order: PaperOrder; fills: PaperFill[]; time: number }
  | { kind: 'triggered'; order: PaperOrder; fills: PaperFill[]; time: number }
  | { kind: 'liquidated'; coin: string; fill: PaperFill; time: number }
  | { kind: 'cancelled'; order: PaperOrder; why: 'no-position' | 'no-margin'; time: number }

interface Fired { state: PaperState; event: PaperEvent }

function fillLimit(s: PaperState, o: PaperOrder, time: number): Fired {
  const base = cancelPaper(s, [o.oid])
  let sz = o.sz
  if (o.reduceOnly) {
    const pos = base.positions.find(p => p.coin === o.coin)
    if (!pos || Math.sign(pos.szi) === (o.isBuy ? 1 : -1)) return { state: base, event: { kind: 'cancelled', order: o, why: 'no-position', time } }
    sz = Math.min(sz, Math.abs(pos.szi))
  }
  try {
    const r = applyFill(base, { coin: o.coin, isBuy: o.isBuy, sz, px: o.px, feeRate: o.fees.maker, lev: o.lev, maxLev: o.maxLev, time })
    let st = keep(r.state, r.fills)
    if ((o.tp || o.sl) && st.positions.some(p => p.coin === o.coin)) st = setTpSl(st, o.coin, o.tp, o.sl, time, o.fees)
    return { state: st, event: { kind: 'filled', order: o, fills: r.fills, time } }
  } catch {
    return { state: base, event: { kind: 'cancelled', order: o, why: 'no-margin', time } }
  }
}

function triggerExit(s: PaperState, o: PaperOrder, px: number, time: number): Fired {
  const pos = s.positions.find(p => p.coin === o.coin)!
  const r = applyFill(s, { coin: o.coin, isBuy: pos.szi < 0, sz: Math.abs(pos.szi), px, feeRate: o.fees.taker, lev: pos.lev, maxLev: pos.maxLev, time })
  return { state: keep(r.state, r.fills), event: { kind: 'triggered', order: o, fills: r.fills, time } }
}

function liquidate(s: PaperState, coin: string, px: number, time: number): Fired {
  const p = s.positions.find(x => x.coin === coin)!
  const st = clone(s)
  st.positions = st.positions.filter(x => x.coin !== coin)
  st.orders = st.orders.filter(o => o.coin !== coin || (o.kind === 'limit' && !o.reduceOnly))
  // The position's margin is gone (it's isolated: nothing else is).
  const fill: PaperFill = { tid: st.next++, coin, isBuy: p.szi < 0, px, sz: Math.abs(p.szi), fee: 0, closedPnl: -Math.max(0, p.margin), time, dir: 'Liquidation' }
  return { state: keep(st, [fill]), event: { kind: 'liquidated', coin, fill, time } }
}

type Eligible = (at: number) => boolean
const always: Eligible = () => true
/** A price that fires something: dir −1 fires once the price is at or below px, +1 at or above. */
interface Trig { px: number; dir: 1 | -1; rank: number; at: number; id: number; fire: (s: PaperState, px: number, time: number) => Fired }

function triggersOf(s: PaperState, coin: string, eligible: Eligible): Trig[] {
  const out: Trig[] = []
  const pos = s.positions.find(p => p.coin === coin) ?? null
  for (const o of s.orders) {
    if (o.coin !== coin || !eligible(o.at)) continue
    if (o.kind === 'limit') out.push({ px: o.px, dir: o.isBuy ? -1 : 1, rank: 0, at: o.at, id: o.oid, fire: (st, _px, time) => fillLimit(st, o, time) })
    else if (pos) {
      const isLong = pos.szi > 0
      out.push({ px: o.px, dir: o.kind === 'tp' ? (isLong ? 1 : -1) : (isLong ? -1 : 1), rank: 1, at: o.at, id: o.oid, fire: (st, px, time) => triggerExit(st, o, px, time) })
    }
  }
  if (pos && eligible(pos.at)) out.push({ px: liqPrice(pos), dir: pos.szi > 0 ? -1 : 1, rank: 2, at: pos.at, id: 0, fire: (st, px, time) => liquidate(st, coin, px, time) })
  return out
}

/** Moves one market's price from `from` to `to` and fires, in the order the price reaches them, the limit orders,
 * take-profits, stop-losses and liquidations it crosses. Something already crossed at `from` fires first, at `from`
 * (a gap: a stop fills at the worse price; a resting limit at its own). `eligible` leaves out orders and positions
 * that didn't exist yet (a replayed candle that opened before them). */
export function step(s0: PaperState, coin: string, from: number, to: number, time: number, eligible: Eligible = always): { state: PaperState; events: PaperEvent[] } {
  let s = s0
  let cur = from
  const events: PaperEvent[] = []
  for (let guard = 0; guard < 100; guard++) {
    let best: { t: Trig; dist: number; px: number } | null = null
    for (const t of triggersOf(s, coin, eligible)) {
      let dist: number, px: number
      if (t.dir < 0 ? cur <= t.px : cur >= t.px) { dist = 0; px = cur }
      else if (t.dir < 0 ? to <= t.px : to >= t.px) { dist = Math.abs(cur - t.px); px = t.px }
      else continue
      if (!best || dist < best.dist || (dist === best.dist && (t.rank - best.t.rank || t.at - best.t.at || t.id - best.t.id) < 0)) best = { t, dist, px }
    }
    if (!best) break
    const r = best.t.fire(s, best.px, time)
    s = r.state
    events.push(r.event)
    cur = best.px
  }
  return { state: s, events }
}

const coinsOf = (s: PaperState) => [...new Set([...s.orders.map(o => o.coin), ...s.positions.map(p => p.coin)])]

/** One live pass: each market watched moves from its last price (`prev`) to its mid now. */
export function tick(s0: PaperState, mids: Readonly<Record<string, number>>, time: number, prev?: Readonly<Record<string, number>>): { state: PaperState; events: PaperEvent[] } {
  let s = s0
  const events: PaperEvent[] = []
  for (const coin of coinsOf(s0)) {
    const mid = mids[coin]
    if (!(mid > 0)) continue
    const before = prev?.[coin]
    const r = step(s, coin, before !== undefined && before > 0 ? before : mid, mid, time)
    s = r.state
    events.push(...r.events)
  }
  return { state: s, events }
}


/** One hour's funding on a position: size × price × rate, from its margin (a long pays a positive rate, a short
 * receives it). Never more than the margin it has. */
function payFunding(s0: PaperState, e: FundingEntry, px: number | undefined): PaperState {
  const s = clone(s0)
  s.fundedTo = Math.max(s.fundedTo, e.time)
  const pos = s.positions.find(p => p.coin === e.coin)
  if (!pos || pos.at > e.time || !(px !== undefined && px > 0) || !Number.isFinite(e.rate)) return s
  const pay = Math.min(pos.szi * px * e.rate, pos.margin)
  pos.margin -= pay
  pos.funding += pay
  s.fundingPaid += pay
  return s
}

/** Catches the account up: replays candles (each as open → the side against it → the other side → close, a falling
 * bar visiting its high first) and pays funding in time order. `fundThrough` is the last hour whose rates are all in;
 * `prices` stand in for markets without candles. */
export function replay(s0: PaperState, o: { bars: Bar[]; funding: FundingEntry[]; until: number; fundThrough: number; prices?: Readonly<Record<string, number>> }): { state: PaperState; events: PaperEvent[] } {
  let s = s0
  const events: PaperEvent[] = []
  const bars = [...o.bars].sort((a, b) => a.t - b.t || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0))
  const funding = o.funding.filter(f => f.time > s0.fundedTo && f.time <= o.fundThrough).sort((a, b) => a.time - b.time)
  const last: Record<string, number> = { ...(o.prices ?? {}) }
  const seen = new Set<string>()
  for (const b of bars) if (!seen.has(b.coin)) { seen.add(b.coin); last[b.coin] = b.o }
  let fi = 0
  const fundTo = (t: number) => { while (fi < funding.length && funding[fi].time <= t) { s = payFunding(s, funding[fi], last[funding[fi].coin]); fi++ } }
  for (const b of bars) {
    fundTo(b.t)
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0) || b.t > o.until) continue
    const path = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c]
    const eligible: Eligible = at => at <= b.t
    for (let k = 0; k < 3; k++) {
      const r = step(s, b.coin, path[k], path[k + 1], Math.min(o.until, b.t + Math.round((k * b.ms) / 3)), eligible)
      s = r.state
      events.push(...r.events)
    }
    last[b.coin] = b.c
  }
  fundTo(Infinity)
  s = { ...s, checked: Math.max(s.checked, o.until), fundedTo: Math.max(s.fundedTo, o.fundThrough) }
  return { state: s, events }
}

export interface PaperSummary { value: number; cash: number; available: number; marginUsed: number; upnl: number; pnl: number }

export function summarize(s: PaperState, mids: Readonly<Record<string, number>>): PaperSummary {
  let marginUsed = 0, upnl = 0
  for (const p of s.positions) {
    marginUsed += p.margin
    const mid = mids[p.coin]
    // Isolated: a position is worth its margin plus its P&L, never less than nothing.
    if (mid > 0) upnl += Math.max(-p.margin, (mid - p.entryPx) * p.szi)
  }
  const value = s.cash + marginUsed + upnl
  return { value, cash: s.cash, available: available(s), marginUsed, upnl, pnl: value - s.deposited }
}

/** The book a paper order fills against: Hyperliquid's full-precision levels for the market right now (the page's own
 * may be grouped by price). */
export async function paperBook(coin: string): Promise<PaperBook & { mid: number }> {
  const r = await hlInfo<{ levels?: { px: string; sz: string }[][] }>({ type: 'l2Book', coin }, { timeoutMs: 6_000 })
  const side = (l: { px: string; sz: string }[] | undefined) => (l ?? []).map(x => ({ px: Number(x.px), sz: Number(x.sz) })).filter(x => x.px > 0 && x.sz > 0)
  const bids = side(r.levels?.[0]), asks = side(r.levels?.[1])
  const mid = bids.length && asks.length ? (bids[0].px + asks[0].px) / 2 : 0
  return { bids, asks, mid }
}

/** The last hour whose funding is in for every market held: the latest each market has, or any hour over 15 minutes
 * old (a market Hyperliquid stopped paying on can't hold the others back). */
export function fundedThrough(entries: FundingEntry[], held: string[], now: number, from: number): number {
  const due = Math.floor(now / HOUR) * HOUR
  const settled = Math.floor((now - 15 * 60_000) / HOUR) * HOUR
  let through = due
  for (const coin of held) {
    const latest = entries.filter(e => e.coin === coin).reduce((a, e) => Math.max(a, e.time), from)
    through = Math.min(through, latest)
  }
  return Math.max(from, Math.min(due, Math.max(through, settled)))
}

// ── the account in this browser ─────────────────────────────────────────

const KEY = 'arcdex:hl-paper:v1'
const LEASE = 'arcdex:hl-paper:lease'

// Browsers that block storage keep the account for this tab only.
let memory: PaperState | null = null

function load(): PaperState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<PaperState>
      if (s?.v === 1 && Array.isArray(s.positions) && Array.isArray(s.orders) && Array.isArray(s.fills) && Number.isFinite(s.cash) && Number.isFinite(s.checked)) return { feesPaid: 0, fundingPaid: 0, ...s } as PaperState
    }
  } catch { /* storage blocked or unreadable */ }
  return memory ?? (memory = freshPaper(Date.now()))
}
function save(s: PaperState) {
  memory = s
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage blocked: this tab only */ }
}

/** One tab drives the account at a time (the others follow it through storage events), so two tabs can't fill the
 * same order twice. A hidden tab that stops renewing hands over to a visible one. */
function holdLease(me: string, now: number): boolean {
  try {
    const raw = localStorage.getItem(LEASE)
    const l = raw ? (JSON.parse(raw) as { id?: string; until?: number }) : null
    if (l && l.id !== me && (l.until ?? 0) > now) return false
    localStorage.setItem(LEASE, JSON.stringify({ id: me, until: now + 4_000 }))
  } catch { /* storage blocked: this tab alone */ }
  return true
}

export interface PaperNotice { events: PaperEvent[]; caughtUp: { from: number; to: number } | null; gap: { from: number; to: number } | null }

/** The paper account, driven once a second with the live mids, caught up from candles after a gap, kept in this
 * browser and in step across its tabs. `onNotice` hears what each pass did (fills, triggers, liquidations, and
 * whether it replayed a gap). */
export function usePaper(mids: Readonly<Record<string, number>>, onNotice?: (n: PaperNotice) => void) {
  const [state, setState] = useState<PaperState>(load)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  const [catching, setCatching] = useState(false)
  const commit = useCallback((s: PaperState) => { save(s); setState(s) }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setState(load()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    const me = Math.random().toString(36).slice(2)
    const prev: Record<string, number> = {}
    let alive = true
    let busy = false
    let failures = 0
    // This tab's last live pass. The stored `checked` is saved every few seconds, not every pass.
    let lastLive = 0
    let lastSave = 0
    let fundingAsked = 0

    async function catchUp(s: PaperState, from: number, now: number) {
      const coins = coinsOf(s)
      const held = [...new Set(s.positions.map(p => p.coin))]
      setCatching(true)
      try {
        const [bars, funding] = await Promise.all([
          Promise.all(coins.map(c => barsFor(c, from, now))).then(x => x.flat()),
          Promise.all(held.map(c => fundingFor(c, s.fundedTo, now))).then(x => x.flat()),
        ])
        if (!alive) return
        const fresh = load()
        const r = replay(fresh, { bars, funding, until: now, fundThrough: fundedThrough(funding, held, now, fresh.fundedTo), prices: mids })
        commit(r.state)
        failures = 0
        lastLive = lastSave = now
        for (const c of coins) if (mids[c] > 0) prev[c] = mids[c]
        noticeRef.current?.({ events: r.events, caughtUp: { from, to: now }, gap: null })
      } catch {
        // Hyperliquid didn't answer: try again shortly; after three tries, carry on from now and say so.
        if (++failures >= 3) {
          failures = 0
          commit({ ...load(), checked: now })
          lastLive = lastSave = now
          noticeRef.current?.({ events: [], caughtUp: null, gap: { from, to: now } })
        }
      } finally { if (alive) setCatching(false) }
    }

    async function payHours(now: number) {
      const s = load()
      const held = [...new Set(s.positions.map(p => p.coin))]
      if (!held.length) return
      const funding = (await Promise.all(held.map(c => fundingFor(c, s.fundedTo, now)))).flat()
      if (!alive) return
      const fresh = load()
      const through = fundedThrough(funding, held, now, fresh.fundedTo)
      if (through <= fresh.fundedTo) return
      commit(replay(fresh, { bars: [], funding, until: fresh.checked, fundThrough: through, prices: mids }).state)
    }

    async function beat() {
      if (busy || !alive) return
      const now = Date.now()
      if (!holdLease(me, now)) { lastLive = 0; return }
      const s = load()
      if (!s.orders.length && !s.positions.length) return
      busy = true
      try {
        const from = Math.max(s.checked, lastLive)
        if (now - from > PAPER.gapMs) { await catchUp(s, from, now); return }
        const r = tick(s, mids, now, prev)
        for (const c of coinsOf(s)) if (mids[c] > 0) prev[c] = mids[c]
        lastLive = now
        if (r.events.length || now - lastSave > 5_000) { lastSave = now; commit({ ...r.state, checked: now }) }
        if (r.events.length) noticeRef.current?.({ events: r.events, caughtUp: null, gap: null })
        // Funding: once an hour has passed since the last one paid, ask for its rates (at most once a minute).
        if (s.positions.length && Math.floor(now / HOUR) * HOUR > s.fundedTo && now - fundingAsked > 60_000) {
          fundingAsked = now
          void payHours(now).catch(() => {})
        }
      } finally { busy = false }
    }

    const id = setInterval(() => { void beat() }, 1_000)
    return () => {
      alive = false
      clearInterval(id)
      try { const l = JSON.parse(localStorage.getItem(LEASE) ?? 'null') as { id?: string } | null; if (l?.id === me) localStorage.removeItem(LEASE) } catch { /* nothing to release */ }
    }
  }, [mids, commit])

  return {
    state,
    catching,
    summary: summarize(state, mids),
    /** Applies an order or a change to the stored account (fresh from storage, so another tab's work isn't lost). */
    run: <T extends { state: PaperState }>(f: (s: PaperState) => T): T => {
      const before = load()
      const r = f(before)
      const now = Date.now()
      const next = { ...r.state }
      // An account that was watching nothing starts watching from now, and its funding from this hour.
      if (!before.orders.length && !before.positions.length) { next.checked = now; next.fundedTo = Math.max(next.fundedTo, Math.floor(now / HOUR) * HOUR) }
      commit(next)
      return { ...r, state: next }
    },
    reset: (amount = PAPER.start) => commit(freshPaper(Date.now(), amount)),
  }
}
export type PaperApi = ReturnType<typeof usePaper>
