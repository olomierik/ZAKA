// The engine's Chainlink BTC/USD estimate, built from exchange prices (Polymarket's own Chainlink stream needs CLOB
// credentials since it moved to PolyBolt).
//
// - Coinbase's BTC-USD ticker and Binance's BTCUSDT trades stream in; each second keeps each source's last price.
// - Each source's basis to Chainlink is learned from Polymarket itself: every new window's price to beat is the
//   60-second Chainlink TWAP before its start, so the source's average over that same minute gives one observation.
//   Windows open every 5 minutes, so a basis is learned within minutes of a restart. A source is used only once its
//   basis has 2 observations (Binance's USDT price sits ~20 bp off USD; that can't be guessed).
// - The estimate is the mean of the fresh, learned sources. Volatility is an EWMA of its one-second log returns.

import { log, errMsg } from '../log'

export const SPOT = {
  freshMs: 2_000,
  keepSec: 20 * 60,
  basisAlpha: 0.3,
  basisMinObs: 2,
  volHalfLifeSec: 300,
  sigmaFloor: 0.4e-4,
  sigmaCap: 12e-4,
  sigmaStart: 1e-4,
}

interface Source { name: string; last: number | null; lastAt: number; secs: Map<number, number>; basis: number | null; basisN: number; resid: number }

export class SpotModel {
  private src = new Map<string, Source>()
  /** The combined estimate (log price) at the end of each second. */
  private est = new Map<number, number>()
  private var = SPOT.sigmaStart * SPOT.sigmaStart
  private lastSec: number | null = null
  private volN = 0

  constructor(names: string[] = ['coinbase', 'binance']) {
    for (const name of names) this.src.set(name, { name, last: null, lastAt: 0, secs: new Map(), basis: null, basisN: 0, resid: 0 })
  }

  onTick(name: string, price: number, atMs: number) {
    const s = this.src.get(name)
    if (!s || !(price > 0)) return
    s.last = price
    s.lastAt = atMs
    s.secs.set(Math.floor(atMs / 1000), Math.log(price))
  }

  private usable(nowMs: number) {
    return [...this.src.values()].filter(s => s.last !== null && nowMs - s.lastAt <= SPOT.freshMs && s.basis !== null && s.basisN >= SPOT.basisMinObs)
  }

  /** The Chainlink estimate now, or null when no learned source is fresh. */
  estimate(nowMs: number): { price: number; sources: number; spreadBp: number } | null {
    const u = this.usable(nowMs)
    if (!u.length) return null
    const xs = u.map(s => Math.log(s.last!) + s.basis!)
    const x = xs.reduce((a, b) => a + b, 0) / xs.length
    const spreadBp = xs.length > 1 ? (Math.max(...xs) - Math.min(...xs)) * 1e4 : 0
    return { price: Math.exp(x), sources: u.length, spreadBp }
  }

  /** Once a second: record the estimate and update the volatility. */
  tick(nowMs: number) {
    const sec = Math.floor(nowMs / 1000)
    const e = this.estimate(nowMs)
    if (e) {
      const x = Math.log(e.price)
      if (this.lastSec !== null && sec === this.lastSec + 1) {
        const prev = this.est.get(this.lastSec)
        if (prev !== undefined) {
          const r = x - prev
          const lambda = Math.pow(0.5, 1 / SPOT.volHalfLifeSec)
          this.var = lambda * this.var + (1 - lambda) * r * r
          this.volN++
        }
      }
      this.est.set(sec, x)
      this.lastSec = sec
    }
    const cut = sec - SPOT.keepSec
    for (const k of this.est.keys()) if (k < cut) this.est.delete(k)
    for (const s of this.src.values()) for (const k of s.secs.keys()) if (k < cut) s.secs.delete(k)
  }

  /** Per-second volatility of log price, floored and capped. */
  sigma(): number { return Math.min(SPOT.sigmaCap, Math.max(SPOT.sigmaFloor, Math.sqrt(this.var))) }
  get volSamples() { return this.volN }

  /** The estimate (dollars) recorded for a second, or null. */
  priceAt(sec: number): number | null { const x = this.est.get(sec); return x === undefined ? null : Math.exp(x) }

