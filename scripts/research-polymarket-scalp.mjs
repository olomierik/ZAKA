// Research for the BTC Up/Down autotrader's exits (2026-11-01): the engine's lane A entries replayed against
// Polymarket's recorded order books, each position then closed by a different exit rule, so the rules compare on the
// same fills. Data: the free Marketlens sample (github.com/marketlenstrade/polymarket-historical-data, folder
// bitcoin-5m-15m-hourly-2026-06-15), every book update and trade of every BTC 5m and 15m market on 2026-06-15, with
// Binance's trade tape over the same day. Nothing here touches a market.
//
// Usage (hyparquet reads the Parquet files; it isn't one of the app's dependencies):
//   mkdir /tmp/pq && cd /tmp/pq && bun add hyparquet@1.13.4 && cp <repo>/scripts/research-polymarket-scalp.mjs .
//   bun research-polymarket-scalp.mjs <marketlens bitcoin folder>
//
// Model: P(Up) = T4(ln(S/S0) / (sigma_1m · √minutes left)), S from Binance's tape, sigma from the tape's previous 60
// one-minute returns. Entries are lane A's (engine/src/updown/strategy.ts): after the first 20 s and before the last
// minute, asks of 15–85¢ only, the model beating ask + fee by 10¢ (15¢ for 40–60¢ asks), and only a gap that just opened
// (the market's mid within 7¢ of the model 8 s earlier); $25 or what the best level holds, 15 s apart, $100 a market.
// Orders land `lat` ms after the decision at the book as it then is. Fees: 0.07 · p · (1 − p) a share on taker fills
// (buys and sales); makers pay none. That day predates the 60-second TWAP settlement and the 150 ms taker delay.
import { readFileSync } from 'node:fs'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

const [dir] = process.argv.slice(2)

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

const tape = await parquetReadObjects({ file: await asyncBufferFromFile(`${dir}/reference-BTC.parquet`) })
const tB = new Float64Array(tape.length), pB = new Float64Array(tape.length)
tape.forEach((r, i) => { tB[i] = Number(r.timestamp); pB[i] = Number(r.price) })
function priceAt(t) { let lo = 0, hi = tB.length - 1; if (t < tB[0]) return NaN; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tB[m] <= t) lo = m; else hi = m - 1 } return pB[lo] }
function sigmaMin(tMs) {
  const end = Math.floor(tMs / 60000) * 60000; let s = 0, k = 0
  for (let m = end - 59 * 60000; m <= end; m += 60000) { const a = priceAt(m - 60000), b = priceAt(m); if (a > 0 && b > 0) { const r = Math.log(b / a); s += r * r; k++ } }
  return k > 30 ? Math.sqrt(s / k) : NaN
}
function tcdf4(z) { const t = z * Math.SQRT2; const u = t / Math.sqrt(4 + t * t); return 0.5 + 0.75 * u - 0.25 * u * u * u }
const fee = p => 0.07 * p * (1 - p)
function bestOf(map, wantMax) { let bp = wantMax ? -1 : 2, sz = 0; for (const [p, s] of map) { if (s <= 0) continue; if (wantMax ? p > bp : p < bp) { bp = p; sz = s } } return bp < 0 || bp > 1 ? null : { p: bp, s: sz } }

