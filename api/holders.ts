// True holder counts, straight from the chain.
//
//   GET /api/holders?token=0x…[&created=<unix seconds hint>]
//   → { token, holders, top10Pct, top: [{ address, balance, pct, tag }],
//       decimals, complete, progress, scannedTo, head }
//
// GeckoTerminal's holder numbers are hours to days stale (null for new
// launches). This rebuilds every holder's exact balance from the token's
// Transfer logs, starting at the block its contract was created in, and
// keeps them in Supabase (v4 migration) — so each request only scans the
// blocks since the previous one. A token's first scan runs in slices of a
// few seconds across requests; the coin page polls until `complete`.

import { adminReady, db, DbError, json } from './_supabaseAdmin'
import { ARCHIVE_RPCS, RECENT_RPC, RpcError, headBlock, rpcBatch, rpcCall, scanLogs } from './_arcLogs'
import { BURN, POOL_MANAGER, TRANSFER, creationBlock, deltasOf, mergeDeltas } from './_holdersCore'

export const config = { runtime: 'edge' }

const BUDGET_MS = 14_000
const TOP = 50

interface ScanRow { token: string; from_block: number; scanned_to: number; holders: number }

async function readScan(token: string): Promise<ScanRow | null> {
  const r = await db<ScanRow[]>(`arcdex_holder_scans?token=eq.${token}&select=token,from_block,scanned_to,holders`)
  return r[0] ?? null
}

async function tokenMeta(token: string): Promise<{ decimals: number; supply: bigint }> {
  const call = (data: string) => ({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })
  const [d, s] = await rpcBatch<string>(RECENT_RPC, [call('0x313ce567'), call('0x18160ddd')], 6_000)
    .catch(() => Promise.all([
      rpcCall<string>(ARCHIVE_RPCS[0], 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => null),
      rpcCall<string>(ARCHIVE_RPCS[0], 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']).catch(() => null),
    ]))
  return { decimals: d && d !== '0x' ? Number(BigInt(d)) : 18, supply: s && s !== '0x' ? BigInt(s) : 0n }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const token = (url.searchParams.get('token') ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(token)) return json(400, { error: 'bad token' })
  if (!adminReady) return json(503, { error: 'Holder index not configured' })
  const deadline = Date.now() + BUDGET_MS

  try {
    const head = await headBlock()
    let row = await readScan(token)
    if (!row) {
      const hint = Number(url.searchParams.get('created'))
      const from = await creationBlock(token, head, Number.isFinite(hint) && hint > 1e9 ? hint : null)
      if (from === null) return json(422, { error: 'This token is not indexed' }, 'public, s-maxage=3600')
      row = { token, from_block: from, scanned_to: from - 1, holders: 0 }
    }

    // Catch up from where the index stopped (a few seconds' worth at most).
    if (row.scanned_to < head) {
      const res = await scanLogs({ address: token, topics: [TRANSFER] }, row.scanned_to + 1, head, {
        head, deadline, reduce: deltasOf, concurrency: 5,
      })
      if (res.scannedTo > row.scanned_to) {
        await db<number>('rpc/arcdex_apply_holder_deltas', {
          method: 'POST',
          body: { p_token: token, p_from_block: row.from_block, p_expected: row.scanned_to, p_to: res.scannedTo, p_deltas: mergeDeltas(res.parts) },
        })
        // -1 (another request applied this range first) is fine: re-read.
      }
      row = (await readScan(token)) ?? row
    }

    const [top, meta] = await Promise.all([
      db<{ holder: string; balance: string }[]>(`arcdex_holder_balances?token=eq.${token}&select=holder,balance::text&order=balance.desc&limit=${TOP}`),
      tokenMeta(token),
    ])
    const pct = (b: string) => meta.supply > 0n ? Number((BigInt(b) * 1_000_000n) / meta.supply) / 10_000 : null
    const rows = top.map(t => ({
      address: t.holder,
      balance: Number(BigInt(t.balance)) / 10 ** meta.decimals,
      pct: pct(t.balance),
      tag: t.holder === POOL_MANAGER ? 'pool' : t.holder === BURN ? 'burn' : null,
    }))
    // Like DEX screeners: top 10 wallets, not counting the pool or the burn address.
    const top10Pct = meta.supply > 0n ? rows.filter(r => !r.tag).slice(0, 10).reduce((s, r) => s + (r.pct ?? 0), 0) : null
    const complete = row.scanned_to >= head - 20
    const progress = complete ? 1 : Math.max(0, Math.min(1, (row.scanned_to - row.from_block) / Math.max(1, head - row.from_block)))
    return json(200, {
      token, holders: row.holders, top10Pct, top: rows, decimals: meta.decimals,
      complete, progress, scannedTo: row.scanned_to, head,
    }, complete ? 'public, s-maxage=15, stale-while-revalidate=120' : 'no-store')
  } catch (e) {
    if (e instanceof DbError && (e.status === 404 || /arcdex_holder|PGRST20[25]|42P01|42883/.test(e.body))) {
      return json(503, { error: 'Holder index not set up — run the v4 migration' }, 'public, s-maxage=60')
    }
    const msg = e instanceof RpcError || e instanceof Error ? e.message : 'error'
    return json(502, { error: `Could not count holders: ${msg.slice(0, 120)}` })
  }
}
