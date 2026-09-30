// Paper trading: every signal becomes a simulated position at the live
// price, with its costs, and is closed by the strategy's own exits. The
// results are the engine's track record: win rate, average win and loss,
// profit factor, drawdown. No money moves. Live positions (trading/live.ts)
// use the same exits (`exitsAt`), filled at what the sale really paid.
//
// Costs, both ways: what the honeypot probe measured a $1 round trip to
// cost (pool fees, hook taxes, token taxes), half on entry and half on exit,
// plus price impact for the size against the pool's liquidity.

export type Strategy = 'snipe' | 'second-leg' | 'scalp'

export interface StrategyParams {
  sizeUsd: number
  /** Exit everything at this multiple of the entry (0.65 = −35%). */
  stopLoss: number
  /** Take profit: at this multiple, sell this share. */
  tp1Multiple: number
  tp1SellPct: number
  /** After the take-profit, exit the rest this far below the peak (0.35 = 35%). */
  trailFromPeak: number
  /** After this long, exit unless up at least `timeStopMinGain`. */
  timeStopMin: number
  timeStopMinGain: number
  /** Out after this long whatever happened (the runner too). */
  maxHoldMin?: number
  /** Out the moment the coin's creator sells any of it. */
  exitOnCreatorSell?: boolean
}

export const STRATEGIES: Record<Strategy, StrategyParams> = {
  snipe: { sizeUsd: 25, stopLoss: 0.65, tp1Multiple: 2, tp1SellPct: 0.5, trailFromPeak: 0.35, timeStopMin: 45, timeStopMinGain: 1.1 },
  'second-leg': { sizeUsd: 25, stopLoss: 0.8, tp1Multiple: 1.8, tp1SellPct: 0.5, trailFromPeak: 0.25, timeStopMin: 360, timeStopMinGain: 1.1 },
  // A snipe on a coin that passed every hard check but not a risk check (the
  // creator holds a big stake, launches coin after coin, a copycat ticker):
  // a fifth of the size, most of it sold at +30%, out when the creator sells,
  // and never held past 15 minutes (owner's decision, 2026-09-30).
  scalp: { sizeUsd: 5, stopLoss: 0.85, tp1Multiple: 1.3, tp1SellPct: 0.75, trailFromPeak: 0.15, timeStopMin: 5, timeStopMinGain: 1.05, maxHoldMin: 15, exitOnCreatorSell: true },
}

export const RISK = {
  maxOpen: 5,
  /** Scalps open at once, within `maxOpen`. */
  maxOpenScalp: 3,
  /** A coin traded once isn't traded again for this long. */
  cooldownMin: 360,
  /** No new positions once today's (UTC) realized loss reaches this. */
  dailyLossUsd: 100,
}

export type ExitReason = 'tp1' | 'trail' | 'stop' | 'time' | 'safety' | 'creator' | 'manual'

export interface Fill { at: number; price: number; qty: number; usd: number; reason: 'entry' | ExitReason }

export interface LiveTx { kind: 'buy' | 'approve' | 'sell'; hash: string; at: number; usd?: number; gasUsd?: number }

export interface Position {
  id: string
  /** paper: simulated at the market price with modelled costs; live: bought and sold by the bot wallet. Missing: paper. */
  mode?: 'paper' | 'live'
  strategy: Strategy
  token: string
  symbol: string
  launchpad: string
  signalId: string
  openedAt: number
  /** The market price at entry, and what was actually paid per token after costs. */
  marketEntry: number
  entryPrice: number
  sizeUsd: number
  qty: number
  remaining: number
  /** Cost per side, as a fraction (0.02 = 2%). */
  cost: number
  peak: number
  tp1Done: boolean
  fills: Fill[]
  status: 'open' | 'closed'
  closedAt: number | null
  exitReason: ExitReason | null
  /** Sale proceeds minus the size (and, live, the gas), once closed. */
  pnlUsd: number | null
  /** Live: its transactions, the gas they cost, and why a sale is failing (it's retried). */
  txs?: LiveTx[]
  gasUsd?: number
  stuck?: string | null
  /** Live: the token amount bought, in its smallest unit (qty is in whole tokens). */
  rawQty?: string
}

/** Cost per side: half the measured round trip (at least 1%), plus impact for the size. */
export function costPerSide(roundTripLossPct: number | null, sizeUsd: number, liquidityUsd: number | null): number {
  const base = Math.max(0.01, (roundTripLossPct ?? 4) / 100 / 2)
  // Constant product: a trade of x against depth L (both sides) moves the price about x / (L/2).
  const impact = liquidityUsd && liquidityUsd > 0 ? sizeUsd / (liquidityUsd / 2) : 0.02
  return Math.min(0.5, base + impact)
}

export function openPosition(o: { id: string; strategy: Strategy; token: string; symbol: string; launchpad: string; signalId: string; price: number; cost: number; now: number; params?: StrategyParams }): Position {
  const p = o.params ?? STRATEGIES[o.strategy]
  const entryPrice = o.price * (1 + o.cost)
  const qty = p.sizeUsd / entryPrice
  return {
    id: o.id, strategy: o.strategy, token: o.token, symbol: o.symbol, launchpad: o.launchpad, signalId: o.signalId,
    openedAt: o.now, marketEntry: o.price, entryPrice, sizeUsd: p.sizeUsd, qty, remaining: qty, cost: o.cost, peak: o.price,
    tp1Done: false, fills: [{ at: o.now, price: entryPrice, qty, usd: p.sizeUsd, reason: 'entry' }],
    status: 'open', closedAt: null, exitReason: null, pnlUsd: null,
  }
}