// Exit rules. Each takes the position and the moment, and says whether to sell now and how (taker at the bid, or a
// resting maker ask filled when a trade prints through it).
const EXITS = {
  hold: () => null,
  // Taker sale once the bid, after the fee, pays the model's value less a tolerance: the market has caught up.
  'fair-0': (p, x) => x.bidNet >= x.q ? 'taker' : null,
  'fair-2': (p, x) => x.bidNet >= x.q - 0.02 ? 'taker' : null,
  'fair-5': (p, x) => x.bidNet >= x.q - 0.05 ? 'taker' : null,
  // Same, but only at a profit over what the position cost.
  'fair-2+profit': (p, x) => x.bidNet >= x.q - 0.02 && x.bidNet > p.cps ? 'taker' : null,
  'fair-5+profit': (p, x) => x.bidNet >= x.q - 0.05 && x.bidNet > p.cps ? 'taker' : null,
  // Fixed profit targets, taken at the bid.
  'tp-3c': (p, x) => x.bidNet >= p.cps + 0.03 ? 'taker' : null,
  'tp-5c': (p, x) => x.bidNet >= p.cps + 0.05 ? 'taker' : null,
  'tp-10c': (p, x) => x.bidNet >= p.cps + 0.10 ? 'taker' : null,
  // A profit target rested as a maker ask (no fee), at cost + X or the model's value, whichever is higher.
  'maker-3c': (p, x) => ({ ask: Math.max(p.cps + 0.03, x.q) }),
  'maker-5c': (p, x) => ({ ask: Math.max(p.cps + 0.05, x.q) }),
  'maker-fair': (p, x) => ({ ask: Math.max(p.cps + 0.01, x.q) }),
  // A stop: sell once the model itself says the side is worth 15¢ less than it cost.
  'stop-15': (p, x) => x.q < p.cps - 0.15 ? 'taker' : null,
  'fair-2+stop-15': (p, x) => x.bidNet >= x.q - 0.02 || x.q < p.cps - 0.15 ? 'taker' : null,
  // Only when the market pays more than the model's value: better than holding by the model's own count.
  'over+2': (p, x) => x.bidNet >= x.q + 0.02 ? 'taker' : null,
  'over+5': (p, x) => x.bidNet >= x.q + 0.05 ? 'taker' : null,
  'stop-10': (p, x) => x.q < p.cps - 0.10 ? 'taker' : null,
  'stop-20': (p, x) => x.q < p.cps - 0.20 ? 'taker' : null,
  'over+2+stop-15': (p, x) => x.bidNet >= x.q + 0.02 || x.q < p.cps - 0.15 ? 'taker' : null,
  'over+0+stop-15': (p, x) => x.bidNet >= x.q || x.q < p.cps - 0.15 ? 'taker' : null,
  'over+5+stop-15': (p, x) => x.bidNet >= x.q + 0.05 || x.q < p.cps - 0.15 ? 'taker' : null,
  // The market caught up only once the model's edge is mostly gone: sell when the bid nets 2/3 of the way from cost to the model.
  'caught-2/3+stop-15': (p, x) => (x.q > p.cps && x.bidNet >= p.cps + (x.q - p.cps) * 0.67) || x.q < p.cps - 0.15 ? 'taker' : null,
}

