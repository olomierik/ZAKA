// Trade quality before an order: what the trade is expected to make after
// everything it costs. The strategy's own recent results (net of costs, from
// the paper book or live) are blended with a prior (gross of costs, minus
// this trade's costs) weighted as `priorTrades` trades, so a new strategy
// starts from the prior and earns its own record. No order goes out when the
// expected edge is under the minimum, in percent or in dollars.

import type { QuantConfig } from './config'
import type { Costs } from './liquidity'

export interface StrategyRecord { trades: number; wins: number; /** Net returns of its closed trades (fractions), newest last. */ returns: number[] }

export interface TradeQuality {
  p_win: number
  /** The average winning move it can expect before costs (%). */
  expected_price_move_pct: number
  entry_slippage_pct: number
  exit_slippage_pct: number
  buy_tax_pct: number
  sell_tax_pct: number
  gas_usd: number
  price_impact_pct: number
  round_trip_cost_pct: number
  expected_net_return_pct: number
  expected_value_usd: number
  ok: boolean
  why: string
}

export function tradeQuality(o: { sizeUsd: number; costs: Costs; stopPct: number; record: StrategyRecord | null; edge: QuantConfig['edge']; explore?: boolean }): TradeQuality {
  const e = o.edge
  const recent = o.record ? o.record.returns.slice(-e.lookbackTrades) : []
  const n = recent.length
  const k = e.priorTrades
  const costPct = o.costs.roundTrip * 100
  // The prior: its win rate, its average win, and a loss at most the stop (plus the exit's own impact), gross of costs.
  const priorLoss = Math.min(e.priorAvgLossPct, o.stopPct + o.costs.exitSlippage * 100)
  const priorEv = e.priorWinRate * e.priorAvgWinPct - (1 - e.priorWinRate) * priorLoss - costPct
  const recordEv = n ? (recent.reduce((s, x) => s + x, 0) / n) * 100 : 0
  const ev = (n * recordEv + k * priorEv) / Math.max(1, n + k)
  const wins = recent.filter(x => x > 0)
  const pWin = (wins.length + k * e.priorWinRate) / Math.max(1, n + k)
  const avgWinGross = (wins.length ? (wins.reduce((s, x) => s + x, 0) / wins.length) * 100 + costPct : e.priorAvgWinPct)
  const evUsd = (ev / 100) * o.sizeUsd
  // Exploring (paper only, a strategy without its own record yet): any expected edge that isn't negative, so it gets measured.
  const minPct = o.explore ? 0 : e.minEdgePct, minUsd = o.explore ? 0 : e.minEdgeUsd
  const ok = ev >= minPct && evUsd >= minUsd
  const r2 = (x: number) => Math.round(x * 100) / 100
  return {
    p_win: r2(pWin), expected_price_move_pct: r2((wins.length * avgWinGross + k * e.priorAvgWinPct) / Math.max(1, wins.length + k)),
    entry_slippage_pct: r2(o.costs.entrySlippage * 100), exit_slippage_pct: r2(o.costs.exitSlippage * 100),
    buy_tax_pct: r2(o.costs.buyTax * 100), sell_tax_pct: r2(o.costs.sellTax * 100), gas_usd: r2(o.costs.gasUsd),
    price_impact_pct: r2(o.costs.entrySlippage * 100), round_trip_cost_pct: r2(costPct),
    expected_net_return_pct: r2(ev), expected_value_usd: Math.round(evUsd * 1_000) / 1_000,
    ok, why: `expected ${r2(ev)}% ($${evUsd.toFixed(2)}) after ${r2(costPct)}% of costs${ok ? '' : `: under the ${minPct}% / $${minUsd} minimum edge`}${o.explore ? ' (exploring: the strategy has no record of its own yet)' : ''}`,
  }
}
