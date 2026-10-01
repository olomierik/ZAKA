// Outcome labels for every signal, traded or not: what the price did after it
// over the next `horizonMin` minutes. Stored beside the signal's feature
// vector (arcdex_sig_signal_outcomes), they are the targets a model can learn
// later; the deterministic rules and risk controls stay in charge either way.
//
//   hit_10_before_5    +10% reached before −5% (null: neither within the horizon)
//   hit_20_before_10   +20% before −10%
//   max_return         the best price over the horizon against the signal's (fraction)
//   max_drawdown       the worst (fraction, ≤ 0)
//   return_5m / 15m / 60m   the price then against the signal's
//
// Prices are the coin's main-pool prices as they arrive, so the labels follow
// the same data the engine traded on.

import type { OutcomeRow } from './store'

interface Tracked {
  signalId: string
  token: string
  strategy: string
  at: number
  price: number
  max: number
  min: number
  hit10: boolean | null
  hit20: boolean | null
  r5: number | null
  r15: number | null
  last: number
}

const BARRIERS = [{ key: 'hit10' as const, up: 0.1, down: -0.05 }, { key: 'hit20' as const, up: 0.2, down: -0.1 }]

export class Labeler {
  private byToken = new Map<string, Tracked[]>()

  constructor(private horizonMin: () => number) {}

  get pending() { let n = 0; for (const l of this.byToken.values()) n += l.length; return n }

  track(signalId: string, token: string, strategy: string, at: number, price: number) {
    if (!(price > 0)) return
    const list = this.byToken.get(token) ?? []
    list.push({ signalId, token, strategy, at, price, max: price, min: price, hit10: null, hit20: null, r5: null, r15: null, last: price })
    this.byToken.set(token, list)
  }

  /** A new price for `token` at `ts` (labels finish on the clock: `due`). */
  onPrice(token: string, price: number, ts: number) {
    const list = this.byToken.get(token)
    if (!list || !(price > 0)) return
    const horizon = this.horizonMin() * 60_000
    for (const t of list) {
      if (ts <= t.at) continue
      if (ts - t.at > horizon) continue // finished on the clock (due)
      if (t.r5 === null && ts - t.at >= 300_000) t.r5 = t.last / t.price - 1
      if (t.r15 === null && ts - t.at >= 900_000) t.r15 = t.last / t.price - 1
      t.max = Math.max(t.max, price); t.min = Math.min(t.min, price); t.last = price
      const r = price / t.price - 1
      for (const b of BARRIERS) if (t[b.key] === null) { if (r >= b.up) t[b.key] = true; else if (r <= b.down) t[b.key] = false }
    }
  }

  /** Labels whose horizon has passed by `now`. */
  due(now: number): OutcomeRow[] {
    const horizon = this.horizonMin() * 60_000
    const out: OutcomeRow[] = []
    for (const [token, list] of this.byToken) {
      const keep: Tracked[] = []
      for (const t of list) {
        if (now - t.at < horizon) { keep.push(t); continue }
        out.push({
          signalId: t.signalId, at: t.at, token, strategy: t.strategy,
          data: {
            horizon_min: horizon / 60_000, entry_price: t.price,
            max_return: t.max / t.price - 1, max_drawdown: t.min / t.price - 1,
            hit_10_before_5: t.hit10, hit_20_before_10: t.hit20,
            return_5m: t.r5 ?? t.last / t.price - 1, return_15m: t.r15 ?? t.last / t.price - 1, return_60m: t.last / t.price - 1,
          },
        })
      }
      if (keep.length) this.byToken.set(token, keep); else this.byToken.delete(token)
    }
    return out
  }
}
