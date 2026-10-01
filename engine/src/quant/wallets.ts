// Wallet intelligence: every wallet's record across coins, from the engine's
// own trades. A wallet's position in a coin opens with its first buy and
// closes when it has sold (nearly) everything; a closed position is one trade
// with its return (what it got out over what it put in) and its hold time.
// Only closed trades count, and only ones closed before the moment being
// judged, so a backtest replaying the past learns as it goes (no look-ahead).
//
// Classes (approximate, from behaviour, never from size):
//   SMART_MONEY      enough closed trades over several coins, winning often
//                    and by more than it loses, a positive median return, a
//                    real realized profit, and not a bot buying everything
//   EARLY_BUYER      most of its entries in a coin's first minutes
//   SCALPER          in and out within minutes, or buying more coins a day
//                    than a person would (sniper and pump farms)
//   MOMENTUM_TRADER  holds minutes to an hour
//   HIGH_RISK        a long record of losing
//   UNKNOWN          not enough history
//
// A coin's smart-money view: the smart wallets that bought it in the last
// minutes (count and quality), any cluster of them entering together, and
// those leaving it.

import type { TokenTape } from './tape'
import { median, ramp } from './util'

export type WalletClass = 'SMART_MONEY' | 'EARLY_BUYER' | 'MOMENTUM_TRADER' | 'SCALPER' | 'UNKNOWN' | 'HIGH_RISK'

export interface WalletPosition { token: string; tokens: number; boughtTokens: number; cost: number; proceeds: number; openedAt: number; lastAt: number; early: boolean }

export interface WalletStats {
  wallet: string
  trade_count: number
  wins: number
  win_rate: number
  profit_factor: number | null
  average_return: number
  median_return: number
  average_hold_ms: number
  maximum_drawdown_usd: number
  early_entry_frequency: number
  successful_early_entries: number
  realized_profit: number
  realized_loss: number
  average_position_usd: number
  tokens_traded: number
  tokens_per_day: number
  class: WalletClass
  /** 0–1, for smart money: how sure and how good. */
  quality: number
  updated_at: number
}

interface WalletRecord {
  positions: Map<string, WalletPosition>
  returns: number[]
  trades: number
  wins: number
  grossProfit: number
  grossLoss: number
  holdMs: number
  early: number
  earlyWins: number
  costSum: number
  cumPnl: number
  peakPnl: number
  maxDd: number
  tokens: Set<string>
  /** First-buy times of coins in the last day. */
  buysDay: number[]
  lastAt: number
  stats: WalletStats | null
}

export interface SmartConfig {
  minClosedTrades: number; minTokens: number; minWinRate: number; minProfitFactor: number; minRealizedUsd: number
  minMedianReturnPct: number; earlyEntrySec: number; maxTokensPerDay: number; windowMin: number; clusterWindowMin: number; clusterMin: number; maxWallets: number
}

export interface SmartView {
  smart_money_count: number
  /** Average quality of those wallets (0–1). */
  smart_money_quality: number
  /** Smart wallets that sold half or more of their position in the window. */
  smart_money_exits: number
  /** A cluster: `clusterMin`+ smart wallets entering within `clusterWindowMin`. */
  cluster: boolean
  /** When and at what price the first smart wallet of the window bought. */
  first_entry_at: number | null
  first_entry_price: number | null
  wallets: { wallet: string; quality: number; at: number }[]
}

const DUST = 0.01

export class WalletBook {
  readonly wallets = new Map<string, WalletRecord>()
  /** Wallets whose record changed since the last flush (quant/store.ts). */
  readonly changed = new Set<string>()
  private adds = 0

  constructor(private cfg: SmartConfig) {}
  setConfig(cfg: SmartConfig) { this.cfg = cfg; for (const r of this.wallets.values()) r.stats = null }

