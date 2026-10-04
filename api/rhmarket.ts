// Robinhood Chain's market list, kept on the engine (served at /api/rhmarket) so every visitor gets it
// whole at once. Built from the browser alone, it lost most launchpads: GeckoTerminal lets one IP make
// about five calls before answering 429 (measured 2026-10-04), and a list is 17 calls (the busiest pools,
// the stock tokens, then each launchpad's pools), so Bankr's, Clanker's and Clank.trade's came through
// and Pons's, Virtuals', o1's and the rest were dropped.
//
// Here the list is read a little at a time: whenever the stored copy is over 40 seconds old, the next two
// of its calls (in turn, round and round, `rhListPaths`) refresh their pools, so the whole list is re-read
// every few minutes for a few calls a minute of the engine's GeckoTerminal budget. The engine asks every 40
// seconds itself (site/siteApi.ts), so it stays fresh with nobody looking. A pool not seen again for 6
// hours drops out. Stock-named coins are checked once on the chain (Robinhood's beacon), so an
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
  /** Pons coins' curves, by token (`ponsCurves`). */
  curves?: Record<string, PonsCurve>
}

/** A Pons coin's curve as the chain last answered: how far to graduating, and whether it has. */
export interface PonsCurve { progress: number; graduated: boolean; at: number }

const SNAPSHOT = 'rh:market'
const BUILDING = 'rh:building'
/** Read more once the stored copy is this old. */
export const RH_FRESH_MS = 40_000
/** Calls per refresh: about three a minute while anyone looks. */
export const RH_CALLS_PER_STEP = 2
/** A pool not seen again for this long drops out (an hour until 2026-10-04: with the list read only while someone
 * looked, a quiet spell let stock tokens and whole launchpads age out). */
export const RH_KEEP_MS = 6 * 3_600_000
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

/** Whether each token is one of Robinhood's stock tokens: its EIP-1967 beacon slot names Robinhood's beacon. One
 * JSON-RPC batch (the public RPC answers many single requests at once with 429); null where it didn't answer. */
async function stockChecks(tokens: string[]): Promise<(boolean | null)[]> {
  if (!tokens.length) return []
  try {
    const res = await fetch(RH_RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6_000),
      body: JSON.stringify(tokens.map((t, id) => ({ jsonrpc: '2.0', id, method: 'eth_getStorageAt', params: [t, BEACON_SLOT, 'latest'] }))),
    })
    const j = await res.json() as { id: number; result?: string }[] | unknown
    if (!Array.isArray(j)) return tokens.map(() => null)
    const by = new Map((j as { id: number; result?: string }[]).map(x => [x.id, x.result]))
    return tokens.map((_, i) => { const r = by.get(i); return typeof r === 'string' ? `0x${r.slice(-40)}`.toLowerCase() === STOCK_BEACON : null })
  } catch { return tokens.map(() => null) }
}

// Pons, the bonding-curve launchpad on Robinhood Chain (2026-10-04, owner: "near-bonding coins: give the correct
// data"). Its coins sit on GeckoTerminal's two curve venues until they graduate to a Uniswap v4 pool ("pons-v2-dex"):
//   pons-dot-family  the active factory answers graduationStatus(token) → (current, threshold, graduated)
//   pons-v2          the pool GeckoTerminal lists is the curve itself: realQuoteReserve(), graduationThreshold(), graduated()
// Progress is Pons's own measure, the ETH raised over the threshold (4.2 ETH for ETH-quoted launches). Checked on
// mainnet 2026-10-04: DELTA and HMM (listed on pons-dot-family) had graduated, HOODNIGHT was at 3.23 of 4.2 ETH.
export const PONS_FACTORY = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb'
const SEL = { graduationStatus: '0x98d652f1', realQuoteReserve: '0x4f1f58fd', graduationThreshold: '0x8b0bc501', graduated: '0xe7c2b772' } as const
/** A curve still trading is read again after this long; a graduated one never. */
export const PONS_FRESH_MS = 60_000
/** Calls per JSON-RPC batch, and batches per refresh: Robinhood's public RPC answers a larger batch of eth_calls
 * with 429 (measured 2026-10-04: 77 refused, 24 fine). A curve is three calls, a factory read one; what doesn't fit is
 * read at the next refresh, 40 seconds later. */
const PONS_BATCH = 24
const PONS_BATCHES = 2

