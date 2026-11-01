// The fair value of a BTC Up/Down window under Polymarket's TWAP rules (docs/PREDICT-BTC-AUTOTRADE-2026-10.md §3, §5).
//
// The market resolves on A_end, the average of Chainlink's BTC/USD over the last 60 seconds, against A_start, the same
// average over the 60 seconds before the start (Polymarket's "price to beat"). In log prices, with x the estimate now
// and σ the per-second volatility:
//   - more than 60 s left: A_end − x has variance σ²·((τ − 60) + 60/3), the 60/3 being the averaging;
//   - inside the last minute: (60 − τ) seconds of the average are already observed (mean A_obs), and the rest has
//     variance σ²·τ/3, weighted by τ/60. The uncertainty shrinks with τ^1.5, so the side ahead locks in fast.
// A small basis error (the Chainlink estimate is built from exchange prices) is added on top. P(Up) = P(A_end ≥ A_start)
// (a tie is Up) through a unit-variance Student-t(4): fat-tailed, as one-second BTC returns are.

/** The CDF of Student's t with 4 degrees of freedom (closed form). */
export function tcdf4(t: number): number {
  const u = 1 + (t * t) / 4
  return 0.5 + (3 / 8) * (t / Math.sqrt(u)) * (1 - (t * t) / (12 * u))
}

/** The same distribution scaled to unit variance (t4 has variance 2). */
export const unitT4 = (z: number) => tcdf4(z * Math.SQRT2)

export interface FairInput {
  /** The price to beat (A_start), in dollars. */
  open: number
  /** The Chainlink estimate now, in dollars. */
  now: number
  /** Seconds until the window ends. */
  secondsLeft: number
  /** Per-second volatility of log price. */
  sigma: number
  /** The mean of the estimate over the part of the final minute already passed (needed when secondsLeft < 60). */
  observedAvg?: number | null
  /** One standard deviation of the basis error, as a fraction (1.5e-4 = 1.5 bp). */
  basisSd?: number
  twapSec?: number
}

export function fairUp(i: FairInput): number {
  const L = i.twapSec ?? 60
  const tau = Math.max(0, i.secondsLeft)
  const x = Math.log(i.now)
  const target = Math.log(i.open)
  const s2 = i.sigma * i.sigma
  let mean: number, v: number
  if (tau > L) {
    mean = x
    v = s2 * (tau - L + L / 3)
  } else {
    const obs = i.observedAvg && i.observedAvg > 0 ? Math.log(i.observedAvg) : x
    const w = tau / L
    mean = (1 - w) * obs + w * x
    v = s2 * w * w * (tau / 3)
  }
  const b = i.basisSd ?? 1.5e-4
  // The basis error moves both the observed part and the rest, so it isn't averaged away.
  v += b * b * (tau > L ? 1 : Math.max(0.25, tau / L))
  const sd = Math.sqrt(v)
  if (!(sd > 0)) return mean >= target ? 1 : 0
  const p = unitT4((mean - target) / sd)
  return Math.min(1, Math.max(0, p))
}

/** Kelly's fraction for a binary contract bought at all-in cost c with win chance p. */
export const kelly = (p: number, c: number) => (c >= 1 ? 0 : Math.max(0, (p - c) / (1 - c)))
