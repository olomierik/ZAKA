// The market engine: normalized trades and launches in → hot state,
// candles, history rows and WebSocket events out. Everything here is
// in-memory and incremental; nothing on the trade path waits on a network
// call (Redis and the database are written in the background).

import { toWire, type Interval, type LaunchInfo, type ServerMessage, type TokenStats, type Trade, type WireCandle, type WireTrade } from '../../../api/_marketProtocol'
import { INTERVAL_LIST } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { HistoryStore } from '../store/history'
import type { HotStore } from '../store/hot'
import { CandleEngine, toWireCandle, type ApplyResult } from './candles'
import { TokenState } from './tokenState'

export interface Publisher {
  publish(topics: string[], msg: ServerMessage): void
  /** Anyone subscribed? (Skips building messages nobody will read.) */
  wants(topic: string): boolean
}

const RECENT_TRADES = 100
const IDLE_MS = 26 * 3_600_000

export class MarketEngine {
  readonly tokens = new Map<string, TokenState>()
  readonly metas = new Map<string, LaunchInfo>()
  readonly candles = new CandleEngine()
  private recent = new Map<string, WireTrade[]>()
  private poolPrice = new Map<string, number>()
  private lastLiq = new Map<string, { usd: number; at: number }>()
  private dirty = new Set<string>()
  private candlesDirty = new Set<string>()
  private ticks = new Set<string>()
  private supplyQueue = new Set<string>()
  private lastEvict = Date.now()
  lastNewTokenAt = 0

  constructor(private out: Publisher, private hot: HotStore, private history: HistoryStore, private rpc: Rpc | null) {}

  launchpadOf = (token: string) => this.metas.get(token)?.launchpad ?? null

  private state(token: string) {
    let st = this.tokens.get(token)
    if (!st) {
      st = new TokenState(token)
      this.tokens.set(token, st)
      this.supplyQueue.add(token)
    }
    return st
  }

  onTrade(t: Trade, ctx: { replay: boolean; receivedAt?: number }) {
    const ord = t.blockNumber * 100_000 + t.logIndex
    const st = this.state(t.token)
    const priceBefore = this.poolPrice.get(t.pool) ?? null
    const latest = st.add(t, ord)
    if (t.priceUsd !== null && (latest || priceBefore === null)) this.poolPrice.set(t.pool, t.priceUsd)

    const wire = toWire(t)
    this.remember(t.token, wire)
    this.hot.pushTrade(t.token, wire)
    this.history.trade(t)

    let cr: ApplyResult | null = null
    if (t.priceUsd !== null) {
      cr = this.candles.apply(t.token, t.priceUsd, t.usdValue ?? 0, t.timestamp, ord, priceBefore)
      for (const c of cr.completed) this.history.candle(t.token, c.interval, c.candle)
      for (const r of cr.repair) this.history.repair(t.token, r.interval, r.bucket)
      this.candlesDirty.add(t.token)
    }

    let liqChanged = false
    if (t.liquidity !== null && latest) {
      const prev = this.lastLiq.get(t.pool)
      const now = Date.now()
      if (!prev || Math.abs(t.liquidity - prev.usd) > prev.usd * 0.005 || now - prev.at > 60_000) {
        this.lastLiq.set(t.pool, { usd: t.liquidity, at: now })
        this.history.liquidity({ pool: t.pool, token: t.token, block: t.blockNumber, ts: t.timestamp, usd: t.liquidity })
        liqChanged = !prev || Math.abs(t.liquidity - prev.usd) > prev.usd * 0.005
      }
    }

    this.dirty.add(t.token)
    this.ticks.add(t.token)
    metrics.inc('trades')
    if (ctx.replay) { metrics.inc('trades_replayed'); return }

    const k = t.token
    this.out.publish([`token:${k}`, `trades:${k}`], { t: 'TRADE', k, d: wire })
    const s = st.stats()
    if (latest && t.priceUsd !== null) {
      this.out.publish([`token:${k}`, `price:${k}`], { t: 'PRICE_UPDATE', k, d: { pu: s.priceUsd, p: s.price, mc: s.marketCapUsd, b: t.blockNumber, ts: t.timestamp } })
    }
    this.out.publish([`token:${k}`, `volume:${k}`], { t: 'VOLUME_UPDATE', k, d: { v: s.vol24, bv: s.buyVol24, sv: s.sellVol24, bc: s.buys24, sc: s.sells24, tc: s.trades24 } })
    if (liqChanged && t.liquidity !== null) {
      this.out.publish([`token:${k}`, `liquidity:${k}`], { t: 'LIQUIDITY_UPDATE', k, d: { lq: t.liquidity, pl: t.pool, b: t.blockNumber, ts: t.timestamp } })
    }
    for (const u of cr?.updated ?? []) {
      const topic = `candles:${k}:${u.interval}`
      if (this.out.wants(topic)) this.out.publish([topic], { t: 'CANDLE_UPDATE', k, i: u.interval, d: toWireCandle(u.candle) })
    }
    if (ctx.receivedAt) metrics.latency('trade_processing', Date.now() - ctx.receivedAt)
    metrics.latency('block_to_publish', Date.now() - t.timestamp)
  }

