// Small numeric helpers shared by the signal engine's parts.

/** 0 at or below `lo`, 1 at or above `hi`, linear between (lo > hi reverses it). Non-finite input is 0. */
export function ramp(x: number | null | undefined, lo: number, hi: number): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0
  if (lo === hi) return x >= hi ? 1 : 0
  const r = (x - lo) / (hi - lo)
  return r <= 0 ? 0 : r >= 1 ? 1 : r
}

export const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo)

/** a / b, or `fallback` when b is 0 or either isn't a finite number. */
export function ratio(a: number | null | undefined, b: number | null | undefined, fallback: number | null = null): number | null {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback
  return a / b
}

/** a / b − 1 (a change), or null. */
export const change = (a: number | null | undefined, b: number | null | undefined): number | null => {
  const r = ratio(a, b)
  return r === null ? null : r - 1
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1))
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const round = (x: number | null | undefined, digits = 4): number | null => {
  if (x === null || x === undefined || !Number.isFinite(x)) return null
  const f = 10 ** digits
  return Math.round(x * f) / f
}
