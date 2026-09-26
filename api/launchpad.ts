// ArcLaunchpad index: every launch (with its image and socials) and every trade.
//
//   GET /api/launchpad            → { launchpad, head, scannedTo, complete, launches: [Launch & { stats }] }
//   GET /api/launchpad?token=0x…  → the same, plus that token's `trades` (oldest first)
//
// The public Arc RPC answers getLogs for ~9k blocks at a time, so the
// browser's own lookups (one getLogs over the whole chain for a coin's
// metadata, 50k blocks for its trades) failed: no images, trades or charts
// for launchpad coins. This keeps the launchpad's logs in Supabase
// (`arcdex_kv`), scans only the blocks since the last request, resolves each
// coin's metadata once, and is CDN-cached.

import { adminReady, json, kvGet, kvSet } from './_supabaseAdmin'
import { headBlock, scanLogs, type RawLog } from './_arcLogs'
import { creationBlock } from './_holdersCore'
import { ARC_LAUNCHPAD, CURVE_TRADE, DEPLOY_BLOCKS, TOKEN_LAUNCHED, decodeLaunch, decodeTrade, resolveMeta, statsOf, type Launch, type TradeRow } from './_launchpadCore'

export const config = { runtime: 'edge' }
declare const process: { env: Record<string, string | undefined> }

const LAUNCHPAD = (process.env.VITE_ARC_LAUNCHPAD_ADDRESS || ARC_LAUNCHPAD).toLowerCase()
const KEY = `launchpad:v1:${LAUNCHPAD}`
const BUDGET_MS = 12_000
/** A hosted metadata file that didn't answer is retried this often. */
const META_RETRY_MS = 10 * 60_000
const MAX_TRADES_OUT = 20_000

type StoredLaunch = Launch & { metaTriedAt?: number }
interface State { fromBlock: number; scannedTo: number; launches: StoredLaunch[]; trades: TradeRow[] }
interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

// Edge instances are reused between requests: the last state stays here too.
let mem: State | null = null

async function load(head: number): Promise<State | null> {
  if (mem) return mem
  const stored = adminReady ? await kvGet<State>(KEY) : null
  if (stored?.value?.launches) return stored.value
  const from = DEPLOY_BLOCKS[LAUNCHPAD] ?? await creationBlock(LAUNCHPAD, head, null)
  return from === null ? null : { fromBlock: from, scannedTo: from - 1, launches: [], trades: [] }
}

export default async function handler(req: Request, ctx?: Ctx): Promise<Response> {
  const url = new URL(req.url)
  const token = (url.searchParams.get('token') ?? '').toLowerCase()
  if (token && !/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: 'bad token' })
  if (!/^0x[0-9a-f]{40}$/.test(LAUNCHPAD)) return json(503, { error: 'Launchpad not configured' })
  const deadline = Date.now() + BUDGET_MS

  try {
    const head = await headBlock()
    const state = await load(head)
    if (!state) return json(422, { error: 'No launchpad contract at that address' }, 'public, s-maxage=3600')
    let changed = false

    // New blocks since the last request.
    if (state.scannedTo < head) {
      const res = await scanLogs<RawLog[]>({ address: LAUNCHPAD, topics: [[TOKEN_LAUNCHED, CURVE_TRADE]] }, state.scannedTo + 1, head, {
        head, deadline, reduce: l => l, concurrency: 5,
      })
      if (res.scannedTo > state.scannedTo) {
        const known = new Set(state.launches.map(l => l.token))
        const seen = new Set(state.trades.slice(-2_000).map(t => `${t[10]}:${t[11]}`))
        for (const l of res.parts.flat()) {
          const launch = decodeLaunch(l)
          if (launch && !known.has(launch.token)) { state.launches.push(launch); known.add(launch.token); continue }
          const trade = decodeTrade(l)
          if (trade && !seen.has(`${trade[10]}:${trade[11]}`)) { state.trades.push(trade); seen.add(`${trade[10]}:${trade[11]}`) }
        }
        state.scannedTo = res.scannedTo
        changed = true
      }
    }

    // Metadata (image, description, socials) for coins that don't have it yet.
    const now = Date.now()
    const pending = state.launches.filter(l => !l.meta && l.metadataURI && (!l.metaTriedAt || now - l.metaTriedAt > META_RETRY_MS)).slice(0, 8)
    if (pending.length && deadline - Date.now() > 2_000) {
      await Promise.all(pending.map(async l => { l.meta = await resolveMeta(l.metadataURI); l.metaTriedAt = now }))
      changed = true
    }

    mem = state
    if (changed && adminReady) {
      const save = kvSet(KEY, state)
      if (ctx?.waitUntil) ctx.waitUntil(save); else await save
    }

    const byToken = new Map<string, TradeRow[]>()
    for (const t of state.trades) {
      const list = byToken.get(t[0])
      if (list) list.push(t); else byToken.set(t[0], [t])
    }
    const complete = state.scannedTo >= head - 20
    const body: Record<string, unknown> = {
      launchpad: LAUNCHPAD, head, scannedTo: state.scannedTo, complete,
      launches: state.launches.map(({ metaTriedAt: _skip, ...l }) => ({ ...l, stats: statsOf(byToken.get(l.token) ?? [], undefined, l.ts) })),
    }
    if (token) body.trades = (byToken.get(token) ?? []).slice(-MAX_TRADES_OUT)
    return json(200, body, complete ? 'public, s-maxage=4, stale-while-revalidate=30' : 'no-store')
  } catch (e) {
    return json(502, { error: `Launchpad index unavailable: ${(e instanceof Error ? e.message : 'error').slice(0, 120)}` })
  }
}
