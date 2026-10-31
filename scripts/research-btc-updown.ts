// Research for the BTC 5m/15m "Up or Down" autotrader (docs/PREDICT-BTC-AUTOTRADE-2026-10.md).
//
// Measures, on 1-minute BTC/USD candles, how Polymarket-style windows resolve ("Up" if the price at the window's end is
// at or above the price at its start), and how well a volatility-scaled fair value predicts them from any minute inside
// the window. It answers three questions the strategy depends on:
//   1. Can the direction be called at the window's start (momentum, reversal)? If not, a bot can't win 70% by "predicting".
//   2. Mid-window, how accurate is P(up) = F(ln(S_t/S_0) / (sigma * sqrt(minutes left)))? Normal vs fat-tailed F.
//   3. Late in the window, how often does the side that's ahead win, by how far ahead it is? That is the win rate a
//      late "favorite" strategy gets, and the price it can pay before it loses money.
//
// Usage: bun scripts/research-btc-updown.ts <btcusd_1min.csv> [--from YYYY-MM-DD] [--json out.json]
// The CSV is timestamp,open,high,low,close,volume with the minute's UTC open time, one row per minute
// (e.g. github.com/ff137/bitstamp-btcusd-minute-data, data/updates/btcusd_bitstamp_1min_latest.csv).
// Nothing here touches a market or a wallet.

import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const path = args.find(a => !a.startsWith('--'))
if (!path) { console.error('usage: bun scripts/research-btc-updown.ts <csv> [--from YYYY-MM-DD] [--json out.json]'); process.exit(1) }
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const fromTs = opt('--from') ? Date.parse(`${opt('--from')}T00:00:00Z`) / 1000 : 0
const jsonOut = opt('--json')

// ---- load ----
const lines = readFileSync(path, 'utf8').split('\n')
const n0 = lines.length - 1
const ts = new Float64Array(n0), op = new Float64Array(n0), cl = new Float64Array(n0), vol = new Float64Array(n0)
let n = 0
for (let i = 1; i < lines.length; i++) {
  const l = lines[i]
  if (!l) continue
  const p = l.split(',')
  const t = Number(p[0])
  if (t < fromTs) continue
  ts[n] = t; op[n] = Number(p[1]); cl[n] = Number(p[4]); vol[n] = Number(p[5]); n++
}
for (let i = 1; i < n; i++) if (ts[i] - ts[i - 1] !== 60) throw new Error(`gap in minutes at ${ts[i - 1]} → ${ts[i]}`)
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
console.log(`${n.toLocaleString()} minutes, ${iso(ts[0])} → ${iso(ts[n - 1])} UTC`)

// Per-minute log returns (close to close) and prefix sums of their squares and of zero-volume minutes.
const sq = new Float64Array(n + 1), zero = new Float64Array(n + 1)
for (let i = 0; i < n; i++) {
  const r = i === 0 ? 0 : Math.log(cl[i] / cl[i - 1])
  sq[i + 1] = sq[i] + r * r
  zero[i + 1] = zero[i] + (vol[i] === 0 ? 1 : 0)
}
/** Per-minute volatility from the W returns ending at minute `end` (inclusive). */
const sigmaAt = (end: number, W: number) => Math.sqrt((sq[end + 1] - sq[end + 1 - W]) / W)

// ---- distributions ----
function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
  const s = Math.sign(x); x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return s * y
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x, tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (const k of c) ser += k / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300
  let c = 1, d = 1 - (a + b) * x / (a + 1)
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d; h *= d * c
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b
}
/** Student-t CDF with nu degrees of freedom, rescaled to unit variance (so z keeps its meaning in sigmas). */
function tCdf(z: number, nu: number): number {
  const t = z * Math.sqrt(nu / (nu - 2))
  const x = nu / (nu + t * t)
  const tail = 0.5 * betai(nu / 2, 0.5, x)
  return t >= 0 ? 1 - tail : tail
}
const MODELS: { name: string; cdf: (z: number) => number }[] = [
  { name: 'normal', cdf: normCdf },
  { name: 't(3)', cdf: z => tCdf(z, 3) },
  { name: 't(4)', cdf: z => tCdf(z, 4) },
  { name: 't(6)', cdf: z => tCdf(z, 6) },
]

