import { gtFetch, gtUpstream } from './_geckoterminal'
import { kvGet, kvSet } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

interface Ctx { waitUntil?: (p: Promise<unknown>) => void }

export default async function handler(req: Request, ctx?: Ctx) {
  const url = new URL(req.url)
  const path = url.searchParams.get('path') ?? ''
  // Arc data only — this is a CDN-cached proxy for this app, not a general
  // open relay to the upstream API.
  if (!/^\/networks\/arc\/[A-Za-z0-9_/,.-]+$/.test(path) && path !== '/search/pools') {
    return new Response(JSON.stringify({ error: 'bad path' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const qs = new URLSearchParams()
  url.searchParams.forEach((v, k) => { if (k !== 'path') qs.set(k, v) })
  qs.sort()
  const target = qs.toString() ? `${path}?${qs}` : path
  // Last-good copies are kept for stable paths only (not searches or
  // paged-back candles, which are one-offs).
  const cacheKey = path === '/search/pools' || qs.has('before_timestamp') ? null : `gt:${path}?${qs}`

  let res: Response | null = null
  try { res = await gtFetch(target, { signal: AbortSignal.timeout(8_000) }) } catch { /* upstream down */ }

  if (res?.ok) {
    const body = await res.text()
    if (cacheKey) {
      const save = (async () => { try { await kvSet(cacheKey, JSON.parse(body)) } catch { /* not JSON */ } })()
      if (ctx?.waitUntil) ctx.waitUntil(save); else await save
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=10, stale-while-revalidate=300',
        'X-Arcdex-Upstream': gtUpstream(),
      },
    })
  }

  // Throttled (GeckoTerminal often 429s Vercel's shared IPs) or down: the
  // last good copy beats making the browser wait on its own paced retries.
  const last = cacheKey ? await kvGet<unknown>(cacheKey) : null
  if (last && last.age < 6 * 3600_000) {
    return new Response(JSON.stringify(last.value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=5',
        'X-Arcdex-Age': String(Math.round(last.age / 1000)),
        'X-Arcdex-Upstream': gtUpstream(),
      },
    })
  }
  return new Response(res ? await res.text() : JSON.stringify({ error: 'upstream unavailable' }), {
    status: res?.status ?? 502,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Never cache an error (a 429 would be served to every visitor).
      'Cache-Control': 'no-store',
      'X-Arcdex-Upstream': gtUpstream(),
    },
  })
}
