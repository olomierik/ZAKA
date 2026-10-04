// Solana's market list, kept on the engine (served at /api/solmarket), as Robinhood Chain's is (api/rhmarket.ts):
// every launchpad's coins at once for every visitor, read a little at a time on the engine's GeckoTerminal budget.
// Whenever the stored copy is over 40 seconds old, the next two of its calls (`solListPaths`, round and round)
// refresh their pools; the engine asks every 40 seconds itself (site/siteApi.ts). A pool not seen again for 6 hours
// drops out.
//
// The chain adds what GeckoTerminal doesn't say (api/_solCore.ts):
//   • each coin's launch curve, read from its main pool account: how far to graduating, and whether it has
//     (GeckoTerminal lists graduated pump.fun coins on pump.fun's venue for good). Read again after a minute while on
//     its curve; never once graduated.
//   • what its mint lets someone do: mint more, freeze holders, and Token-2022 extensions. Read once: an authority
//     renounced can't come back.

import { gtFetch } from './_geckoterminal'
import { kvGet, kvSet } from './_supabaseAdmin'
import { listedSol, mergeSolCoins, parseSolPools, readCurves, readMints, solListPaths, SOL_RPC_SERVER, SOL_CURVE_DEXES, type CurveRead, type MintFlags, type SolCoin } from './_solCore'
import type { GtPools } from './_rhCore'

export const config = { runtime: 'edge' }

interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

type Pool = SolCoin & { seenAt: number }
export interface SolSnapshot {
  updatedAt: number
  pools: Pool[]
  cursor: number
  rounds: number
  /** Curves read, by coin: and when (re-read after a minute while on the curve). */
  curves: Record<string, CurveRead & { at: number }>
  /** Mint flags, by coin (read once). */
  mints: Record<string, MintFlags>
  /** Meteora DBC configs' thresholds, as decimal strings (never change). */
  configs: Record<string, string | null>
}

const SNAPSHOT = 'sol:market'
const BUILDING = 'sol:building'
export const SOL_FRESH_MS = 40_000
export const SOL_CALLS_PER_STEP = 2
export const SOL_KEEP_MS = 6 * 3_600_000
const FIRST_BUDGET_MS = 12_000
/** A curve still trading is read again after this long. */
const CURVE_FRESH_MS = 60_000
/** Chain reads per step: pools and mints in batches of 100 (getMultipleAccounts' limit). */
const CURVES_PER_STEP = 200
const MINTS_PER_STEP = 200

async function gt(path: string): Promise<GtPools | 'later' | 'skip'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await gtFetch(path, { signal: AbortSignal.timeout(8_000) })
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2_000)); continue }
      if (!res.ok) return 'skip'
      return (await res.json()) as GtPools
    } catch { return 'later' }
  }
  return 'later'
}

/** The chain's part: curves due (never read, or read over a minute ago and still trading), mints never read. */
export async function readChain(coins: SolCoin[], prev: Pick<SolSnapshot, 'curves' | 'mints' | 'configs'>, rpcs = SOL_RPC_SERVER, now = Date.now()): Promise<Pick<SolSnapshot, 'curves' | 'mints' | 'configs'>> {
  const curves = { ...prev.curves }, mints = { ...prev.mints }
  const configs = new Map(Object.entries(prev.configs).map(([k, v]) => [k, v === null ? null : BigInt(v)]))
  const due = coins
    .filter(c => SOL_CURVE_DEXES.has(c.dex) && !curves[c.address]?.graduated && (!curves[c.address] || now - curves[c.address].at > CURVE_FRESH_MS))
    .sort((a, b) => (curves[a.address]?.at ?? 0) - (curves[b.address]?.at ?? 0))
    .slice(0, CURVES_PER_STEP)
  if (due.length) {
    const read = await readCurves(due.map(c => ({ address: c.address, pool: c.pool })), rpcs, configs).catch(() => new Map<string, CurveRead>())
    for (const [k, v] of read) curves[k] = { ...v, at: now }
  }
  const unread = coins.filter(c => !mints[c.address]).map(c => c.address).slice(0, MINTS_PER_STEP)
  if (unread.length) {
    const read = await readMints(unread, rpcs).catch(() => new Map<string, MintFlags>())
    for (const [k, v] of read) mints[k] = v
  }
  return { curves, mints, configs: Object.fromEntries([...configs].map(([k, v]) => [k, v === null ? null : v.toString()])) }
}

