// How a visitor's bot improves itself (owner's request, 2026-09-30: "the bot
// reads the logs of the loss trades and improves each user's strategies, so
// the win rate increases"). Each bot has its own settings per strategy (a
// StrategyTuning): its exits, the profit a trade is sized for, and entry
// filters on the numbers every signal carries (SignalFeatures). After its
// trades close, the learner reads the losing ones and changes what they show,
// within fixed bounds, saying why in words:
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
//   a losing kind       a kind of signal that lost 3 of its last 4 or worse
//                       for this bot is skipped, and tried again 12 hours later
//
// Entry filters are learned per kind of signal (2026-10-01): a fast scalp
// comes from momentum bursts (buyers counted over two minutes: 6–30) and from
// snipes on risky coins (buyers since launch: 30–450), so a buyer count learned
// on one blocked every signal of the other, and bots stopped trading.
//
// The bots are a team (owner's request: "learn from other bots, paper or
// live; work together as a team"). Every bot reads the team's closed trades
// of each kind of signal too (`shared`: every other bot's, paper and live, and
// the engine's own paper book, one per signal), the last 20 beside its own
// last 20. So a new bot learns before its first trade closes, and every bot
// learns from signals it didn't take. Exits are still learned from its own
// trades only: they depend on its own settings.
//
// Every change is a new version. A version that then wins clearly less often
// than the one before it is rolled back, and filters that keep the bot from
// trading at all are loosened again, so learning can't lock a bot up.
// Nothing here promises a win rate: it only stops repeating what lost.

import type { BotFilters, LearnNote, SignalFeatures, SignalRule, StrategyTuning } from '../../../api/_marketProtocol'
import type { Position, Strategy, StrategyParams } from '../trading/paper'
import { TARGETS } from './sizing'

/** A bot's tuning for one strategy, and the version before it (for a rollback). */
export type Tuning = StrategyTuning & { prev?: StrategyTuning | null }

/** No filtering beyond the signal engine's own rules (the scanner already needs $1,000 of liquidity). */
export const OPEN_FILTERS: BotFilters = { minLiquidityUsd: 1_000, minBuyers: 0, minBuySellRatio: 0, maxRunUp: 100, minScore: 0, maxTopBuyerPct: 100, avoidFlags: [] }

/** The kinds of signal each strategy trades. */
export const RULES_OF: Record<Strategy, SignalRule[]> = { scalp: ['momentum', 'snipe'], snipe: ['snipe'], 'second-leg': ['second-leg'], precision: ['snipe', 'momentum'] }
export const RULE_LABEL: Record<SignalRule, string> = { momentum: 'momentum bursts', snipe: 'snipes', 'second-leg': 'dip rebounds' }

const EXITS: Record<Strategy, Pick<StrategyTuning, 'takeProfit' | 'stopLoss' | 'timeStopMin' | 'maxHoldMin'>> = {
  scalp: { takeProfit: 1.1, stopLoss: 0.9, timeStopMin: 3, maxHoldMin: 60 },
  snipe: { takeProfit: 1.1, stopLoss: 0.9, timeStopMin: 3, maxHoldMin: 60 },
  'second-leg': { takeProfit: 1.35, stopLoss: 0.85, timeStopMin: 120, maxHoldMin: 360 },
  // Prime signals only: all of it at +6% (signals/grades.ts).
  precision: { takeProfit: 1.1, stopLoss: 0.9, timeStopMin: 3, maxHoldMin: 10 },
}

/** How far learning may move a take-profit. */
export const TP_BOUNDS: Record<Strategy, [number, number]> = { scalp: [1.06, 1.3], snipe: [1.06, 1.6], 'second-leg': [1.15, 1.8], precision: [1.05, 1.15] }

/**
 * The exit plan (2026-09-30): half sold at the take-profit, then the stop at
 * break-even and the rest trailing 25% below its peak (trading/paper.ts). Bots
 * from before (`plan` missing: all sold at +15%, or +40% for snipes) move to it
 * when they load (`upgradeExits`).
 */
