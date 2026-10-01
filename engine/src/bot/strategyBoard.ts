// The strategy board (owner's request, 2026-10-01: "give only 3 strategies
// that have proven to be working and produced profits on paper, and make them
// trade LIVE; let bots self-improve and auto-switch strategies based on the
// opportunity shown on the signals; let bots learn from paper trading bots").
//
// Three strategies, the ones with a paper record behind them (AGENTS.md):
//   precision   Prime signals: an early crowd or a crowd momentum burst
//               (signals/grades.ts). In the 72-hour search at live speed:
//               21 of 21, then 8 of 8 and 21 of 23 on coins it never saw.
//   snipe       a young coin's market buying, on a coin that passed every
//               check: 6 of 6 won on the team's paper record.
//   scalp       the same on a coin with a risk flag, sold small and fast:
//               12 of 14 won (the engine's book: 12 of 16, +$11.79).
// Dip rebounds (fragile in every test) and plain momentum bursts (5 of 15)
// are measured on paper only.
//
// Paper bots explore: each trades every signal of its strategies at live
// speed (a buy 2.5s after the signal, a sale 2s after its trigger, as a live
// bot gets them) and learns from its losses (bot/learner.ts). The engine's own
// paper book trades every signal with the platform's settings. The board
// reads them all and, for each strategy, takes the paper book doing best on
// it now (its last 20 trades over 48 hours, at least 8): live bots trade the
// strategy with that book's settings (its exits and learned filters), and
// switch by themselves as the board changes.
//
//   live    the best paper book on it is in profit (more made than lost,
//           half or more won): live bots trade it, with that book's settings
//   paused  paper books have the trades, and none is in profit; or live
//           bots' own last trades on it lost (paper and live disagree):
//           live bots pass its signals over until that changes
//   trial   not enough paper trades yet: live bots trade it at the $2 base
//           with the platform's settings while paper builds its record
//
// Only trades from paper at live speed count (from 2026-09-30, 17:00 UTC):
// before that paper filled every trade at once, and showed gains a live bot
// can't get (AGENTS.md, "Why live bots lost"). Nothing here promises a profit.

import type { BotStrategy, SignalFeatures, SignalRule, StrategyBoardEntry, StrategyTuning } from '../../../api/_marketProtocol'
import { QUICK_EXITS, STRATEGIES, type Position, type Strategy, type StrategyParams } from '../trading/paper'
import { admits, toParams } from './learner'

/** The three strategies bots trade (dip rebounds are measured on paper only). */
export const BOT_STRATEGIES: readonly Strategy[] = ['precision', 'snipe', 'scalp']
export const BOARD_LABEL: Record<Strategy, string> = { precision: 'Precision', snipe: 'Snipe', scalp: 'Fast scalp', 'second-leg': 'Dip rebound' }

export const BOARD = {
  /** Paper trades opened from here on were filled at live speed. */
  since: Date.UTC(2026, 8, 30, 17, 0),
  windowMs: 48 * 3_600_000,
  last: 20,
  minTrades: 8,
  minWinRate: 0.5,
  /** Live bots' own trades on a strategy: its last 10 within 24 hours; 6 or more that lost on average, with under half won, pause it. */
  live: { last: 10, minTrades: 6, windowMs: 24 * 3_600_000 },
  /** Recomputed this often. */
  everyMs: 10_000,
}

/**
 * The platform's settings for each strategy: what the engine's own paper book
 * trades it with, and what live bots trade it with until a paper bot does
 * better. Prime signals with Precision (all of it at +10%); snipes and fast
 * scalps with the quick exits (all of it at +6%, trading/paper.ts QUICK_EXITS);
 * dip rebounds with their own.
 */
export function platformParams(s: Strategy, sizeUsd: number): StrategyParams {
  if (s === 'snipe' || s === 'scalp') return { ...QUICK_EXITS, sizeUsd }
  return { ...STRATEGIES[s], sizeUsd }
}

/** A paper book on one strategy: the engine's own, or a bot's (with its learned settings). */
export interface Candidate { kind: 'house' | 'bot'; id: string; name: string; slug?: string; trades: Position[]; tuning: StrategyTuning | null }

export interface BookRecord { trades: number; wins: number; winRate: number; avgReturn: number; pnlUsd: number }

/** A book's last trades (closed in the window, opened at live speed): how many, won, the average return a trade, P&L. Null with none. */
export function recordOf(trades: Position[], now: number, o: { last: number; windowMs: number; since?: number } = BOARD): BookRecord | null {
  const since = Math.max(now - o.windowMs, o.since ?? 0)
  const list = trades
    .filter(p => p.status === 'closed' && p.pnlUsd !== null && (p.closedAt ?? 0) >= now - o.windowMs && p.openedAt >= since && p.sizeUsd > 0)
    .sort((x, y) => (x.closedAt ?? 0) - (y.closedAt ?? 0))
    .slice(-o.last)
  if (!list.length) return null
  const wins = list.filter(p => (p.pnlUsd ?? 0) > 0).length
  return {
    trades: list.length, wins, winRate: wins / list.length,
    avgReturn: list.reduce((s, p) => s + (p.pnlUsd ?? 0) / p.sizeUsd, 0) / list.length,
    pnlUsd: list.reduce((s, p) => s + (p.pnlUsd ?? 0), 0),
  }
}