  /** A trade of `wallet` in `token` (launched at `launchedAt`). */
  onTrade(wallet: string | null, token: string, side: 'BUY' | 'SELL', usd: number, tokens: number, ts: number, launchedAt: number) {
    if (!wallet || !(tokens > 0)) return
    let r = this.wallets.get(wallet)
    if (!r) {
      r = { positions: new Map(), returns: [], trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, holdMs: 0, early: 0, earlyWins: 0, costSum: 0, cumPnl: 0, peakPnl: 0, maxDd: 0, tokens: new Set(), buysDay: [], lastAt: 0, stats: null }
      this.wallets.set(wallet, r)
      if (++this.adds % 1_000 === 0) this.evict()
    }
    r.lastAt = Math.max(r.lastAt, ts)
    let p = r.positions.get(token)
    if (side === 'BUY') {
      if (!p) {
        p = { token, tokens: 0, boughtTokens: 0, cost: 0, proceeds: 0, openedAt: ts, lastAt: ts, early: ts - launchedAt <= this.cfg.earlyEntrySec * 1_000 }
        r.positions.set(token, p)
        r.stats = null // coins a day (the bot check) changed
        r.buysDay.push(ts)
        while (r.buysDay.length && ts - r.buysDay[0] > 86_400_000) r.buysDay.shift()
      }
      p.tokens += tokens; p.boughtTokens += tokens; p.cost += usd; p.lastAt = ts
      r.tokens.add(token)
      return
    }
    if (!p || !(p.cost > 0)) return // sold coins it didn't buy here: no cost to measure against
    const sold = Math.min(tokens, p.tokens)
    p.proceeds += p.tokens > 0 ? usd * (sold / tokens) : 0
    p.tokens -= sold; p.lastAt = ts
    if (p.tokens <= p.boughtTokens * DUST) this.close(wallet, r, p, ts)
  }

  private close(wallet: string, r: WalletRecord, p: WalletPosition, ts: number) {
    r.positions.delete(p.token)
    const pnl = p.proceeds - p.cost
    const ret = p.cost > 0 ? p.proceeds / p.cost - 1 : 0
    r.trades++
    if (pnl > 0) { r.wins++; r.grossProfit += pnl } else r.grossLoss += -pnl
    r.returns.push(ret); if (r.returns.length > 200) r.returns.shift()
    r.holdMs += ts - p.openedAt
    r.costSum += p.cost
    if (p.early) { r.early++; if (pnl > 0) r.earlyWins++ }
    r.cumPnl += pnl; r.peakPnl = Math.max(r.peakPnl, r.cumPnl); r.maxDd = Math.max(r.maxDd, r.peakPnl - r.cumPnl)
    r.stats = null
    this.changed.add(wallet)
  }

  /** Drops the least recently active wallets beyond the cap. */
  private evict() {
    const over = this.wallets.size - this.cfg.maxWallets
    if (over <= 0) return
    const oldest = [...this.wallets.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, over + Math.floor(this.cfg.maxWallets * 0.05))
    for (const [w] of oldest) { this.wallets.delete(w); this.changed.delete(w) }
  }

  stats(wallet: string, now = Date.now()): WalletStats | null {
    const r = this.wallets.get(wallet)
    if (!r) return null
    if (r.stats) return r.stats
    const c = this.cfg
    const winRate = r.trades ? r.wins / r.trades : 0
    const pf = r.grossLoss > 0 ? r.grossProfit / r.grossLoss : r.grossProfit > 0 ? Infinity : null
    const med = median(r.returns) ?? 0
    const avgHold = r.trades ? r.holdMs / r.trades : 0
    const perDay = r.buysDay.filter(t => now - t <= 86_400_000).length
    const enough = r.trades >= c.minClosedTrades
    const bot = perDay > c.maxTokensPerDay
    let cls: WalletClass = 'UNKNOWN'
    if (enough && winRate < 0.3 && (pf ?? 0) < 0.5) cls = 'HIGH_RISK'
    else if (enough && !bot && r.tokens.size >= c.minTokens && winRate >= c.minWinRate && (pf ?? 0) >= c.minProfitFactor && r.grossProfit - r.grossLoss >= c.minRealizedUsd && med * 100 >= c.minMedianReturnPct) cls = 'SMART_MONEY'
    else if (bot || (r.trades >= 5 && avgHold < 180_000)) cls = 'SCALPER'
    else if (r.trades >= 3 && r.early / r.trades >= 0.5) cls = 'EARLY_BUYER'
    else if (r.trades >= 3) cls = 'MOMENTUM_TRADER'
    const pfN = pf === null ? 0 : pf === Infinity ? 1 : ramp(pf, 1.2, 4)
    const quality = cls !== 'SMART_MONEY' ? 0 : (r.trades / (r.trades + 10)) * (0.4 * ramp(winRate, 0.5, 0.8) + 0.3 * pfN + 0.3 * ramp(med, 0, 0.3))
    r.stats = {
      wallet, trade_count: r.trades, wins: r.wins, win_rate: winRate, profit_factor: pf === Infinity ? null : pf,
      average_return: r.trades ? r.returns.reduce((s, x) => s + x, 0) / r.returns.length : 0, median_return: med,
      average_hold_ms: avgHold, maximum_drawdown_usd: r.maxDd,
      early_entry_frequency: r.trades ? r.early / r.trades : 0, successful_early_entries: r.earlyWins,
      realized_profit: r.grossProfit, realized_loss: r.grossLoss,
      average_position_usd: r.trades ? r.costSum / r.trades : 0,
      tokens_traded: r.tokens.size, tokens_per_day: perDay, class: cls, quality, updated_at: now,
    }
    return r.stats
  }

