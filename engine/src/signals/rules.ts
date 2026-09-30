// When a coin is worth a trade, in market terms. Safety is separate (the
// scanner must pass too). Pure functions over a coin's flow and its price
// path, so each rule can be tested and tuned against recorded outcomes.
//
// The thresholds are starting points, not findings: paper trading records
// every signal's outcome (trading/paper.ts), and they change when the
// numbers say so. Nothing here promises a win rate.

import type { Flow } from '../intel/flow'

export const RULES = {
  snipe: {
    /** Let the first blocks' bundlers show before judging. */
    minAgeSec: 20,
    maxAgeSec: 600,
    minBuyers: 8,
    minBuyUsd: 300,
    /** Buy volume at least this many times sell volume. */
    minBuySellRatio: 1.5,
    /** No single buyer above this share of buy volume. */
    maxTopBuyerPct: 25,
    /** Not late: the price hasn't already run this far from its first trade. */
    maxRunUp: 5,
    /** Not already falling: within this share of its peak. */
    minOfPeak: 0.85,
  },
  secondLeg: {
    maxAgeHours: 48,
    /** Ran at least this far from its first price. */
    minPeakMultiple: 10,
    /** Then fell between these shares from the peak. */
    minDrawdown: 0.5,
    maxDrawdown: 0.85,
    /** The bottom held for this long… */
    minMinutesSinceBottom: 10,
    /** …the lows since then stay this far above it (a higher low)… */
    higherLowAbove: 1.05,
    /** …and the price is back this far off the bottom. */
    minBounce: 1.2,
    /** Buying back: last 15 minutes' buy volume at least this many times the sell volume. */
    minBuySellRatio15m: 1.3,
    minBuyUsd15m: 200,
  },
}

export interface RuleResult { ok: boolean; reasons: string[] }

export function snipeReady(f: Flow, ageSec: number, r = RULES.snipe): RuleResult {
  const reasons: string[] = []
  const need = (cond: boolean, pass: string, fail: string) => { reasons.push(cond ? pass : `✗ ${fail}`); return cond }
  const run = f.firstPrice && f.lastPrice ? f.lastPrice / f.firstPrice : null
  const ofPeak = f.peakPrice && f.lastPrice ? f.lastPrice / f.peakPrice : null
  const ok = [
    need(ageSec >= r.minAgeSec && ageSec <= r.maxAgeSec, `${Math.round(ageSec)}s since launch`, `age ${Math.round(ageSec)}s outside ${r.minAgeSec}–${r.maxAgeSec}s`),
    need(f.buyers >= r.minBuyers, `${f.buyers} buyers`, `only ${f.buyers} buyers (need ${r.minBuyers})`),
    need(f.buyUsd >= r.minBuyUsd, `$${Math.round(f.buyUsd)} bought`, `only $${Math.round(f.buyUsd)} bought (need $${r.minBuyUsd})`),
    need(f.buyUsd >= r.minBuySellRatio * f.sellUsd, `buys ${(f.buyUsd / Math.max(1, f.sellUsd)).toFixed(1)}× sells`, `sells too heavy ($${Math.round(f.sellUsd)} vs $${Math.round(f.buyUsd)} bought)`),
    need(f.topBuyerPct <= r.maxTopBuyerPct, `largest buyer ${f.topBuyerPct.toFixed(0)}% of buys`, `one buyer is ${f.topBuyerPct.toFixed(0)}% of buys`),
    need(run !== null && run <= r.maxRunUp, `${run?.toFixed(1)}× from the first trade`, run === null ? 'no price yet' : `already ${run.toFixed(1)}× from the first trade (late)`),
    need(ofPeak !== null && ofPeak >= r.minOfPeak, `${((ofPeak ?? 0) * 100).toFixed(0)}% of its peak`, `already ${(100 - (ofPeak ?? 0) * 100).toFixed(0)}% off its peak`),
  ].every(Boolean)
  return { ok, reasons }
}

/** One minute of a coin's trading. */
export interface Minute { m: number; o: number; h: number; l: number; c: number; bv: number; sv: number }

