// Candles from on-chain swaps, merged onto GeckoTerminal's history.
//
// A pool's price only moves when someone swaps, and each Swap event carries
// the pool price right after it. So a candle opens at the previous candle's
// close (the price going into that bucket), and every swap in the bucket is
// a tick. That keeps the series continuous — no gaps between candles — and
// lets a 1-second chart move on every block.

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

/** A swap as the chart sees it: when, the pool price after it (USD), and its size (USD). */
export interface Tick { time: number; priceUsd: number; usd: number }

/** Buckets ticks (any order; times in ms) into candles of `step` seconds. */
export function candlesFromTicks(ticks: Tick[], step: number): Candle[] {
  const sorted = ticks.filter(t => t.priceUsd > 0 && Number.isFinite(t.priceUsd)).sort((a, b) => a.time - b.time)
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const t of sorted) {
    const bucket = Math.floor(t.time / 1000 / step) * step
    if (!cur || cur.time !== bucket) {
      const open: number = cur ? cur.close : t.priceUsd
      cur = { time: bucket, open, high: Math.max(open, t.priceUsd), low: Math.min(open, t.priceUsd), close: t.priceUsd, volume: 0 }
      out.push(cur)
    } else {
      cur.high = Math.max(cur.high, t.priceUsd)
      cur.low = Math.min(cur.low, t.priceUsd)
      cur.close = t.priceUsd
    }
    cur.volume += t.usd
  }
  return out
}

/** History up to and including the first on-chain bucket (that bucket may
 * be only partly covered by the swaps loaded), on-chain candles after it —
 * re-opened at the previous close so the join is seamless. */
export function mergeCandles(history: Candle[], recent: Candle[]): Candle[] {
  if (recent.length === 0) return history
  if (history.length === 0) return recent
  const cut = recent[0].time
  const before = history.filter(c => c.time < cut)
  const atCut = history.find(c => c.time === cut)
  const after = (atCut ? recent.slice(1) : recent).map(c => ({ ...c }))
  const out = [...before, ...(atCut ? [atCut] : []), ...after]
  const firstNew = out.length - after.length
  if (after.length && firstNew > 0) {
    const prev = out[firstNew - 1], c = out[firstNew]
    c.open = prev.close
    c.high = Math.max(c.high, c.open)
    c.low = Math.min(c.low, c.open)
  }
  return out
}
