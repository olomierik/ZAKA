// Research for the BTC 5m/15m "Up or Down" autotrader (docs/PREDICT-BTC-AUTOTRADE-2026-10.md): strategies replayed
// against Polymarket's recorded order books, every book update and trade of every BTC 5m and 15m market on 2026-06-15
// (the free Marketlens sample, github.com/marketlenstrade/polymarket-historical-data, folder
// bitcoin-5m-15m-hourly-2026-06-15, with Binance's trade tape over the same day).
//
// Usage (hyparquet reads the Parquet files; it isn't one of the app's dependencies):
//   mkdir /tmp/pq && cd /tmp/pq && bun add hyparquet@1.13.4 && cp <repo>/scripts/research-polymarket-books.mjs .
//   bun research-polymarket-books.mjs <marketlens bitcoin folder> <bitstamp 1-minute csv> [--out trades.json]
//
// Fair value: P(Up) = T4(ln(S/S0) / (sigma_1m · √minutes left)), S from Binance's tape, sigma from the previous 60
// one-minute Bitstamp returns. That day predates the 60-second TWAP settlement (2026-08-07) and the 150 ms taker delay
// on crypto markets (2026-09-04), so these results describe June, not today. Fees: Polymarket's crypto taker fee,
// 0.07 · p · (1 − p) per share (docs.polymarket.com/trading/fees); makers pay none. Nothing here touches a market.
import { readFileSync, writeFileSync } from 'node:fs'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

const [dir, bitstampCsv] = process.argv.slice(2)
const outIdx = process.argv.indexOf('--out'); const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null

// ---- csv ----
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  const [h, ...rest] = rows
  return rest.filter(r => r.length === h.length).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])))
}
const markets = parseCsv(readFileSync(`${dir}/markets.csv`, 'utf8')).filter(m => m.series === 'btc-up-or-down-5m' || m.series === 'btc-up-or-down-15m')

// ---- Binance tape ----
const tape = await parquetReadObjects({ file: await asyncBufferFromFile(`${dir}/reference-BTC.parquet`) })
const tB = new Float64Array(tape.length), pB = new Float64Array(tape.length)
tape.forEach((r, i) => { tB[i] = Number(r.timestamp); pB[i] = Number(r.price) })
function priceAt(t) { let lo = 0, hi = tB.length - 1; if (t < tB[0]) return NaN; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tB[m] <= t) lo = m; else hi = m - 1 } return pB[lo] }

// ---- Bitstamp minutes for volatility ----
const bs = new Map()
for (const line of readFileSync(bitstampCsv, 'utf8').split('\n')) {
  const p = line.split(','); const ts = Number(p[0]); if (!(ts > 1781300000 && ts < 1781700000)) continue
  bs.set(ts, Number(p[4]))
}
function sigmaMin(tMs) { // per-minute vol from the 60 complete minutes before t
  const end = Math.floor(tMs / 60000) * 60 - 60; let s = 0, k = 0
  for (let m = end - 59 * 60; m <= end; m += 60) { const a = bs.get(m - 60), b = bs.get(m); if (a && b) { const r = Math.log(b / a); s += r * r; k++ } }
  return k > 30 ? Math.sqrt(s / k) : NaN
}

// ---- Student-t(4) CDF on unit variance ----
function tcdf4(z) { const t = z * Math.SQRT2; const u = t / Math.sqrt(4 + t * t); return 0.5 + 0.75 * u - 0.25 * u * u * u }

// ---- book replay ----
function bestOf(map, wantMax) { let bp = wantMax ? -1 : 2, sz = 0; for (const [p, s] of map) { if (s <= 0) continue; if (wantMax ? p > bp : p < bp) { bp = p; sz = s } } return bp < 0 || bp > 1 ? null : { p: bp, s: sz } }