  onLaunch(l: LaunchInfo, ctx: { replay: boolean; initialPriceUsd?: number | null }) {
    if (this.metas.has(l.token)) return // idempotent (replays, duplicate events)
    this.metas.set(l.token, l)
    this.hot.putMeta(l.token, l)
    this.hot.pushLaunch(l)
    this.history.launch(l)
    const st = this.state(l.token)
    // Visible with a price before its first trade: the pool's initial price.
    if (st.priceUsd === null && ctx.initialPriceUsd && ctx.initialPriceUsd > 0) {
      st.priceUsd = ctx.initialPriceUsd
      st.firstPriceUsd = ctx.initialPriceUsd
      st.mainPool = l.pool
      st.quote = l.quote
      st.latestBlock = l.blockNumber
      st.latestTs = l.timestamp
    }
    this.dirty.add(l.token)
    metrics.inc('new_tokens')
    this.lastNewTokenAt = Date.now()
    if (ctx.replay) return
    metrics.latency('launch_detection', Date.now() - l.timestamp)
    const s = st.stats()
    this.out.publish(['new_tokens'], { t: 'NEW_TOKEN', k: l.token, d: { ...l, priceUsd: s.priceUsd, marketCapUsd: s.marketCapUsd } })
    log.info('new token', { token: l.token, symbol: l.symbol, launchpad: l.launchpad, portal: l.portal, block: l.blockNumber })
  }

  private remember(token: string, w: WireTrade) {
    const list = this.recent.get(token) ?? []
    // Newest first by chain order; late trades slot into place.
    const ord = (x: WireTrade) => x.b * 100_000 + x.li
    const o = ord(w)
    let i = 0
    while (i < list.length && ord(list[i]) > o) i++
    if (list[i]?.id === w.id) return
    list.splice(i, 0, w)
    if (list.length > RECENT_TRADES) list.length = RECENT_TRADES
    this.recent.set(token, list)
  }

  // ── reads (WebSocket snapshots, REST) ────────────────────────────────

  statsOf(token: string): TokenStats | null { return this.tokens.get(token)?.stats() ?? null }
  recentTrades(token: string, limit: number): WireTrade[] { return (this.recent.get(token) ?? []).slice(0, limit) }
  currentCandle(token: string, interval: Interval): WireCandle | null {
    const c = this.candles.current(token, interval)
    return c ? toWireCandle(c) : null
  }
  recentCandles(token: string, interval: Interval): WireCandle[] { return this.candles.recent(token, interval).map(toWireCandle) }

  /** Most active tokens, for the market endpoint. */
  market(limit: number) {
    const rows = [...this.tokens.values()]
      .map(st => ({ token: st.token, stats: st.stats(), meta: this.metas.get(st.token) ?? null }))
      .filter(r => r.stats.priceUsd !== null)
      .sort((a, b) => b.stats.vol24 - a.stats.vol24)
    return rows.slice(0, limit)
  }

  // ── background ──────────────────────────────────────────────────────

