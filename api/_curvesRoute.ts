// Every Mercuri and SolonPad coin worth a row in the Terminal — served by
// /api/launchpad?of=curves (a route of that function rather than a function
// of its own, to keep the deployment's function count where it is). Each
// coin on its launchpad's bonding curve or graduated, with its price, market
// cap, the USDC in its curve, 24h volume, buys and sells, and how far it is
// to graduation. Each server instance keeps the index (api/_curveIndex.ts)
// in memory and brings it up to date in the background once it's 30s old;
// Supabase (`arcdex_kv`) keeps the latest rows, so any instance answers at
// once, and the whole index, so a new instance picks up where the last one
// left off (read once per instance, not per request). Responses are
// CDN-cached. (The leading underscore keeps Vercel from deploying this file
// as its own function.)

import { json, kvGet, kvReady, kvSet } from './_supabaseAdmin'
import { ARCHIVE_RPCS, RECENT_RPC, headBlock, rpcBatch, scanLogs, type RawLog } from './_arcLogs'
import { gtFetch } from './_geckoterminal'
import { coinImage, emptyState, listRows, updateIndex, type CurveMarketRow, type GtTokens, type IndexIO, type IndexState, type RpcCallSpec } from './_curveIndex'

/** The rows as served (small: read by any instance that has no index in memory). */
const ROWS = 'curves:rows:v1'
/** The whole index (read once per instance). */
const STATE = 'curves:state:v1'
const LOCK = 'curves:building'
/** Brought up to date once this old. */
const FRESH_MS = 30_000
/** The whole index is saved at most this often by one instance (the rows every time). */
const SAVE_STATE_MS = 60_000
/** Edge functions must answer within 25s; a build is cut to this. */
const BUDGET_MS = 12_000

export interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

interface Snapshot { updatedAt: number; head: number; complete: boolean; indexed: number; coins: CurveMarketRow[] }

// Edge instances are reused between requests: the index lives here.
let mem: IndexState | null = null
let savedAt = 0
let building = false

/** One batch of calls, from whichever endpoint takes it; a batch an
 * endpoint refuses (too large, throttled) is retried in halves. */
async function batch(calls: RpcCallSpec[]): Promise<(string | null)[]> {
  for (const url of [RECENT_RPC, ARCHIVE_RPCS[0]]) {
    try { return await rpcBatch<string>(url, calls) } catch { /* next endpoint */ }
  }
  if (calls.length <= 8) throw new Error('RPC batch refused')
  const half = Math.ceil(calls.length / 2)
  return [...await batch(calls.slice(0, half)), ...await batch(calls.slice(half))]
}

const io: IndexIO = {
  head: headBlock,
  async scan(filter, from, to, head, deadline) {
    const r = await scanLogs<RawLog[]>(filter, from, to, { head, deadline, reduce: l => l, concurrency: 5 })
    return { logs: r.parts.flat(), scannedTo: r.scannedTo }
  },
  batch,
  async gecko(path) {
    const res = await gtFetch(path, { signal: AbortSignal.timeout(5_000) })
    return res.ok ? (await res.json()) as GtTokens : null
  },
  image: uri => coinImage(uri),
}

const validState = (s: IndexState | null | undefined): s is IndexState => !!s && Array.isArray(s.coins) && Number.isFinite(s.launchesTo) && Number.isFinite(s.tradesTo)
const validRows = (s: Snapshot | null | undefined): s is Snapshot => !!s && Array.isArray(s.coins) && Number.isFinite(s.updatedAt)

function snapshotOf(s: IndexState): Snapshot {
  return {
    updatedAt: s.updatedAt,
    head: s.head,
    complete: s.launchesTo >= s.head && (s.instantTo ?? 0) >= s.head && s.tradesTo >= s.head - 50,
    indexed: s.coins.length,
    coins: listRows(s.coins, Math.floor(Date.now() / 1000)),
  }
}

/** Brings the index up to date: this instance's, else the saved one, else a new one. */
async function build(): Promise<Snapshot> {
  let s = mem
  if (!s) {
    const saved = await kvGet<IndexState>(STATE)
    s = validState(saved?.value) ? saved.value : emptyState(await headBlock())
  }
  // A copy: requests keep reading the last complete one meanwhile.
  const next = await updateIndex(structuredClone(s), io, BUDGET_MS)
  mem = next
  const snap = snapshotOf(next)
  const saves = [kvSet(ROWS, snap)]
  if (Date.now() - savedAt >= SAVE_STATE_MS || !snap.complete) { savedAt = Date.now(); saves.push(kvSet(STATE, next)) }
  await Promise.all(saves)
  return snap
}

function respond(s: Snapshot): Response {
  return json(200, { ...s, updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null },
    s.complete ? 'public, s-maxage=30, stale-while-revalidate=600' : 'no-store')
}

/** Claims the one build at a time (Supabase's lock across instances, a flag within one). */
async function takeLock(): Promise<boolean> {
  if (building) return false
  const lock = kvReady() ? await kvGet<number>(LOCK) : null
  if (lock && lock.value && Date.now() - lock.value < 30_000) return false
  building = true
  await kvSet(LOCK, Date.now())
  return true
}
async function releaseLock() {
  building = false
  await kvSet(LOCK, 0)
}

const EMPTY: Snapshot = { updatedAt: 0, head: 0, complete: false, indexed: 0, coins: [] }
const fresh = (s: { updatedAt: number } | null) => !!s && Date.now() - s.updatedAt <= FRESH_MS

/** GET /api/launchpad?of=curves */
export async function curvesHandler(ctx?: Ctx): Promise<Response> {
  try {
    if (mem && fresh(mem)) return respond(snapshotOf(mem))
    // No fresh index here: the latest rows any instance saved, or this instance's own.
    const saved = await kvGet<Snapshot>(ROWS)
    const kept = validRows(saved?.value) ? saved.value : null
    const snap = kept && (!mem || kept.updatedAt >= mem.updatedAt) ? kept : mem ? snapshotOf(mem) : null
    if (snap && fresh(snap)) return respond(snap)
    if (!ctx?.waitUntil) return respond(await build())
    // Out of date, or never built: answer with what there is now and update
    // in the background (a first build reads the launch history in steps).
    const res = respond(snap ?? EMPTY)
    if (await takeLock()) {
      ctx.waitUntil((async () => {
        try { await build() } catch { /* the next request tries again */ } finally { await releaseLock() }
      })())
    }
    return res
  } catch (e) {
    return json(502, { error: `Curve index unavailable: ${(e instanceof Error ? e.message : 'error').slice(0, 120)}` })
  }
}