/** Records a sale of `qty` tokens that brought in `usd` (after costs). */
export function recordSell(pos: Position, qty: number, usd: number, now: number, reason: ExitReason): Fill {
  const f: Fill = { at: now, price: qty > 0 ? usd / qty : 0, qty, usd, reason }
  pos.remaining -= qty
  if (reason === 'tp1') pos.tp1Done = true
  pos.fills.push(f)
  if (pos.remaining <= pos.qty * 1e-9) {
    pos.remaining = 0
    pos.status = 'closed'
    pos.closedAt = now
    pos.exitReason = reason
    pos.pnlUsd = pos.fills.filter(x => x.reason !== 'entry').reduce((s, x) => s + x.usd, 0) - pos.sizeUsd - (pos.gasUsd ?? 0)
  }
  return f
}

export interface Exit { qty: number; reason: ExitReason }

/** The sales a new price calls for, in order (pure: the position doesn't change). */
export function exitsAt(pos: Position, price: number, now: number, params = STRATEGIES[pos.strategy]): Exit[] {
  if (pos.status !== 'open' || !(price > 0)) return []
  const peak = Math.max(pos.peak, price)
  const x = price / pos.marketEntry
  if (x <= params.stopLoss) return [{ qty: pos.remaining, reason: 'stop' }]
  const out: Exit[] = []
  let left = pos.remaining, tp1Done = pos.tp1Done
  const open = () => left > pos.qty * 1e-9
  if (!tp1Done && x >= params.tp1Multiple) { const q = left * params.tp1SellPct; out.push({ qty: q, reason: 'tp1' }); left -= q; tp1Done = true }
  if (open() && tp1Done && price <= peak * (1 - params.trailFromPeak)) { out.push({ qty: left, reason: 'trail' }); left = 0 }
  if (open() && now - pos.openedAt >= params.timeStopMin * 60_000 && x < params.timeStopMinGain && !tp1Done) { out.push({ qty: left, reason: 'time' }); left = 0 }
  if (open() && params.maxHoldMin !== undefined && now - pos.openedAt >= params.maxHoldMin * 60_000) { out.push({ qty: left, reason: 'time' }); left = 0 }
  return out
}

/** A new market price for an open paper position: returns the fills its exits made. */
export function onPrice(pos: Position, price: number, now: number, params = STRATEGIES[pos.strategy]): Fill[] {
  const exits = exitsAt(pos, price, now, params)
  if (pos.status === 'open' && price > 0) pos.peak = Math.max(pos.peak, price)
  return exits.map(e => recordSell(pos, e.qty, e.qty * price * (1 - pos.cost), now, e.reason))
}

/** Close a paper position at the last price (a later safety failure, say). */
export function closeNow(pos: Position, price: number, now: number, reason: ExitReason): Fill[] {
  return pos.status === 'open' && price > 0 ? [recordSell(pos, pos.remaining, pos.remaining * price * (1 - pos.cost), now, reason)] : []
}

export interface Stats {
  closed: number
  open: number
  wins: number
  losses: number
  /** Share of closed positions that made money. */
  winRate: number | null
  avgWinUsd: number | null
  avgLossUsd: number | null
  /** Total won ÷ total lost. Above 1 makes money. */
  profitFactor: number | null
  /** Average result per closed position. */
  expectancyUsd: number | null
  totalPnlUsd: number
  /** Largest fall of the running total from its high. */
  maxDrawdownUsd: number
}

export function stats(positions: Position[]): Stats {
  const closed = positions.filter(p => p.status === 'closed').sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const pnl = closed.map(p => p.pnlUsd ?? 0)
  const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x <= 0)
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)
  let run = 0, high = 0, dd = 0
  for (const x of pnl) { run += x; high = Math.max(high, run); dd = Math.max(dd, high - run) }
  return {
    closed: closed.length,
    open: positions.filter(p => p.status === 'open').length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWinUsd: wins.length ? sum(wins) / wins.length : null,
    avgLossUsd: losses.length ? sum(losses) / losses.length : null,
    profitFactor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : wins.length ? Infinity : null,
    expectancyUsd: closed.length ? sum(pnl) / closed.length : null,
    totalPnlUsd: sum(pnl),
    maxDrawdownUsd: dd,
  }
}

/** Whether a new position is allowed now (pure; pass the positions of one mode). */
export function canOpen(positions: Position[], token: string, now: number, risk = RISK, strategy?: Strategy): { ok: boolean; why: string } {
  const open = positions.filter(p => p.status === 'open')
  if (open.length >= risk.maxOpen) return { ok: false, why: `${open.length} positions open (max ${risk.maxOpen})` }
  const scalps = open.filter(p => p.strategy === 'scalp').length
  if (strategy === 'scalp' && scalps >= risk.maxOpenScalp) return { ok: false, why: `${scalps} scalps open (max ${risk.maxOpenScalp})` }
  if (positions.some(p => p.token === token && (p.status === 'open' || now - (p.closedAt ?? 0) < risk.cooldownMin * 60_000))) return { ok: false, why: 'traded this coin recently' }
  const day = new Date(now).toISOString().slice(0, 10)
  const today = positions.filter(p => p.closedAt && new Date(p.closedAt).toISOString().slice(0, 10) === day).reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
  if (today <= -risk.dailyLossUsd) return { ok: false, why: `today's loss $${(-today).toFixed(2)} reached the $${risk.dailyLossUsd} limit` }
  return { ok: true, why: '' }
}
