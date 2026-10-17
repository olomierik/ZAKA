// Alerts the engine watches and delivers by web push, so they reach a phone or desktop with ARCDEX closed (the build
// pack's Phase 5: "price and activity alerts … delivered within 10 seconds of trigger").
//
//   price      a Hyperliquid market (BTC, xyz:NVDA) or an Arc coin reaching a level: up to it, or down to it, whichever
//              side the price was on when it was set. Fires once.
//   activity   a single trade on an Arc coin of at least an amount (any side, buys or sells): a whale. Fires each time,
//              at most once a minute per alert.
//   wallet     a trade by a wallet the visitor follows (the wallet tracker, 2026-10-17), on Arc, Robinhood Chain, Solana
//              or BNB Chain: every trade the Trenches' books read for it (trench/walletWatch.ts), at most one every 10
//              seconds per alert, optionally from a size up and on one side.
//
// Watching: Arc coins on every trade the engine streams (onTrade); Hyperliquid markets from its mid prices, read every
// two seconds while any alert waits on them; wallets from the wallet tracker, which keeps a wallet's trades while an
// alert wants them (wantsWallet) as it does while a page is subscribed. Delivery starts the moment an alert is met, and every delivery's time is
// kept: from when the condition was met on the venue (the trade's block time; the mid's read) to the push service
// accepting the message (stats(): the share within 10 seconds, p50 and p95). What the push service then takes to reach
// the device is its own (usually under a second; not measurable from here).
//
// A browser subscribes once (POST /v1/push/subscribe) and gets an id and a secret token; it then sets its alerts with
// them (POST /v1/push/alerts). The engine keeps the token's hash only. The notification's words come from the page, in
// the visitor's language, as plain text (a notification renders no HTML); the engine fills in the trade's dollars.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Trade } from '../../../api/_marketProtocol'
import { tradeTopic, walletTopic, type TrenchChain, type WalletTradeWire } from '../../../api/_trenchProtocol'
import { sendPush, subscriptionProblem, type PushResult, type Subscription, type VapidKeys } from './webpush'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'

export const PUSH = {
  maxAlerts: 50,
  maxSubs: 20_000,
  subsPerIpHour: 10,
  activityCooldownMs: 60_000,
  /** A wallet alert fires at most this often: a bot trading every second shouldn't flood a phone. */
  walletCooldownMs: 10_000,
  hlEveryMs: 2_000,
  /** A subscription that failed this many times in a row (not "gone") is dropped. */
  maxFails: 10,
  testEveryMs: 60_000,
  withinMs: 10_000,
} as const

export type ServerAlert =
  | { id: string; kind: 'price'; venue: 'hl' | 'arc'; market: string; dir: 'above' | 'below'; px: number; title: string; body: string; url: string; firedAt?: number | null }
  | { id: string; kind: 'activity'; venue: 'arc'; market: string; minUsd: number; side: 'any' | 'buy' | 'sell'; title: string; body: string; url: string; buyWord: string; sellWord: string; lastAt?: number | null }
  | { id: string; kind: 'wallet'; venue: 'wallet'; market: string; minUsd: number; side: 'any' | 'buy' | 'sell'; title: string; body: string; url: string; buyWord: string; sellWord: string; lastAt?: number | null }

export interface PushSubRow {
  id: string
  tokenHash: string
  endpoint: string
  p256dh: string
  auth: string
  alerts: ServerAlert[]
  created: number
  updated: number
  fails: number
  lastOk: number | null
  lastTest: number | null
}

export interface PushStore {
  pushSubs(): Promise<PushSubRow[]>
  putPushSub(r: PushSubRow): Promise<void>
  deletePushSub(id: string): Promise<void>
}

