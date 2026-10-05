// The site's read functions, served by the market engine (2026-10-02). Vercel
// paused arcdex.online for CPU use over the Hobby plan's fair-use limit
// (fluidCpuDuration): every page view ran these functions on Vercel. The same
// code (api/*.ts) now runs here, on Railway, and the browser calls the engine
// first (src/arcdex/api/siteFetch.ts), Vercel only when the engine can't be
// reached.
//
//   /api/argus      the market list (GeckoTerminal, every Arc launchpad)
//   /api/gecko      the GeckoTerminal proxy (coin pages, the Terminal)
//   /api/holders    exact holder counts from Transfer logs
//   /api/launchpad  the ARCDEX launchpad's index (and ?of=curves: Mercuri and SolonPad)
//   /api/radar      the RadarDex proxy
//   /api/dex        the DexScreener proxy
//
// What Vercel gave these for free, done here:
//   CDN caching    each response kept for its s-maxage, served stale for its
//                  stale-while-revalidate while one request refreshes it, and
//                  identical requests in flight share one answer
//   last good copies  `arcdex_kv` in the engine's own Postgres (setKvStore),
//                  not Supabase's, so no Supabase key is needed on Railway
//   the holder index  arcdex_holder_scans / arcdex_holder_balances and their
//                  apply function, in the engine's Postgres
//   rate limits    GeckoTerminal's free API allows ~30 calls a minute per IP,
//                  and every visitor's calls now leave from this one: they are
//                  metered (SITE_GT_PER_MIN, 25 by default); over the budget a
//                  call answers 429 and the functions fall back to their last
//                  good copies, the browser to GeckoTerminal from its own IP
//
// The write functions too (2026-10-03, when the site moved to Netlify, which serves only its files):
//   /api/session    sign in with a wallet (ARCDEX_SESSION_SECRET)
//   /api/social     profiles, follows, theses, likes, clans, transfer notes (Supabase's secret key)
//   /api/upload     coin logos into Supabase Storage (Supabase's secret key)
//   /api/index-trades  the router trade indexer, after a visitor's own trade (every router: v1, the swap router in
//                      force and the curve router, whose addresses are built in, not read from the site's settings)
// POSTs pass straight through with their headers and body, never cached. Without their keys on Railway they answer
// 503, as they did on Vercel without them, and the site shows its empty states.
//
// The trade indexer (api/index-trades.ts) writes to Supabase: it runs here when
// the engine has the Supabase secret key, else the engine asks the site's copy
// once a minute (SITE_INDEX_URL), instead of every open page every 30 seconds.

import { SQL } from 'bun'
import { setGtFetch, type FetchLike } from '../../../api/_geckoterminal'
import { adminReady, setKvStore, type KvStore } from '../../../api/_supabaseAdmin'
import { holdersHandler, supabaseHolders, type HolderStore, type ScanRow } from '../../../api/holders'
import argus from '../../../api/argus'
import dex from '../../../api/dex'
import gecko from '../../../api/gecko'
import indexTrades from '../../../api/index-trades'
import launchpad from '../../../api/launchpad'
import radar from '../../../api/radar'
import rhmarket from '../../../api/rhmarket'
import solmarket from '../../../api/solmarket'
import bscmarket from '../../../api/bscmarket'
import session from '../../../api/session'
import social from '../../../api/social'
import upload from '../../../api/upload'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'

type Ctx = { waitUntil: (p: Promise<unknown>) => void }
type Handler = (req: Request, ctx: Ctx) => Promise<Response> | Response

// ── storage ──────────────────────────────────────────────────────────────

