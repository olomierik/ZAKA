// When a coin is worth a trade, in market terms. Safety is separate (the
// scanner must pass too). Pure functions over a coin's flow and its price
// path, so each rule can be tested and tuned against recorded outcomes.
//
// The thresholds are starting points, not findings: paper trading records
// every signal's outcome (trading/paper.ts), and they change when the
// numbers say so. Nothing here promises a win rate.

import type { Flow, Window } from '../intel/flow'

// 2026-09-30, owner's request: "trades within 2 minutes, not waiting for
// 10×; we only need $1–5 a trade". Loosened for small, quick targets: snipes
// 6 buyers and $200 (were 8 and $300), buys 1.3× sells (1.5×); scalps from
// 60s old, 3 buyers, $100, 1.6× (90s, 4, $150, 2×), a 2% move (3%) and
// $2,000 of liquidity ($2,500); the second leg is a dip rebound: a 2× run
// (was 10×), a 25–70% pullback (50–85%), 3 minutes off the bottom (10), 8%
// up from it (20%), $100 bought in 15 minutes (200). The rug guard and the
// safety scan stay as strict as they were.
export const RULES = {
  snipe: {
    /** Let the first blocks' bundlers show before judging. */
    minAgeSec: 20,
    maxAgeSec: 600,
    minBuyers: 6,
    minBuyUsd: 200,
    /** Buy volume at least this many times sell volume. */
    minBuySellRatio: 1.3,
    /** No single buyer above this share of buy volume. */
    maxTopBuyerPct: 25,
    /** Not late: the price hasn't already run this far from its first trade. */
    maxRunUp: 5,
    /** Not already falling: within this share of its peak. */
    minOfPeak: 0.85,
  },
  /** Fast scalp on momentum (owner's request, 2026-09-30: "scan many coins and fast scalp for
   * 1 to 2 dollar profits"): a burst of real buying on any coin of the last 48 hours. */
  scalp: {
    /** The window read: the last 2 minutes. */
    windowSec: 120,
    /** After the first minute's bundlers and bots have shown. */
    minAgeSec: 60,
    minBuyers: 3,
    minBuyUsd: 100,
    /** Buy volume at least this many times sell volume in the window. */
    minBuySellRatio: 1.6,
    /** The price up at least this much in the window, and not more than this (not the top of a spike). */
    minMove: 1.02,
    maxMove: 1.35,
    /** Still near the window's high. */
    minOfHigh: 0.92,
    /** No single buyer above this share of the window's buys. */
    maxTopBuyerPct: 40,
    /** Deep enough that a $1–2 profit survives the costs. */
    minLiquidityUsd: 2_000,
    /** The same coin scalped again only after this long. */
    repeatMin: 30,
  },
  /** A dip rebound: a coin that ran, pulled back and is being bought again. */
  secondLeg: {
    maxAgeHours: 48,
    /** Ran at least this far from its first price. */
    minPeakMultiple: 2,
    /** Then fell between these shares from the peak. */
    minDrawdown: 0.25,
    maxDrawdown: 0.7,
    /** The bottom held for this long… */
    minMinutesSinceBottom: 3,
    /** …the lows since then stay this far above it (a higher low)… */
    higherLowAbove: 1.03,
    /** …and the price is back this far off the bottom. */
    minBounce: 1.08,
    /** Buying back: last 15 minutes' buy volume at least this many times the sell volume. */
    minBuySellRatio15m: 1.2,
    minBuyUsd15m: 100,
    /** Fired again on the same coin after this long. */
    repeatMin: 60,
  },
}

/** `failed`: short ids of the unmet conditions ("buyers", "ratio"…), counted by the scanner (GET /v1/bot/rejections). */
export interface RuleResult { ok: boolean; reasons: string[]; failed: string[] }

/**
 * A snipe: real buying in a coin's first minutes. It reads the market's own
 * buying (`Flow.organic`: the creator's buys and the launch blocks' left out),
 * so a dev buy at launch neither blocks it ("one buyer is 80% of buys") nor
 * passes it on its own ("$2,500 bought").
 */
