// When the engine buys a side of a BTC Up/Down window (docs/PREDICT-BTC-AUTOTRADE-2026-10.md §7).
//
// Lane A, the sniper: mid-window, take an ask only when the model's chance of that side beats ask + fee by a margin
// (bigger between 40¢ and 60¢, where the fee is highest and the market is most often right). Lane B, the TWAP lock-in:
// inside the last minute, buy the side the observed part of the average all but decides, only below its fair value
// minus the fee. Every order is fill-and-kill against the levels that still clear the margin; nothing rests.
// The engine never buys from a stale picture: no order without a fresh price, a live book, the price to beat, and the
// exchange sources agreeing.

import { takerFee, type UpdownDur, type UpdownExit, type UpdownLane, type UpdownSide } from '../../../api/_updownProtocol'
import type { Level } from './markets'

export const RULES = {
  /** Lane A's margin over ask + fee, and the wider one for asks between 40¢ and 60¢. */
  marginA: 0.10,
  marginMid: 0.15,
  /** Lane B: at least this chance, and this much below it after the fee. */
  minProbB: 0.97,
  marginB: 0.02,
  /** Lane A trades after the window's first 20 s and before its last minute; lane B in the last minute, not the last 3 s. */
  aFromSec: 20,
  bLastSec: 60,
  bStopSec: 3,
  /** Asks under 5¢ or over 98¢ aren't taken (the model's tails are where it's least sure), and lane A only takes
   *  15–85¢: its first live trade (2026-11-01) bought Up at 6¢ on a 20% model and lost, and Polymarket's longshots
   *  are the most overpriced side (the favourite-longshot bias). */
  minAsk: 0.05,
  maxAsk: 0.98,
  minAskA: 0.15,
  maxAskA: 0.85,
  orderUsd: 25,
  windowUsd: 100,
  dailyLossUsd: 150,
  cooldownMs: 15_000,
  /** Fractional Kelly on the all-in cost. */
  kelly: 0.2,
  maxSpreadBp: 10,
  /** Lane A trades only a gap that just opened: the market agreed with the model this many seconds ago, within
   *  `agreeLag`. A gap that was already there is the market knowing something the model doesn't (Chainlink's own
   *  price, mostly), not a stale quote. */
  lagSec: 8,
  agreeLag: 0.07,
  /** Lane B skips a window whose market is further than this from the model. */
  agreeB: 0.10,
  /** The engine aligns its Chainlink estimate with the market in calm moments; it trades once it has this many. */
  alignMin: 30,
  bookStaleMs: 15_000,
  /** Exits (2026-11-01, owner: "take positions and scalp profits"). A position is sold at the bid once the bid, after
   *  the fee, pays the model's value plus `overpay` (the market has caught up, or overshot), and cut once the model
   *  says the side is worth `stop` less than it cost. Replayed on every BTC 5m/15m book of 2026-06-15
   *  (scripts/research-polymarket-scalp.mjs): on 15m windows this made 35–38% of the stake against 12–18% held to the
   *  end, winning 80% of trades with half the swings; on 5m windows holding paid better, so 5m only sells into a 5¢
   *  overpayment (24% against 22–26% held, with a third less swing). Fixed profit targets (+3¢, +5¢, +10¢) and resting
   *  maker asks did worse than both. */
  overpay: { '5m': 0.05, '15m': 0 } as Record<UpdownDur, number>,
  stop: 0.15,
  /** No exits in the last seconds: the sale might not land before the window closes. */
  exitStopSec: 3,
}

export interface DecideInput {
  side: UpdownSide
  /** The model's chance this side wins. */
  p: number
  asks: Level[]
  secondsLeft: number
  elapsed: number
  feeRate: number
  feeExponent: number
}

export interface Intent { lane: UpdownLane; side: UpdownSide; worst: number; edge: number; p: number; ask: number }

