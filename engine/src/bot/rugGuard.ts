// The rug guard (owner's request, 2026-09-30: "prevent the bot from rug
// pulls, quickly close trades to avoid the account being drained"). Every
// trade in a coin is checked as it arrives; an alarm closes every open
// position in the coin at once (the bot's, the bot wallet's and every
// visitor's bot), before the stop-loss would, and keeps the coin from being
// bought again for a while. The safety scan already refuses coins that can
// be rugged by code (mint, freeze, a hook that blocks sales, a honeypot);
// this catches the rugs that happen in the market:
//
//   liquidity pulled   the pool's liquidity falls 35% below its high of the
//                      last 15 minutes (liquidity removed, or drained)
//   insider dump       a wallet that bought in the launch block or the two
//                      after it, or one funded from a cluster the safety
//                      scan found, sells 4% or more of the pool
//   whale dump         any one sale of 12% or more of the pool
//   crash              the price 20% under its high of the last minute, on
//                      sells at least twice the buys
//
// The creator selling is handled beside it (bot.ts): it closes scalps and
// every visitor's bot at once.
//
// A paper position closes at the price after the trade that raised the
// alarm, as a real sale would: the guard can't undo the dump that tripped
// it, it gets out before the next one.

import type { RecentTapes, TapeTrade } from '../intel/flow'

export const RUG = {
  liqDropPct: 35,
  liqWindowMs: 15 * 60_000,
  whaleSellPct: 12,
  insiderSellPct: 4,
  crashPct: 20,
  crashWindowMs: 60_000,
  crashSellRatio: 2,
  /** A coin that raised an alarm isn't bought again for this long. */
  quarantineMs: 30 * 60_000,
}

export interface RugAlarm { at: number; text: string }

const usd = (n: number) => `$${n >= 10_000 ? `${(n / 1_000).toFixed(1)}K` : Math.round(n).toLocaleString('en-US')}`

export class RugWatch {
  private liq = new Map<string, { ts: number; usd: number }[]>()
  private insiders = new Map<string, Set<string>>()
  private alarms = new Map<string, RugAlarm>()

  constructor(private tapes: RecentTapes, private rules = RUG) {}

  /** Wallets that count as insiders for a coin (bundled at launch, funded from a cluster, funded by the creator). */
  setInsiders(token: string, wallets: Iterable<string>) {
    const set = new Set([...wallets].map(w => w.toLowerCase()))
    if (set.size) this.insiders.set(token, set); else this.insiders.delete(token)
  }

  /**
   * A trade in `token`, already added to the recent tape. `liquidityUsd` is
   * the main pool's depth after it (null: a side pool's trade, or unknown);
   * `priced`: whether it's the main pool (its price is the coin's).
   */
  onTrade(token: string, t: TapeTrade, liquidityUsd: number | null, priced: boolean, now = Date.now()): RugAlarm | null {
    const r = this.rules
    let text: string | null = null
    const list = this.liq.get(token) ?? []
    if (priced && liquidityUsd !== null && liquidityUsd >= 0) {
      while (list.length && t.ts - list[0].ts > r.liqWindowMs) list.shift()
      const high = list.reduce((m, x) => Math.max(m, x.usd), 0)
      list.push({ ts: t.ts, usd: liquidityUsd })
      if (list.length > 300) list.splice(0, list.length - 300)
      this.liq.set(token, list)
      if (high > 0 && liquidityUsd < high * (1 - r.liqDropPct / 100)) {
        text = `liquidity fell ${Math.round((1 - liquidityUsd / high) * 100)}% (${usd(high)} → ${usd(liquidityUsd)}): pulled or drained`
      }
    }
    const depth = (priced ? liquidityUsd : null) ?? list[list.length - 1]?.usd ?? null
    if (!text && t.side === 'SELL' && depth && depth > 0 && t.usd > 0) {
      const share = (t.usd / depth) * 100
      if (t.wallet && this.insiders.get(token)?.has(t.wallet) && share >= r.insiderSellPct) text = `an early insider sold ${usd(t.usd)} (${share.toFixed(0)}% of the pool)`
      else if (share >= r.whaleSellPct) text = `one wallet sold ${usd(t.usd)} (${share.toFixed(0)}% of the pool)`
    }
    if (!text && priced && t.price !== null && t.price > 0) {
      const w = this.tapes.window(token, t.ts, r.crashWindowMs)
      const high = w.reduce((m, x) => Math.max(m, x.price ?? 0), 0)
      const sells = w.reduce((s, x) => s + (x.side === 'SELL' ? x.usd : 0), 0)
      const buys = w.reduce((s, x) => s + (x.side === 'BUY' ? x.usd : 0), 0)
      if (high > 0 && t.price <= high * (1 - r.crashPct / 100) && sells >= r.crashSellRatio * Math.max(buys, 1)) {
        text = `price −${Math.round((1 - t.price / high) * 100)}% in a minute on heavy selling (${usd(sells)} sold, ${usd(buys)} bought)`
      }
    }
    if (!text) return null
    const a = { at: now, text }
    this.alarms.set(token, a)
    return a
  }

  /** The coin's last alarm, while it's still quarantined. */
  recentAlarm(token: string, now = Date.now()): RugAlarm | null {
    const a = this.alarms.get(token)
    return a && now - a.at < this.rules.quarantineMs ? a : null
  }

  forget(token: string) { this.liq.delete(token); this.insiders.delete(token); this.alarms.delete(token) }
}
