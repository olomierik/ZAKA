import { GT_BASE, gtHeaders } from './_geckoterminal'

export const config = { runtime: 'edge' }

export default async function handler(req: Request) {
  const url = new URL(req.url)
  const path = url.searchParams.get('path') ?? ''
  // Arc data only — this is a CDN-cached proxy for this app, not a general
  // open relay to the upstream API.
  if (!/^\/networks\/arc\/[A-Za-z0-9_/,.-]+$/.test(path) && path !== '/search/pools') {
    return new Response(JSON.stringify({ error: 'bad path' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const upstream = `${GT_BASE}${path}`
  const qs = new URLSearchParams()
  url.searchParams.forEach((v, k) => { if (k !== 'path') qs.set(k, v) })
  const full = qs.toString() ? `${upstream}?${qs}` : upstream

  const res = await fetch(full, { headers: gtHeaders() })

  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Never cache an error (a 429 would be served to every visitor).
      'Cache-Control': res.ok ? 's-maxage=10, stale-while-revalidate=20' : 'no-store',
    },
  })
}
