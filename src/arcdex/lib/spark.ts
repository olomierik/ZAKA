// A coin's trend line ("Trend" on Argus: a small price history, oldest on
// the left, newest on the right) as SVG paths in a 100×30 box, which the
// card stretches to its width.

export const SPARK_W = 100
export const SPARK_H = 30
const PAD = 3

export interface SparkGeometry {
  line: string
  /** The line closed along the bottom, for the fill under it. */
  area: string
  /** Where the latest price sits, 0 (top) to SPARK_H. */
  lastY: number
  dir: 'up' | 'down' | 'flat'
}

/** Null with fewer than two prices: nothing to draw. */
export function sparkGeometry(points: readonly number[] | undefined): SparkGeometry | null {
  const p = (points ?? []).filter(v => Number.isFinite(v) && v > 0)
  if (p.length < 2) return null
  const lo = Math.min(...p), hi = Math.max(...p)
  const first = p[0], last = p[p.length - 1]
  const dir = last > first * 1.0005 ? 'up' : last < first * 0.9995 ? 'down' : 'flat'
  const y = (v: number) => (hi - lo < hi * 1e-9 ? SPARK_H / 2 : PAD + (1 - (v - lo) / (hi - lo)) * (SPARK_H - 2 * PAD))
  const line = 'M' + p.map((v, i) => `${((i / (p.length - 1)) * SPARK_W).toFixed(2)},${y(v).toFixed(2)}`).join('L')
  return { line, area: `${line}L${SPARK_W},${SPARK_H}L0,${SPARK_H}Z`, lastY: y(last), dir }
}

/** "+12.4%", "-3.1%", "+1,240%": signed, one decimal under 100%. */
export function pctText(p: number): string {
  const a = Math.abs(p)
  if (a < 0.05) return '0.0%'
  const body = a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(1)
  return `${p < 0 ? '-' : '+'}${body}%`
}