export function snipeReady(flow: Flow, ageSec: number, r = RULES.snipe): RuleResult {
  const reasons: string[] = []
  const failed: string[] = []
  const need = (id: string, cond: boolean, pass: string, fail: string) => { reasons.push(cond ? pass : `✗ ${fail}`); if (!cond) failed.push(id); return cond }
  const f = flow.organic
  const run = f.firstPrice && f.lastPrice ? f.lastPrice / f.firstPrice : null
  const ofPeak = f.peakPrice && f.lastPrice ? f.lastPrice / f.peakPrice : null
  const ok = [
    need('age', ageSec >= r.minAgeSec && ageSec <= r.maxAgeSec, `${Math.round(ageSec)}s since launch`, `age ${Math.round(ageSec)}s outside ${r.minAgeSec}–${r.maxAgeSec}s`),
    need('buyers', f.buyers >= r.minBuyers, `${f.buyers} buyers since launch`, `only ${f.buyers} buyers since launch (need ${r.minBuyers})`),
    need('bought', f.buyUsd >= r.minBuyUsd, `$${Math.round(f.buyUsd)} bought since launch`, `only $${Math.round(f.buyUsd)} bought since launch (need $${r.minBuyUsd}; the creator's buys don't count)`),
    need('ratio', f.buyUsd >= r.minBuySellRatio * f.sellUsd, `buys ${(f.buyUsd / Math.max(1, f.sellUsd)).toFixed(1)}× sells`, `sells too heavy ($${Math.round(f.sellUsd)} vs $${Math.round(f.buyUsd)} bought)`),
    need('topbuyer', f.topBuyerPct <= r.maxTopBuyerPct, `largest buyer ${f.topBuyerPct.toFixed(0)}% of buys`, `one buyer is ${f.topBuyerPct.toFixed(0)}% of buys`),
    need('late', run !== null && run <= r.maxRunUp, `${run?.toFixed(1)}× from the first trade`, run === null ? 'no price yet' : `already ${run.toFixed(1)}× from the first trade (late)`),
    need('offpeak', ofPeak !== null && ofPeak >= r.minOfPeak, `${((ofPeak ?? 0) * 100).toFixed(0)}% of its peak`, `already ${(100 - (ofPeak ?? 0) * 100).toFixed(0)}% off its peak`),
  ].every(Boolean)
  return { ok, reasons, failed }
}

