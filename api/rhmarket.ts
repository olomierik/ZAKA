// Robinhood Chain's market list, kept on the engine (served at /api/rhmarket) so every visitor gets it
// whole at once. Built from the browser alone, it lost most launchpads: GeckoTerminal lets one IP make
// about five calls before answering 429 (measured 2026-10-04), and a list is 17 calls (the busiest pools,
// the stock tokens, then each launchpad's pools), so Bankr's, Clanker's and Clank.trade's came through
// and Pons's, Virtuals', o1's and the rest were dropped.
//
// Here the list is read a little at a time: whenever the stored copy is over 40 seconds old, the next two
// of its calls (in turn, round and round, `rhListPaths`) refresh their pools, so the whole list is re-read
// every few minutes for a few calls a minute of the engine's GeckoTerminal budget. A pool not seen again
// for an hour drops out. Stock-named coins are checked once on the chain (Robinhood's beacon), so an
// impostor isn't listed as a stock.

import { gtFetch } from './_geckoterminal'
import { kvGet, kvSet } from './_supabaseAdmin'
import { BEACON_SLOT, RH_RPC_URL, STOCK_BEACON, listed, mergeCoins, parsePools, rhListPaths, type GtPools, type RhCoin } from './_rhCore'

export const config = { runtime: 'edge' }

interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

type Pool = RhCoin & { seenAt: number }
export interface RhSnapshot {
  updatedAt: number
  /** Every pool read in the last hour, by pool id. */
  pools: Pool[]
  /** The next call of the round (`rhListPaths`). */
  cursor: number
  /** Whole rounds read since the list started. */
  rounds: number
  /** Stock-named coins the chain has answered for: true for one of Robinhood's stock tokens. */
  stocks: Record<string, boolean>
}

const SNAPSHOT = 'rh:market'
const BUILDING = 'rh:building'
/** Read more once the stored copy is this old. */
export const RH_FRESH_MS = 40_000
/** Calls per refresh: about three a minute while anyone looks. */
export const RH_CALLS_PER_STEP = 2
/** A pool not seen again for this long drops out. */
export const RH_KEEP_MS = 60 * 60_000
/** The first list, when there's no stored copy: as many calls as fit in this. */
const FIRST_BUDGET_MS = 12_000

/** A call's pools; 'later' when GeckoTerminal throttled or didn't answer (tried again next time), 'skip'
 * when it answered with an error (left for this round, so one bad call can't hold up the rest). */
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

/** Whether `token` is one of Robinhood's stock tokens: its EIP-1967 beacon slot names Robinhood's beacon. */
async function isStock(token: string): Promise<boolean | null> {
  try {
    const res = await fetch(RH_RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [token, BEACON_SLOT, 'latest'] }),
    })
    const j = await res.json() as { result?: string }
    return typeof j.result === 'string' ? `0x${j.result.slice(-40)}`.toLowerCase() === STOCK_BEACON : null
  } catch { return null }
}

/** Reads the next `calls` of the round into `prev` (or a fresh list) and returns the new snapshot. */
export async function advanceRh(prev: RhSnapshot | null, calls: number, deadline = Infinity): Promise<RhSnapshot> {
  const paths = rhListPaths()
  const now = Date.now()
  const byPool = new Map((prev?.pools ?? []).filter(p => now - p.seenAt < RH_KEEP_MS).map(p => [p.pool, p]))
  let cursor = (prev?.cursor ?? 0) % paths.length
  let rounds = prev?.rounds ?? 0
  for (let i = 0; i < calls && Date.now() < deadline; i++) {
    const d = await gt(paths[cursor])
    // A throttled call is tried again next time rather than skipped.
    if (d === 'later') break
    if (d !== 'skip') for (const row of parsePools(d)) byPool.set(row.pool, { ...row, seenAt: Date.now() })
    cursor = (cursor + 1) % paths.length
    if (cursor === 0) rounds++
  }
  const stocks = { ...(prev?.stocks ?? {}) }
  const ask = [...new Set([...byPool.values()].filter(p => p.stock && !(p.address in stocks)).map(p => p.address))].slice(0, 20)
  const answers = await Promise.all(ask.map(a => isStock(a)))
  ask.forEach((a, i) => { if (answers[i] !== null) stocks[a] = answers[i]! })
  return { updatedAt: Date.now(), pools: [...byPool.values()], cursor, rounds, stocks }
}

/** The rows to show: one per coin, launchpad coins and Robinhood's stock tokens only. */
export function rhRows(s: RhSnapshot): RhCoin[] {
  return listed(mergeCoins(s.pools.map(({ seenAt: _seen, ...row }) => row)), a => s.stocks[a])
}

function respond(s: RhSnapshot, cache: string): Response {
  const body = { updatedAt: s.updatedAt, rounds: s.rounds, complete: s.rounds > 0, rows: rhRows(s) }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache },
  })
}

export default async function handler(_req: Request, ctx?: Ctx): Promise<Response> {
  const snap = await kvGet<RhSnapshot>(SNAPSHOT)
  if (snap && snap.value.pools.length) {
    if (snap.age > RH_FRESH_MS && ctx?.waitUntil) {
      const lock = await kvGet<number>(BUILDING)
      if (!lock || lock.age > 30_000) {
        ctx.waitUntil((async () => {
          await kvSet(BUILDING, Date.now())
          await kvSet(SNAPSHOT, await advanceRh(snap.value, RH_CALLS_PER_STEP))
        })())
      }
    }
    // Until a whole round is in, a short cache, so the rest comes in sooner.
    return respond(snap.value, snap.value.rounds > 0 ? 'public, s-maxage=20, stale-while-revalidate=600' : 'public, s-maxage=10, stale-while-revalidate=600')
  }
  // No stored list yet: as many calls as fit in a few seconds, then the rest a step at a time.
  const first = await advanceRh(snap?.value ?? null, rhListPaths().length, Date.now() + FIRST_BUDGET_MS)
  if (!first.pools.length) {
    return new Response(JSON.stringify({ error: 'GeckoTerminal unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }
  const save = kvSet(SNAPSHOT, first)
  if (ctx?.waitUntil) ctx.waitUntil(save); else await save
  return respond(first, 'public, s-maxage=10, stale-while-revalidate=600')
}