/** A coin's price and volume by the minute since launch: only minutes that
 * had trades are kept, up to 48 hours. */
export class PricePath {
  readonly minutes: Minute[] = []
  constructor(readonly launchedAt: number, private cap = 2_880) {}
  add(ts: number, price: number | null, side: 'BUY' | 'SELL' | 'UNKNOWN', usd: number) {
    if (price === null || !(price > 0)) return
    const m = Math.floor(ts / 60_000)
    let last = this.minutes[this.minutes.length - 1]
    if (!last || m > last.m) {
      if (this.minutes.length >= this.cap) this.minutes.shift()
      last = { m, o: price, h: price, l: price, c: price, bv: 0, sv: 0 }
      this.minutes.push(last)
    } else if (m < last.m) {
      // Late trade for an earlier minute: find it (rare; keep it simple).
      const e = this.minutes.find(x => x.m === m)
      if (!e) return
      last = e
    }
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price)
    if (m >= this.minutes[this.minutes.length - 1].m) last.c = price
    if (side === 'BUY') last.bv += usd; else if (side === 'SELL') last.sv += usd
  }
}

export function secondLegReady(p: PricePath, now: number, r = RULES.secondLeg): RuleResult & { peak?: number; bottom?: number } {
  const reasons: string[] = []
  const ms = p.minutes
  if (!ms.length) return { ok: false, reasons: ['✗ no trades'] }
  const ageH = (now - p.launchedAt) / 3_600_000
  if (ageH > r.maxAgeHours) return { ok: false, reasons: [`✗ ${ageH.toFixed(0)}h old`] }
  const first = ms[0].o
  let peakI = 0
  ms.forEach((x, i) => { if (x.h > ms[peakI].h) peakI = i })
  const peak = ms[peakI].h
  const after = ms.slice(peakI + 1)
  if (!after.length) return { ok: false, reasons: ['✗ still at its peak'], peak }
  let botI = 0
  after.forEach((x, i) => { if (x.l < after[botI].l) botI = i })
  const bottom = after[botI].l
  const since = after.slice(botI + 1)
  const cur = ms[ms.length - 1].c
  const nowMin = Math.floor(now / 60_000)
  const last15 = ms.filter(x => x.m > nowMin - 15)
  const bv = last15.reduce((s, x) => s + x.bv, 0), sv = last15.reduce((s, x) => s + x.sv, 0)
  const need = (cond: boolean, pass: string, fail: string) => { reasons.push(cond ? pass : `✗ ${fail}`); return cond }
  const draw = 1 - bottom / peak
  const minutesSinceBottom = nowMin - after[botI].m
  const higherLow = since.length > 0 && Math.min(...since.map(x => x.l)) >= bottom * r.higherLowAbove
  const ok = [
    need(peak / first >= r.minPeakMultiple, `ran ${(peak / first).toFixed(1)}× to its peak`, `peak only ${(peak / first).toFixed(1)}× (need ${r.minPeakMultiple}×)`),
    need(draw >= r.minDrawdown && draw <= r.maxDrawdown, `fell ${(draw * 100).toFixed(0)}% from the peak`, `fell ${(draw * 100).toFixed(0)}% (need ${r.minDrawdown * 100}–${r.maxDrawdown * 100}%)`),
    need(minutesSinceBottom >= r.minMinutesSinceBottom, `bottom ${minutesSinceBottom} min ago`, `bottom only ${minutesSinceBottom} min ago`),
    need(higherLow, 'lows since the bottom are higher', 'no higher low yet'),
    need(cur >= bottom * r.minBounce, `${((cur / bottom - 1) * 100).toFixed(0)}% off the bottom`, `only ${((cur / bottom - 1) * 100).toFixed(0)}% off the bottom`),
    need(bv >= r.minBuyUsd15m && bv >= r.minBuySellRatio15m * sv, `last 15 min: $${Math.round(bv)} bought vs $${Math.round(sv)} sold`, `last 15 min: $${Math.round(bv)} bought vs $${Math.round(sv)} sold`),
  ].every(Boolean)
  return { ok, reasons, peak, bottom }
}
