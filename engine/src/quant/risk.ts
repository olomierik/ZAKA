// Global risk controls and the live-trading gate.
//
// Every order asks the governor first: trading on, not killed, the book's
// mode switched on, under the day's loss limit, under the concurrent-position
// and exposure limits, one position per coin, and the signal over the global
// minimum score and safety and under the maximum exhaustion and slippage.
// Every refusal is a risk event (arcdex_sig_risk_events).
//
// Live orders also need the live gate, all of it:
//   1. SIG_LIVE_ALLOWED=1 on the engine (a deploy-time switch the site can't flip)
//   2. risk.liveEnabled, switched on by the owner's signed control
//   3. a bot wallet (BOT_PRIVATE_KEY)
//   4. a recent walk-forward run whose out-of-sample trades pass: enough of
//      them, a profit factor, a positive expectancy and a bounded drawdown
//   5. the paper book over enough days and trades, passing the same bars
// Until every one passes, live stays off and the dashboard says which failed.

import type { QuantConfig } from './config'
import type { BookStats, QPosition } from './positions'

export interface RiskEvent { at: number; mode: 'paper' | 'live' | 'backtest'; kind: string; token?: string; detail: string }

export interface GateCheck { id: string; ok: boolean; detail: string }
export interface LiveGate { ok: boolean; checks: GateCheck[] }

export interface OrderAsk {
  mode: 'paper' | 'live' | 'backtest'
  token: string
  sizeUsd: number
  equityUsd: number
  open: QPosition[]
  closedToday: QPosition[]
  score: number
  safetyScore: number
  exhaustion: number
  liquidity: number | null
  slippagePct: number
}

const dayStart = (now: number) => Math.floor(now / 86_400_000) * 86_400_000

export class RiskGovernor {
  constructor(private cfg: () => QuantConfig, readonly liveAllowedByEnv: boolean) {}

  /** The day's realized loss of a book (USD, positive), from positions closed since midnight UTC. */
  static dayLoss(closed: QPosition[], now: number): number {
    const from = dayStart(now)
    const pnl = closed.filter(p => (p.closedAt ?? 0) >= from).reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
    return Math.max(0, -pnl)
  }

  /** null when the order may go; otherwise why not. */
  check(a: OrderAsk, now: number): string | null {
    const c = this.cfg(), r = c.risk, g = c.gates
    if (!r.tradingEnabled) return 'trading is switched off (global switch)'
    if (r.killSwitch) return 'the kill switch is on'
    if (a.mode === 'paper' && !r.paperEnabled) return 'paper trading is switched off'
    if (a.mode === 'live' && !r.liveEnabled) return 'live trading is switched off'
    const book = a.mode === 'backtest' ? 'paper' : a.mode
    const limit = r.maxDailyLossUsd[book]
    const lost = RiskGovernor.dayLoss(a.closedToday, now)
    if (lost >= limit) return `the day's loss limit is reached ($${lost.toFixed(2)} of $${limit})`
    if (a.open.some(p => p.token === a.token && p.status !== 'closed' && p.status !== 'failed')) return 'already holding this coin'
    const open = a.open.filter(p => p.status === 'open' || p.status === 'pending')
    if (open.length >= r.maxConcurrent) return `${open.length} positions open (the most at once: ${r.maxConcurrent})`
    const exposure = open.reduce((s, p) => s + (p.costUsd || p.plannedUsd), 0)
    if (exposure + a.sizeUsd > (a.equityUsd * c.sizing.maxPortfolioExposurePct) / 100 + 1e-9) return `exposure would reach $${(exposure + a.sizeUsd).toFixed(2)} (over ${c.sizing.maxPortfolioExposurePct}% of $${Math.round(a.equityUsd)})`
    if (a.sizeUsd > c.sizing.maxPositionUsd + 1e-9) return `size $${a.sizeUsd.toFixed(2)} over the $${c.sizing.maxPositionUsd} maximum position`
    if (a.slippagePct > r.maxSlippagePct) return `expected slippage ${a.slippagePct.toFixed(1)}% (over ${r.maxSlippagePct}%)`
    if ((a.liquidity ?? 0) < g.minLiquidityUsd) return `liquidity under $${g.minLiquidityUsd.toLocaleString('en-US')}`
    if (a.score < g.minSignalScore) return `score ${a.score} under the global minimum ${g.minSignalScore}`
    if (a.safetyScore < g.minSafetyScore) return `safety ${a.safetyScore} under the global minimum ${g.minSafetyScore}`
    if (a.exhaustion > g.maxExhaustion) return `exhaustion ${a.exhaustion} over the global maximum ${g.maxExhaustion}`
    return null
  }

  /** Whether live orders may go, and every condition's state. */
  liveGate(o: { hasWallet: boolean; oos: (BookStats & { at: number }) | null; paper: BookStats & { firstAt: number | null } }, now: number): LiveGate {
    const c = this.cfg(), L = c.liveGate
    const checks: GateCheck[] = []
    const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })
    add('env', this.liveAllowedByEnv, this.liveAllowedByEnv ? 'SIG_LIVE_ALLOWED=1 on the engine' : 'SIG_LIVE_ALLOWED is not set on the engine (Railway): live stays off')
    add('switch', c.risk.liveEnabled, c.risk.liveEnabled ? 'switched on by the owner' : "the owner hasn't switched live on")
    add('wallet', o.hasWallet, o.hasWallet ? 'bot wallet ready' : 'no bot wallet (BOT_PRIVATE_KEY)')
    const b = o.oos
    if (!b) add('backtest', false, 'no walk-forward run yet')
    else {
      const age = (now - b.at) / 3_600_000
      add('backtest_age', age <= L.maxBacktestAgeHours, `walk-forward run ${age.toFixed(1)}h old (at most ${L.maxBacktestAgeHours}h)`)
      add('oos_trades', b.trades >= L.minOosTrades, `${b.trades} out-of-sample trades (at least ${L.minOosTrades})`)
      add('oos_pf', (b.profit_factor ?? 0) >= L.minOosProfitFactor, `out-of-sample profit factor ${b.profit_factor ?? '—'} (at least ${L.minOosProfitFactor})`)
      add('oos_expectancy', b.expectancy_pct >= L.minOosExpectancyPct, `out-of-sample expectancy ${b.expectancy_pct}% a trade (at least ${L.minOosExpectancyPct}%)`)
      add('oos_drawdown', b.max_drawdown_pct <= L.maxOosDrawdownPct, `out-of-sample drawdown ${b.max_drawdown_pct}% (at most ${L.maxOosDrawdownPct}%)`)
    }
    const p = o.paper
    const days = p.firstAt ? (now - p.firstAt) / 86_400_000 : 0
    add('paper_days', days >= L.minPaperDays, `paper record over ${days.toFixed(1)} days (at least ${L.minPaperDays})`)
    add('paper_trades', p.trades >= L.minPaperTrades, `${p.trades} paper trades (at least ${L.minPaperTrades})`)
    add('paper_pf', (p.profit_factor ?? 0) >= L.minPaperProfitFactor, `paper profit factor ${p.profit_factor ?? '—'} (at least ${L.minPaperProfitFactor})`)
    add('paper_expectancy', p.expectancy_pct >= L.minPaperExpectancyPct, `paper expectancy ${p.expectancy_pct}% a trade (at least ${L.minPaperExpectancyPct}%)`)
    add('paper_drawdown', p.max_drawdown_pct <= L.maxPaperDrawdownPct, `paper drawdown ${p.max_drawdown_pct}% (at most ${L.maxPaperDrawdownPct}%)`)
    return { ok: checks.every(x => x.ok), checks }
  }
}