export const EXIT_PLAN = { version: 2, sellPct: 0.5, trailFromPeak: 0.25 }
export const FILTER_CAPS = { minLiquidityUsd: 25_000, minBuyers: 40, minBuySellRatio: 4, maxRunUp: 1.02, minScore: 90, maxTopBuyerPct: 10, maxTotalBuyers: 25, maxSellUsd: 10, maxOverhang: 0.05, maxFarmShare: 0.2, maxAgeSec: 120 }

/**
 * Filters on a coin's crowd and creator (2026-10-01, SignalFeatures): missing means open, so tunings from before keep
 * working. Found in the trade logs (bot/patterns.ts): coins with a big crowd already in, heavy selling before the entry,
 * a creator holding a big share of the pool, a launcher's own wallets, or an old coin kept losing on the $2 plan.
 */
const CROWD_FILTERS = ['maxTotalBuyers', 'maxSellUsd', 'maxOverhang', 'maxFarmShare', 'maxAgeSec'] as const

export const LEARN = {
  /** The trades read: the last 20 of the kind of signal. */
  window: 20,
  minTrades: 6,
  minLosses: 3,
  /** A version is judged on at least this many of its own trades before the next change (a bot with under 10 trades: 3). */
  perVersion: 5,
  perVersionNew: 3,
  /** A pattern counts when this share of the losses shows it. */
  share: 0.3,
  /** Rolled back after this many trades if its win rate is this far under the version before. */
  rollbackAfter: 8,
  rollbackGap: 0.1,
  /** Loosened after this many signals skipped by learned filters, with no trade for this long. */
  relaxAfterSkips: 15,
  relaxAfterMs: 2 * 3_600_000,
  /** A kind of signal it skips (it kept losing) is tried again after this long. */
  retryRuleAfterMs: 12 * 3_600_000,
}

export function defaultTuning(s: Strategy): Tuning {
  return { version: 1, ...EXITS[s], targetUsd: TARGETS[s].target, filters: { ...OPEN_FILTERS, avoidFlags: [] }, rules: {}, changedAt: null, basis: null, prev: null, plan: EXIT_PLAN.version }
}

/** A tuning from before the exit plan: its exits become the plan's (its learned filters stay), with a note saying so. */
export function upgradeExits(t: Tuning, s: Strategy, now = Date.now()): { tuning: Tuning; note: LearnNote | null } {
  if ((t.plan ?? 1) >= EXIT_PLAN.version) return { tuning: t, note: null }
  const exits = s === 'second-leg' ? {} : EXITS[s]
  const version = t.version + 1
  const tuning: Tuning = { ...t, ...exits, plan: EXIT_PLAN.version, version, changedAt: now, basis: null, prev: null }
  return {
    tuning,
    note: { at: now, strategy: s, version, kind: 'exit', text: `New exits: half sold at ${gain(tuning.takeProfit)}, then the stop moves to break-even and the rest trails 25% below its peak (an hour at most). Replayed at live speed on the last signals, this lost far less than selling everything at once, and it lets the trailing half run.` },
  }
}

/** The kind of signal a position came from; an older one without it: what its strategy implies (a fast scalp's is unknown). */
export function ruleOfPosition(p: Pick<Position, 'rule' | 'strategy'>): SignalRule | null {
  return p.rule ?? (p.strategy === 'snipe' ? 'snipe' : p.strategy === 'second-leg' ? 'second-leg' : null)
}

/** The filters a kind of signal is checked against: its own, else the strategy-wide ones. */
export function filtersFor(t: StrategyTuning, rule: SignalRule | null | undefined): BotFilters {
  return (rule && t.rules?.[rule]) || t.filters
}

/**
 * The exits a position opened with this tuning trades with: half sold at the
 * take-profit, the rest trailing with the stop at break-even. Precision sells
 * all of it at its take-profit: a small, fast gain is the whole trade.
 */
