import { N_ } from './i18n'

// Chart indicators (fomo's "Indicators" menu). Pure functions over candle
// arrays; each returns one value per candle (null while warming up).

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

export type IndicatorId = 'volume' | 'ma7' | 'ma25' | 'ma99' | 'ema20' | 'bb' | 'vwap' | 'rsi'
export const INDICATORS: { id: IndicatorId; label: string; color: string }[] = [
  { id: 'volume', label: N_('Volume'), color: '#64748b' },
  { id: 'ma7', label: N_('MA 7'), color: '#facc15' },
  { id: 'ma25', label: N_('MA 25'), color: '#a855f7' },
  { id: 'ma99', label: N_('MA 99'), color: '#38bdf8' },
  { id: 'ema20', label: N_('EMA 20'), color: '#f97316' },
  { id: 'bb', label: N_('Bollinger Bands (20, 2)'), color: '#94a3b8' },
  { id: 'vwap', label: N_('VWAP'), color: '#ec4899' },
  { id: 'rsi', label: N_('RSI 14'), color: '#c084fc' },
]

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    out.push(i >= n - 1 ? sum / n : null)
  }
  return out
}

export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  const k = 2 / (n + 1)
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(null); continue }
    // Seed with the SMA of the first n values, then smooth.
    prev = prev === null ? values.slice(0, n).reduce((a, b) => a + b, 0) / n : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function bollinger(values: number[], n = 20, mult = 2): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(values, n)
  const upper: (number | null)[] = [], lower: (number | null)[] = []
  for (let i = 0; i < values.length; i++) {
    const m = mid[i]
    if (m === null) { upper.push(null); lower.push(null); continue }
    let v = 0
    for (let j = i - n + 1; j <= i; j++) v += (values[j] - m) ** 2
    const sd = Math.sqrt(v / n)
    upper.push(m + mult * sd); lower.push(m - mult * sd)
  }
  return { mid, upper, lower }
}

/** VWAP over the loaded range, from typical price × volume. */
export function vwap(bars: Bar[]): (number | null)[] {
  let pv = 0, vol = 0
  return bars.map(b => {
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume; vol += b.volume
    return vol > 0 ? pv / vol : null
  })
}

/** Wilder's RSI. */
export function rsi(values: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null]
  let gain = 0, loss = 0
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    const g = Math.max(0, d), l = Math.max(0, -d)
    if (i <= n) {
      gain += g; loss += l
      if (i < n) { out.push(null); continue }
      gain /= n; loss /= n
    } else {
      gain = (gain * (n - 1) + g) / n
      loss = (loss * (n - 1) + l) / n
    }
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))
  }
  return out
}