export class MemoryPushStore implements PushStore {
  rows = new Map<string, PushSubRow>()
  async pushSubs() { return [...this.rows.values()].map(r => structuredClone(r)) }
  async putPushSub(r: PushSubRow) { this.rows.set(r.id, structuredClone(r)) }
  async deletePushSub(id: string) { this.rows.delete(id) }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const isHlCoin = (s: string) => /^([a-z]{1,8}:)?[A-Za-z0-9]{1,20}$/.test(s)
const isAddr = (s: string) => /^0x[0-9a-f]{40}$/.test(s)

/** One alert from a page, checked; or why not. */
export function cleanAlert(raw: unknown): ServerAlert | string {
  const a = raw as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return 'not an alert'
  const id = text(a.id, 40)
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return 'bad id'
  const url = text(a.url, 200)
  // Opened on this site only: a path, never another origin.
  if (!/^\/(?!\/)[A-Za-z0-9/_:.?=&%-]*$/.test(url)) return 'bad url'
  const title = text(a.title, 120), body = text(a.body, 160)
  if (!title) return 'no title'
  const side = a.side === 'buy' || a.side === 'sell' ? a.side : 'any'
  const words = { buyWord: text(a.buyWord, 20) || 'buy', sellWord: text(a.sellWord, 20) || 'sell' }
  if (a.kind === 'wallet') {
    // An EVM address (one wallet on Arc, Robinhood Chain and BNB Chain) or a Solana one, as the wallet tracker keys them.
    const raw = text(a.market, 44)
    const market = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw
    if (!walletTopic(market)) return 'bad wallet'
    const minUsd = a.minUsd === undefined || a.minUsd === null ? 0 : Number(a.minUsd)
    if (!(minUsd >= 0 && minUsd <= 10_000_000)) return 'the amount must be between $0 and $10M'
    return { id, kind: 'wallet', venue: 'wallet', market, minUsd, side, title, body, url, ...words, lastAt: null }
  }
  const venue = a.venue === 'hl' ? 'hl' : a.venue === 'arc' ? 'arc' : null
  const market = venue === 'arc' ? text(a.market, 42).toLowerCase() : text(a.market, 30)
  if (!venue || !(venue === 'arc' ? isAddr(market) : isHlCoin(market))) return 'bad market'
  if (a.kind === 'price') {
    const px = Number(a.px)
    if (!(px > 0 && Number.isFinite(px)) || (a.dir !== 'above' && a.dir !== 'below')) return 'bad level'
    return { id, kind: 'price', venue, market, dir: a.dir, px, title, body, url, firedAt: null }
  }
  if (a.kind === 'activity') {
    if (venue !== 'arc') return 'activity alerts are for Arc coins'
    const minUsd = Number(a.minUsd)
    if (!(minUsd >= 10 && minUsd <= 10_000_000)) return 'the amount must be between $10 and $10M'
    return { id, kind: 'activity', venue, market, minUsd, side, title, body, url, ...words, lastAt: null }
  }
  return 'unknown kind'
}

/** Whether a price meets a price alert. */
export const priceMet = (a: { dir: 'above' | 'below'; px: number }, price: number) => (a.dir === 'above' ? price >= a.px : price <= a.px)

const CHAIN_NAME: Record<TrenchChain, string> = { arc: 'Arc', hood: 'Robinhood Chain', sol: 'Solana', bnb: 'BNB Chain' }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const fmtUsd = (n: number) => `$${n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0)}`

export interface Delivery { at: number; sinceTriggerMs: number; detectMs: number; ok: boolean; status: number }

export interface PushAlertsOptions {
  store: PushStore
  keys: VapidKeys
  /** VAPID's contact: a mailto: or https: URL. */
  subject: string
  fetcher?: typeof fetch
  /** Hyperliquid's mid prices for a dex ('' for the main one), keyed as Hyperliquid names them ("BTC", "xyz:NVDA"). */
  hlMids: (dex: string) => Promise<Record<string, number>>
  now?: () => number
}

export class PushAlerts {
  private subs = new Map<string, PushSubRow>()
  private arcIndex = new Map<string, { sub: string; alert: string }[]>()
  /** Wallet alerts by the wallet tracker's topic (wallet:evm:… / wallet:sol:…). */
  private walletIndex = new Map<string, { sub: string; alert: string }[]>()
  private hlDexes = new Set<string>()
  private ipNew = new Map<string, number[]>()
  private deliveries: Delivery[] = []
  private counts = { sent: 0, failed: 0, gone: 0 }
  private hlBusy = false
  private now: () => number

  constructor(private o: PushAlertsOptions) { this.now = o.now ?? Date.now }

  async load() {
    for (const r of await this.o.store.pushSubs().catch(e => { log.error('push: subscriptions not loaded', { error: errMsg(e) }); return [] as PushSubRow[] })) this.subs.set(r.id, r)
    this.reindex()
    log.info('push: loaded', { subscriptions: this.subs.size })
  }