/** The best lane's order for one side, or why there's none. */
export function decide(i: DecideInput): Intent | { why: string } {
  const top = i.asks[0]
  if (!top) return { why: 'no asks' }
  if (top.price < RULES.minAsk || top.price > RULES.maxAsk) return { why: 'ask outside 5–98¢' }
  const cost = (p: number) => p + takerFee(p, i.feeRate, i.feeExponent)
  let lane: UpdownLane, margin: number
  if (i.secondsLeft <= RULES.bLastSec) {
    if (i.secondsLeft < RULES.bStopSec) return { why: 'closing' }
    if (i.p < RULES.minProbB) return { why: 'last minute, not decided' }
    lane = 'B'; margin = RULES.marginB
  } else {
    if (i.elapsed < RULES.aFromSec) return { why: 'window just opened' }
    if (top.price < RULES.minAskA || top.price > RULES.maxAskA) return { why: 'mid-window, ask outside 15–85¢' }
    lane = 'A'; margin = top.price >= 0.4 && top.price <= 0.6 ? RULES.marginMid : RULES.marginA
  }
  const edge = i.p - cost(top.price)
  if (edge < margin) return { why: `edge ${(edge * 100).toFixed(1)}¢ under ${(margin * 100).toFixed(0)}¢` }
  // The worst price still worth taking: the highest level whose cost leaves the margin.
  let worst = top.price
  for (const l of i.asks) { if (i.p - cost(l.price) >= margin) worst = l.price; else break }
  return { lane, side: i.side, worst, edge, p: i.p, ask: top.price }
}

/** How much to put on an intent: fractional Kelly on the bankroll, within the order and window caps. */
export function sizeUsd(p: number, ask: number, feeRate: number, bankroll: number, windowLeft: number): number {
  const c = ask + takerFee(ask, feeRate)
  const f = c >= 1 ? 0 : Math.max(0, (p - c) / (1 - c))
  return Math.max(0, Math.min(RULES.orderUsd, windowLeft, bankroll * f * RULES.kelly))
}

/** Fill-and-kill against the book as it is when the order lands: levels up to `worst`, up to `usd` all in (fees too). */
export function fillFak(asks: Level[], worst: number, usd: number, feeRate: number, feeExponent = 1) {
  let shares = 0, spent = 0, fee = 0
  for (const l of asks) {
    if (l.price > worst + 1e-9 || spent + fee >= usd - 1e-9) break
    const per = l.price + takerFee(l.price, feeRate, feeExponent)
    const take = Math.min(l.size, (usd - spent - fee) / per)
    shares += take; spent += take * l.price; fee += take * takerFee(l.price, feeRate, feeExponent)
  }
  return { shares, spent, fee, avg: shares > 0 ? spent / shares : 0 }
}

export interface ExitInput {
  dur: UpdownDur
  /** The model's chance this side wins, now. */
  p: number
  /** What a share of the position cost, fees included. */
  costPerShare: number
  bids: Level[]
  secondsLeft: number
  feeRate: number
  feeExponent: number
}

/** Whether to sell an open position now, and the lowest price worth selling at; or why not. */
export function exitDecision(i: ExitInput): { why: UpdownExit; floor: number } | { hold: string } {
  if (i.secondsLeft < RULES.exitStopSec) return { hold: 'closing' }
  const top = i.bids[0]
  if (!top) return { hold: 'no bids' }
  const net = (p: number) => p - takerFee(p, i.feeRate, i.feeExponent)
  const want = i.p + RULES.overpay[i.dur]
  if (net(top.price) >= want) {
    // The lowest level that still pays the model's value plus the overpayment.
    let floor = top.price
    for (const l of i.bids) { if (net(l.price) >= want) floor = l.price; else break }
    return { why: 'scalp', floor }
  }
  if (i.p < i.costPerShare - RULES.stop) return { why: 'stop', floor: Math.max(0.01, top.price - 0.03) }
  return { hold: 'holding' }
}

/** A fill-and-kill sale against the bids as they are when it lands: levels down to `floor`, up to `shares`, each
 *  share paying its price less the taker fee. */
export function sellFak(bids: Level[], floor: number, shares: number, feeRate: number, feeExponent = 1) {
  let sold = 0, gross = 0, fee = 0
  for (const l of bids) {
    if (l.price < floor - 1e-9 || sold >= shares - 1e-9) break
    const take = Math.min(l.size, shares - sold)
    sold += take; gross += take * l.price; fee += take * takerFee(l.price, feeRate, feeExponent)
  }
  return { shares: sold, gross, fee, proceeds: gross - fee, avg: sold > 0 ? gross / sold : 0 }
}