export function toParams(t: StrategyTuning, sizeUsd: number, s?: Strategy): StrategyParams {
  if (s === 'precision') {
    return {
      sizeUsd, stopLoss: t.stopLoss, tp1Multiple: t.takeProfit, tp1SellPct: 1, trailFromPeak: EXIT_PLAN.trailFromPeak,
      // Kept past the time stop only a third of the way to the take-profit (+2% at +6%).
      timeStopMin: t.timeStopMin, timeStopMinGain: 1 + (t.takeProfit - 1) / 3, maxHoldMin: t.maxHoldMin, exitOnCreatorSell: true,
    }
  }
  return {
    sizeUsd, stopLoss: t.stopLoss, tp1Multiple: t.takeProfit, tp1SellPct: EXIT_PLAN.sellPct, trailFromPeak: EXIT_PLAN.trailFromPeak, breakevenAfterTp1: true,
    // A time stop keeps a position only if it's a fifth of the way to the take-profit.
    timeStopMin: t.timeStopMin, timeStopMinGain: 1 + (t.takeProfit - 1) * 0.2, maxHoldMin: t.maxHoldMin,
    exitOnCreatorSell: true,
  }
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const pct = (x: number) => `${Math.round(x * 100)}%`
const gain = (m: number) => `+${Math.round((m - 1) * 100)}%`

/** Why a bot with this tuning won't take a signal, or null if it will. Signals without features are taken. */
export function admits(t: StrategyTuning, f: SignalFeatures | undefined, rule?: SignalRule | null): string | null {
  const x = filtersFor(t, rule)
  if (rule && x.skip) return `it learned to skip ${RULE_LABEL[rule]} for now (they kept losing)`
  if (!f) return null
  if (f.liquidityUsd !== null && f.liquidityUsd < x.minLiquidityUsd) return `liquidity ${money(f.liquidityUsd)} is under its learned minimum ${money(x.minLiquidityUsd)}`
  if (f.buyers < x.minBuyers) return `${f.buyers} buyers, it now needs ${x.minBuyers}`
  if ((f.buySellRatio ?? Infinity) < x.minBuySellRatio) return `buys only ${f.buySellRatio!.toFixed(1)}× sells, it now needs ${x.minBuySellRatio.toFixed(2)}×`
  if (f.runUp !== null && f.runUp > x.maxRunUp) return `already ${gain(f.runUp)}, it skips coins up more than ${gain(x.maxRunUp)}`
  if (f.score < x.minScore) return `safety score ${f.score}, it now needs ${x.minScore}`
  if (f.topBuyerPct > x.maxTopBuyerPct) return `one buyer is ${Math.round(f.topBuyerPct)}% of buys, it allows ${Math.round(x.maxTopBuyerPct)}%`
  const flag = f.flags.find(g => x.avoidFlags.includes(g))
  if (flag) return `flagged "${flag}", which it learned to skip`
  // The coin's crowd and creator (missing on older signals: not checked).
  const share = (v: number) => `${Math.round(v * 100)}%`
  if (x.maxTotalBuyers != null && f.totalBuyers != null && f.totalBuyers > x.maxTotalBuyers) return `${f.totalBuyers} buyers already in, it skips coins with more than ${x.maxTotalBuyers} (late: the crowd has bought)`
  if (x.maxSellUsd != null && f.sellUsd != null && f.sellUsd > x.maxSellUsd) return `${money(f.sellUsd)} already sold, it skips coins with more than ${money(x.maxSellUsd)} sold`
  if (x.maxOverhang != null && f.overhang != null && f.overhang > x.maxOverhang) return `the creator holds coins worth ${share(f.overhang)} of the pool, it allows ${share(x.maxOverhang)}`
  if (x.maxFarmShare != null && f.farmShare != null && f.farmShare > x.maxFarmShare) return `${share(f.farmShare)} of the buyers also bought the creator's other coins, it allows ${share(x.maxFarmShare)}`
  if (x.maxAgeSec != null && f.ageSec > x.maxAgeSec) return `${Math.round(f.ageSec / 60)} minutes old, it skips coins older than ${Math.round(x.maxAgeSec / 60)} minutes`
  return null
}

const won = (p: Position) => (p.pnlUsd ?? 0) > 0
const RUGGY = new Set(['rug', 'creator', 'safety'])

type NumFilter = Exclude<keyof BotFilters, 'avoidFlags' | 'skip' | 'skippedAt'>
interface Feature { key: 'liquidityUsd' | 'buyers' | 'buySellRatio' | 'score' | 'runUp' | 'topBuyerPct' | 'totalBuyers' | 'sellUsd' | 'overhang' | 'farmShare' | 'ageSec'; dir: 'min' | 'max'; filter: NumFilter; label: string; fmt: (v: number) => string }
/** A filter's value, missing ones open. */
const curOf = (f: BotFilters, k: NumFilter, dir: 'min' | 'max') => f[k] ?? (dir === 'min' ? -Infinity : Infinity)
const FEATURES: Feature[] = [
  { key: 'liquidityUsd', dir: 'min', filter: 'minLiquidityUsd', label: 'liquidity', fmt: money },
  { key: 'buyers', dir: 'min', filter: 'minBuyers', label: 'buyers', fmt: v => String(Math.round(v)) },
  { key: 'buySellRatio', dir: 'min', filter: 'minBuySellRatio', label: 'buys ÷ sells', fmt: v => `${v.toFixed(2)}×` },
  { key: 'score', dir: 'min', filter: 'minScore', label: 'safety score', fmt: v => String(Math.round(v)) },
  { key: 'runUp', dir: 'max', filter: 'maxRunUp', label: 'run-up before entry', fmt: gain },
  { key: 'topBuyerPct', dir: 'max', filter: 'maxTopBuyerPct', label: 'largest buyer', fmt: v => `${Math.round(v)}%` },
  { key: 'totalBuyers', dir: 'max', filter: 'maxTotalBuyers', label: 'buyers already in', fmt: v => String(Math.round(v)) },
  { key: 'sellUsd', dir: 'max', filter: 'maxSellUsd', label: 'selling before the entry', fmt: money },
  { key: 'overhang', dir: 'max', filter: 'maxOverhang', label: 'the creator\'s coins (share of the pool)', fmt: v => `${Math.round(v * 100)}%` },
  { key: 'farmShare', dir: 'max', filter: 'maxFarmShare', label: 'buyers from the creator\'s other coins', fmt: v => `${Math.round(v * 100)}%` },
  { key: 'ageSec', dir: 'max', filter: 'maxAgeSec', label: 'age', fmt: v => `${Math.round(v / 60)} min` },
]
const valueOf = (p: Position, k: Feature['key']): number | null => {
  const f = p.features
  if (!f) return null
  if (k === 'buySellRatio') return f.buySellRatio ?? 99 // no sells at all: as strong as it gets
  return f[k] ?? null
}
const capped = (filter: NumFilter, v: number) => {
  const cap = FILTER_CAPS[filter]
  return filter.startsWith('max') ? Math.max(cap, v) : Math.min(cap, v)
}

/** The one threshold that would have kept out the most losses for the fewest wins, if it's clearly worth it. */
function bestThreshold(cur: BotFilters, trades: Position[]): { f: Feature; th: number; lost: number; wins: number; L: number; W: number } | null {
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
      const tighter = f.dir === 'min' ? th > curOf(cur, f.filter, f.dir) : th < curOf(cur, f.filter, f.dir)
      if (!tighter) continue
      const score = lost / L - wins / Math.max(1, W)
      if (!best || score > best.score) best = { f, th, lost, wins, L, W, score }
    }
  }
  return best
}