const word = (hex: string, i: number) => BigInt('0x' + (hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'))
export const ponsProgress = (current: bigint, threshold: bigint) =>
  threshold > 0n ? Math.max(0, Math.min(100, Number((current * 10_000n) / threshold) / 100)) : 0

/** Which of the list's coins are Pons coins, and how to read each: the factory (pons-dot-family), or its curve. */
export function ponsTargets(pools: RhCoin[]): Map<string, { via: 'factory' | 'curve'; curve?: string }> {
  const out = new Map<string, { via: 'factory' | 'curve'; curve?: string }>()
  for (const p of pools) {
    if (p.dex === 'pons-v2' && /^0x[0-9a-f]{40}$/.test(p.pool)) out.set(p.address, { via: 'curve', curve: p.pool })
    else if (p.dex === 'pons-dot-family' && !out.has(p.address)) out.set(p.address, { via: 'factory' })
  }
  return out
}

/** Reads the curves due: those never read, and those still trading after `PONS_FRESH_MS`. */
export async function ponsCurves(pools: RhCoin[], prev: Record<string, PonsCurve>, rpc = RH_RPC_URL, now = Date.now()): Promise<Record<string, PonsCurve>> {
  const out: Record<string, PonsCurve> = {}
  const targets = ponsTargets(pools)
  for (const [a, c] of Object.entries(prev)) if (targets.has(a)) out[a] = c
  const due = [...targets].filter(([a]) => { const c = out[a]; return !c || (!c.graduated && now - c.at > PONS_FRESH_MS) })
    .sort(([a], [b]) => (out[a]?.at ?? 0) - (out[b]?.at ?? 0))
  // Packed into batches of PONS_BATCH calls, a curve's three calls never split.
  const batches: [string, { via: 'factory' | 'curve'; curve?: string }][][] = []
  let cur: [string, { via: 'factory' | 'curve'; curve?: string }][] = [], n = 0
  for (const d of due) {
    const k = d[1].via === 'factory' ? 1 : 3
    if (n + k > PONS_BATCH) { batches.push(cur); cur = []; n = 0; if (batches.length >= PONS_BATCHES) break }
    cur.push(d); n += k
  }
  if (cur.length && batches.length < PONS_BATCHES) batches.push(cur)
  for (const [bi, batch] of batches.entries()) {
    if (bi > 0) await new Promise(r => setTimeout(r, 1_200))
    const calls: { to: string; data: string }[] = []
    for (const [token, t] of batch) {
      if (t.via === 'factory') calls.push({ to: PONS_FACTORY, data: SEL.graduationStatus + token.slice(2).padStart(64, '0') })
      else calls.push({ to: t.curve!, data: SEL.realQuoteReserve }, { to: t.curve!, data: SEL.graduationThreshold }, { to: t.curve!, data: SEL.graduated })
    }
    let res: { id: number; result?: string }[] = []
    try {
      const r = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))),
      })
      const j = await r.json()
      if (!Array.isArray(j)) break // throttled: the rest wait for the next refresh
      res = j
    } catch { break }
    const at = new Map(res.map(x => [x.id, typeof x.result === 'string' && x.result.length > 2 ? x.result : null]))
    let i = 0
    for (const [token, t] of batch) {
      if (t.via === 'factory') {
        const r = at.get(i++)
        if (r && r.length >= 2 + 64 * 3) out[token] = { progress: ponsProgress(word(r, 0), word(r, 1)), graduated: word(r, 2) !== 0n, at: now }
      } else {
        const c = at.get(i++), th = at.get(i++), g = at.get(i++)
        if (c && th && g) out[token] = { progress: ponsProgress(word(c, 0), word(th, 0)), graduated: word(g, 0) !== 0n, at: now }
      }
    }
  }
  return out
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
  const answers = await stockChecks(ask)
  ask.forEach((a, i) => { if (answers[i] !== null) stocks[a] = answers[i]! })
  const pools = [...byPool.values()]
  const curves = await ponsCurves(pools, prev?.curves ?? {})
  return { updatedAt: Date.now(), pools, cursor, rounds, stocks, curves }
}

/** The rows to show: one per coin, launchpad coins and Robinhood's stock tokens only. */
export function rhRows(s: RhSnapshot): RhCoin[] {
  const rows = listed(mergeCoins(s.pools.map(({ seenAt: _seen, ...row }) => row)), a => s.stocks[a])
  return rows.map(r => { const c = s.curves?.[r.address]; return c ? { ...r, curveProgress: c.graduated ? 100 : c.progress, graduated: c.graduated } : r })
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