/** Reads the next `calls` of the round into `prev` (or a fresh list), then the chain's part. */
export async function advanceSol(prev: SolSnapshot | null, calls: number, deadline = Infinity): Promise<SolSnapshot> {
  const paths = solListPaths()
  const now = Date.now()
  const byPool = new Map((prev?.pools ?? []).filter(p => now - p.seenAt < SOL_KEEP_MS).map(p => [p.pool, p]))
  let cursor = (prev?.cursor ?? 0) % paths.length
  let rounds = prev?.rounds ?? 0
  for (let i = 0; i < calls && Date.now() < deadline; i++) {
    const d = await gt(paths[cursor])
    if (d === 'later') break
    if (d !== 'skip') for (const row of parseSolPools(d)) byPool.set(row.pool, { ...row, seenAt: Date.now() })
    cursor = (cursor + 1) % paths.length
    if (cursor === 0) rounds++
  }
  const pools = [...byPool.values()]
  const coins = listedSol(mergeSolCoins(pools.map(({ seenAt: _s, ...row }) => row)))
  const chain = await readChain(coins, { curves: prev?.curves ?? {}, mints: prev?.mints ?? {}, configs: prev?.configs ?? {} })
  // Only what the coins listed still need.
  const keep = new Set(coins.map(c => c.address))
  const pick = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k)))
  return { updatedAt: Date.now(), pools, cursor, rounds, curves: pick(chain.curves), mints: pick(chain.mints), configs: chain.configs }
}

/** The rows to show: one per coin, launchpad coins only, with what the chain said. */
export function solRows(s: SolSnapshot): SolCoin[] {
  return listedSol(mergeSolCoins(s.pools.map(({ seenAt: _s, ...row }) => row))).map(r => {
    const c = s.curves?.[r.address], m = s.mints?.[r.address]
    return {
      ...r,
      ...(c ? { curveProgress: c.graduated ? 100 : c.progress, graduated: c.graduated } : r.dex === 'pumpswap' ? { graduated: true, curveProgress: 100 } : {}),
      ...(m ? { mint: m } : {}),
    }
  })
}

function respond(s: SolSnapshot, cache: string): Response {
  const body = { updatedAt: s.updatedAt, rounds: s.rounds, complete: s.rounds > 0, rows: solRows(s) }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache },
  })
}

export default async function handler(_req: Request, ctx?: Ctx): Promise<Response> {
  const snap = await kvGet<SolSnapshot>(SNAPSHOT)
  if (snap && snap.value.pools.length) {
    if (snap.age > SOL_FRESH_MS && ctx?.waitUntil) {
      const lock = await kvGet<number>(BUILDING)
      if (!lock || lock.age > 30_000) {
        ctx.waitUntil((async () => {
          await kvSet(BUILDING, Date.now())
          await kvSet(SNAPSHOT, await advanceSol(snap.value, SOL_CALLS_PER_STEP))
        })())
      }
    }
    return respond(snap.value, snap.value.rounds > 0 ? 'public, s-maxage=20, stale-while-revalidate=600' : 'public, s-maxage=10, stale-while-revalidate=600')
  }
  const first = await advanceSol(snap?.value ?? null, solListPaths().length, Date.now() + FIRST_BUDGET_MS)
  if (!first.pools.length) {
    return new Response(JSON.stringify({ error: 'GeckoTerminal unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }
  const save = kvSet(SNAPSHOT, first)
  if (ctx?.waitUntil) ctx.waitUntil(save); else await save
  return respond(first, 'public, s-maxage=10, stale-while-revalidate=600')
}