const results = { taker: [], late: [], maker: [], oracle: { agree: 0, n: 0 }, calib: [] }
const LAT = [250, 1000, 3000]
let done = 0
for (const m of markets) {
  const N = m.series.endsWith('15m') ? 15 : 5
  const open = Date.parse(m.open_time), close = Date.parse(m.close_time)
  const won = m.winning_outcome === 'Up' ? 1 : m.winning_outcome === 'Down' ? 0 : null
  if (won === null) continue
  const S0 = priceAt(open), Send = priceAt(close)
  if (!(S0 > 0 && Send > 0)) continue
  results.oracle.n++; if ((Send >= S0 ? 1 : 0) === won) results.oracle.agree++
  const sig = sigmaMin(open); if (!(sig > 0)) continue
  const rows = await parquetReadObjects({ file: await asyncBufferFromFile(`${dir}/${m.file}`) })
  // Book states at every event: keep a timeline of (t, bestBid, bestAsk) and trades.
  const bids = new Map(), asks = new Map(); const tl = []; const trades = []
  for (const r of rows) {
    const t = Number(r.t)
    if (r.event_type === 'snapshot') {
      bids.clear(); asks.clear()
      for (const l of JSON.parse(r.bids || '[]')) bids.set(Number(l.price), Number(l.size))
      for (const l of JSON.parse(r.asks || '[]')) asks.set(Number(l.price), Number(l.size))
    } else if (r.event_type === 'delta') {
      const book = r.side === 'BUY' ? bids : asks
      if (r.size > 0) book.set(r.price, r.size); else book.delete(r.price)
    } else if (r.event_type === 'trade') { trades.push({ t, p: r.price, s: r.size, side: r.side }); continue }
    const b = bestOf(bids, true), a = bestOf(asks, false)
    if (tl.length && tl[tl.length - 1].t === t) tl[tl.length - 1] = { t, b, a }; else tl.push({ t, b, a })
  }
  const bookAt = (t) => { let lo = 0, hi = tl.length - 1; if (!tl.length || t < tl[0].t) return null; while (lo < hi) { const k = (lo + hi + 1) >> 1; if (tl[k].t <= t) lo = k; else hi = k - 1 } return tl[lo] }
  const fair = (t) => { const S = priceAt(t); const left = (close - t) / 60000; if (left <= 0) return S >= S0 ? 1 : 0; return tcdf4(Math.log(S / S0) / (sig * Math.sqrt(left))) }

  // Calibration of the market mid and of our fair value, every 10 s.
  for (let t = open + 10000; t < close - 1000; t += 10000) {
    const bk = bookAt(t); if (!bk || !bk.b || !bk.a || bk.a.p - bk.b.p > 0.05) continue
    results.calib.push({ N, left: (close - t) / 1000, mid: (bk.a.p + bk.b.p) / 2, q: fair(t), won })
  }

  // Taker: each second, buy the side whose ask is below fair value by at least the margin; one entry per market per margin.
  for (const lat of LAT) for (const margin of [0.03, 0.05, 0.08, 0.12]) {
    for (let t = open + 5000; t < close - 2000; t += 1000) {
      const q = fair(t); const bk = bookAt(t + lat); if (!bk) continue
      let side = null, px = 0, sz = 0
      if (bk.a && q - bk.a.p >= margin) { side = 1; px = bk.a.p; sz = bk.a.s }
      else if (bk.b && (1 - q) - (1 - bk.b.p) >= margin) { side = 0; px = 1 - bk.b.p; sz = bk.b.s }
      if (side === null) continue
      results.taker.push({ N, open, lat, margin, side, px, q: side ? q : 1 - q, topUsd: sz * px, left: (close - t) / 1000, win: side === won ? 1 : 0 })
      break
    }
  }

  // Taker, repeated: every qualifying second after a 15 s cooldown, up to $25 or what the best level holds, $250 a market.
  for (const lat of [250, 1000]) for (const margin of [0.08, 0.12]) {
    let last = -1e15, spent = 0
    for (let t = open + 5000; t < close - 2000; t += 1000) {
      if (t - last < 15000 || spent >= 250) continue
      const q = fair(t); const bk = bookAt(t + lat); if (!bk) continue
      let side = null, px = 0, sz = 0
      if (bk.a && q - bk.a.p >= margin) { side = 1; px = bk.a.p; sz = bk.a.s }
      else if (bk.b && (1 - q) - (1 - bk.b.p) >= margin) { side = 0; px = 1 - bk.b.p; sz = bk.b.s }
      if (side === null) continue
      const usd = Math.min(25, sz * px, 250 - spent); if (usd < 1) continue
      spent += usd; last = t
      ;(results.repeat ??= []).push({ N, open, lat, margin, side, px, usd, q: side ? q : 1 - q, left: (close - t) / 1000, win: side === won ? 1 : 0 })
    }
  }

  // Late favorite: at fixed seconds before the close, buy the side ahead at its ask whatever the price (cap 0.99).
  for (const before of [120, 60, 30, 10]) {
    const t = close - before * 1000; const bk = bookAt(t + 250); if (!bk || !bk.a || !bk.b) continue
    const upAhead = priceAt(t) >= S0
    const px = upAhead ? bk.a.p : 1 - bk.b.p
    if (px >= 0.995) continue
    results.late.push({ N, open, before, px, q: upAhead ? fair(t) : 1 - fair(t), win: (upAhead ? 1 : 0) === won ? 1 : 0 })
  }

  // Maker: every second rest a bid for each side at fair minus the half-spread (never crossing); filled when a trade prints
  // through our price before the next second. Up to $200 per side per market, $10 a fill, held to the end.
  for (const half of [0.02, 0.04, 0.07]) {
    let ti = 0; const inv = [0, 0], cost = [0, 0]
    for (let t = open + 5000; t < close - 3000; t += 1000) {
      const q = fair(t); const bk = bookAt(t); if (!bk || !bk.a || !bk.b) { continue }
      const bidUp = Math.floor((q - half) * 100) / 100, askUp = Math.ceil((q + half) * 100) / 100
      while (ti < trades.length && trades[ti].t < t) ti++
      for (let j = ti; j < trades.length && trades[j].t < t + 1000; j++) {
        const tr = trades[j]
        if (bidUp > 0.01 && bidUp < bk.a.p && tr.p < bidUp && cost[1] < 200) { const sh = 10 / bidUp; inv[1] += sh; cost[1] += 10 }
        if (askUp < 0.99 && askUp > bk.b.p && tr.p > askUp && cost[0] < 200) { const px = 1 - askUp; const sh = 10 / px; inv[0] += sh; cost[0] += 10 }
      }
    }
    if (cost[0] + cost[1] > 0) results.maker.push({ N, half, cost: cost[0] + cost[1], payout: inv[1] * won + inv[0] * (1 - won), sharesUp: inv[1], sharesDown: inv[0] })
  }
  done++
}
console.log(`markets replayed: ${done}; Binance-implied outcome matched Polymarket's ${results.oracle.agree}/${results.oracle.n}`)
if (outPath) writeFileSync(outPath, JSON.stringify(results))

