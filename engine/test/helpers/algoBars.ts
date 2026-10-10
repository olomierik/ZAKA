// Synthetic one-minute candles for ARCDEX Algo's tests: a seeded random walk, optionally with a
// drift that holds for six hours at a time (a market with real trends to find).
import type { PerpsBar } from '../../src/perps/shared'

export function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function gauss(r: () => number) {
  const u = Math.max(1e-12, r()), v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** `n` one-minute candles from `start`; `trend` is the drift in units of the minute's volatility. */
export function walk(seed: number, n: number, start: number, px0: number, vol: number, trend = 0): PerpsBar[] {
  const r = rng(seed)
  const out: PerpsBar[] = []
  let px = px0, drift = 0
  for (let i = 0; i < n; i++) {
    if (i % 360 === 0) drift = trend * vol * (r() < 0.5 ? -1 : 1) * (0.5 + r())
    const o = px, c = px * Math.exp(drift + vol * gauss(r))
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.3)
    const lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.3)
    out.push([start + i * 60_000, o, hi, lo, c])
    px = c
  }
  return out
}

export const START = Date.UTC(2026, 9, 1)

export function market(days: number, trend = 0, seed = 1) {
  const n = days * 1440
  return {
    BTC: walk(seed, n, START, 82_000, 0.0007, trend),
    ETH: walk(seed + 1, n, START, 2_500, 0.0009, trend),
    SOL: walk(seed + 2, n, START, 110, 0.0011, trend),
  }
}