  /** Once a second: market ticks, hot-store state, supplies, eviction. */
  tick() {
    const now = Date.now()
    if (this.ticks.size && this.out.wants('market')) {
      const d: [string, number | null, number | null, number, number | null, number][] = []
      for (const k of this.ticks) {
        const s = this.tokens.get(k)?.stats(now)
        if (s) d.push([k, s.priceUsd, s.chg.h24, s.vol24, s.marketCapUsd, s.trades24])
      }
      if (d.length) this.out.publish(['market'], { t: 'TICKS', d })
    }
    this.ticks.clear()
    for (const k of this.dirty) {
      const st = this.tokens.get(k)
      if (st) this.hot.putState(k, { state: st.serialize(), stats: st.stats(now) })
    }
    this.dirty.clear()
    for (const k of this.candlesDirty) for (const iv of INTERVAL_LIST) this.hot.putCandles(k, iv, this.candles.recent(k, iv))
    this.candlesDirty.clear()
    void this.loadSupplies()
    if (now - this.lastEvict > 60_000) this.evict(now)
    metrics.set('tokens_in_memory', this.tokens.size)
    this.hot.putMarketStats({ tokens: this.tokens.size, tradesPerSec: metrics.rate('trades'), eventsPerSec: metrics.rate('events'), at: now })
  }

  private evict(now: number) {
    this.lastEvict = now
    for (const [k, st] of this.tokens) {
      if (now - Math.max(st.lastTradeAt, this.metas.get(k)?.timestamp ?? 0) > IDLE_MS) {
        this.tokens.delete(k); this.recent.delete(k)
      }
    }
    this.candles.evictIdle(IDLE_MS)
  }

  /** totalSupply for market caps, 25 tokens per second, in the background. */
  private supplyBusy = false
  private async loadSupplies() {
    if (!this.rpc || this.supplyBusy || !this.supplyQueue.size) return
    this.supplyBusy = true
    const batch = [...this.supplyQueue].slice(0, 25)
    batch.forEach(t => this.supplyQueue.delete(t))
    try {
      const call = (to: string, data: string) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] })
      const res = await this.rpc.batch<string>(batch.flatMap(t => [call(t, '0x18160ddd'), call(t, '0x313ce567')]))
      batch.forEach((t, i) => {
        const s = res[2 * i], d = res[2 * i + 1]
        const st = this.tokens.get(t)
        if (!st || !s || s === '0x' || !d || d === '0x') return
        const dec = Number(BigInt(d))
        const supply = Number(BigInt(s)) / 10 ** dec
        // Launch metadata is untrusted (Argus docs): ignore absurd supplies.
        if (dec <= 36 && supply > 1_000 && supply < 1e15) { st.supply = supply; this.dirty.add(t) }
      })
    } catch (e) {
      batch.forEach(t => this.supplyQueue.add(t))
      log.debug('supply batch failed', { error: errMsg(e) })
    } finally { this.supplyBusy = false }
  }

  /** Warm restart: the last state of recently active tokens from the hot store. */
  async warmStart() {
    try {
      const active = await this.hot.getActive(5_000)
      await Promise.all(active.map(async k => {
        const [s, meta, trades] = await Promise.all([this.hot.getState(k), this.hot.getMeta(k), this.hot.getTrades(k, RECENT_TRADES)])
        if (s?.state) this.tokens.set(k, TokenState.restore(k, s.state as ReturnType<TokenState['serialize']>))
        if (meta) this.metas.set(k, meta)
        if (trades.length) this.recent.set(k, trades)
        for (const iv of INTERVAL_LIST) {
          const c = await this.hot.getCandles(k, iv)
          if (c.length) this.candles.load(k, iv, c)
        }
      }))
      const launches = await this.hot.getLaunches(500)
      for (const l of launches) if (!this.metas.has(l.token)) this.metas.set(l.token, l)
      log.info('warm start', { tokens: this.tokens.size, launches: launches.length })
    } catch (e) {
      log.warn('warm start failed — starting cold', { error: errMsg(e) })
    }
  }
}
