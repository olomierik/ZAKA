// The state engine: one market's one-minute candles (the oracle's signed prices, perps/candles.ts)
// turned into one compact numeric state at a candle close. Deterministic and strictly causal: only
// candles that closed at or before `t` are read, and `srcMaxTs` records the latest input, which
// the tests hold to `t`. The state is all the reflex sees; its text form stays under 400 tokens.

import type { AlgoMarket, AlgoState } from '../../../api/_algoProtocol'
import type { PerpsBar } from '../perps/shared'

export const MIN = 60_000

export interface StateInput {
  market: AlgoMarket
  /** One-minute candles [open time, o, h, l, c], oldest first; later ones are ignored. */
  bars: readonly PerpsBar[]
  t: number
  /** The reference major's candles (BTC for ETH and SOL, ETH for BTC). */
  ref?: readonly PerpsBar[] | null
  dispersionBps?: number | null
  inventory?: AlgoState['inventory']
  drawdownPct?: number
  dayPnlPct?: number
  horizonMin: number
}

/** Index one past the last candle closed by `t` (candles are sorted by open time). */
export function closedUpTo(bars: readonly PerpsBar[], t: number, end = bars.length): number {
  let lo = 0, hi = end
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid][0] + MIN <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The close of the last candle closed at or before `at`, among the first `end` candles. */
function closeAt(bars: readonly PerpsBar[], end: number, at: number): number | null {
  const i = closedUpTo(bars, at, end) - 1
  if (i < 0) return null
  // A gap of more than 10 minutes before `at` means the price there isn't known.
  if (at - (bars[i][0] + MIN) > 10 * MIN) return null
  return bars[i][4]
}

const pct = (a: number, b: number) => (Math.log(a / b) * 100)

/** Standard deviation of one-minute log returns (%) over the candles closed in (from, t]. */
function realizedVol(bars: readonly PerpsBar[], end: number, from: number, minCount: number): number | null {
  const r: number[] = []
  for (let i = end - 1; i > 0; i--) {
    if (bars[i][0] < from) break
    if (bars[i][0] - bars[i - 1][0] !== MIN) continue
    r.push(pct(bars[i][4], bars[i - 1][4]))
  }
  if (r.length < minCount) return null
  const mean = r.reduce((s, x) => s + x, 0) / r.length
  const v = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1)
  return Math.sqrt(v)
}

function ema(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  const k = 2 / (n + 1)
  let e = xs.slice(0, n).reduce((s, x) => s + x, 0) / n
  for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k)
  return e
}

/** Five-minute closes from the candles closed by `t` (complete five-minute blocks only). */
function closes5m(bars: readonly PerpsBar[], end: number, t: number): number[] {
  const out: number[] = []
  let block = -1
  // A fixed window (the last ~25 hours) keeps the EMAs the same however much history is loaded.
  for (let i = Math.max(0, end - 1500); i < end; i++) {
    const b = bars[i][0] - (bars[i][0] % (5 * MIN))
    if (b + 5 * MIN > t) break
    if (b === block) out[out.length - 1] = bars[i][4]
    else { out.push(bars[i][4]); block = b }
  }
  return out
}

const round = (x: number | null, d = 4) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)