  get publicKey() { return this.o.keys.publicKey }

  private reindex() {
    this.arcIndex.clear(); this.hlDexes.clear(); this.walletIndex.clear()
    for (const s of this.subs.values()) for (const a of s.alerts) {
      if (a.kind === 'price' && a.firedAt) continue
      if (a.kind === 'wallet') { const k = walletTopic(a.market); if (k) { const l = this.walletIndex.get(k) ?? []; l.push({ sub: s.id, alert: a.id }); this.walletIndex.set(k, l) } }
      else if (a.venue === 'arc') { const l = this.arcIndex.get(a.market) ?? []; l.push({ sub: s.id, alert: a.id }); this.arcIndex.set(a.market, l) }
      else this.hlDexes.add(a.market.includes(':') ? a.market.split(':')[0] : '')
    }
  }

  private auth(body: Record<string, unknown> | null): PushSubRow | null {
    const id = typeof body?.id === 'string' ? body.id : '', token = typeof body?.token === 'string' ? body.token : ''
    const s = this.subs.get(id)
    if (!s || !token) return null
    const a = Buffer.from(sha(token)), b = Buffer.from(s.tokenHash)
    return a.length === b.length && timingSafeEqual(a, b) ? s : null
  }

  private cleanAll(raw: unknown): ServerAlert[] | string {
    if (!Array.isArray(raw)) return 'alerts must be a list'
    if (raw.length > PUSH.maxAlerts) return `at most ${PUSH.maxAlerts} alerts`
    const out: ServerAlert[] = []
    for (const r of raw) { const a = cleanAlert(r); if (typeof a === 'string') return a; if (!out.some(x => x.id === a.id)) out.push(a) }
    return out
  }

  /** A browser's subscription, with its first alerts. */
  async subscribe(body: Record<string, unknown> | null, ip: string): Promise<{ status: number; body: unknown }> {
    const bad = subscriptionProblem(body?.subscription)
    if (bad) return { status: 400, body: { error: bad } }
    const alerts = this.cleanAll(body?.alerts ?? [])
    if (typeof alerts === 'string') return { status: 400, body: { error: alerts } }
    const sub = body!.subscription as Subscription
    const now = this.now()
    // The same browser subscribing again replaces its old entry (one endpoint, one subscription).
    const same = [...this.subs.values()].find(s => s.endpoint === sub.endpoint)
    if (!same) {
      const recent = (this.ipNew.get(ip) ?? []).filter(t => now - t < 3_600_000)
      if (recent.length >= PUSH.subsPerIpHour) return { status: 429, body: { error: 'too many subscriptions from here; try again later' } }
      if (this.subs.size >= PUSH.maxSubs) return { status: 503, body: { error: 'alerts are full for now' } }
      this.ipNew.set(ip, [...recent, now])
    }
    const token = randomBytes(32).toString('base64url')
    const row: PushSubRow = {
      id: same?.id ?? randomBytes(12).toString('base64url'), tokenHash: sha(token), endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
      alerts: alerts.length ? alerts : same?.alerts ?? [], created: same?.created ?? now, updated: now, fails: 0, lastOk: same?.lastOk ?? null, lastTest: same?.lastTest ?? null,
    }
    this.subs.set(row.id, row)
    await this.o.store.putPushSub(row).catch(e => log.error('push: subscription not saved', { error: errMsg(e) }))
    this.reindex()
    metrics.inc('push_subscribed')
    return { status: 200, body: { id: row.id, token, alerts: row.alerts } }
  }

  /** Replaces a subscription's alerts. A fired price alert sent again stays fired. */
  async setAlerts(body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
    const s = this.auth(body)
    if (!s) return { status: 401, body: { error: 'unknown subscription' } }
    const alerts = this.cleanAll(body?.alerts)
    if (typeof alerts === 'string') return { status: 400, body: { error: alerts } }
    for (const a of alerts) {
      const was = s.alerts.find(x => x.id === a.id)
      if (was?.kind === 'price' && a.kind === 'price' && was.firedAt && was.px === a.px && was.dir === a.dir && was.market === a.market) a.firedAt = was.firedAt
      if ((was?.kind === 'activity' && a.kind === 'activity') || (was?.kind === 'wallet' && a.kind === 'wallet')) a.lastAt = was.lastAt ?? null
    }
    s.alerts = alerts
    s.updated = this.now()
    await this.o.store.putPushSub(s).catch(e => log.error('push: alerts not saved', { error: errMsg(e) }))
    this.reindex()
    return { status: 200, body: { alerts: s.alerts } }
  }

