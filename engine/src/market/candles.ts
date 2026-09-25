// Live OHLCV candles for every token at 1s, 5s, 15s, 1m, 5m, 15m, 1h, 4h, 1d.
//
// Every trade updates the current candle of each interval in place:
//   OPEN   the price the bucket's first trade started from (the previous
//          close — or, for a token's first trade, the pool's price before
//          it), so candles join without gaps and a single-trade 1s candle
//          still shows the move
//   HIGH / LOW  over every price touched
//   CLOSE  the latest trade by (block, logIndex) — so a trade arriving late
//          never overwrites a newer close
//   VOLUME USD traded, plus the trade count
// A candle is complete once a trade lands in a later bucket; completed ones
// go to the history store. The last few buckets stay in memory so a late
// trade (recovered by the reconciler) still lands in the right candle;
// anything older is repaired in the database from the stored trades.

import { INTERVALS, INTERVAL_LIST, type Interval, type WireCandle } from '../../../api/_marketProtocol'

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; n: number; ord: number }
export interface CandleEvent { interval: Interval; candle: Candle }
export interface ApplyResult {
  /** Candles changed by this trade (the current one, or a recent one for a late trade). */
  updated: CandleEvent[]
  /** Candles that are now complete (or changed after completing) — persist these. */
  completed: CandleEvent[]
  /** Buckets too old for memory: rebuild them from stored trades. */
  repair: { interval: Interval; bucket: number }[]
}

export const toWireCandle = (c: Candle): WireCandle => [c.t, c.o, c.h, c.l, c.c, c.v, c.n]

export class CandleEngine {
  private series = new Map<string, Candle[]>()
  private lastSeen = new Map<string, number>()

  constructor(private keep = 4) {}

  /** @param ord (block × 100000 + logIndex) — trade order on chain */
  apply(token: string, priceUsd: number, usd: number, tsMs: number, ord: number, priceBefore: number | null): ApplyResult {
    const out: ApplyResult = { updated: [], completed: [], repair: [] }
    this.lastSeen.set(token, Date.now())
    const sec = Math.floor(tsMs / 1000)
    for (const interval of INTERVAL_LIST) {
      const step = INTERVALS[interval]
      const bucket = Math.floor(sec / step) * step
      const key = `${token}|${interval}`
      let list = this.series.get(key)
      if (!list) { list = []; this.series.set(key, list) }
      const last = list[list.length - 1]
      if (!last || bucket > last.t) {
        const open = last ? last.c : (priceBefore && priceBefore > 0 ? priceBefore : priceUsd)
        const c: Candle = { t: bucket, o: open, h: Math.max(open, priceUsd), l: Math.min(open, priceUsd), c: priceUsd, v: usd, n: 1, ord }
        if (last) out.completed.push({ interval, candle: last })
        list.push(c)
        if (list.length > this.keep) list.shift()
        out.updated.push({ interval, candle: c })
        continue
      }
      const c = list.find(x => x.t === bucket)
      if (!c) {
        if (bucket < list[0].t) out.repair.push({ interval, bucket })
        else {
          // A late trade in a bucket that had none: insert it in order.
          const open = [...list].reverse().find(x => x.t < bucket)?.c ?? priceUsd
          const n: Candle = { t: bucket, o: open, h: Math.max(open, priceUsd), l: Math.min(open, priceUsd), c: priceUsd, v: usd, n: 1, ord }
          list.splice(list.findIndex(x => x.t > bucket), 0, n)
          out.updated.push({ interval, candle: n })
          out.completed.push({ interval, candle: n })
        }
        continue
      }
      c.h = Math.max(c.h, priceUsd)
      c.l = Math.min(c.l, priceUsd)
      c.v += usd
      c.n += 1
      if (ord > c.ord) { c.c = priceUsd; c.ord = ord }
      out.updated.push({ interval, candle: c })
      if (c !== last) out.completed.push({ interval, candle: c })
    }
    return out
  }

  current(token: string, interval: Interval): Candle | undefined {
    const l = this.series.get(`${token}|${interval}`)
    return l?.[l.length - 1]
  }

  recent(token: string, interval: Interval): Candle[] {
    return this.series.get(`${token}|${interval}`) ?? []
  }

  /** Warm restart: candles saved in the hot store. */
  load(token: string, interval: Interval, candles: Candle[]) {
    this.series.set(`${token}|${interval}`, candles.slice(-this.keep))
  }

  /** Drop tokens with no trade for `idleMs` (their candles are in the database). */
  evictIdle(idleMs: number) {
    const cutoff = Date.now() - idleMs
    for (const [token, at] of this.lastSeen) {
      if (at >= cutoff) continue
      this.lastSeen.delete(token)
      for (const iv of INTERVAL_LIST) this.series.delete(`${token}|${iv}`)
    }
  }

  get tokenCount() { return this.lastSeen.size }
}
