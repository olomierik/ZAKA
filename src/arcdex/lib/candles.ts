// Candles from on-chain swaps, merged onto GeckoTerminal's history.
//
// A pool's price only moves when someone swaps, and each Swap event carries
// the pool price right after it. So a candle opens at the previous candle's
// close (the price going into that bucket), and every swap in the bucket is
// a tick. That keeps the series continuous — no gaps between candles — and
// lets a 1-second chart move on every block.

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
  /** A bar no one traded in, added to keep time even on the axis (lib/chartFrame.ts fillGaps). */
  fill?: true
}

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

/** A trade more than this many times off the median of the trades around it is left off the chart. */
export const TICK_OFF_X = 1.6
/** Trades on each side that make up the median. */
const TICK_WINDOW = 6

/** Ticks without the ones priced far from the trades around them (2026-10-17). On a busy Solana coin, arbitrage bots
 * trade several pools in one transaction; read from the signer's side, their net amounts priced one trade at 2× the
 * market and the next at 0.2×, so the line zigzagged and the header's price jumped. A trade is kept when it agrees with
 * the trades just before it or with those just after it (each side's median): a real move agrees with the side it
 * moved to, a bot's odd print with neither. Fewer than 5 ticks: unchanged. */
export function cleanTicks(ticks: Tick[]): Tick[] {
  const sorted = ticks.filter(t => t.priceUsd > 0 && Number.isFinite(t.priceUsd)).sort((a, b) => a.time - b.time)
  if (sorted.length < 5) return sorted
  const logs = sorted.map(t => Math.log(t.priceUsd))
  const lim = Math.log(TICK_OFF_X)
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y)
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
  }
  return sorted.filter((_, i) => {
    let before = logs.slice(Math.max(0, i - TICK_WINDOW), i)
    let after = logs.slice(i + 1, i + 1 + TICK_WINDOW)
    // At either end only one side exists: judge by its three nearest trades, so a move right at the start or end stays.
    if (!before.length) after = after.slice(0, 3)
    if (!after.length) before = before.slice(-3)
    return (before.length > 0 && Math.abs(logs[i] - median(before)) <= lim) || (after.length > 0 && Math.abs(logs[i] - median(after)) <= lim)
  })
}