// ---- windows ----
type Win = { start: number; N: number; up: boolean; year: number }
function windows(N: number): Win[] {
  const out: Win[] = []
  const W = 240 // the longest volatility look-back used below
  for (let i = W + 1; i + N <= n; i++) {
    if (ts[i] % (N * 60) !== 0) continue
    // Leave out windows touching a zero-volume minute (an outage or a filled gap) in the look-back or the window.
    if (zero[i + N] - zero[i - 60] > 0) continue
    out.push({ start: i, N, up: cl[i + N - 1] >= op[i], year: new Date(ts[i] * 1000).getUTCFullYear() })
  }
  return out
}
const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const ci95 = (p: number, m: number) => 1.96 * Math.sqrt(p * (1 - p) / m)
const report: Record<string, unknown> = { minutes: n, from: iso(ts[0]), to: iso(ts[n - 1]) }

for (const N of [15, 5]) {
  const ws = windows(N)
  const ups = ws.filter(w => w.up).length
  console.log(`\n================ ${N}-minute windows: ${ws.length.toLocaleString()} (Up ${pct(ups / ws.length)}) ================`)
  const sec: Record<string, unknown> = { windows: ws.length, upRate: ups / ws.length }
  report[`${N}m`] = sec

  // 1. Calling the direction at the start.
  {
    const rules: { name: string; call: (w: Win) => boolean | null }[] = [
      { name: 'same as the previous window (momentum)', call: w => cl[w.start - 1] >= op[w.start - N] },
      { name: 'last 60 min up → Up (momentum)', call: w => cl[w.start - 1] >= cl[w.start - 61] },
      { name: 'last 5 min up → Up (momentum)', call: w => cl[w.start - 1] >= cl[w.start - 6] },
      { name: 'last 1 min up → Up (momentum)', call: w => cl[w.start - 1] >= cl[w.start - 2] },
    ]
    console.log('\n1. Calling it at the start (hit rate of the rule; 50% = no edge)')
    const rows: unknown[] = []
    for (const r of rules) {
      let hit = 0, m = 0
      const byYear: Record<number, [number, number]> = {}
      for (const w of ws) {
        const c = r.call(w); if (c === null) continue
        m++; const ok = c === w.up; if (ok) hit++
        const y = (byYear[w.year] ??= [0, 0]); y[1]++; if (ok) y[0]++
      }
      const p = hit / m
      const years = Object.entries(byYear).map(([y, [h, k]]) => `${y} ${pct(h / k)}`).join(', ')
      console.log(`   ${r.name.padEnd(44)} ${pct(p)} ± ${pct(ci95(p, m))}  (${years})`)
      rows.push({ rule: r.name, hit: p, n: m, byYear })
    }
    sec.atStart = rows
  }

  // 2. Fair value from inside the window.
  const ks = N === 15 ? [3, 6, 9, 12, 13, 14] : [1, 2, 3, 4]
  for (const W of [60, 240]) {
    console.log(`\n2. Fair value P(Up) = F(ln(S_k/S_0) / (sigma_${W}m · √minutes left)) — Brier score by model (lower is better; 0.25 = a coin flip)`)
    console.log(`   ${'minute'.padEnd(8)}${MODELS.map(m => m.name.padStart(10)).join('')}`)
    const rows: unknown[] = []
    for (const k of ks) {
      const brier = MODELS.map(() => 0)
      for (const w of ws) {
        const last = w.start + k - 1
        const z = Math.log(cl[last] / op[w.start]) / (sigmaAt(last, W) * Math.sqrt(N - k))
        const y = w.up ? 1 : 0
        MODELS.forEach((m, j) => { const q = m.cdf(z); brier[j] += (q - y) ** 2 })
      }
      console.log(`   ${String(k).padEnd(8)}${brier.map(b => (b / ws.length).toFixed(4).padStart(10)).join('')}`)
      rows.push({ k, W, brier: Object.fromEntries(MODELS.map((m, j) => [m.name, brier[j] / ws.length])) })
    }
    ;(sec.brier ??= [] as unknown[]) as unknown[]
    ;(sec.brier as unknown[]).push(...rows)
  }

  // 3. Calibration and the late favorite: how often the side ahead wins, by its fair value, with W = 60.
  const W = 60
  const lateKs = N === 15 ? [10, 12, 13, 14] : [2, 3, 4]
  const bins = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0001]
  for (const model of [MODELS[0], MODELS[2]]) {
    console.log(`\n3. The side ahead at minute k: its fair value (${model.name}) against how often it won`)
    const rows: unknown[] = []
    for (const k of lateKs) {
      const cnt = new Array(bins.length - 1).fill(0), won = new Array(bins.length - 1).fill(0), sumq = new Array(bins.length - 1).fill(0)
      let ahead = 0, aheadWon = 0
      for (const w of ws) {
        const last = w.start + k - 1
        const z = Math.log(cl[last] / op[w.start]) / (sigmaAt(last, W) * Math.sqrt(N - k))
        const qUp = model.cdf(z)
        const leaderUp = cl[last] >= op[w.start]
        const q = leaderUp ? qUp : 1 - qUp
        const leaderWon = leaderUp === w.up
        ahead++; if (leaderWon) aheadWon++
        const b = bins.findIndex((lo, j) => q >= lo && q < bins[j + 1])
        if (b < 0) continue
        cnt[b]++; sumq[b] += q; if (leaderWon) won[b]++
      }
      console.log(`   minute ${k} of ${N} (${N - k} left): the side ahead won ${pct(aheadWon / ahead)} of ${ahead.toLocaleString()}`)
      const binRows: unknown[] = []
      for (let b = 0; b < cnt.length; b++) {
        if (!cnt[b]) continue
        const hi = bins[b + 1] > 1 ? 1 : bins[b + 1]
        const wr = won[b] / cnt[b]
        console.log(`     fair value ${bins[b].toFixed(2)}–${hi.toFixed(2)}: n=${String(cnt[b]).padStart(6)}  mean ${(sumq[b] / cnt[b]).toFixed(3)}  won ${pct(wr)} ± ${pct(ci95(wr, cnt[b]))}`)
        binRows.push({ lo: bins[b], hi, n: cnt[b], meanQ: sumq[b] / cnt[b], won: wr })
      }
      rows.push({ k, model: model.name, aheadWon: aheadWon / ahead, n: ahead, bins: binRows })
    }
    ;(sec.late ??= [] as unknown[]) as unknown[]
    ;(sec.late as unknown[]).push(...rows)
  }

  // 4. How far the fair value moves in a minute late in the window: what a quote that's a few seconds stale costs.
  {
    const k = N === 15 ? 13 : 3
    const moves: number[] = []
    for (const w of ws) {
      const a = w.start + k - 2, b = w.start + k - 1
      const za = Math.log(cl[a] / op[w.start]) / (sigmaAt(a, W) * Math.sqrt(N - k + 1))
      const zb = Math.log(cl[b] / op[w.start]) / (sigmaAt(b, W) * Math.sqrt(N - k))
      moves.push(Math.abs(MODELS[2].cdf(zb) - MODELS[2].cdf(za)))
    }
    moves.sort((x, y) => x - y)
    const q = (p: number) => moves[Math.floor(p * (moves.length - 1))]
    console.log(`\n4. Change in fair value over one minute (minute ${k - 1} → ${k}): median ${(100 * q(0.5)).toFixed(1)}¢, p90 ${(100 * q(0.9)).toFixed(1)}¢, p99 ${(100 * q(0.99)).toFixed(1)}¢`)
    sec.oneMinuteMove = { k, median: q(0.5), p90: q(0.9), p99: q(0.99) }
  }
}

if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(report, null, 1)); console.log(`\nwrote ${jsonOut}`) }