/** A momentum scalp: the last 2 minutes of a coin's trading (`w`, from the recent tape). */
export function scalpReady(w: Window, ageSec: number, liquidityUsd: number | null, r = RULES.scalp): RuleResult {
  const reasons: string[] = []
  const failed: string[] = []
  const need = (id: string, cond: boolean, pass: string, fail: string) => { reasons.push(cond ? pass : `✗ ${fail}`); if (!cond) failed.push(id); return cond }
  const move = w.firstPrice && w.lastPrice ? w.lastPrice / w.firstPrice : null
  const ofHigh = w.high && w.lastPrice ? w.lastPrice / w.high : null
  const pct = (x: number) => `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`
  const ok = [
    need('age', ageSec >= r.minAgeSec, `${Math.round(ageSec / 60)} min old`, `only ${Math.round(ageSec)}s old (scalps from ${r.minAgeSec}s)`),
    need('buyers', w.buyers >= r.minBuyers, `${w.buyers} buyers in 2 min`, `${w.buyers} buyers in 2 min (need ${r.minBuyers})`),
    need('bought', w.buyUsd >= r.minBuyUsd, `$${Math.round(w.buyUsd)} bought in 2 min`, `$${Math.round(w.buyUsd)} bought in 2 min (need $${r.minBuyUsd})`),
    need('ratio', w.buyUsd >= r.minBuySellRatio * w.sellUsd, `buys ${(w.buyUsd / Math.max(1, w.sellUsd)).toFixed(1)}× sells`, `buys only ${(w.buyUsd / Math.max(1, w.sellUsd)).toFixed(1)}× sells (need ${r.minBuySellRatio}×)`),
    need('move', move !== null && move >= r.minMove && move <= r.maxMove, move !== null ? `${pct(move)} in 2 min` : '', move === null ? 'no price move yet' : move < r.minMove ? `${pct(move)} in 2 min (need ${pct(r.minMove)})` : `${pct(move)} in 2 min: a spike, too late`),
    need('offhigh', ofHigh !== null && ofHigh >= r.minOfHigh, `${((ofHigh ?? 0) * 100).toFixed(0)}% of its 2-min high`, `${(100 - (ofHigh ?? 0) * 100).toFixed(0)}% off its 2-min high`),
    need('topbuyer', w.topBuyerPct <= r.maxTopBuyerPct, `largest buyer ${w.topBuyerPct.toFixed(0)}% of buys`, `one buyer is ${w.topBuyerPct.toFixed(0)}% of the buying`),
    need('liquidity', liquidityUsd !== null && liquidityUsd >= r.minLiquidityUsd, `$${Math.round(liquidityUsd ?? 0).toLocaleString('en-US')} liquidity`, `liquidity $${Math.round(liquidityUsd ?? 0).toLocaleString('en-US')} (need $${r.minLiquidityUsd.toLocaleString('en-US')} for a scalp)`),
  ].every(Boolean)
  return { ok, reasons, failed }
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
  if (!ms.length) return { ok: false, reasons: ['✗ no trades'], failed: ['notrades'] }
  const ageH = (now - p.launchedAt) / 3_600_000
  if (ageH > r.maxAgeHours) return { ok: false, reasons: [`✗ ${ageH.toFixed(0)}h old`], failed: ['age'] }
  const first = ms[0].o
  let peakI = 0
  ms.forEach((x, i) => { if (x.h > ms[peakI].h) peakI = i })
  const peak = ms[peakI].h
  const after = ms.slice(peakI + 1)
  if (!after.length) return { ok: false, reasons: ['✗ still at its peak'], failed: ['atpeak'], peak }
  let botI = 0
  after.forEach((x, i) => { if (x.l < after[botI].l) botI = i })
  const bottom = after[botI].l
  const since = after.slice(botI + 1)
  const cur = ms[ms.length - 1].c
  const nowMin = Math.floor(now / 60_000)
  const last15 = ms.filter(x => x.m > nowMin - 15)
  const bv = last15.reduce((s, x) => s + x.bv, 0), sv = last15.reduce((s, x) => s + x.sv, 0)
  const failed: string[] = []
  const need = (id: string, cond: boolean, pass: string, fail: string) => { reasons.push(cond ? pass : `✗ ${fail}`); if (!cond) failed.push(id); return cond }
  const draw = 1 - bottom / peak
  const minutesSinceBottom = nowMin - after[botI].m
  const higherLow = since.length > 0 && Math.min(...since.map(x => x.l)) >= bottom * r.higherLowAbove
  const ok = [
    need('peak', peak / first >= r.minPeakMultiple, `ran ${(peak / first).toFixed(1)}× to its peak`, `peak only ${(peak / first).toFixed(1)}× (need ${r.minPeakMultiple}×)`),
    need('drawdown', draw >= r.minDrawdown && draw <= r.maxDrawdown, `fell ${(draw * 100).toFixed(0)}% from the peak`, `fell ${(draw * 100).toFixed(0)}% (need ${r.minDrawdown * 100}–${r.maxDrawdown * 100}%)`),
    need('bottom', minutesSinceBottom >= r.minMinutesSinceBottom, `bottom ${minutesSinceBottom} min ago`, `bottom only ${minutesSinceBottom} min ago`),
    need('higherlow', higherLow, 'lows since the bottom are higher', 'no higher low yet'),
    need('bounce', cur >= bottom * r.minBounce, `${((cur / bottom - 1) * 100).toFixed(0)}% off the bottom`, `only ${((cur / bottom - 1) * 100).toFixed(0)}% off the bottom`),
    need('buying', bv >= r.minBuyUsd15m && bv >= r.minBuySellRatio15m * sv, `last 15 min: $${Math.round(bv)} bought vs $${Math.round(sv)} sold`, `last 15 min: $${Math.round(bv)} bought vs $${Math.round(sv)} sold`),
  ].every(Boolean)
  return { ok, reasons, failed, peak, bottom }
}
