// Polymarket's BTC Up/Down windows: discovery, price to beat, results, and the live order books.
//
// - A window's market comes from Gamma (`/events?slug=btc-updown-<dur>-<start>`): its two tokens (Up, Down), tick,
//   minimum order, fee schedule and TWAP length. Anything unrecognised (another fee type, no TWAP, a third outcome)
//   leaves the window untraded.
// - The price to beat and the result come from Polymarket's crypto-price endpoint (`variant` fiveminute / fifteen):
//   `openPrice` once the window has started, `closePrice` with `completed: true` once it's resolved. Up wins at or
//   above the open.
// - The books stream from Polymarket's market WebSocket: a `book` snapshot per token, then `price_change` updates.

import { log, errMsg } from '../log'
import { UPDOWN_DUR_SEC, UPDOWN_VARIANT, updownSlug, type UpdownDur } from '../../../api/_updownProtocol'

export interface UpWindow {
  slug: string
  dur: UpdownDur
  start: number
  end: number
  conditionId: string
  upToken: string
  downToken: string
  tick: number
  minSize: number
  feeRate: number
  feeExponent: number
  twapSec: number
  accepting: boolean
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const GAMMA = 'https://gamma-api.polymarket.com'
const PRICE = 'https://polymarket.com/api/crypto/crypto-price'

interface GammaMarket {
  conditionId?: string; slug?: string; outcomes?: string; clobTokenIds?: string; orderPriceMinTickSize?: number; orderMinSize?: number
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean }; feeType?: string; feesEnabled?: boolean
  cryptoMarketConfig?: { twapEnabled?: boolean; twapLookbackSeconds?: number; asset?: string }; acceptingOrders?: boolean; closed?: boolean
}

/** Gamma's event for a window, as the engine trades it, or why not. */
export function parseWindow(dur: UpdownDur, start: number, event: unknown): UpWindow | { error: string } {
  const ev = event as { markets?: GammaMarket[] } | undefined
  const m = ev?.markets?.[0]
  if (!m) return { error: 'not listed' }
  if (m.slug !== updownSlug(dur, start)) return { error: 'another market' }
  let outcomes: string[], tokens: string[]
  try { outcomes = JSON.parse(m.outcomes ?? '[]'); tokens = JSON.parse(m.clobTokenIds ?? '[]') } catch { return { error: 'unreadable outcomes' } }
  if (outcomes.length !== 2 || outcomes[0] !== 'Up' || outcomes[1] !== 'Down' || tokens.length !== 2) return { error: 'not an Up/Down market' }
  const cfg = m.cryptoMarketConfig
  if (cfg?.asset !== 'btc' || !cfg.twapEnabled) return { error: 'not a BTC TWAP market' }
  const fs = m.feeSchedule
  if (m.feesEnabled !== false && (!fs || typeof fs.rate !== 'number' || fs.rate < 0 || fs.rate > 0.25 || fs.takerOnly === false)) return { error: 'unrecognised fee schedule' }
  const tick = Number(m.orderPriceMinTickSize)
  if (!(tick > 0 && tick <= 0.01)) return { error: 'unrecognised tick' }
  return {
    slug: m.slug, dur, start, end: start + UPDOWN_DUR_SEC[dur], conditionId: m.conditionId ?? '',
    upToken: tokens[0], downToken: tokens[1], tick, minSize: Number(m.orderMinSize) || 5,
    feeRate: m.feesEnabled === false ? 0 : fs!.rate!, feeExponent: fs?.exponent ?? 1,
    twapSec: cfg.twapLookbackSeconds ?? 60, accepting: m.acceptingOrders !== false && !m.closed,
  }
}

export async function fetchWindow(f: Fetch, dur: UpdownDur, start: number): Promise<UpWindow | { error: string }> {
  const r = await f(`${GAMMA}/events?slug=${updownSlug(dur, start)}`, { signal: AbortSignal.timeout(6_000) })
  if (!r.ok) return { error: `gamma ${r.status}: ${(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)}` }
  const j = await r.json().catch(() => null) as unknown[] | null
  if (!Array.isArray(j)) return { error: 'gamma answered something that isn’t a list' }
  return parseWindow(dur, start, j?.[0])
}

export interface PricePoint { open: number | null; close: number | null; completed: boolean }

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z')

/** Parses the crypto-price answer. Unknown variants fall back to a live spot answer with a close price while
 *  incomplete; the real one carries `closePrice: null` until it's resolved, so that's what's accepted. */
export function parsePrice(j: unknown): PricePoint | null {
  const o = j as { openPrice?: unknown; closePrice?: unknown; completed?: unknown } | null
  if (!o || typeof o.openPrice !== 'number' || !(o.openPrice > 0)) return null
  if (o.completed === true) return typeof o.closePrice === 'number' && o.closePrice > 0 ? { open: o.openPrice, close: o.closePrice, completed: true } : null
  if (o.closePrice !== null) return null
  return { open: o.openPrice, close: null, completed: false }
}

