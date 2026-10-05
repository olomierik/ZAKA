// BNB Chain's market list (2026-10-05), kept on the engine (served at /api/bscmarket), as Solana's is (api/solmarket.ts):
// four.meme's coins, read a little at a time on the engine's GeckoTerminal budget. Whenever the stored copy is over 40
// seconds old, the next two of its calls (`bscListPaths`) refresh their pools; the engine asks every 40 seconds itself
// (site/siteApi.ts). A pool not seen again for 6 hours drops out.
//
// four.meme's own contract adds what GeckoTerminal doesn't say (api/_bscCore.ts `readFour`): whether four.meme launched
// a coin at all (a 4444 address on PancakeSwap is listed only once it says so), its quote, how far along its curve it
// is, and whether it graduated. Read again after a minute while on the curve; never once graduated.

import { gtFetch } from './_geckoterminal'
import { kvGet, kvSet } from './_supabaseAdmin'
import { bscListPaths, listedBsc, mergeBscCoins, parseBscPools, readFour, BSC_RPC_SERVER, type BscCoin, type FourInfo } from './_bscCore'
import type { GtPools } from './_rhCore'

export const config = { runtime: 'edge' }

interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

type Pool = BscCoin & { seenAt: number }
export interface BscSnapshot {
  updatedAt: number
  pools: Pool[]
  cursor: number
  rounds: number
  /** four.meme's word by coin: null for a coin it didn't launch; when read (re-read after a minute while on the curve). */
  four: Record<string, (FourInfo & { at: number }) | { at: number; none: true }>
}

const SNAPSHOT = 'bsc:market'
const BUILDING = 'bsc:building'
export const BSC_FRESH_MS = 40_000
export const BSC_CALLS_PER_STEP = 2
export const BSC_KEEP_MS = 6 * 3_600_000
const FIRST_BUDGET_MS = 12_000
const CURVE_FRESH_MS = 60_000
const READS_PER_STEP = 450

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

const vouchedBy = (four: BscSnapshot['four']) => (a: string) => { const f = four[a]; return f ? !('none' in f) : undefined }

/** four.meme's word for the coins due: never read, or still on the curve and read over a minute ago. */
export async function readChain(coins: BscCoin[], prev: BscSnapshot['four'], rpcs = BSC_RPC_SERVER, now = Date.now()): Promise<BscSnapshot['four']> {
  const four = { ...prev }
  const due = coins.filter(c => { const f = four[c.address]; return !f || (!('none' in f) && !f.graduated && now - f.at > CURVE_FRESH_MS) })
    .sort((a, b) => (four[a.address]?.at ?? 0) - (four[b.address]?.at ?? 0))
    .slice(0, READS_PER_STEP)
  if (!due.length) return four
  const read = await readFour(due.map(c => c.address), rpcs).catch(() => new Map<string, FourInfo | null>())
  for (const [k, v] of read) four[k] = v ? { ...v, at: now } : { at: now, none: true }
  return four
}

export async function advanceBsc(prev: BscSnapshot | null, calls: number, deadline = Infinity): Promise<BscSnapshot> {
  const paths = bscListPaths()
  const now = Date.now()
  const byPool = new Map((prev?.pools ?? []).filter(p => now - p.seenAt < BSC_KEEP_MS).map(p => [p.pool, p]))
  let cursor = (prev?.cursor ?? 0) % paths.length
  let rounds = prev?.rounds ?? 0
  for (let i = 0; i < calls && Date.now() < deadline; i++) {
    const d = await gt(paths[cursor])
    if (d === 'later') break
    // Only four.meme's coins are kept (PancakeSwap's lists carry every coin).
    if (d !== 'skip') for (const row of parseBscPools(d)) if (row.launchpad) byPool.set(row.pool, { ...row, seenAt: Date.now() })
    cursor = (cursor + 1) % paths.length
    if (cursor === 0) rounds++
  }
  const pools = [...byPool.values()]
  const coins = listedBsc(mergeBscCoins(pools.map(({ seenAt: _s, ...row }) => row)))
  const four = await readChain(coins, prev?.four ?? {})
  const keep = new Set(coins.map(c => c.address))
  return { updatedAt: Date.now(), pools, cursor, rounds, four: Object.fromEntries(Object.entries(four).filter(([k]) => keep.has(k))) }
}

/** The rows to show: one per coin, only the ones four.meme vouches for (or hasn't been asked about yet), with its word. */
export function bscRows(s: BscSnapshot): BscCoin[] {
  return listedBsc(mergeBscCoins(s.pools.map(({ seenAt: _s, ...row }) => row)), vouchedBy(s.four)).map(r => {
    const f = s.four?.[r.address]
    return f && !('none' in f) ? { ...r, four: { quote: f.quote, graduated: f.graduated, progress: f.progress }, graduated: f.graduated, curveProgress: f.graduated ? 100 : f.progress } : r
  })
}

function respond(s: BscSnapshot, cache: string): Response {
  const body = { updatedAt: s.updatedAt, rounds: s.rounds, complete: s.rounds > 0, rows: bscRows(s) }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache },
  })
}

export default async function handler(_req: Request, ctx?: Ctx): Promise<Response> {
  const snap = await kvGet<BscSnapshot>(SNAPSHOT)
  if (snap && snap.value.pools.length) {
    if (snap.age > BSC_FRESH_MS && ctx?.waitUntil) {
      const lock = await kvGet<number>(BUILDING)
      if (!lock || lock.age > 30_000) {
        ctx.waitUntil((async () => {
          await kvSet(BUILDING, Date.now())
          await kvSet(SNAPSHOT, await advanceBsc(snap.value, BSC_CALLS_PER_STEP))
        })())
      }
    }
    return respond(snap.value, snap.value.rounds > 0 ? 'public, s-maxage=20, stale-while-revalidate=600' : 'public, s-maxage=10, stale-while-revalidate=600')
  }
  const first = await advanceBsc(snap?.value ?? null, bscListPaths().length, Date.now() + FIRST_BUDGET_MS)
  if (!first.pools.length) {
    return new Response(JSON.stringify({ error: 'GeckoTerminal unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }
  const save = kvSet(SNAPSHOT, first)
  if (ctx?.waitUntil) ctx.waitUntil(save); else await save
  return respond(first, 'public, s-maxage=10, stale-while-revalidate=600')
}