export const SITE_SCHEMA = `
create table if not exists arcdex_kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists arcdex_holder_scans (
  token text primary key, from_block bigint not null, scanned_to bigint not null, holders integer not null default 0, updated_at timestamptz not null default now()
);
create table if not exists arcdex_holder_balances (token text not null, holder text not null, balance numeric(78, 0) not null, primary key (token, holder));
create index if not exists arcdex_holder_balances_top on arcdex_holder_balances (token, balance desc);
create or replace function arcdex_apply_holder_deltas(p_token text, p_from_block bigint, p_expected bigint, p_to bigint, p_deltas jsonb)
returns integer language plpgsql as $fn$
declare cur bigint; n integer;
begin
  if p_to < p_expected then raise exception 'p_to before p_expected'; end if;
  insert into arcdex_holder_scans (token, from_block, scanned_to) values (p_token, p_from_block, p_from_block - 1) on conflict (token) do nothing;
  select scanned_to into cur from arcdex_holder_scans where token = p_token for update;
  if cur <> p_expected then return -1; end if;
  insert into arcdex_holder_balances as b (token, holder, balance)
    select p_token, d.key, d.value::numeric from jsonb_each_text(coalesce(p_deltas, '{}'::jsonb)) d where d.value::numeric <> 0
  on conflict (token, holder) do update set balance = b.balance + excluded.balance;
  delete from arcdex_holder_balances where token = p_token and balance <= 0;
  select count(*) into n from arcdex_holder_balances where token = p_token;
  update arcdex_holder_scans set scanned_to = p_to, holders = n, updated_at = now() where token = p_token;
  return n;
end $fn$;
`

/** Last good copies: memory first, the engine's Postgres behind it (kept across restarts). */
export class SiteKv implements KvStore {
  private mem = new Map<string, { value: unknown; updatedAt: number }>()
  constructor(private sql: SQL | null, private ready: Promise<void> = Promise.resolve(), private cap = 5_000) {}
  async get(key: string) {
    const m = this.mem.get(key)
    if (m || !this.sql) return m ?? null
    await this.ready
    const rows = await this.sql`select value, updated_at from arcdex_kv where key = ${key}` as { value: unknown; updated_at: Date }[]
    if (!rows.length) return null
    const v = { value: typeof rows[0].value === 'string' ? JSON.parse(rows[0].value as string) : rows[0].value, updatedAt: new Date(rows[0].updated_at).getTime() }
    this.remember(key, v)
    return v
  }
  async set(key: string, value: unknown) {
    const v = { value, updatedAt: Date.now() }
    this.remember(key, v)
    if (!this.sql) return
    await this.ready
    await this.sql`insert into arcdex_kv (key, value, updated_at) values (${key}, ${JSON.stringify(value)}::jsonb, ${new Date(v.updatedAt)})
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`
  }
  private remember(key: string, v: { value: unknown; updatedAt: number }) {
    this.mem.delete(key); this.mem.set(key, v)
    if (this.mem.size > this.cap) { const oldest = this.mem.keys().next().value; if (oldest !== undefined) this.mem.delete(oldest) }
  }
}

/** The holder index in the engine's Postgres. */
export function pgHolders(sql: SQL, ready: Promise<void>): HolderStore {
  return {
    ready: () => true,
    async readScan(token) {
      await ready
      const r = await sql`select token, from_block, scanned_to, holders from arcdex_holder_scans where token = ${token}` as { token: string; from_block: number | string; scanned_to: number | string; holders: number }[]
      return r[0] ? { token: r[0].token, from_block: Number(r[0].from_block), scanned_to: Number(r[0].scanned_to), holders: Number(r[0].holders) } : null
    },
    async applyDeltas(token, fromBlock, expected, to, deltas) {
      await ready
      const r = await sql`select arcdex_apply_holder_deltas(${token}, ${fromBlock}, ${expected}, ${to}, ${JSON.stringify(deltas)}::jsonb) as n` as { n: number }[]
      return Number(r[0]?.n ?? -1)
    },
    async top(token, limit) {
      await ready
      return await sql`select holder, balance::text as balance from arcdex_holder_balances where token = ${token} order by balance desc limit ${limit}` as { holder: string; balance: string }[]
    },
  }
}