const strip = (t: Tuning): StrategyTuning => { const { prev: _prev, ...rest } = t; return structuredClone(rest) }
const openCopy = (): BotFilters => ({ ...OPEN_FILTERS, avoidFlags: [] })

/** What one kind of signal's losing trades say about its entry filters: changes `f` and adds notes. */
function tightenFor(rule: SignalRule, s: Strategy, f: BotFilters, w: Position[], own: Position[], now: number, say: (kind: LearnNote['kind'], text: string) => void, skipAnyKind = false, keeps: ((f: BotFilters) => boolean) | null = null) {
  const losses = w.filter(p => !won(p)), wins = w.filter(won)
  const share = (xs: Position[]) => xs.length / Math.max(1, losses.length)
  const wr = wins.length / Math.max(1, w.length)
  const winsOf = (xs: Position[]) => xs.filter(won).length
  const tag = RULE_LABEL[rule]
  // Each lesson is tried on its own: one that would turn away too many of the kind's recent signals is undone, unsaid.
  const attempt = (kind: LearnNote['kind'], apply: () => string) => {
    const before = structuredClone(f)
    const text = apply()
    if (keeps && !keeps(f)) {
      for (const k of Object.keys(f) as (keyof BotFilters)[]) if (!(k in before)) delete f[k]
      Object.assign(f, before)
      return
    }
    say(kind, text)
  }

  // A kind of signal that keeps losing for this bot: skipped for now, tried again later (relax).
  const recent = own.slice(-6)
  const recentPnl = recent.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0)
  if (!f.skip && (s === 'scalp' || skipAnyKind) && recent.length >= 4 && winsOf(recent) / recent.length <= 0.25 && recentPnl < 0) {
    attempt('tighten', () => {
      f.skip = true; f.skippedAt = now
      return `${tag}: won ${winsOf(recent)} of its last ${recent.length} (${money(recentPnl)}): it skips them for now and tries again in 12 hours.`
    })
  }

  if (w.length < LEARN.minTrades || losses.length < LEARN.minLosses) return
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
      attempt('tighten', () => {
        f.minLiquidityUsd = liq; f.minScore = score; f.avoidFlags = [...f.avoidFlags, ...flags]
        return `${tag}: ${rugs.length} of ${losses.length} losses were rugs or dumps: it now needs ${money(liq)} of liquidity and a safety score of ${score}${flags.length ? `, and skips coins flagged ${flags.map(g => `"${g}"`).join(', ')}` : ''}.`
      })
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
      attempt('tighten', () => {
        f.minBuySellRatio = ratio; f.maxRunUp = runUp
        return `${tag}: ${fast.length} losses were stopped out within ${fastMs / 60_000 >= 2 ? `${fastMs / 60_000} minutes` : '90 seconds'} (bought into selling): buys must now be at least ${ratio}× sells${runUp < 100 ? `, and it skips coins already up more than ${gain(runUp)}` : ''}.`
      })
    }
  }
  // Timed out without moving.
  const slow = losses.filter(p => p.exitReason === 'time')
  if (slow.length >= 2 && slow.length / losses.length >= 0.4) {
    const buyers = capped('minBuyers', f.minBuyers + 2)
    if (buyers > f.minBuyers) {
      attempt('tighten', () => {
        f.minBuyers = buyers
        return `${tag}: ${slow.length} losses timed out without moving: it now needs ${buyers} buyers.`
      })
    }
  }
  // One number that separates the losses from the wins.
  const b = bestThreshold(f, w)
  if (b) {
    const th = capped(b.f.filter, b.th)
    const tighter = b.f.dir === 'min' ? th > curOf(f, b.f.filter, b.f.dir) : th < curOf(f, b.f.filter, b.f.dir)
    if (tighter) {
      attempt('tighten', () => {
        f[b.f.filter] = th
        return `${tag}: ${b.lost} of ${b.L} losses had ${b.f.label} ${b.f.dir === 'min' ? 'under' : 'over'} ${b.f.fmt(th)}, only ${b.wins} of ${b.W} wins did: it now needs ${b.f.label} ${b.f.dir === 'min' ? 'of at least' : 'of at most'} ${b.f.fmt(th)}.`
      })
    }
  }
}