  /** A subscription's alerts, with what fired. */
  read(body: Record<string, unknown> | null): { status: number; body: unknown } {
    const s = this.auth(body)
    return s ? { status: 200, body: { alerts: s.alerts, lastOk: s.lastOk } } : { status: 401, body: { error: 'unknown subscription' } }
  }

  async unsubscribe(body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
    const s = this.auth(body)
    if (!s) return { status: 401, body: { error: 'unknown subscription' } }
    this.subs.delete(s.id)
    await this.o.store.deletePushSub(s.id).catch(() => {})
    this.reindex()
    return { status: 200, body: { ok: true } }
  }

  /** A test notification, at most once a minute. */
  async test(body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
    const s = this.auth(body)
    if (!s) return { status: 401, body: { error: 'unknown subscription' } }
    const now = this.now()
    if (s.lastTest && now - s.lastTest < PUSH.testEveryMs) return { status: 429, body: { error: 'one test a minute' } }
    s.lastTest = now
    const title = text(body?.title, 120) || 'ARCDEX', msg = text(body?.body, 160)
    const r = await this.deliver(s, { title, body: msg, url: '/', tag: 'test', at: now }, now, now)
    return { status: r.ok ? 200 : 502, body: r }
  }

  /** Each trade the engine streams: the coin's price and activity alerts. */
  onTrade(t: Trade) {
    const list = this.arcIndex.get(t.token.toLowerCase())
    if (!list?.length) return
    const detected = this.now()
    for (const { sub, alert } of list) {
      const s = this.subs.get(sub)
      const a = s?.alerts.find(x => x.id === alert)
      if (!s || !a) continue
      if (a.kind === 'price') {
        if (a.firedAt || t.priceUsd === null || !priceMet(a, t.priceUsd)) continue
        a.firedAt = detected
        void this.fire(s, a, { title: a.title, body: a.body }, t.timestamp, detected)
      } else {
        const usd = t.usdValue ?? 0
        const side = t.side === 'BUY' ? 'buy' : t.side === 'SELL' ? 'sell' : null
        if (usd < a.minUsd || (a.side !== 'any' && a.side !== side)) continue
        if (a.lastAt && detected - a.lastAt < PUSH.activityCooldownMs) continue
        a.lastAt = detected
        const fill = (s: string) => s.replace(/\{usd\}/g, fmtUsd(usd)).replace(/\{side\}/g, side === 'sell' ? a.sellWord : a.buyWord)
        void this.fire(s, a, { title: fill(a.title), body: fill(a.body) }, t.timestamp, detected)
      }
    }
  }

  /** Whether any alert follows a wallet tracker topic: the tracker then keeps and hands over that wallet's trades. */
  wantsWallet(topic: string): boolean { return this.walletIndex.has(topic) }

  /** A trade by a followed wallet, from the wallet tracker: each wallet alert on it, at most every 10 seconds. */
  onWalletTrade(d: WalletTradeWire) {
    const list = this.walletIndex.get(tradeTopic(d.c, d.w))
    if (!list?.length) return
    const detected = this.now()
    const side = d.side === 'B' ? 'buy' : 'sell'
    for (const { sub, alert } of list) {
      const s = this.subs.get(sub)
      const a = s?.alerts.find(x => x.id === alert)
      if (!s || !a || a.kind !== 'wallet') continue
      if (d.u < a.minUsd || (a.side !== 'any' && a.side !== side)) continue
      if (a.lastAt && detected - a.lastAt < PUSH.walletCooldownMs) continue
      a.lastAt = detected
      const fill = (x: string) => x.replace(/\{usd\}/g, fmtUsd(d.u)).replace(/\{side\}/g, side === 'sell' ? a.sellWord : a.buyWord)
        .replace(/\{coin\}/g, (d.s || short(d.t)).slice(0, 24)).replace(/\{chain\}/g, CHAIN_NAME[d.c] ?? d.c)
      void this.fire(s, a, { title: fill(a.title), body: fill(a.body) }, d.ts, detected)
    }
  }

