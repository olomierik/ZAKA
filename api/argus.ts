// Argus market list, built server-side from GeckoTerminal and CDN-cached so
// one refresh serves every visitor. The list logic lives in _argusCore.ts;
// when this comes back partial (GeckoTerminal throttles Vercel's shared
// IPs), the browser rebuilds it from its own IP — see argusMarket.ts.

import { GT_BASE, gtHeaders } from './_geckoterminal'
import { buildArgusMarket, type GtList } from './_argusCore'

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
      const res = await fetch(`${GT_BASE}${path}`, {
        headers: gtHeaders(),
        signal: AbortSignal.timeout(Math.min(6_000, left)),
      })
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

export default async function handler(): Promise<Response> {
  const deadline = Date.now() + BUDGET_MS
  const failures: Failure[] = []
  const pools = await buildArgusMarket(path => gtBudgeted(path, deadline, failures))

  if (pools.length === 0) {
    return new Response(JSON.stringify({ error: 'GeckoTerminal unavailable', failures }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }

  const partial = failures.length > 0
  return new Response(JSON.stringify({ updatedAt: new Date().toISOString(), source: 'geckoterminal', partial, failures, pools }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // A complete list is shared for a minute (prices on a coin's own page
      // refresh far faster: 15s poll + live WebSocket swaps). A partial one
      // is held only briefly so a later refresh can complete it.
      'Cache-Control': partial
        ? 'public, s-maxage=15, stale-while-revalidate=60'
        : 'public, s-maxage=60, stale-while-revalidate=600',
    },
  })
}
