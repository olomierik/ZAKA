// Position management: when to take profit, when to cut, and when to get out
// because the setup is gone. A pure step function: the position and what the
// market looks like now go in, the sales to make and the stop's new level
// come out. The same function manages paper, live and backtest positions.
//
// In order of precedence, each tick:
//   emergency      a rug alarm, a failed safety re-check, the kill switch
//   liquidity      the pool's depth down `liquidityDropPct` from entry or its 15-minute high
//   distribution   whales and top holders selling (distribution score at the exit level)
//   stop           the dynamic stop: volatility-based at entry, moved to break-even after
//                  `breakevenAfterTp` targets, trailing once armed
//   targets        the ladder: each target sells its share of the original position
//   momentum       the move is over: buying gone, under the 1-minute VWAP, falling on 30s and 1m
//   time           out after `maxHoldMin`; out early if not up `staleGainPct` after `staleMin`

import type { ExitConfig, StrategyId } from './config'
import { clamp } from './util'

export type PositionStatus = 'pending' | 'open' | 'closed' | 'failed'

export interface Fill { at: number; side: 'BUY' | 'SELL'; price: number; tokens: number; usd: number; feesUsd: number; reason: string; txHash?: string; gasUsd?: number }

export interface QPosition {
  id: string
  signalId: string
  token: string
  symbol: string
  strategy: StrategyId
  mode: 'paper' | 'live' | 'backtest'
  status: PositionStatus
  openedAt: number
  closedAt: number | null
  /** The planned size and what was actually paid (USD), and the average entry price. */
  plannedUsd: number
  costUsd: number
  entryPrice: number
  tokens: number
  remainingTokens: number
  proceedsUsd: number
  feesUsd: number
  exits: ExitConfig
  /** (1 + entry costs) / (1 − exit costs): the price multiple that breaks even. */
  breakevenMult: number
  stopPrice: number
  stopPct: number
  stopKind: 'initial' | 'breakeven' | 'trailing'
  highPrice: number
  lowPrice: number
  tpHit: number
  trailPct: number | null
  volatilityPct: number | null
  liquidityAtEntry: number | null
  exitReason: string | null
  fills: Fill[]
  /** Realized P&L (USD) and return on cost once closed. */
  pnlUsd: number | null
  returnPct: number | null
  /** Best and worst move from the entry while held (%). */
  maxGainPct: number
  maxDrawdownPct: number
  /** Live: the token's balance as an integer string (18-decimal units), for exact sales. */
  liveTokens?: string
}

export interface MarketNow {
  now: number
  price: number
  liquidity: number | null
  liquidityHigh15m: number | null
  distribution: number
  /** Momentum gone: buying faded, under the 1-minute VWAP, falling on 30s and 1m. */
  momentumTurn: boolean
  volatilityPct: number | null
  emergency: string | null
}

export interface ExitAction { fraction: number; reason: string; kind: 'emergency' | 'liquidity' | 'distribution' | 'stop' | 'target' | 'momentum' | 'time' }

export interface StepResult { actions: ExitAction[]; stopPrice: number; stopKind: QPosition['stopKind']; trailPct: number | null; tpHit: number; highPrice: number }

