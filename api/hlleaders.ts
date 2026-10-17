// Hyperliquid's top traders, for the futures leaderboard (2026-10-11, competing with liquid.trade, whose Leaderboard
// is this). Hyperliquid publishes its whole leaderboard as one file of ~47,000 traders (stats-data.hyperliquid.xyz,
// 39 MB on 2026-10-11): far too big for a browser. This reads it at most every 10 minutes while someone is looking,
// keeps the top 100 of each window (day, week, month, all time) by P&L, accounts worth $10K or more, and serves
// ~50 KB. Served by the engine at /api/hlleaders.
//
// Ranked by P&L only, as Hyperliquid's own board is: its return figure is measured against what an account started
// the window with, so an account that grew from a small deposit shows returns in the millions of percent (seen on
// 2026-10-11). The return is kept as a column, not a ranking.
// Display names are the traders' own, from Hyperliquid, except anything that looks like an email address or a link,
// which shows as the address instead.

import { json, kvGet, kvSet } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

const SOURCE = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
const KEY = 'hl:leaders:v1'
const FRESH_MS = 10 * 60_000
const TOP = 100
const MIN_VALUE = 10_000

export const HL_WINDOWS = ['day', 'week', 'month', 'allTime'] as const
export type HlWindow = (typeof HL_WINDOWS)[number]
/** One trader: address, display name, account value, and per window [P&L, return (0.1 = 10%), volume]. */
export interface HlLeader { a: string; n: string | null; v: number; w: Record<HlWindow, [number, number, number]> }
/** `top[window]` are indexes into `rows`, the most P&L first. */
export interface HlLeaders { at: number; traders: number; rows: HlLeader[]; top: Record<HlWindow, number[]> }

interface RawRow { ethAddress?: string; accountValue?: string; displayName?: string | null; windowPerformances?: [string, { pnl?: string; roi?: string; vlm?: string }][] }

/** A display name safe to show: no email addresses or links, no control characters, 24 characters at most. */
export function cleanName(n: unknown): string | null {
  if (typeof n !== 'string') return null
  const s = n.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!s || s.includes('@') || /https?:|www\.|\.(com|io|xyz|net|org)\b/i.test(s)) return null
  return s.slice(0, 24)
}

export function summarize(raw: RawRow[], at: number): HlLeaders {
  const all: HlLeader[] = []
  for (const r of raw) {
    const a = String(r.ethAddress ?? '').toLowerCase()
    const v = Number(r.accountValue)
    if (!/^0x[0-9a-f]{40}$/.test(a) || !Number.isFinite(v) || v < MIN_VALUE) continue
    const w = {} as HlLeader['w']
    let ok = true
    for (const name of HL_WINDOWS) {
      const p = r.windowPerformances?.find(x => x[0] === name)?.[1]
      const pnl = Number(p?.pnl), roi = Number(p?.roi), vlm = Number(p?.vlm)
      if (!Number.isFinite(pnl) || !Number.isFinite(roi)) { ok = false; break }
      w[name] = [Math.round(pnl), Math.round(roi * 1e4) / 1e4, Math.round(Number.isFinite(vlm) ? vlm : 0)]
    }
    if (ok) all.push({ a, n: cleanName(r.displayName), v: Math.round(v), w })
  }
  // The union of every list, each trader once.
  const index = new Map<string, number>()
  const rows: HlLeader[] = []
  const pick = (l: HlLeader) => {
    let i = index.get(l.a)
    if (i === undefined) { i = rows.length; rows.push(l); index.set(l.a, i) }
    return i
  }
  const top = {} as HlLeaders['top']
  for (const name of HL_WINDOWS) {
    top[name] = [...all].sort((x, y) => y.w[name][0] - x.w[name][0]).slice(0, TOP).filter(l => l.w[name][0] > 0).map(pick)
  }
  return { at, traders: raw.length, rows, top }
}

let mem: HlLeaders | null = null
let building: Promise<void> | null = null

async function build(fetcher: typeof fetch): Promise<void> {
  const r = await fetcher(SOURCE, { signal: AbortSignal.timeout(90_000) })
  if (!r.ok) throw new Error(`leaderboard answered ${r.status}`)
  const j = (await r.json()) as { leaderboardRows?: RawRow[] }
  const s = summarize(j.leaderboardRows ?? [], Date.now())
  if (!s.rows.length) throw new Error('leaderboard was empty')
  mem = s
  await kvSet(KEY, s)
}

/** For tests: forget the copy in memory. */
export function _reset() { mem = null; building = null }

export default async function handler(_req?: Request, _ctx?: unknown, fetcher: typeof fetch = fetch, firstWaitMs = 8_000): Promise<Response> {
  if (!mem) {
    const saved = await kvGet<HlLeaders>(KEY)
    if (saved?.value?.rows?.length) mem = saved.value
  }
  if ((!mem || Date.now() - mem.at > FRESH_MS) && !building) {
    building = build(fetcher).catch(() => { /* the last good copy stays */ }).finally(() => { building = null })
  }
  // The first answer ever waits for the build, at most 8 seconds (the engine ends a request after 10; the download
  // can take longer): the build carries on behind, and the next ask gets the board. Later answers are served at once
  // and refreshed behind.
  if (!mem && building) await Promise.race([building, new Promise(r => setTimeout(r, firstWaitMs))])
  if (!mem) return new Response(JSON.stringify({ error: 'Hyperliquid’s leaderboard is loading' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '10' } })
  // `complete` tells the engine's warm-up (engine/src/site/siteApi.ts) that the board is in.
  return json(200, { ...mem, complete: true }, 'public, max-age=60')
}