/** The holder index in memory (no database: development and tests), with the same rules as the SQL function. */
export function memoryHolders(): HolderStore {
  const scans = new Map<string, ScanRow>()
  const balances = new Map<string, Map<string, bigint>>()
  return {
    ready: () => true,
    async readScan(token) { const s = scans.get(token); return s ? { ...s } : null },
    async applyDeltas(token, fromBlock, expected, to, deltas) {
      if (to < expected) throw new Error('to before expected')
      if (!scans.has(token)) scans.set(token, { token, from_block: fromBlock, scanned_to: fromBlock - 1, holders: 0 })
      const s = scans.get(token)!
      if (s.scanned_to !== expected) return -1
      const b = balances.get(token) ?? new Map<string, bigint>()
      for (const [holder, v] of Object.entries(deltas)) { const next = (b.get(holder) ?? 0n) + BigInt(v); if (next > 0n) b.set(holder, next); else b.delete(holder) }
      balances.set(token, b)
      s.scanned_to = to; s.holders = b.size
      return b.size
    },
    async top(token, limit) {
      return [...(balances.get(token) ?? new Map<string, bigint>())].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).slice(0, limit).map(([holder, v]) => ({ holder, balance: v.toString() }))
    },
  }
}

// ── GeckoTerminal metering ───────────────────────────────────────────────

/** A token bucket: `perMin` calls a minute, waiting up to `waitMs` for a slot, else a 429 (the callers' fallbacks take over). */
export function meteredFetch(perMin: number, waitMs = 1_500, inner: FetchLike = (i, n) => fetch(i, n), now = () => Date.now()): FetchLike {
  let tokens = perMin, at = now()
  const refill = () => { const t = now(); tokens = Math.min(perMin, tokens + ((t - at) / 60_000) * perMin); at = t }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const until = now() + waitMs
    for (;;) {
      refill()
      if (tokens >= 1) { tokens -= 1; metrics.inc('site_gt_calls'); return inner(input, init) }
      if (now() >= until) { metrics.inc('site_gt_metered'); return new Response(JSON.stringify({ error: 'metered: over this engine\'s GeckoTerminal budget' }), { status: 429, headers: { 'Content-Type': 'application/json' } }) }
      await new Promise(r => setTimeout(r, Math.min(250, Math.max(10, until - now()))))
    }
  }) as FetchLike
}

// ── the CDN's part: caching, stale-while-revalidate, shared requests ──────

interface Cached { status: number; body: string; headers: [string, string][]; at: number; fresh: number; stale: number }

const cacheTimes = (cc: string | null): { fresh: number; stale: number } | null => {
  if (!cc || /no-store|private/.test(cc)) return null
  const n = (k: string) => { const m = new RegExp(`${k}=(\\d+)`).exec(cc); return m ? Number(m[1]) * 1_000 : 0 }
  const fresh = n('s-maxage') || n('max-age')
  return fresh > 0 ? { fresh, stale: n('stale-while-revalidate') } : null
}

export class ResponseCache {
  private entries = new Map<string, Cached>()
  private inflight = new Map<string, Promise<Cached>>()
  constructor(private cap = 3_000, private now = () => Date.now()) {}

  /** The cached answer for `key`, or `make`'s; one `make` at a time per key. */
  async get(key: string, make: () => Promise<Response>): Promise<{ res: Cached; from: 'fresh' | 'stale' | 'miss' | 'shared' }> {
    const c = this.entries.get(key)
    const t = this.now()
    if (c && t - c.at < c.fresh) return { res: c, from: 'fresh' }
    if (c && t - c.at < c.fresh + c.stale) { void this.refresh(key, make).catch(() => {}); return { res: c, from: 'stale' } }
    const had = this.inflight.get(key)
    if (had) return { res: await had, from: 'shared' }
    return { res: await this.refresh(key, make), from: 'miss' }
  }