// ---- report ----
const fee = p => 0.07 * p * (1 - p)
const pct = x => `${(100 * x).toFixed(1)}%`
console.log('\n== Brier score of the market mid and of the fair value, by seconds left (lower is better)')
for (const N of [5, 15]) for (const [lo, hi] of [[0, 60], [60, 180], [180, 900]]) {
  const xs = results.calib.filter(c => c.N === N && c.left >= lo && c.left < hi); if (!xs.length) continue
  const b = f => (xs.reduce((s, c) => s + (f(c) - c.won) ** 2, 0) / xs.length).toFixed(4)
  console.log(`  ${N}m, ${lo}-${hi}s left: n=${xs.length}  market ${b(c => c.mid)}  fair ${b(c => c.q)}`)
}
console.log('\n== Taker on fair value: buy when the ask is below fair value by the margin; $25 or the best level, 15 s apart')
for (const N of [5, 15]) for (const lat of [250, 1000]) for (const margin of [0.08, 0.12]) {
  const xs = (results.repeat ?? []).filter(x => x.N === N && x.lat === lat && x.margin === margin); if (!xs.length) continue
  const u = xs.reduce((s, x) => s + x.usd, 0), gross = xs.reduce((s, x) => s + x.usd * x.win / x.px, 0) - u
  const fees = xs.reduce((s, x) => s + x.usd * fee(x.px) / x.px, 0)
  console.log(`  ${N}m, ${lat} ms, margin ${margin}: ${xs.length} fills, $${u.toFixed(0)}, won ${pct(xs.reduce((s, x) => s + x.win, 0) / xs.length)}, gross ${pct(gross / u)}, after fees ${pct((gross - fees) / u)}`)
}
console.log('\n== Late favourite: buy the side ahead at its ask, one per market')
for (const N of [5, 15]) for (const before of [120, 60, 30, 10]) {
  const xs = results.late.filter(x => x.N === N && x.before === before); if (!xs.length) continue
  console.log(`  ${N}m, ${before}s before the close: ${xs.length}, won ${pct(xs.reduce((s, x) => s + x.win, 0) / xs.length)}, paid ${(xs.reduce((s, x) => s + x.px, 0) / xs.length).toFixed(3)}, after fees ${pct(xs.reduce((s, x) => s + (x.win - x.px - fee(x.px)) / x.px, 0) / xs.length)}`)
}
console.log('\n== Maker at fair value ± half-spread, $10 fills when a trade prints through the quote, held to the end')
for (const N of [5, 15]) for (const half of [0.02, 0.04, 0.07]) {
  const xs = results.maker.filter(x => x.N === N && x.half === half); if (!xs.length) continue
  const cost = xs.reduce((s, x) => s + x.cost, 0), pay = xs.reduce((s, x) => s + x.payout, 0)
  console.log(`  ${N}m, half-spread ${half}: $${cost.toFixed(0)} traded, P&L ${pct((pay - cost) / cost)}`)
}
