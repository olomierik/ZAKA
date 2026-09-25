// Argus market list, built server-side from GeckoTerminal and CDN-cached so
// one refresh serves every visitor. The last list is also kept in Supabase
// (v4 `arcdex_kv`), so a visitor never waits on a rebuild: they get the
// stored list at once and a stale one is rebuilt in the background. The
// list logic lives in _argusCore.ts; when there's no stored list and the
// build comes back partial (GeckoTerminal throttles Vercel's shared IPs),
// the browser rebuilds it from its own IP — see argusMarket.ts.

import { gtFetch, gtUpstream } from './_geckoterminal'
import { buildArgusMarket, type ArgusPool, type GtList } from './_argusCore'
import { bondedFlags } from './_argusBonded'
import { kvGet, kvSet } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

// Edge functions must start responding within 25s. Every call shares this
// budget, so a throttled upstream yields a shorter list, never a timeout.
const BUDGET_MS = 17_000

/** Why a call yielded nothing — reported in the response for ops. */
type Failure = { path: string; why: string }

async function gtBudgeted(path: string, deadline: number, failures: Failure[]): Promise<GtList | null> {
  // Back off and retry a 429 once rather than silently dropping that slice.
  let why = 'budget'
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now()
    if (left < 1_000) break
    try {
      const res = await gtFetch(path, { signal: AbortSignal.timeout(Math.min(6_000, left)) })
      if (res.status === 429) { why = '429'; await new Promise(r => setTimeout(r, Math.min(1_500, Math.max(0, deadline - Date.now() - 1_000)))); continue }
      if (!res.ok) { why = String(res.status); break }
      return (await res.json()) as GtList
    } catch (e) {
      why = e instanceof Error ? e.name : 'error'
      break
    }
  }
  failures.push({ path: path.split('&include')[0], why })
  return null
}

interface Ctx { waitUntil?: (p: Promise<unknown>) => void }
interface Snapshot { updatedAt: string; source: string; partial: boolean; failures: Failure[]; pools: (ArgusPool & { seenAt?: number })[] }

const SNAPSHOT = 'argus:market'
const BUILDING = 'argus:building'
/** Rebuild in the background once the stored list is this old. */
const FRESH_MS = 45_000
/** A coin a throttled rebuild missed stays listed this long. */
const KEEP_UNSEEN_MS = 15 * 60_000

async function build(prev: Snapshot | null): Promise<Snapshot | null> {
  const deadline = Date.now() + BUDGET_MS
  const failures: Failure[] = []
  const pools = await buildArgusMarket(path => gtBudgeted(path, deadline, failures))

  // Graduated vs still-bonding, for the Graduated / Bonding lists. Capped
  // at 5s so a slow RPC can never hold up the market list itself.
  try {
    const flags = await Promise.race([
      bondedFlags(pools.map(p => p.token.address)),
      new Promise<Map<string, boolean>>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000)),
    ])
    for (const p of pools) p.bonded = flags.has(p.token.address) ? flags.get(p.token.address)! : null
  } catch { /* flags stay absent this round */ }
  if (pools.length === 0) return null

  // A throttled rebuild comes back shorter: keep what it missed from the
  // previous list for a while instead of dropping those coins.
  const now = Date.now()
  const before = new Map((prev?.pools ?? []).map(p => [p.token.address, p]))
  const fresh = pools.map(p => ({ ...p, seenAt: now, bonded: p.bonded ?? before.get(p.token.address)?.bonded ?? null }))
  const seen = new Set(fresh.map(p => p.token.address))
  const carried = (prev?.pools ?? []).filter(p => !seen.has(p.token.address) && now - (p.seenAt ?? 0) < KEEP_UNSEEN_MS)
  return {
    updatedAt: new Date().toISOString(),
    source: gtUpstream(),
    // Partial only when there was nothing to fill the gaps with.
    partial: failures.length > 0 && !prev,
    failures,
    pools: [...fresh, ...carried],
  }
}

function respond(s: Snapshot, cache: string): Response {
  return new Response(JSON.stringify(s), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache, 'X-Arcdex-Upstream': gtUpstream() },
  })
}

export default async function handler(_req: Request, ctx?: Ctx): Promise<Response> {
  // The last list, from Supabase (~100ms): every visitor gets it at once,
  // and a stale one is rebuilt in the background — nobody waits on
  // GeckoTerminal (10-17s when it's throttling Vercel's IPs).
  const snap = await kvGet<Snapshot>(SNAPSHOT)
  if (snap) {
    if (snap.age > FRESH_MS && ctx?.waitUntil) {
      const lock = await kvGet<number>(BUILDING)
      if (!lock || lock.age > 30_000) {
        ctx.waitUntil((async () => {
          await kvSet(BUILDING, Date.now())
          const next = await build(snap.value)
          if (next) await kvSet(SNAPSHOT, next)
        })())
      }
    }
    return respond(snap.value, 'public, s-maxage=20, stale-while-revalidate=3600')
  }

  // First run (or the v4 table isn't there yet): build it now.
  const next = await build(null)
  if (!next) {
    return new Response(JSON.stringify({ error: 'GeckoTerminal unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }
  const save = kvSet(SNAPSHOT, next)
  if (ctx?.waitUntil) ctx.waitUntil(save); else await save
  // A complete list is fresh for a minute; a partial one for 15s so a later
  // refresh can complete it. Past that, the CDN keeps serving the last copy
  // instantly while it rebuilds in the background.
  return respond(next, next.partial
    ? 'public, s-maxage=15, stale-while-revalidate=3600'
    : 'public, s-maxage=60, stale-while-revalidate=3600')
}