  private refresh(key: string, make: () => Promise<Response>): Promise<Cached> {
    const had = this.inflight.get(key)
    if (had) return had
    const p = (async () => {
      const r = await make()
      const body = await r.text()
      const times = r.status === 200 ? cacheTimes(r.headers.get('cache-control')) : null
      const c: Cached = { status: r.status, body, headers: [...r.headers.entries()], at: this.now(), fresh: times?.fresh ?? 0, stale: times?.stale ?? 0 }
      if (times) {
        this.entries.delete(key); this.entries.set(key, c)
        if (this.entries.size > this.cap) { const oldest = this.entries.keys().next().value; if (oldest !== undefined) this.entries.delete(oldest) }
      }
      return c
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  get size() { return this.entries.size }
}

// ── the API ──────────────────────────────────────────────────────────────

export interface SiteApi { handle(req: Request, url: URL): Promise<Response>; names: string[] }

/** Functions that write (or act): their requests pass through as they came, and their answers are never cached. */
const WRITES = new Set(['session', 'social', 'upload', 'index-trades'])

export function createSiteApi(o: { databaseUrl: string | null; gtPerMin?: number; handlers?: Record<string, Handler>; holders?: HolderStore; indexUrl?: string | null; indexEveryMs?: number; warm?: boolean; hotTokens?: () => { token: string; createdSec?: number }[]; holdersEveryMs?: number }): SiteApi {
  let sql: SQL | null = null
  let ready: Promise<void> = Promise.resolve()
  if (o.databaseUrl) {
    sql = new SQL(o.databaseUrl, { max: 3, idleTimeout: 30, connectionTimeout: 15 })
    ready = sql.unsafe(SITE_SCHEMA).then(() => { log.info('site api: tables ready') }, e => { log.error('site api: schema failed', { error: errMsg(e) }) })
  }
  setKvStore(new SiteKv(sql, ready))
  setGtFetch(meteredFetch(o.gtPerMin ?? 25))
  // The holder index lives where the site reads it: Supabase, whenever the engine has its secret key (2026-10-03; the
  // Terminal and coin pages read arcdex_holder_scans and arcdex_holder_balances from there directly). Without the key,
  // the engine's own Postgres.
  const holders = o.holders ?? (adminReady ? supabaseHolders : sql ? pgHolders(sql, ready) : memoryHolders())
  const handlers: Record<string, Handler> = o.handlers ?? {
    argus: (r, c) => argus(r, c), gecko: (r, c) => gecko(r, c), launchpad: (r, c) => launchpad(r, c),
    radar: r => radar(r), dex: r => dex(r), holders: holdersHandler(holders), rhmarket: (r, c) => rhmarket(r, c), solmarket: (r, c) => solmarket(r, c), bscmarket: (r, c) => bscmarket(r, c),
    session: r => session(r), social: r => social(r), upload: r => upload(r), 'index-trades': () => indexTrades(),
  }
  const cache = new ResponseCache()
  const pending = new Set<Promise<unknown>>()
  const ctx: Ctx = { waitUntil: p => { pending.add(p); void p.catch(e => log.warn('site api: background work failed', { error: errMsg(e) })).finally(() => pending.delete(p)) } }

  // The trade indexer: here with the Supabase key, else the site's copy, once a minute either way.
  if (o.indexEveryMs !== 0) {
    const every = o.indexEveryMs ?? 60_000
    const url = o.indexUrl === undefined ? 'https://arcdex.online/api/index-trades' : o.indexUrl
    const run = async () => {
      try {
        if (adminReady) await indexTrades()
        else if (url) await fetch(url, { signal: AbortSignal.timeout(25_000) })
        metrics.inc('site_index_runs')
      } catch (e) { metrics.inc('site_index_errors'); log.debug('site api: trade indexer', { error: errMsg(e) }) }
    }
    setInterval(() => void run(), every)
  }

  // Holder counts for what's trading now (2026-10-03): the 30 most active coins are brought up to date every minute, so
  // their counts are right in the Terminal before anyone opens their page. One coin at a time; a round still running
  // when the next is due is left to finish.
  if (o.hotTokens && o.holdersEveryMs !== 0) {
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        for (const { token, createdSec } of o.hotTokens!().slice(0, 30)) {
          const q = new URLSearchParams({ token })
          if (createdSec) q.set('created', String(createdSec))
          try { await handlers.holders(new Request(`http://engine/api/holders?${q}`), ctx); metrics.inc('site_holders_refreshed') }
          catch (e) { metrics.inc('site_holders_refresh_errors'); log.debug('site api: holder refresh', { token, error: errMsg(e) }) }
        }
      } finally { busy = false }
    }
    setInterval(() => void refresh(), o.holdersEveryMs ?? 60_000)
  }

  // Robinhood Chain's market list (api/rhmarket.ts) reads two of its GeckoTerminal calls whenever its stored copy is
  // stale; asked here every 40 seconds, so it stays whole with nobody looking (until 2026-10-04 only visitors asked, and
  // a quiet spell let stock tokens and whole launchpads age out of it).
  if (o.warm !== false && handlers.rhmarket) {
    const rh = handlers.rhmarket
    setInterval(() => { Promise.resolve().then(() => rh(new Request('http://engine/api/rhmarket'), ctx)).catch(e => log.debug('site api: rhmarket', { error: errMsg(e) })) }, 40_000)
  }
  // Solana's (api/solmarket.ts, 2026-10-04): the same, plus each coin's launch curve and mint read from the chain.
  if (o.warm !== false && handlers.solmarket) {
    const sol = handlers.solmarket
    setInterval(() => { Promise.resolve().then(() => sol(new Request('http://engine/api/solmarket'), ctx)).catch(e => log.debug('site api: solmarket', { error: errMsg(e) })) }, 40_000)
  }
  // BNB Chain's (api/bscmarket.ts, 2026-10-05): four.meme's coins, with its own contract's word on each.
  if (o.warm !== false && handlers.bscmarket) {
    const b = handlers.bscmarket
    setInterval(() => { Promise.resolve().then(() => b(new Request('http://engine/api/bscmarket'), ctx)).catch(e => log.debug('site api: bscmarket', { error: errMsg(e) })) }, 40_000)
  }

  // Indexes that build in slices (the launchpad's, the curves'): kept going from the start, so the first visitors after a
  // deploy don't each wait on a slice (their state was in Supabase; here it starts in the engine's own database).
  if (o.warm !== false) {
    const started = Date.now()
    const warm = async (name: string, path: string) => {
      const h = handlers[name]
      if (!h) return
      for (let i = 0; Date.now() - started < 30 * 60_000; i++) {
        try {
          const r = await h(new Request(`http://engine${path}`), ctx)
          const body = await r.json().catch(() => null) as { complete?: boolean } | null
          if (r.status === 200 && body?.complete) { log.info('site api: index warm', { path, rounds: i + 1, s: Math.round((Date.now() - started) / 1000) }); return }
        } catch (e) { log.debug('site api: warm-up', { path, error: errMsg(e) }) }
        await new Promise(r => setTimeout(r, 5_000))
      }
    }
    void warm('launchpad', '/api/launchpad')
    void warm('launchpad', '/api/launchpad?of=curves')
  }

  return {
    names: Object.keys(handlers),
    async handle(req, url) {
      const name = url.pathname.slice('/api/'.length)
      const h = handlers[name]
      if (!h) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      // Writes: the request as it came (headers, body), never cached.
      if (WRITES.has(name)) {
        try {
          const res = await h(req, ctx)
          metrics.inc(`site_${name}_write`)
          const headers = new Headers(res.headers)
          headers.set('Access-Control-Allow-Origin', '*')
          headers.set('X-Arcdex-Served-By', 'engine')
          headers.set('Access-Control-Expose-Headers', 'X-Arcdex-Served-By')
          return new Response(res.body, { status: res.status, headers })
        } catch (e) {
          metrics.inc(`site_${name}_errors`)
          log.warn('site api error', { name, error: errMsg(e) })
          return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Arcdex-Served-By': 'engine' } })
        }
      }
      if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
      const params = new URLSearchParams(url.search); params.sort()
      const key = `${name}?${params}`
      const t0 = Date.now()
      try {
        const { res, from } = await cache.get(key, async () => await h(new Request(`http://engine${url.pathname}?${params}`), ctx))
        metrics.inc(`site_${name}_${from}`)
        metrics.latency(`site_${name}_ms`, Date.now() - t0)
        const headers = new Headers(res.headers)
        // Public data, as Vercel served it; the CDN's own caching is done above.
        headers.set('Access-Control-Allow-Origin', '*')
        headers.set('X-Arcdex-Served-By', 'engine')
        headers.set('X-Arcdex-Cache', from)
        headers.set('Access-Control-Expose-Headers', 'X-Arcdex-Served-By, X-Arcdex-Cache, X-Arcdex-Age, X-Arcdex-Upstream')
        return new Response(res.body, { status: res.status, headers })
      } catch (e) {
        metrics.inc(`site_${name}_errors`)
        log.warn('site api error', { name, error: errMsg(e) })
        return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
      }
    },
  }
}