  /** The mean estimate (dollars) over [fromSec, toSec), or null with under half the seconds recorded. */
  observedAvg(fromSec: number, toSec: number): number | null {
    let sum = 0, n = 0
    for (let s = fromSec; s < toSec; s++) { const x = this.est.get(s); if (x !== undefined) { sum += x; n++ } }
    return n > 0 && n >= (toSec - fromSec) / 2 ? Math.exp(sum / n) : null
  }

  /** A new price to beat is the Chainlink TWAP over [start − 60, start): each source's mean over it is one observation. */
  learnBasis(startSec: number, open: number, twapSec = 60) {
    for (const s of this.src.values()) {
      let sum = 0, n = 0
      for (let t = startSec - twapSec; t < startSec; t++) { const x = s.secs.get(t); if (x !== undefined) { sum += x; n++ } }
      if (n < twapSec * 0.6) continue
      const obs = Math.log(open) - sum / n
      if (Math.abs(obs) > 0.01) continue // a 100 bp gap is a bad print, not a basis
      if (s.basis === null) s.basis = obs
      else {
        s.resid = (1 - SPOT.basisAlpha) * s.resid + SPOT.basisAlpha * Math.abs(obs - s.basis)
        s.basis = (1 - SPOT.basisAlpha) * s.basis + SPOT.basisAlpha * obs
      }
      s.basisN++
    }
  }

  /** The basis error to price in: the sources' recent residual, at least 1.5 bp. */
  basisSd(): number {
    const r = [...this.src.values()].filter(s => s.basisN >= SPOT.basisMinObs).map(s => s.resid)
    return Math.max(1.5e-4, ...(r.length ? r : [3e-4]))
  }

  view(nowMs: number) {
    return [...this.src.values()].map(s => ({ name: s.name, ageMs: s.last === null ? null : nowMs - s.lastAt, basisBp: s.basis === null ? null : Math.round(s.basis * 1e5) / 10 }))
  }

  toJSON() { return [...this.src.values()].map(s => ({ name: s.name, basis: s.basis, basisN: s.basisN, resid: s.resid })) }
  restore(j: { name: string; basis: number | null; basisN: number; resid: number }[] | null | undefined) {
    for (const x of j ?? []) { const s = this.src.get(x.name); if (s && typeof x.basis === 'number') { s.basis = x.basis; s.basisN = Math.min(x.basisN, SPOT.basisMinObs); s.resid = x.resid || 0 } }
  }
}

type WsCtor = new (url: string) => WebSocket

/** Connects the exchange streams to a SpotModel, reconnecting with backoff. */
export class SpotFeeds {
  private sockets: WebSocket[] = []
  private stopped = false
  constructor(private model: SpotModel, private Ws: WsCtor = WebSocket) {}

  start() {
    this.open('coinbase', 'wss://ws-feed.exchange.coinbase.com', ws => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] })), d => {
      const m = JSON.parse(d) as { type?: string; price?: string; time?: string }
      if (m.type === 'ticker' && m.price) this.model.onTick('coinbase', Number(m.price), Date.now())
    })
    this.open('binance', 'wss://stream.binance.com:9443/ws/btcusdt@trade', null, d => {
      const m = JSON.parse(d) as { p?: string }
      if (m.p) this.model.onTick('binance', Number(m.p), Date.now())
    })
  }

  private open(name: string, url: string, onOpen: ((ws: WebSocket) => void) | null, onMsg: (d: string) => void, attempt = 0) {
    if (this.stopped) return
    let ws: WebSocket
    try { ws = new this.Ws(url) } catch (e) { log.warn('updown: feed failed to open', { name, error: errMsg(e) }); return }
    this.sockets.push(ws)
    let alive = false
    ws.onopen = () => { alive = true; attempt = 0; onOpen?.(ws) }
    ws.onmessage = e => { try { onMsg(String(e.data)) } catch { /* a malformed frame is skipped */ } }
    ws.onclose = () => {
      this.sockets = this.sockets.filter(s => s !== ws)
      if (this.stopped) return
      const wait = Math.min(60_000, 2_000 * 2 ** (alive ? 0 : Math.min(attempt, 5)))
      setTimeout(() => this.open(name, url, onOpen, onMsg, attempt + 1), wait)
    }
    ws.onerror = () => { /* onclose follows */ }
  }

  stop() { this.stopped = true; for (const s of this.sockets) try { s.close() } catch { /* already closed */ } }
}
