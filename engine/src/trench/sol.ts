// Solana's launches and trades within seconds (the Trenches' live feed, trench/service.ts): pump.fun's bonding curves and
// PumpSwap, its pools after graduation, straight from Solana's own WebSocket. One logsSubscribe per program at
// "confirmed"; each transaction's "Program data:" lines are Anchor events, decoded here (layouts read from live
// transactions on 2026-10-12, scripts in engine/test/trenchSol.test.ts's fixtures):
//
//   pump.fun CreateEvent    name, symbol, uri (strings), mint, bonding curve, user, creator, timestamp, virtual token
//                           and SOL reserves, real token reserves, total supply
//   pump.fun TradeEvent     mint, SOL in or out, tokens, buy?, user, timestamp, virtual SOL and token reserves, real SOL
//                           and token reserves (later fields, which vary by version, aren't read)
//   pump.fun CompleteEvent  user, mint, bonding curve, timestamp: the curve sold out (graduating to PumpSwap)
//   PumpSwap Buy/SellEvent  timestamp, then u64s (base, limit, the user's and the pool's reserves, quote in or out, fees…)
//                           and the pool and user at bytes 120 and 152. A pool's coin is read from its account once.
//
// A transaction touching both programs (a router) arrives on both subscriptions and is read once. Curves quoted in
// anything but SOL (some launches since 2026 use other quotes) are left out: their virtual SOL reserves sit outside
// what a SOL curve can hold. Solana's public endpoints carry it (Solana's own first, publicnode after; a socket quiet for 30 seconds moves to the next), ~90 events a
// second at the time; TRENCH_SOL_WSS names another (e.g. a paid node's, its key server-side only).

import { createHash } from 'node:crypto'
import { base58, fromBase64, readAccounts, PUMP_FOR_SALE, SOL_RPC_SERVER, SOL_USDC, SOL_USDT, USD1, WSOL } from '../../../api/_solCore'
import type { TrenchMessage } from '../../../api/_trenchProtocol'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import type { TrenchBook } from './book'
import type { NativePrices } from './prices'

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
export const SOL_WSS = ['wss://api.mainnet-beta.solana.com', 'wss://solana-rpc.publicnode.com']

const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex')
const D = { create: disc('CreateEvent'), trade: disc('TradeEvent'), complete: disc('CompleteEvent'), buy: disc('BuyEvent'), sell: disc('SellEvent') }

/** A SOL-quoted pump.fun curve starts with 30 SOL of virtual reserves and graduates near 115. */
const SOL_CURVE_MIN = 25_000_000_000n
const SOL_CURVE_MAX = 200_000_000_000n
/** pump.fun's coins: 1B supply, 6 decimals. */
const PUMP_SUPPLY = 1_000_000_000

export type PumpEvent =
  | { k: 'create'; mint: string; name: string; symbol: string; uri: string; curve: string; user: string; creator: string; ts: number; vTok: bigint; vSol: bigint; rTok: bigint; supply: bigint }
  | { k: 'trade'; mint: string; sol: bigint; tok: bigint; buy: boolean; user: string; ts: number; vSol: bigint; vTok: bigint; rSol: bigint; rTok: bigint }
  | { k: 'complete'; mint: string; user: string; curve: string; ts: number }
  | { k: 'amm'; buy: boolean; ts: number; base: bigint; quote: bigint; poolBase: bigint; poolQuote: bigint; pool: string; user: string }

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const u64 = (b: Uint8Array, o: number) => view(b).getBigUint64(o, true)
const i64 = (b: Uint8Array, o: number) => Number(view(b).getBigInt64(o, true))
const pk = (b: Uint8Array, o: number) => base58(b.subarray(o, o + 32))
function str(b: Uint8Array, o: number): [string, number] {
  const n = view(b).getUint32(o, true)
  if (n > 400 || o + 4 + n > b.length) throw new Error('bad string')
  return [new TextDecoder().decode(b.subarray(o + 4, o + 4 + n)), o + 4 + n]
}
const hex8 = (b: Uint8Array) => Array.from(b.subarray(0, 8), x => x.toString(16).padStart(2, '0')).join('')