const out = {} // exit -> lat -> [{ N, stake, pnl, hour }]
for (const k of Object.keys(EXITS)) out[k] = { 250: [], 1000: [] }
let done = 0
for (const m of markets) {
  const N = m.series.endsWith('15m') ? 15 : 5
  const open = Date.parse(m.open_time), close = Date.parse(m.close_time)
  const won = m.winning_outcome === 'Up' ? 1 : m.winning_outcome === 'Down' ? 0 : null
  if (won === null) continue
  const S0 = priceAt(open), sig = sigmaMin(open)
  if (!(S0 > 0 && sig > 0)) continue
  const rows = await parquetReadObjects({ file: await asyncBufferFromFile(`${dir}/${m.file}`) })
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
    } else if (r.event_type === 'trade') { trades.push({ t, p: Number(r.price) }); continue }
    const b = bestOf(bids, true), a = bestOf(asks, false)
    if (tl.length && tl[tl.length - 1].t === t) tl[tl.length - 1] = { t, b, a }; else tl.push({ t, b, a })
  }
  const bookAt = t => { let lo = 0, hi = tl.length - 1; if (!tl.length || t < tl[0].t) return null; while (lo < hi) { const k = (lo + hi + 1) >> 1; if (tl[k].t <= t) lo = k; else hi = k - 1 } return tl[lo] }
  const qUp = t => { const left = (close - t) / 60000; const S = priceAt(t); if (left <= 0) return S >= S0 ? 1 : 0; return tcdf4(Math.log(S / S0) / (sig * Math.sqrt(left))) }
  // A side's book, Up as recorded, Down mirrored: its ask, its bid, and their sizes in its own shares.
  const sideBook = (bk, side) => side === 1
    ? { ask: bk.a, bid: bk.b }
    : { ask: bk.b ? { p: 1 - bk.b.p, s: bk.b.s } : null, bid: bk.a ? { p: 1 - bk.a.p, s: bk.a.s } : null }
  const tradesIn = (t0, t1) => { const r = []; for (const tr of trades) if (tr.t >= t0 && tr.t < t1) r.push(tr); return r }

  for (const lat of [250, 1000]) {
    // Entries, as lane A takes them.
    const entries = []
    let last = -1e15, spent = 0
    for (let t = open + 20000; t < close - 60000; t += 1000) {
      if (t - last < 15000 || spent >= 99) continue
      const bkNow = bookAt(t); const bk8 = bookAt(t - 8000); if (!bkNow?.a || !bkNow?.b || !bk8?.a || !bk8?.b) continue
      const q = qUp(t), q8 = qUp(t - 8000), mid8 = (bk8.a.p + bk8.b.p) / 2
      if (Math.abs(mid8 - q8) > 0.07) continue
      for (const side of [1, 0]) {
        const p = side ? q : 1 - q
        const a = sideBook(bkNow, side).ask; if (!a || a.p < 0.15 || a.p > 0.85) continue
        const margin = a.p >= 0.4 && a.p <= 0.6 ? 0.15 : 0.10
        if (p - a.p - fee(a.p) < margin) continue
        const land = bookAt(t + lat); const la = land && sideBook(land, side).ask
        if (!la || p - la.p - fee(la.p) < margin) break // nothing left at a price that clears the margin: missed
        const usd = Math.min(25, 100 - spent, la.s * (la.p + fee(la.p))); if (usd < 1) break
        const shares = usd / (la.p + fee(la.p))
        entries.push({ side, at: t + lat, shares, cost: usd, cps: usd / shares })
        spent += usd; last = t
        break
      }
    }
    // Each exit on the same entries.
    for (const [name, rule] of Object.entries(EXITS)) {
      for (const e of entries) {
        let left = e.shares, cash = 0, resting = null
        for (let t = e.at + 1000; t < close - 3000 && left > 1e-9; t += 1000) {
          const bk = bookAt(t); if (!bk) continue
          const sb = sideBook(bk, e.side); const q = e.side ? qUp(t) : 1 - qUp(t)
          // A resting maker ask from the last second fills on any trade printed through it (the side's price above it).
          if (resting !== null) {
            for (const tr of tradesIn(t - 1000, t)) {
              const px = e.side ? tr.p : 1 - tr.p
              if (px > resting + 1e-9 && left > 1e-9) { cash += left * resting; left = 0 }
            }
            if (left <= 1e-9) break
          }
          if (!sb.bid) continue
          const decision = rule(e, { q, bid: sb.bid.p, bidNet: sb.bid.p - fee(sb.bid.p), t, left: (close - t) / 1000 })
          if (decision === 'taker') {
            const land = bookAt(t + lat); const lb = land && sideBook(land, e.side).bid; if (!lb) continue
            const take = Math.min(left, lb.s)
            cash += take * (lb.p - fee(lb.p)); left -= take
          } else if (decision && typeof decision === 'object') {
            resting = Math.min(0.99, Math.ceil(decision.ask * 100 - 1e-9) / 100)
          }
        }
        const payout = left * (e.side === won ? 1 : 0)
        out[name][lat].push({ N, stake: e.cost, pnl: cash + payout - e.cost, hour: new Date(open).getUTCHours(), sold: left <= 1e-9 })
      }
    }
  }
  done++
}

console.log(`markets replayed: ${done}`)
const pct = x => `${(100 * x).toFixed(1)}%`
for (const lat of [250, 1000]) for (const N of [5, 15]) {
  console.log(`\n== ${N}m, orders land ${lat} ms after the decision`)
  console.log('  exit             trades  won    sold   staked   P&L      /staked  worst   sd/trade  00-12h   12-24h')
  for (const name of Object.keys(EXITS)) {
    const xs = out[name][lat].filter(x => x.N === N); if (!xs.length) continue
    const st = xs.reduce((s, x) => s + x.stake, 0), pnl = xs.reduce((s, x) => s + x.pnl, 0)
    const won = xs.filter(x => x.pnl > 0).length, sold = xs.filter(x => x.sold).length
    const rets = xs.map(x => x.pnl / x.stake), mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length)
    const half = h => { const ys = xs.filter(x => (x.hour < 12) === h); const s = ys.reduce((a, x) => a + x.stake, 0); return s ? pct(ys.reduce((a, x) => a + x.pnl, 0) / s) : '-' }
    console.log(`  ${name.padEnd(16)} ${String(xs.length).padStart(6)}  ${pct(won / xs.length).padStart(5)}  ${pct(sold / xs.length).padStart(5)}  $${st.toFixed(0).padStart(6)}  ${(pnl >= 0 ? '+' : '') + pnl.toFixed(0).padStart(5)}   ${pct(pnl / st).padStart(6)}  ${Math.min(...xs.map(x => x.pnl)).toFixed(1).padStart(6)}  ${sd.toFixed(2).padStart(6)}   ${half(true).padStart(6)}  ${half(false).padStart(6)}`)
  }
}