const inProfit = (r: BookRecord | null): r is BookRecord => !!r && r.trades >= BOARD.minTrades && r.avgReturn > 0 && r.pnlUsd > 0 && r.winRate >= BOARD.minWinRate

export interface BoardPick {
  strategy: Strategy
  status: StrategyBoardEntry['status']
  /** The paper book live bots take their settings from (live), or the best of those that lost (paused). */
  source: (Candidate & { record: BookRecord }) | null
  live: BookRecord | null
  why: string
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`
const rec = (r: BookRecord) => `won ${r.wins} of its last ${r.trades} at live speed (${pct(r.avgReturn)} a trade)`
const bookName = (c: Candidate) => (c.kind === 'house' ? 'the engine\'s own paper book' : `${c.name}'s paper bot`)

/** Where a strategy stands now, from its paper books and live bots' own trades on it. */
export function pickStrategy(strategy: Strategy, candidates: Candidate[], live: Position[], now: number): BoardPick {
  const label = BOARD_LABEL[strategy]
  if (!BOT_STRATEGIES.includes(strategy)) return { strategy, status: 'paused', source: null, live: null, why: `${label}: live bots trade Precision, Snipe and Fast scalp; this one is measured on paper only` }
  const books = candidates.map(c => ({ ...c, record: recordOf(c.trades, now) })).filter((c): c is Candidate & { record: BookRecord } => !!c.record)
  const liveRec = recordOf(live, now, { last: BOARD.live.last, windowMs: BOARD.live.windowMs })
  const best = books.filter(c => inProfit(c.record)).sort((x, y) => y.record.avgReturn - x.record.avgReturn || y.record.trades - x.record.trades)[0] ?? null
  if (liveRec && liveRec.trades >= BOARD.live.minTrades && liveRec.avgReturn < 0 && liveRec.winRate < BOARD.minWinRate) {
    return { strategy, status: 'paused', source: best, live: liveRec, why: `${label} is paused for live: live bots' own last ${liveRec.trades} trades on it won ${liveRec.wins} (${pct(liveRec.avgReturn)} a trade), whatever paper shows; it's tried again once those are a day old` }
  }
  if (best) return { strategy, status: 'live', source: best, live: liveRec, why: `${label} trades live with ${bookName(best)}'s settings: it ${rec(best.record)}` }
  const measured = books.filter(c => c.record.trades >= BOARD.minTrades).sort((x, y) => y.record.avgReturn - x.record.avgReturn)[0] ?? null
  if (measured) return { strategy, status: 'paused', source: measured, live: liveRec, why: `${label} is paused for live: no paper book is in profit on it; the best, ${bookName(measured)}, ${rec(measured.record)}` }
  const most = Math.max(0, ...books.map(c => c.record.trades))
  return { strategy, status: 'trial', source: null, live: liveRec, why: `${label} is on trial: ${most} of ${BOARD.minTrades} paper trades at live speed so far, so live bots trade it at the $2 base with the platform's settings while paper builds its record` }
}

/** The exits live bots trade a strategy with: the source paper bot's learned ones, else the platform's. */
export function boardParams(pick: BoardPick, sizeUsd: number): StrategyParams {
  const src = pick.status === 'live' ? pick.source : null
  if (src?.kind === 'bot' && src.tuning) return toParams(src.tuning, sizeUsd, pick.strategy)
  return platformParams(pick.strategy, sizeUsd)
}

/** Whether the source paper bot's learned filters let a signal through (null), or why not. */
export function boardAdmits(pick: BoardPick, f: SignalFeatures | undefined, rule?: SignalRule | null): string | null {
  const src = pick.status === 'live' ? pick.source : null
  if (src?.kind !== 'bot' || !src.tuning) return null
  const why = admits(src.tuning, f, rule)
  return why ? `${why} (${src.name}'s learned filter, which live bots trade ${BOARD_LABEL[pick.strategy]} with)` : null
}

/** The board as the site shows it. */
export function boardEntry(pick: BoardPick): StrategyBoardEntry {
  const p = boardParams(pick, 2)
  const r = (x: BookRecord) => ({ trades: x.trades, wins: x.wins, avgPct: Math.round(x.avgReturn * 1_000) / 10, pnlUsd: Math.round(x.pnlUsd * 100) / 100 })
  return {
    strategy: pick.strategy as BotStrategy,
    status: pick.status,
    source: pick.source ? { kind: pick.source.kind, name: pick.source.kind === 'house' ? 'ARCDEX paper book' : pick.source.name, ...(pick.source.slug ? { slug: pick.source.slug } : {}), ...r(pick.source.record) } : null,
    live: pick.live ? r(pick.live) : null,
    exits: { takeProfit: p.tp1Multiple, sellPct: Math.round(p.tp1SellPct * 100), stopLoss: p.stopLoss, maxHoldMin: p.maxHoldMin ?? null },
    why: pick.why,
  }
}
