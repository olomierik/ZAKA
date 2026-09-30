// How a visitor's bot improves itself (owner's request, 2026-09-30: "the bot
// reads the logs of the loss trades and improves each user's strategies, so
// the win rate increases"). Each bot has its own settings per strategy (a
// StrategyTuning): its exits, the profit a trade is sized for, and entry
// filters on the numbers every signal carries (SignalFeatures). After its
// trades close, the learner reads the losing ones and changes one thing at a
// time, within fixed bounds, saying why in words:
//
//   rugs and dumps      losses closed by the rug guard, the creator selling or
//                       a failed re-check: more liquidity and a higher safety
//                       score needed, and the risk flags those coins shared
//                       are skipped
//   near misses         losers that rose most of the way to the take-profit
//                       before turning: the take-profit comes closer (and the
//                       size grows to keep the same dollar target)
//   fast stop-outs      stopped within a minute or two: it bought into
//                       selling, so buys must outweigh sells more, and coins
//                       that had already run that far are skipped
//   time-outs           never moved: more buyers needed
//   one number          a threshold on one feature (liquidity, buyers,
//                       buys ÷ sells, safety score, run-up, largest buyer)
//                       that would have kept out most losses and few wins
//
// Every change is a new version. A version that then wins clearly less often
// than the one before it is rolled back, and filters that keep the bot from
// trading at all are loosened again, so learning can't lock a bot up.
// Nothing here promises a win rate: it only stops repeating what lost.

import type { BotFilters, LearnNote, SignalFeatures, StrategyTuning } from '../../../api/_marketProtocol'
import type { Position, Strategy, StrategyParams } from '../trading/paper'
import { TARGETS } from './sizing'

/** A bot's tuning for one strategy, and the version before it (for a rollback). */
export type Tuning = StrategyTuning & { prev?: StrategyTuning | null }

/** No filtering beyond the signal engine's own rules (the scanner already needs $1,000 of liquidity). */
export const OPEN_FILTERS: BotFilters = { minLiquidityUsd: 1_000, minBuyers: 0, minBuySellRatio: 0, maxRunUp: 100, minScore: 0, maxTopBuyerPct: 100, avoidFlags: [] }

const EXITS: Record<Strategy, Pick<StrategyTuning, 'takeProfit' | 'stopLoss' | 'timeStopMin' | 'maxHoldMin'>> = {
  scalp: { takeProfit: 1.15, stopLoss: 0.9, timeStopMin: 3, maxHoldMin: 10 },
  snipe: { takeProfit: 1.4, stopLoss: 0.8, timeStopMin: 20, maxHoldMin: 60 },
  'second-leg': { takeProfit: 1.35, stopLoss: 0.85, timeStopMin: 120, maxHoldMin: 360 },
}

/** How far learning may move a take-profit. */
export const TP_BOUNDS: Record<Strategy, [number, number]> = { scalp: [1.06, 1.3], snipe: [1.15, 2], 'second-leg': [1.15, 1.8] }
export const FILTER_CAPS = { minLiquidityUsd: 25_000, minBuyers: 40, minBuySellRatio: 4, maxRunUp: 1.02, minScore: 90, maxTopBuyerPct: 10 }

export const LEARN = {
  /** The trades read: the last 20 of the strategy. */
  window: 20,
  minTrades: 6,
  minLosses: 3,
  /** A version is judged on at least this many of its own trades before the next change. */
  perVersion: 5,
  /** A pattern counts when this share of the losses shows it. */
  share: 0.3,
  /** Rolled back after this many trades if its win rate is this far under the version before. */
  rollbackAfter: 8,
  rollbackGap: 0.1,
  /** Loosened after this many signals skipped by learned filters, with no trade for this long. */
  relaxAfterSkips: 15,
  relaxAfterMs: 2 * 3_600_000,
}

export function defaultTuning(s: Strategy): Tuning {
  return { version: 1, ...EXITS[s], targetUsd: TARGETS[s].target, filters: { ...OPEN_FILTERS, avoidFlags: [] }, changedAt: null, basis: null, prev: null }
}