export async function fetchPrice(f: Fetch, dur: UpdownDur, start: number): Promise<PricePoint | null> {
  const url = `${PRICE}?symbol=BTC&eventStartTime=${iso(start)}&variant=${UPDOWN_VARIANT[dur]}&endDate=${iso(start + UPDOWN_DUR_SEC[dur])}`
  const r = await f(url, { signal: AbortSignal.timeout(6_000) })
  if (!r.ok) return null
  return parsePrice(await r.json())
}

export async function fetchGeoblock(f: Fetch): Promise<{ blocked: boolean; country: string } | null> {
  try {
    const r = await f('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(6_000) })
    if (!r.ok) return null
    const j = await r.json() as { blocked?: boolean; country?: string }
    return { blocked: j.blocked === true, country: String(j.country ?? '') }
  } catch { return null }
}

/** One price level: price and size in shares. */
export interface Level { price: number; size: number }

/** Every subscribed token's book, from snapshots and updates. */
export class Books {
  private bids = new Map<string, Map<number, number>>()
  private asks = new Map<string, Map<number, number>>()
  lastMsgAt = 0
  private lags: number[] = []

  apply(raw: unknown, recvMs: number) {
    for (const m of Array.isArray(raw) ? raw : [raw]) {
      const x = m as { event_type?: string; asset_id?: string; bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[]; price_changes?: { asset_id: string; price: string; size: string; side: string }[]; timestamp?: string }
      if (!x || typeof x !== 'object') continue
      const ts = Number(x.timestamp)
      if (ts > 0) { this.lags.push(Math.max(0, recvMs - ts)); if (this.lags.length > 200) this.lags.shift() }
      this.lastMsgAt = recvMs
      if ((x.event_type === 'book' || (x.bids && x.asks)) && x.asset_id) {
        this.bids.set(x.asset_id, new Map((x.bids ?? []).map(l => [Number(l.price), Number(l.size)])))
        this.asks.set(x.asset_id, new Map((x.asks ?? []).map(l => [Number(l.price), Number(l.size)])))
      } else if (x.price_changes) {
        for (const c of x.price_changes) {
          const book = (c.side === 'BUY' ? this.bids : this.asks).get(c.asset_id)
          if (!book) continue
          const p = Number(c.price), s = Number(c.size)
          if (s > 0) book.set(p, s)
          else book.delete(p)
        }
      }
    }
  }

  has(token: string) { return this.asks.has(token) }
  /** Asks, cheapest first. */
  askLevels(token: string): Level[] {
    return [...(this.asks.get(token) ?? new Map()).entries()].filter(([, s]) => s > 0).map(([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price)
  }
  bestBid(token: string): number | null {
    let b: number | null = null
    for (const [p, s] of this.bids.get(token) ?? []) if (s > 0 && (b === null || p > b)) b = p
    return b
  }
  bestAsk(token: string): Level | null { return this.askLevels(token)[0] ?? null }
  drop(tokens: Set<string>) { for (const t of [...this.asks.keys()]) if (!tokens.has(t)) { this.asks.delete(t); this.bids.delete(t) } }
  /** The median delay between Polymarket stamping a message and the engine receiving it. */
  lagMs(): number | null {
    if (this.lags.length < 5) return null
    const s = [...this.lags].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
}

type WsCtor = new (url: string) => WebSocket

/** Polymarket's market WebSocket for a set of tokens; a changed set reconnects with the new list. */
export class BookStream {
  private ws: WebSocket | null = null
  private tokens: string[] = []
  private ping: ReturnType<typeof setInterval> | null = null
  private stopped = false
  connected = false
  constructor(private books: Books, private Ws: WsCtor = WebSocket, private now: () => number = Date.now) {}

  watch(tokens: string[]) {
    const next = [...new Set(tokens)].sort()
    if (next.join() === this.tokens.join() && this.ws) return
    this.tokens = next
    this.books.drop(new Set(next))
    this.reconnect()
  }

  private reconnect(attempt = 0) {
    if (this.stopped) return
    try { this.ws?.close() } catch { /* already closed */ }
    if (!this.tokens.length) return
    const ws = new this.Ws('wss://ws-subscriptions-clob.polymarket.com/ws/market')
    this.ws = ws
    const tokens = this.tokens
    ws.onopen = () => {
      this.connected = true
      ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' }))
      if (this.ping) clearInterval(this.ping)
      this.ping = setInterval(() => { try { ws.send('PING') } catch { /* closing */ } }, 10_000)
    }
    ws.onmessage = e => {
      const d = String(e.data)
      if (d === 'PONG') return
      try { this.books.apply(JSON.parse(d), this.now()) } catch { /* a malformed frame is skipped */ }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.connected = false
      if (this.stopped) return
      setTimeout(() => { if (this.ws === ws) this.reconnect(attempt + 1) }, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)))
    }
    ws.onerror = e => log.debug('updown: book stream error', { error: errMsg(e) })
  }

  stop() { this.stopped = true; if (this.ping) clearInterval(this.ping); try { this.ws?.close() } catch { /* already closed */ } }
}