/** The state at `t`, or null when there isn't an hour of candles yet. */
export function buildState(i: StateInput): AlgoState | null {
  const end = closedUpTo(i.bars, i.t)
  if (end < 61) return null
  const last = i.bars[end - 1]
  if (i.t - (last[0] + MIN) > 5 * MIN) return null // the feed stopped: no state
  const px = last[4]
  const back = (min: number) => { const c = closeAt(i.bars, end, last[0] + MIN - min * MIN); return c ? pct(px, c) : null }
  const rv1h = realizedVol(i.bars, end, last[0] - 59 * MIN, 45)
  const rv24h = realizedVol(i.bars, end, last[0] - 1439 * MIN, 180)
  const rvBase = rv24h ?? rv1h
  const sigma1h = rvBase !== null ? rvBase * Math.sqrt(60) : null // % over an hour
  const c5 = closes5m(i.bars, end, i.t)
  const e20 = ema(c5, 20), e60 = ema(c5, 60)
  const trend = e20 !== null && e60 !== null && sigma1h ? (pct(e20, e60) / sigma1h) : null
  const hour = i.bars.slice(Math.max(0, end - 60), end).filter(b => b[0] >= last[0] - 59 * MIN)
  const mean1h = hour.length >= 45 ? hour.reduce((s, b) => s + b[4], 0) / hour.length : null
  const z1h = mean1h !== null && sigma1h ? pct(px, mean1h) / sigma1h : null
  const prev = i.bars[end - 2]
  const r1m = prev && last[0] - prev[0] === MIN ? pct(px, prev[4]) : null
  const jump = r1m !== null && rv1h ? r1m / rv1h : null
  const day = i.bars.slice(Math.max(0, end - 1440), end).filter(b => b[0] >= last[0] - 1439 * MIN)
  let range24: number | null = null
  if (day.length >= 180) {
    const hi = Math.max(...day.map(b => b[2])), lo = Math.min(...day.map(b => b[3]))
    range24 = hi > lo ? (px - lo) / (hi - lo) : 0.5
  }
  let refR1h: number | null = null, refMax = 0
  if (i.ref && i.ref.length) {
    const re = closedUpTo(i.ref, i.t)
    if (re > 0) {
      const rl = i.ref[re - 1]
      refMax = rl[0] + MIN
      const c = closeAt(i.ref, re, rl[0] + MIN - 60 * MIN)
      if (c && i.t - refMax <= 5 * MIN) refR1h = pct(rl[4], c)
    }
  }
  return {
    market: i.market,
    t: i.t,
    srcMaxTs: Math.max(last[0] + MIN, refMax),
    px,
    r5m: round(back(5)), r15m: round(back(15)), r1h: round(back(60)), r4h: round(back(240)), r24h: round(back(1440)),
    rv1h: round(rv1h, 5), rv24h: round(rv24h, 5),
    volRatio: round(rv1h !== null && rv24h ? rv1h / rv24h : null, 3),
    trend: round(trend, 3), z1h: round(z1h, 3), jump: round(jump, 3), range24: round(range24, 3),
    refR1h: round(refR1h),
    dispersionBps: i.dispersionBps ?? null,
    inventory: i.inventory ?? null,
    drawdownPct: round(i.drawdownPct ?? 0, 3) ?? 0,
    dayPnlPct: round(i.dayPnlPct ?? 0, 3) ?? 0,
    sigmaH: round(rvBase !== null ? rvBase * Math.sqrt(i.horizonMin) : null, 4),
  }
}

const f = (x: number | null, d = 2) => (x === null ? '-' : String(Number(x.toFixed(d))))

/** The compact snapshot: one line, well under 400 tokens. */
export function snapshotText(s: AlgoState): string {
  const inv = s.inventory ? `${s.inventory.side}:${f(s.inventory.uPnlPct)}%:${Math.round(s.inventory.ageMin)}m` : 'flat'
  return [
    `${s.market}@${new Date(s.t).toISOString().slice(0, 16)}Z`,
    `px=${Number(s.px.toPrecision(7))}`,
    `r5m=${f(s.r5m)} r15m=${f(s.r15m)} r1h=${f(s.r1h)} r4h=${f(s.r4h)} r24h=${f(s.r24h)}`,
    `rv1h=${f(s.rv1h, 4)} rv24h=${f(s.rv24h, 4)} vr=${f(s.volRatio)}`,
    `trend=${f(s.trend)} z1h=${f(s.z1h)} jump=${f(s.jump)} rng24=${f(s.range24)} ref1h=${f(s.refR1h)}`,
    `disp=${f(s.dispersionBps, 1)}bps sigH=${f(s.sigmaH)} inv=${inv} dd=${f(s.drawdownPct)} day=${f(s.dayPnlPct)}`,
  ].join(' ')
}

/** A rough token count (four characters a token), for the 400-token budget. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4)