/** One "Program data:" payload (base64) as a pump.fun or PumpSwap event, or null. */
export function decodePumpData(b64: string): PumpEvent | null {
  let b: Uint8Array
  try { b = fromBase64(b64) } catch { return null }
  if (b.length < 16) return null
  const d = hex8(b)
  try {
    if (d === D.trade && b.length >= 129) {
      return { k: 'trade', mint: pk(b, 8), sol: u64(b, 40), tok: u64(b, 48), buy: b[56] === 1, user: pk(b, 57), ts: i64(b, 89), vSol: u64(b, 97), vTok: u64(b, 105), rSol: u64(b, 113), rTok: u64(b, 121) }
    }
    if (d === D.create) {
      let o = 8
      let name: string, symbol: string, uri: string
      ;[name, o] = str(b, o); [symbol, o] = str(b, o); [uri, o] = str(b, o)
      if (b.length < o + 168) return null
      return { k: 'create', name, symbol, uri, mint: pk(b, o), curve: pk(b, o + 32), user: pk(b, o + 64), creator: pk(b, o + 96), ts: i64(b, o + 128), vTok: u64(b, o + 136), vSol: u64(b, o + 144), rTok: u64(b, o + 152), supply: u64(b, o + 160) }
    }
    if (d === D.complete && b.length >= 112) return { k: 'complete', user: pk(b, 8), mint: pk(b, 40), curve: pk(b, 72), ts: i64(b, 104) }
    if ((d === D.buy || d === D.sell) && b.length >= 184) {
      return { k: 'amm', buy: d === D.buy, ts: i64(b, 8), base: u64(b, 16), quote: u64(b, 64), poolBase: u64(b, 48), poolQuote: u64(b, 56), pool: pk(b, 120), user: pk(b, 152) }
    }
  } catch { return null }
  return null
}

/** A SOL curve's price (SOL per coin), market cap in SOL and progress, from a pump.fun event's reserves; null for a curve
 * quoted in something else. */
export function pumpCurve(vSol: bigint, vTok: bigint, rTok: bigint, supply = PUMP_SUPPLY): { priceSol: number; mcapSol: number; progress: number } | null {
  if (vSol < SOL_CURVE_MIN || vSol > SOL_CURVE_MAX || vTok <= 0n) return null
  const priceSol = (Number(vSol) / 1e9) / (Number(vTok) / 1e6)
  const sold = rTok >= PUMP_FOR_SALE ? 0n : PUMP_FOR_SALE - rTok
  return { priceSol, mcapSol: priceSol * supply, progress: Math.min(100, Number((sold * 10_000n) / PUMP_FOR_SALE) / 100) }
}

interface AmmPool { base: string; quote: string; baseDec: number; quoteDec: number; supply: number }
const QUOTE_DEC: Record<string, number> = { [WSOL]: 9, [SOL_USDC]: 6, [SOL_USDT]: 6, [USD1]: 6 }

export interface SolFeedOpts {
  book: TrenchBook
  prices: NativePrices
  publish: (m: TrenchMessage) => void
  wss?: string[]
  rpcs?: string[]
  fetcher?: typeof fetch
}

export class SolFeed {
  private ws: WebSocket | null = null
  private urlIx = 0
  private backoff = 1_000
  private lastMsgAt = 0
  private seen = new Map<string, number>()
  private subs = new Map<number, string>()
  private pools = new Map<string, AmmPool | null>()
  private poolWait = new Map<string, { ev: Extract<PumpEvent, { k: 'amm' }>; at: number }[]>()
  private resolving = false
  private metaQueue: { mint: string; uri: string }[] = []
  private metaBusy = 0
  private timers: ReturnType<typeof setInterval>[] = []
  connected = false
  stopped = false

  constructor(private o: SolFeedOpts) {}

  start() {
    this.connect()
    this.timers.push(setInterval(() => this.watchdog(), 10_000))
    this.timers.push(setInterval(() => void this.resolvePools(), 1_000))
  }
  stop() { this.stopped = true; for (const t of this.timers) clearInterval(t); this.ws?.close() }

  private get urls() { return this.o.wss?.length ? this.o.wss : SOL_WSS }