/** The fraction of the remaining tokens each action sells (1 = all that's left). */
export function manage(p: QPosition, m: MarketNow): StepResult {
  const e = p.exits
  const high = Math.max(p.highPrice, m.price)
  let stop = p.stopPrice, kind = p.stopKind, trail = p.trailPct, tp = p.tpHit
  const out = (reason: string, k: ExitAction['kind']): StepResult => ({ actions: [{ fraction: 1, reason, kind: k }], stopPrice: stop, stopKind: kind, trailPct: trail, tpHit: tp, highPrice: high })
  const heldMin = (m.now - p.openedAt) / 60_000
  const gain = m.price / p.entryPrice - 1
  if (m.emergency) return out(`emergency: ${m.emergency}`, 'emergency')
  if (m.liquidity !== null) {
    const ref = Math.max(p.liquidityAtEntry ?? 0, m.liquidityHigh15m ?? 0)
    if (ref > 0 && m.liquidity <= ref * (1 - e.liquidityDropPct / 100)) return out(`liquidity fell ${Math.round((1 - m.liquidity / ref) * 100)}% (from $${Math.round(ref).toLocaleString('en-US')})`, 'liquidity')
  }
  if (m.distribution >= e.distributionExit) return out(`distribution ${m.distribution}: whales or top holders selling`, 'distribution')
  if (m.price <= stop) return out(kind === 'trailing' ? `trailing stop (${trail?.toFixed(1)}% under the high)` : kind === 'breakeven' ? 'break-even stop' : `stop (−${p.stopPct.toFixed(1)}%)`, 'stop')
  // Targets: each sells its share of the original position.
  const actions: ExitAction[] = []
  let remainingShare = p.tokens > 0 ? p.remainingTokens / p.tokens : 0
  while (tp < e.ladder.length && gain * 100 >= e.ladder[tp].gainPct && remainingShare > 1e-9) {
    const want = Math.min(remainingShare, e.ladder[tp].sellPct / 100)
    actions.push({ fraction: want / remainingShare, reason: `target ${tp + 1}: +${e.ladder[tp].gainPct}% (sold ${e.ladder[tp].sellPct}% of the position)`, kind: 'target' })
    remainingShare -= want
    tp++
  }
  if (e.breakevenAfterTp > 0 && tp >= e.breakevenAfterTp && kind === 'initial') { stop = Math.max(stop, p.entryPrice * p.breakevenMult); kind = 'breakeven' }
  const armed = (e.trail.afterTp > 0 && tp >= e.trail.afterTp) || gain * 100 >= e.trail.armGainPct
  if (armed) {
    const pct = clamp(e.trail.volMult * (m.volatilityPct ?? p.volatilityPct ?? e.trail.maxPct), e.trail.minPct, e.trail.maxPct)
    trail = pct
    const level = high * (1 - pct / 100)
    if (level > stop) { stop = level; kind = 'trailing' }
  }
  if (remainingShare > 1e-9) {
    if (e.momentumExit && m.momentumTurn && heldMin >= 2) actions.push({ fraction: 1, reason: 'momentum gone: buying faded and the price turned', kind: 'momentum' })
    else if (heldMin >= e.maxHoldMin) actions.push({ fraction: 1, reason: `held ${e.maxHoldMin} min (the limit)`, kind: 'time' })
    else if (e.staleMin > 0 && heldMin >= e.staleMin && p.maxGainPct < e.staleGainPct && tp === 0) actions.push({ fraction: 1, reason: `not up ${e.staleGainPct}% after ${e.staleMin} min`, kind: 'time' })
  }
  return { actions, stopPrice: stop, stopKind: kind, trailPct: trail, tpHit: tp, highPrice: high }
}

/** Closed-position statistics (the backtest report, strategy results, the live gate). */
export interface BookStats {
  trades: number
  wins: number
  losses: number
  win_rate: number
  profit_factor: number | null
  gross_profit: number
  gross_loss: number
  net_pnl: number
  average_trade: number
  average_winner: number
  average_loser: number
  /** Average return on cost (%). */
  expectancy_pct: number
  max_drawdown_usd: number
  /** The drawdown as a share of the starting equity plus the peak profit (%). */
  max_drawdown_pct: number
  average_hold_min: number
  tp_hit_rates: number[]
  stop_rate: number
  exit_reasons: Record<string, number>
}

export function bookStats(closed: Pick<QPosition, 'pnlUsd' | 'returnPct' | 'openedAt' | 'closedAt' | 'tpHit' | 'exitReason' | 'exits'>[], equityUsd = 1_000): BookStats {
  const done = [...closed].filter(p => p.pnlUsd !== null).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const pnl = done.map(p => p.pnlUsd!)
  const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x <= 0)
  const gp = wins.reduce((s, x) => s + x, 0), gl = -losses.reduce((s, x) => s + x, 0)
  let cum = 0, peak = 0, dd = 0
  for (const x of pnl) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum) }
  const ladderLen = Math.max(0, ...done.map(p => p.exits?.ladder?.length ?? 0))
  const reasons: Record<string, number> = {}
  for (const p of done) { const k = (p.exitReason ?? 'open').split(/[:(]/)[0].trim(); reasons[k] = (reasons[k] ?? 0) + 1 }
  const n = done.length
  const r2 = (x: number) => Math.round(x * 100) / 100
  return {
    trades: n, wins: wins.length, losses: losses.length, win_rate: n ? r2(wins.length / n) : 0,
    // No losing trade yet: 99 stands for "no losses" (JSON has no infinity).
    profit_factor: gl > 0 ? r2(gp / gl) : gp > 0 ? 99 : null,
    gross_profit: r2(gp), gross_loss: r2(gl), net_pnl: r2(gp - gl),
    average_trade: n ? r2((gp - gl) / n) : 0,
    average_winner: wins.length ? r2(gp / wins.length) : 0,
    average_loser: losses.length ? r2(-gl / losses.length) : 0,
    expectancy_pct: n ? r2(done.reduce((s, p) => s + (p.returnPct ?? 0), 0) / n) : 0,
    max_drawdown_usd: r2(dd), max_drawdown_pct: r2((dd / (equityUsd + peak)) * 100),
    average_hold_min: n ? r2(done.reduce((s, p) => s + ((p.closedAt ?? p.openedAt) - p.openedAt), 0) / n / 60_000) : 0,
    tp_hit_rates: Array.from({ length: ladderLen }, (_, i) => (n ? r2(done.filter(p => p.tpHit > i).length / n) : 0)),
    // Stop-loss exits only (a trailing or break-even stop protects a profit).
    stop_rate: n ? r2(done.filter(p => /^stop \(/.test(p.exitReason ?? '')).length / n) : 0,
    exit_reasons: reasons,
  }
}