  classOf(wallet: string | null, now?: number): WalletClass { return wallet ? this.stats(wallet, now)?.class ?? 'UNKNOWN' : 'UNKNOWN' }

  /** Smart wallets in a coin over the last `windowMin` (from its tape). */
  smartView(tape: TokenTape, now: number): SmartView {
    const c = this.cfg
    const from = now - c.windowMin * 60_000
    const firstBuy = new Map<string, { at: number; price: number | null; quality: number }>()
    const sold = new Map<string, number>()
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const t = tape.trades[i]
      if (t.ts > now) continue
      if (t.ts <= from) break
      if (!t.wallet) continue
      const s = this.stats(t.wallet, now)
      if (s?.class !== 'SMART_MONEY') continue
      if (t.side === 'BUY') firstBuy.set(t.wallet, { at: t.ts, price: t.price ?? tape.priceAt(t.ts), quality: s.quality })
      else sold.set(t.wallet, (sold.get(t.wallet) ?? 0) + t.tokens)
    }
    let exits = 0
    for (const [w, s] of sold) {
      const h = tape.holdings.get(w)
      const before = (h?.tokens ?? 0) + s
      if (before > 0 && s / before >= 0.5) exits++
    }
    const entries = [...firstBuy.entries()].map(([wallet, v]) => ({ wallet, ...v })).sort((a, b) => a.at - b.at)
    let cluster = false
    for (let i = 0, j = 0; j < entries.length; j++) {
      while (entries[j].at - entries[i].at > c.clusterWindowMin * 60_000) i++
      if (j - i + 1 >= c.clusterMin) { cluster = true; break }
    }
    return {
      smart_money_count: entries.length,
      smart_money_quality: entries.length ? entries.reduce((s, e) => s + e.quality, 0) / entries.length : 0,
      smart_money_exits: exits, cluster,
      first_entry_at: entries[0]?.at ?? null, first_entry_price: entries[0]?.price ?? null,
      wallets: entries.map(e => ({ wallet: e.wallet, quality: Math.round(e.quality * 1_000) / 1_000, at: e.at })),
    }
  }

  /** Class counts (dashboards, /metrics). */
  summary(now = Date.now()): Record<WalletClass, number> & { wallets: number } {
    const out: Record<WalletClass, number> = { SMART_MONEY: 0, EARLY_BUYER: 0, MOMENTUM_TRADER: 0, SCALPER: 0, UNKNOWN: 0, HIGH_RISK: 0 }
    for (const w of this.wallets.keys()) out[this.stats(w, now)!.class]++
    return { ...out, wallets: this.wallets.size }
  }

  /** The best smart wallets now. */
  top(n: number, now = Date.now()): WalletStats[] {
    const rows: WalletStats[] = []
    for (const w of this.wallets.keys()) { const s = this.stats(w, now)!; if (s.class === 'SMART_MONEY') rows.push(s) }
    return rows.sort((a, b) => b.quality - a.quality).slice(0, n)
  }

  /** Open positions of a wallet (the wallet_token_positions rows). */
  positionsOf(wallet: string): WalletPosition[] { return [...(this.wallets.get(wallet)?.positions.values() ?? [])] }
}