  private connect() {
    if (this.stopped) return
    const url = this.urls[this.urlIx % this.urls.length]
    let ws: WebSocket
    try { ws = new WebSocket(url) } catch (e) { log.warn('trench sol: connect failed', { error: errMsg(e) }); this.retry(); return }
    this.ws = ws
    this.subs.clear()
    ws.onopen = () => {
      this.connected = true
      this.lastMsgAt = Date.now()
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [PUMP_AMM] }, { commitment: 'confirmed' }] }))
      log.info('trench sol: connected', { host: new URL(url).host })
    }
    ws.onmessage = ev => {
      this.lastMsgAt = Date.now()
      this.backoff = 1_000
      try { this.onMessage(String(ev.data)) } catch (e) { metrics.inc('trench_sol_errors'); log.debug('trench sol: message failed', { error: errMsg(e) }) }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.connected = false
      this.retry()
    }
    ws.onerror = () => { try { ws.close() } catch { /* already closing */ } }
  }

  private retry() {
    if (this.stopped) return
    this.urlIx++
    const delay = this.backoff
    this.backoff = Math.min(30_000, this.backoff * 2)
    setTimeout(() => this.connect(), delay)
  }

  /** A socket that went quiet for 30 seconds is replaced (the other endpoint next). */
  private watchdog() {
    if (this.ws && this.connected && Date.now() - this.lastMsgAt > 30_000) {
      log.warn('trench sol: quiet for 30s, reconnecting')
      try { this.ws.close() } catch { /* closing */ }
    }
  }

  private onMessage(raw: string) {
    const j = JSON.parse(raw) as { id?: number; result?: number; params?: { result?: { value?: { signature?: string; err?: unknown; logs?: string[] } } } }
    if (j.id) { if (typeof j.result === 'number') this.subs.set(j.result, j.id === 1 ? 'pump' : 'amm'); return }
    const v = j.params?.result?.value
    if (!v || v.err || !v.signature || !v.logs) return
    if (this.seen.has(v.signature)) return
    this.seen.set(v.signature, 1)
    if (this.seen.size > 60_000) { let n = 0; for (const k of this.seen.keys()) { this.seen.delete(k); if (++n >= 15_000) break } }
    for (const line of v.logs) {
      if (!line.startsWith('Program data: ')) continue
      const e = decodePumpData(line.slice(14))
      if (e) this.onEvent(e)
    }
  }

  /** One decoded event (exported through the class for tests: feed it what the socket would). */
  onEvent(e: PumpEvent, now = Date.now()) {
    const { book, prices, publish } = this.o
    const sol = prices.usd('SOL', now)
    metrics.inc('trench_sol_events')
    if (e.k === 'create') {
      const c = pumpCurve(e.vSol, e.vTok, e.rTok, Number(e.supply) / 1e6 || PUMP_SUPPLY)
      if (!c || !sol) return
      const wire = book.launch({
        token: e.mint, symbol: e.symbol.slice(0, 24), name: e.name.slice(0, 48), image: null, launchpad: 'pump.fun', quote: 'SOL',
        pool: e.curve, createdAt: e.ts > 0 ? Math.min(now, e.ts * 1000) : now, creator: e.creator || e.user,
        priceUsd: c.priceSol * sol, mcapUsd: c.mcapSol * sol, liquidityUsd: 0, progress: 0,
      }, now)
      if (wire) { publish({ t: 'TLAUNCH', c: 'sol', d: wire }); metrics.inc('trench_launches_sol') }
      if (e.uri) this.queueMeta(e.mint, e.uri)
      return
    }
    if (e.k === 'trade') {
      const c = pumpCurve(e.vSol, e.vTok, e.rTok)
      if (!c || !sol || !(e.tok > 0n)) return
      const st = book.trade({
        token: e.mint, wallet: e.user, side: e.buy ? 'buy' : 'sell', usd: (Number(e.sol) / 1e9) * sol, tokens: Number(e.tok) / 1e6,
        ts: e.ts > 0 ? Math.min(now, e.ts * 1000) : now, priceUsd: c.priceSol * sol, mcapUsd: c.mcapSol * sol,
        liquidityUsd: (Number(e.rSol) / 1e9) * sol, progress: c.progress, graduated: e.rTok === 0n,
      })
      if (st) publish({ t: 'TSMART', c: 'sol', d: st })
      return
    }
    if (e.k === 'complete') {
      book.markGraduated(e.mint)
      return
    }
    // PumpSwap: the pool's coin first.
    const pool = this.pools.get(e.pool)
    if (pool === undefined) {
      const q = this.poolWait.get(e.pool) ?? []
      if (q.length < 50) q.push({ ev: e, at: now })
      this.poolWait.set(e.pool, q)
      return
    }
    if (pool) this.ammTrade(e, pool, now)
  }

  private ammTrade(e: Extract<PumpEvent, { k: 'amm' }>, p: AmmPool, now: number) {
    const qUsd = p.quote === WSOL ? this.o.prices.usd('SOL', now) : QUOTE_DEC[p.quote] ? 1 : null
    if (!qUsd || !(e.base > 0n) || !(e.poolBase > 0n)) return
    const base = Number(e.base) / 10 ** p.baseDec
    const quote = Number(e.quote) / 10 ** p.quoteDec
    // The pool's reserves after the trade (the event states them before it).
    const pb = Number(e.buy ? e.poolBase - e.base : e.poolBase + e.base) / 10 ** p.baseDec
    const pq = Number(e.buy ? e.poolQuote + e.quote : e.poolQuote - e.quote) / 10 ** p.quoteDec
    if (!(pb > 0) || !(pq > 0)) return
    const priceUsd = (pq / pb) * qUsd
    const st = this.o.book.trade({
      token: p.base, wallet: e.user, side: e.buy ? 'buy' : 'sell', usd: quote * qUsd, tokens: base,
      ts: e.ts > 0 ? Math.min(now, e.ts * 1000) : now, priceUsd, mcapUsd: priceUsd * p.supply, liquidityUsd: 2 * pq * qUsd, progress: 100, graduated: true,
    })
    if (st) this.o.publish({ t: 'TSMART', c: 'sol', d: st })
  }

  /** Reads the pools trades arrived for (their coin and quote, then the coin's decimals and supply), 100 at a time. */
  private async resolvePools() {
    if (this.resolving || !this.poolWait.size) return
    this.resolving = true
    try {
      const now = Date.now()
      const ids = [...this.poolWait.keys()].slice(0, 100)
      const rpcs = this.o.rpcs ?? SOL_RPC_SERVER
      const accts = await readAccounts(ids, rpcs, this.o.fetcher)
      const found = new Map<string, { base: string; quote: string }>()
      for (const id of ids) {
        const a = accts.get(id)
        if (a === undefined) continue // not answered: asked again next second
        if (!a || a.owner !== PUMP_AMM || a.data.length < 107) { this.pools.set(id, null); continue }
        found.set(id, { base: base58(a.data.subarray(43, 75)), quote: base58(a.data.subarray(75, 107)) })
      }
      const mints = [...new Set([...found.values()].map(f => f.base))]
      const mintAccts = mints.length ? await readAccounts(mints, rpcs, this.o.fetcher) : new Map()
      for (const [id, f] of found) {
        const m = mintAccts.get(f.base)
        if (m === undefined) continue
        const qd = QUOTE_DEC[f.quote]
        if (!m || m.data.length < 45 || qd === undefined) { this.pools.set(id, null); continue }
        const dec = m.data[44]
        const supply = Number(u64(m.data, 36)) / 10 ** dec
        const pool: AmmPool = { base: f.base, quote: f.quote, baseDec: dec, quoteDec: qd, supply: supply > 0 ? supply : PUMP_SUPPLY }
        this.pools.set(id, pool)
      }
      for (const id of ids) {
        const p = this.pools.get(id)
        if (p === undefined) { const q = this.poolWait.get(id); if (q && now - q[0].at > 20_000) this.poolWait.delete(id); continue }
        const waiting = this.poolWait.get(id) ?? []
        this.poolWait.delete(id)
        if (p) for (const w of waiting) this.ammTrade(w.ev, p, now)
      }
      if (this.pools.size > 50_000) { let n = 0; for (const k of this.pools.keys()) { this.pools.delete(k); if (++n >= 10_000) break } }
    } catch (e) {
      log.debug('trench sol: pool read failed', { error: errMsg(e) })
    } finally { this.resolving = false }
  }

  // ── launch pictures ────────────────────────────────────────────────────

  private queueMeta(mint: string, uri: string) {
    this.metaQueue.push({ mint, uri })
    if (this.metaQueue.length > 300) this.metaQueue.shift()
    this.pumpMeta()
  }

  private pumpMeta() {
    while (this.metaBusy < 4 && this.metaQueue.length) {
      const job = this.metaQueue.pop()! // newest first: the coins at the top of New
      this.metaBusy++
      void fetchImage(job.uri, this.o.fetcher).then(img => {
        if (img && this.o.book.setImage(job.mint, img)) this.o.publish({ t: 'TMETA', c: 'sol', d: { a: job.mint, i: img } })
      }).finally(() => { this.metaBusy--; this.pumpMeta() })
    }
  }
}

/** ipfs:// links as an https gateway's. */
export const httpUrl = (u: string) => (u.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}` : u)

/** A metadata JSON's picture (https only), or null: 5 seconds, 64 KB at most. */
export async function fetchImage(uri: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const url = httpUrl(uri.trim())
  if (!/^https:\/\//.test(url)) return null
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } })
    if (!r.ok) return null
    const text = await r.text()
    if (text.length > 65_536) return null
    const j = JSON.parse(text) as { image?: unknown }
    const img = typeof j.image === 'string' ? httpUrl(j.image.trim()) : ''
    return /^https:\/\/[^\s"'<>]{4,400}$/.test(img) ? img : null
  } catch { return null }
}