/**
 * How a bot learns. `pinTakeProfit`: the take-profit never moves (the $2 plan's is fixed). `skipAnyKind`: any kind of
 * signal that keeps losing may be skipped for a while (by default only a fast scalp's kinds are). `minAdmitShare`: a
 * lesson that would turn away more than this share of the kind's recent signals (the trades it learns from, its own
 * and the team's) isn't taken: on 2026-10-01 lessons learned from the replays left the $2 plan's live bots nothing
 * to buy for hours (bot/dollarPlan.ts QUICK_LEARN).
 */
export interface LearnOptions { pinTakeProfit?: boolean; skipAnyKind?: boolean; minAdmitShare?: number }

/**
 * Reads a strategy's closed trades (oldest first) and returns the bot's next
 * tuning with notes, or null if there's nothing to change yet. `shared`:
 * the team's closed trades of the strategy (one per signal). `force`: learn
 * now, without waiting for its own trades on the current version (the team's
 * trades are enough: PaperAccounts' team sync).
 */
export function learn(t: Tuning, s: Strategy, trades: Position[], now: number, shared: Position[] = [], force = false, opts: LearnOptions = {}): { tuning: Tuning; notes: LearnNote[] } | null {
  const closed = trades.filter(p => p.status === 'closed')
  const cur = closed.filter(p => (p.tuningVersion ?? 0) === t.version)
  const winsOf = (xs: Position[]) => xs.filter(won).length
  const note = (version: number, kind: LearnNote['kind'], text: string, rule?: SignalRule): LearnNote => ({ at: now, strategy: s, version, kind, text, ...(rule ? { rule } : {}) })

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

  if (!force && cur.length < (closed.length < 10 ? LEARN.perVersionNew : LEARN.perVersion)) return null
  const next: Tuning = { ...structuredClone(strip(t)), prev: null }
  next.rules = { ...(next.rules ?? {}) }
  const notes: { kind: LearnNote['kind']; text: string; rule?: SignalRule }[] = []

  // Exits, for the strategy as a whole: near misses mean the take-profit was too far.
  const w = closed.slice(-LEARN.window)
  const losses = w.filter(p => !won(p))
  if (!opts.pinTakeProfit && w.length >= LEARN.minTrades && losses.length >= LEARN.minLosses) {
    const tpOf = (p: Position) => p.exits?.tp1Multiple ?? t.takeProfit
    const near = losses.filter(p => p.marketEntry > 0 && p.peak / p.marketEntry >= 1 + 0.6 * (tpOf(p) - 1))
    if (near.length >= 2 && near.length / losses.length >= LEARN.share) {
      const [lo] = TP_BOUNDS[s]
      const tp = Math.max(lo, Math.round((1 + (t.takeProfit - 1) * 0.85) * 1_000) / 1_000)
      if (tp < t.takeProfit - 0.004) {
        next.takeProfit = tp
        notes.push({ kind: 'exit', text: `${near.length} losing trades rose most of the way to ${gain(t.takeProfit)} before turning: it takes profit at ${gain(tp)} now (each trade is sized up to keep the $${t.targetUsd} target).` })
      }
    }
  }

  // Entry filters, per kind of signal: its own last 20 trades and the team's last 20 (signals it didn't take).
  for (const rule of RULES_OF[s]) {
    const own = closed.filter(p => ruleOfPosition(p) === rule)
    const ownIds = new Set(own.map(p => p.signalId))
    const team = shared.filter(p => ruleOfPosition(p) === rule && !ownIds.has(p.signalId) && p.status === 'closed').slice(-LEARN.window)
    const mine = own.slice(-LEARN.window)
    const rw = [...team, ...mine].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    if (rw.length < 4) continue
    const f: BotFilters = structuredClone(t.rules?.[rule] ?? openCopy())
    const before = JSON.stringify(f)
    // Whether a bot with these filters would still take enough of the kind's recent signals.
    const share = opts.minAdmitShare
    const keeps = share ? (x: BotFilters) => {
      const tt: StrategyTuning = { ...t, rules: { ...(t.rules ?? {}), [rule]: x } }
      return rw.filter(p => !admits(tt, p.features, rule)).length >= share * rw.length
    } : null
    tightenFor(rule, s, f, rw, own, now, (kind, text) => notes.push({ kind, rule, text: team.length > 0 && !text.includes('skips them for now') ? `${text} (read from its ${mine.length} trades and ${team.length} of the team's)` : text }), opts.skipAnyKind, keeps)
    if (JSON.stringify(f) !== before) next.rules[rule] = f
  }

  if (!notes.length) return null
  const version = t.version + 1
  Object.assign(next, { version, changedAt: now, basis: { trades: cur.length, wins: winsOf(cur) }, prev: strip(t) })
  return { tuning: next, notes: notes.map(n => note(version, n.kind, n.text, n.rule)) }
}