  /** Hyperliquid's mids, every two seconds while any alert waits on them. */
  async tickHl() {
    if (this.hlBusy || !this.hlDexes.size) return
    this.hlBusy = true
    try {
      for (const dex of [...this.hlDexes]) {
        const read = this.now()
        const mids = await this.o.hlMids(dex).catch(e => { log.debug('push: hyperliquid mids failed', { error: errMsg(e) }); return null })
        if (!mids) continue
        const detected = this.now()
        for (const s of this.subs.values()) for (const a of s.alerts) {
          if (a.kind !== 'price' || a.venue !== 'hl' || a.firedAt || (a.market.includes(':') ? a.market.split(':')[0] : '') !== dex) continue
          const px = mids[a.market]
          if (!(px > 0) || !priceMet(a, px)) continue
          a.firedAt = detected
          void this.fire(s, a, { title: a.title, body: a.body }, read, detected)
        }
      }
    } finally { this.hlBusy = false }
  }

  private async fire(s: PushSubRow, a: ServerAlert, words: { title: string; body: string }, triggeredAt: number, detectedAt: number) {
    metrics.inc('push_fired')
    if (a.kind === 'price') this.reindex()
    await this.deliver(s, { ...words, url: a.url, tag: a.id, at: detectedAt }, triggeredAt, detectedAt)
    // Kept (what fired, when) unless the push service said the browser is gone and it was dropped.
    if (this.subs.get(s.id) === s) await this.o.store.putPushSub(s).catch(e => log.warn('push: alert state not saved', { error: errMsg(e) }))
  }

  private async deliver(s: PushSubRow, payload: { title: string; body: string; url: string; tag: string; at: number }, triggeredAt: number, detectedAt: number): Promise<PushResult> {
    let r: PushResult
    try {
      r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, this.o.keys, this.o.subject, { fetcher: this.o.fetcher, topic: payload.tag })
      // A push service that asks to wait a moment gets one retry, if it still lands within the 10 seconds.
      const wait = !r.ok && r.status === 429 ? r.retryAfterMs ?? 1_000 : null
      if (wait !== null && wait <= 5_000) {
        await new Promise(res => setTimeout(res, wait))
        r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, this.o.keys, this.o.subject, { fetcher: this.o.fetcher, topic: payload.tag })
      }
    } catch (e) {
      r = { ok: false, status: 0, gone: false, retryAfterMs: null }
      log.warn('push: not sent', { error: errMsg(e) })
    }
    const at = this.now()
    this.deliveries.push({ at, sinceTriggerMs: Math.max(0, at - triggeredAt), detectMs: Math.max(0, detectedAt - triggeredAt), ok: r.ok, status: r.status })
    if (this.deliveries.length > 500) this.deliveries.splice(0, this.deliveries.length - 500)
    if (r.ok) {
      this.counts.sent++; metrics.inc('push_sent')
      s.fails = 0; s.lastOk = at
    } else if (r.gone) {
      this.counts.gone++; metrics.inc('push_gone')
      this.subs.delete(s.id); await this.o.store.deletePushSub(s.id).catch(() => {}); this.reindex()
    } else {
      this.counts.failed++; metrics.inc('push_failed')
      if (++s.fails >= PUSH.maxFails) { this.subs.delete(s.id); await this.o.store.deletePushSub(s.id).catch(() => {}); this.reindex() }
    }
    return r
  }

  /** What anyone may see: how many, and how fast (no subscription or endpoint is ever shown). */
  stats() {
    const ok = this.deliveries.filter(d => d.ok).map(d => d.sinceTriggerMs).sort((a, b) => a - b)
    const q = (p: number) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor(p * ok.length))] : null)
    let alerts = 0, waiting = 0
    for (const s of this.subs.values()) for (const a of s.alerts) { alerts++; if (!(a.kind === 'price' && a.firedAt)) waiting++ }
    return {
      enabled: true, subscriptions: this.subs.size, alerts, waiting, ...this.counts,
      delivery: { n: ok.length, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: ok.length ? ok[ok.length - 1] : null, withinShare: ok.length ? ok.filter(v => v <= PUSH.withinMs).length / ok.length : null },
    }
  }
}