/** The exits a position opened with this tuning trades with: everything sold at the take-profit. */
export function toParams(t: StrategyTuning, sizeUsd: number): StrategyParams {
  return {
    sizeUsd, stopLoss: t.stopLoss, tp1Multiple: t.takeProfit, tp1SellPct: 1, trailFromPeak: 0.2,
    // A time stop keeps a position only if it's a fifth of the way to the take-profit.
    timeStopMin: t.timeStopMin, timeStopMinGain: 1 + (t.takeProfit - 1) * 0.2, maxHoldMin: t.maxHoldMin,
    exitOnCreatorSell: true,
  }
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const pct = (x: number) => `${Math.round(x * 100)}%`
const gain = (m: number) => `+${Math.round((m - 1) * 100)}%`

/** Why a bot with this tuning won't take a signal, or null if it will. Signals without features are taken. */
export function admits(t: StrategyTuning, f: SignalFeatures | undefined): string | null {
  if (!f) return null
  const x = t.filters
  if (f.liquidityUsd !== null && f.liquidityUsd < x.minLiquidityUsd) return `liquidity ${money(f.liquidityUsd)} is under its learned minimum ${money(x.minLiquidityUsd)}`
  if (f.buyers < x.minBuyers) return `${f.buyers} buyers, it now needs ${x.minBuyers}`
  if ((f.buySellRatio ?? Infinity) < x.minBuySellRatio) return `buys only ${f.buySellRatio!.toFixed(1)}× sells, it now needs ${x.minBuySellRatio.toFixed(2)}×`
  if (f.runUp !== null && f.runUp > x.maxRunUp) return `already ${gain(f.runUp)}, it skips coins up more than ${gain(x.maxRunUp)}`
  if (f.score < x.minScore) return `safety score ${f.score}, it now needs ${x.minScore}`
  if (f.topBuyerPct > x.maxTopBuyerPct) return `one buyer is ${Math.round(f.topBuyerPct)}% of buys, it allows ${Math.round(x.maxTopBuyerPct)}%`
  const flag = f.flags.find(g => x.avoidFlags.includes(g))
  if (flag) return `flagged "${flag}", which it learned to skip`
  return null
}

const won = (p: Position) => (p.pnlUsd ?? 0) > 0
const RUGGY = new Set(['rug', 'creator', 'safety'])

type NumFilter = Exclude<keyof BotFilters, 'avoidFlags'>
interface Feature { key: 'liquidityUsd' | 'buyers' | 'buySellRatio' | 'score' | 'runUp' | 'topBuyerPct'; dir: 'min' | 'max'; filter: NumFilter; label: string; fmt: (v: number) => string }
const FEATURES: Feature[] = [
  { key: 'liquidityUsd', dir: 'min', filter: 'minLiquidityUsd', label: 'liquidity', fmt: money },
  { key: 'buyers', dir: 'min', filter: 'minBuyers', label: 'buyers', fmt: v => String(Math.round(v)) },
  { key: 'buySellRatio', dir: 'min', filter: 'minBuySellRatio', label: 'buys ÷ sells', fmt: v => `${v.toFixed(2)}×` },
  { key: 'score', dir: 'min', filter: 'minScore', label: 'safety score', fmt: v => String(Math.round(v)) },
  { key: 'runUp', dir: 'max', filter: 'maxRunUp', label: 'run-up before entry', fmt: gain },
  { key: 'topBuyerPct', dir: 'max', filter: 'maxTopBuyerPct', label: 'largest buyer', fmt: v => `${Math.round(v)}%` },
]
const valueOf = (p: Position, k: Feature['key']): number | null => {
  const f = p.features
  if (!f) return null
  if (k === 'buySellRatio') return f.buySellRatio ?? 99 // no sells at all: as strong as it gets
  return f[k] ?? null
}
const capped = (filter: NumFilter, v: number) => {
  const cap = FILTER_CAPS[filter]
  return filter === 'maxRunUp' || filter === 'maxTopBuyerPct' ? Math.max(cap, v) : Math.min(cap, v)
}

/** The one threshold that would have kept out the most losses for the fewest wins, if it's clearly worth it. */
function bestThreshold(t: StrategyTuning, trades: Position[]): { f: Feature; th: number; lost: number; wins: number; L: number; W: number } | null {
  let best: { f: Feature; th: number; lost: number; wins: number; L: number; W: number; score: number } | null = null
  for (const f of FEATURES) {
    const rows = trades.map(p => ({ v: valueOf(p, f.key), win: won(p) })).filter((r): r is { v: number; win: boolean } => r.v !== null)
    if (rows.length < 10) continue
    const L = rows.filter(r => !r.win).length, W = rows.length - L
    if (L < LEARN.minLosses) continue
    const values = [...new Set(rows.map(r => r.v))].sort((a, b) => a - b)
    for (const c of new Set(rows.filter(r => !r.win).map(r => r.v))) {
      // min: require at least the next value above c; max: at most the next below it.
      const i = values.indexOf(c)
      const th = f.dir === 'min' ? values[i + 1] : values[i - 1]
      if (th === undefined) continue
      const out = (v: number) => (f.dir === 'min' ? v < th : v > th)
      const lost = rows.filter(r => !r.win && out(r.v)).length, wins = rows.filter(r => r.win && out(r.v)).length
      if (lost < Math.max(2, Math.ceil(0.4 * L)) || wins > 0.2 * W || rows.length - lost - wins < 4) continue
      const tighter = f.dir === 'min' ? th > t.filters[f.filter] : th < t.filters[f.filter]
      if (!tighter) continue
      const score = lost / L - wins / Math.max(1, W)
      if (!best || score > best.score) best = { f, th, lost, wins, L, W, score }
    }
  }
  return best
}

const strip = (t: Tuning): StrategyTuning => { const { prev: _prev, ...rest } = t; return structuredClone(rest) }

/**
 * Reads a strategy's closed trades (oldest first) and returns the bot's next
 * tuning with notes, or null if there's nothing to change yet.
 */
export function learn(t: Tuning, s: Strategy, trades: Position[], now: number): { tuning: Tuning; notes: LearnNote[] } | null {
  const closed = trades.filter(p => p.status === 'closed')
  const cur = closed.filter(p => (p.tuningVersion ?? 0) === t.version)
  const winsOf = (xs: Position[]) => xs.filter(won).length
  const note = (version: number, kind: LearnNote['kind'], text: string): LearnNote => ({ at: now, strategy: s, version, kind, text })

  // A change that did clearly worse than the settings before it goes back.
  if (t.prev && t.basis && t.basis.trades >= LEARN.perVersion && cur.length >= LEARN.rollbackAfter) {
    const wr = winsOf(cur) / cur.length, before = t.basis.wins / t.basis.trades
    if (wr + LEARN.rollbackGap < before) {
      const version = t.version + 1
      return {
        tuning: { ...structuredClone(t.prev), version, changedAt: now, basis: { trades: cur.length, wins: winsOf(cur) }, prev: null },
        notes: [note(version, 'revert', `Rolled back version ${t.version}: it won ${pct(wr)} of ${cur.length} trades, the settings before it ${pct(before)} of ${t.basis.trades}.`)],
      }
    }
  }

  if (cur.length < LEARN.perVersion) return null
  const w = closed.slice(-LEARN.window)
  if (w.length < LEARN.minTrades) return null
  const losses = w.filter(p => !won(p)), wins = w.filter(won)
  if (losses.length < LEARN.minLosses) return null

  const next: Tuning = { ...structuredClone(strip(t)), prev: null }
  const f = next.filters
  const notes: { kind: LearnNote['kind']; text: string }[] = []
  const share = (xs: Position[]) => xs.length / losses.length
  const wr = wins.length / w.length

  // Rugs and dumps.
  const rugs = losses.filter(p => RUGGY.has(p.exitReason ?? ''))
  if (rugs.length >= 2 && share(rugs) >= LEARN.share) {
    const liq = capped('minLiquidityUsd', Math.round((Math.max(f.minLiquidityUsd, OPEN_FILTERS.minLiquidityUsd) * 1.5) / 100) * 100)
    const score = capped('minScore', f.minScore + 5)
    const counts = new Map<string, number>()
    for (const p of rugs) for (const g of p.features?.flags ?? []) counts.set(g, (counts.get(g) ?? 0) + 1)
    const flags = [...counts].filter(([g, n]) => {
      if (n < Math.ceil(rugs.length / 2) || f.avoidFlags.includes(g)) return false
      const withFlag = w.filter(p => p.features?.flags.includes(g))
      return winsOf(withFlag) / withFlag.length < wr
    }).map(([g]) => g)
    if (liq > f.minLiquidityUsd || score > f.minScore || flags.length) {
      f.minLiquidityUsd = liq; f.minScore = score; f.avoidFlags = [...f.avoidFlags, ...flags]
      notes.push({ kind: 'tighten', text: `${rugs.length} of ${losses.length} losses were rugs or dumps: it now needs ${money(liq)} of liquidity and a safety score of ${score}${flags.length ? `, and skips coins flagged ${flags.map(g => `"${g}"`).join(', ')}` : ''}.` })
    }
  }

  // Near misses: the take-profit was too far.
  const tpOf = (p: Position) => p.exits?.tp1Multiple ?? t.takeProfit
  const near = losses.filter(p => p.marketEntry > 0 && p.peak / p.marketEntry >= 1 + 0.6 * (tpOf(p) - 1))
  if (near.length >= 2 && share(near) >= LEARN.share) {
    const [lo] = TP_BOUNDS[s]
    const tp = Math.max(lo, Math.round((1 + (t.takeProfit - 1) * 0.85) * 1_000) / 1_000)
    if (tp < t.takeProfit - 0.004) {
      next.takeProfit = tp
      notes.push({ kind: 'exit', text: `${near.length} losing trades rose most of the way to ${gain(t.takeProfit)} before turning: it takes profit at ${gain(tp)} now (each trade is sized up to keep the $${t.targetUsd} target).` })
    }
  }

  // Stopped out fast: it bought into selling.
  const fastMs = s === 'scalp' ? 90_000 : 180_000
  const fast = losses.filter(p => p.exitReason === 'stop' && (p.closedAt ?? 0) - p.openedAt <= fastMs)
  if (fast.length >= 2 && share(fast) >= LEARN.share) {
    const ratio = Math.min(FILTER_CAPS.minBuySellRatio, Math.round((Math.max(f.minBuySellRatio, 1) + 0.25) * 100) / 100)
    const runUps = fast.map(p => p.features?.runUp).filter((x): x is number => typeof x === 'number' && x > 1).sort((a, b) => a - b)
    const median = runUps.length >= 2 ? runUps[Math.floor(runUps.length / 2)] : null
    const runUp = median !== null ? capped('maxRunUp', Math.round(Math.min(f.maxRunUp, median) * 100) / 100) : f.maxRunUp
    if (ratio > f.minBuySellRatio || runUp < f.maxRunUp) {
      f.minBuySellRatio = ratio; f.maxRunUp = runUp
      notes.push({ kind: 'tighten', text: `${fast.length} losses were stopped out within ${fastMs / 60_000 >= 2 ? `${fastMs / 60_000} minutes` : '90 seconds'} (bought into selling): buys must now be at least ${ratio}× sells${runUp < 100 ? `, and it skips coins already up more than ${gain(runUp)}` : ''}.` })
    }
  }

  // Timed out without moving.
  const slow = losses.filter(p => p.exitReason === 'time')
  if (slow.length >= 2 && slow.length / losses.length >= 0.4) {
    const buyers = capped('minBuyers', f.minBuyers + 2)
    if (buyers > f.minBuyers) {
      f.minBuyers = buyers
      notes.push({ kind: 'tighten', text: `${slow.length} losses timed out without moving: it now needs ${buyers} buyers.` })
    }
  }

  // One number that separates the losses from the wins.
  const b = bestThreshold(next, w)
  if (b) {
    const th = capped(b.f.filter, b.th)
    const tighter = b.f.dir === 'min' ? th > f[b.f.filter] : th < f[b.f.filter]
    if (tighter) {
      f[b.f.filter] = th
      notes.push({ kind: 'tighten', text: `${b.lost} of ${b.L} losses had ${b.f.label} ${b.f.dir === 'min' ? 'under' : 'over'} ${b.f.fmt(th)}, only ${b.wins} of ${b.W} wins did: it now needs ${b.f.label} ${b.f.dir === 'min' ? 'of at least' : 'of at most'} ${b.f.fmt(th)}.` })
    }
  }

  if (!notes.length) return null
  const version = t.version + 1
  Object.assign(next, { version, changedAt: now, basis: { trades: cur.length, wins: winsOf(cur) }, prev: strip(t) })
  return { tuning: next, notes: notes.map(n => note(version, n.kind, n.text)) }
}

/** Filters that kept the bot from trading at all come partway back toward open. */
export function relax(t: Tuning, s: Strategy, skipped: number, lastBuyAt: number | null, now: number): { tuning: Tuning; notes: LearnNote[] } | null {
  const f = t.filters
  const open = OPEN_FILTERS
  const tight = (Object.keys(open) as (keyof BotFilters)[]).some(k => k === 'avoidFlags' ? f.avoidFlags.length > 0 : f[k] !== open[k])
  if (!tight || skipped < LEARN.relaxAfterSkips || now - Math.max(lastBuyAt ?? 0, t.changedAt ?? 0) < LEARN.relaxAfterMs) return null
  const next: Tuning = { ...structuredClone(strip(t)), prev: strip(t) }
  const back = (k: NumFilter, digits: number) => { const v = f[k] + (open[k] - f[k]) * 0.4; next.filters[k] = Math.round(v * 10 ** digits) / 10 ** digits }
  back('minLiquidityUsd', -2); back('minBuyers', 0); back('minBuySellRatio', 2); back('maxRunUp', 2); back('minScore', 0); back('maxTopBuyerPct', 0)
  next.filters.avoidFlags = f.avoidFlags.slice(0, -1)
  const version = t.version + 1
  Object.assign(next, { version, changedAt: now, basis: t.basis })
  const hours = Math.round((now - Math.max(lastBuyAt ?? 0, t.changedAt ?? 0)) / 3_600_000)
  return { tuning: next, notes: [{ at: now, strategy: s, version, kind: 'loosen', text: `Its filters skipped ${skipped} signals in ${hours}h without a trade: loosened them partway back.` }] }
}