/**
 * Filters that kept the bot from trading at all come partway back toward
 * open; a kind of signal it skipped is tried again after 12 hours.
 */
export function relax(t: Tuning, s: Strategy, skipped: number, lastBuyAt: number | null, now: number): { tuning: Tuning; notes: LearnNote[] } | null {
  const notes: LearnNote[] = []
  const next: Tuning = { ...structuredClone(strip(t)), prev: strip(t) }
  next.rules = { ...(next.rules ?? {}) }
  const version = t.version + 1
  // A kind of signal skipped long enough: tried again.
  for (const rule of RULES_OF[s]) {
    const r = next.rules[rule]
    if (r?.skip && now - (r.skippedAt ?? 0) >= LEARN.retryRuleAfterMs) {
      next.rules[rule] = { ...r, skip: false, skippedAt: undefined }
      notes.push({ at: now, strategy: s, rule, version, kind: 'loosen', text: `${RULE_LABEL[rule]}: skipped for 12 hours, it tries them again.` })
    }
  }
  // Filters that skipped everything for hours: partway back toward open.
  const open = OPEN_FILTERS
  const all: BotFilters[] = [next.filters, ...Object.values(next.rules).filter((x): x is BotFilters => !!x)]
  const tight = all.some(f => (Object.keys(open) as (keyof BotFilters)[]).some(k => k === 'avoidFlags' ? f.avoidFlags.length > 0 : f[k] !== open[k]) || CROWD_FILTERS.some(k => f[k] != null))
  if (tight && skipped >= LEARN.relaxAfterSkips && now - Math.max(lastBuyAt ?? 0, t.changedAt ?? 0) >= LEARN.relaxAfterMs) {
    for (const f of all) {
      const back = (k: Exclude<NumFilter, (typeof CROWD_FILTERS)[number]>, digits: number) => { const v = f[k] + (open[k] - f[k]) * 0.4; f[k] = Math.round(v * 10 ** digits) / 10 ** digits }
      back('minLiquidityUsd', -2); back('minBuyers', 0); back('minBuySellRatio', 2); back('maxRunUp', 2); back('minScore', 0); back('maxTopBuyerPct', 0)
      // The crowd filters have no "open" value to come back to: each allows half as much again.
      for (const k of CROWD_FILTERS) { const v = f[k]; if (v != null) f[k] = k === 'maxOverhang' || k === 'maxFarmShare' ? Math.round(v * 1.5 * 100) / 100 : Math.round(v * 1.5) }
      f.avoidFlags = f.avoidFlags.slice(0, -1)
    }
    const hours = Math.round((now - Math.max(lastBuyAt ?? 0, t.changedAt ?? 0)) / 3_600_000)
    notes.push({ at: now, strategy: s, version, kind: 'loosen', text: `Its filters skipped ${skipped} signals in ${hours}h without a trade: loosened them partway back.` })
  }
  if (!notes.length) return null
  Object.assign(next, { version, changedAt: now, basis: t.basis })
  return { tuning: next, notes }
}

/**
 * An older tuning (before 2026-10-01) kept one set of filters for the whole
 * strategy. They move to the kind of signal they were learned on: a fast
 * scalp's came almost all from snipes on risky coins (momentum starts open),
 * a snipe's and a dip rebound's from their own kind.
 */
export function migrateTuning(t: Tuning, s: Strategy): Tuning {
  if (t.rules) return t
  const learned = JSON.stringify(t.filters) !== JSON.stringify(OPEN_FILTERS)
  const rule: SignalRule = s === 'second-leg' ? 'second-leg' : 'snipe'
  return { ...t, filters: openCopy(), rules: learned ? { [rule]: structuredClone(t.filters) } : {}, prev: null }
}
