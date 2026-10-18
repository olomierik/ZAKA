// A stand-in engine for checking card deposits locally: the engine's own /api/onramp (api/onramp.ts) with Circle's
// API stubbed (it answers a made-up session token, so the widget at onramp.arc.io loads and says the session is bad),
// and a /api/session that signs anyone in. Every other route is passed on to the production engine (as arcsense.site).
// No Circle key is needed, and nothing reaches Circle.
//
//   bun engine/scripts/onramp-standin.ts      (port 8792; the site with VITE_ARCDEX_WS_URL=ws://localhost:8792/ws)

import { createOnramp } from '../../api/onramp'

const PORT = Number(process.env.PORT ?? 8792)
const PROD = process.env.PROD_ENGINE ?? 'https://arcdex-engine-production.up.railway.app'
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:5174,http://localhost:4173').split(',')

const sessions: { address: string; at: string }[] = []
const onramp = createOnramp({
  apiKey: 'STANDIN_API_KEY:x:y',
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { walletAddress: string; referrerDomain: string }
    sessions.push({ address: body.walletAddress, at: new Date().toISOString() })
    console.log('circle (stubbed): session for', body.walletAddress, 'framed by', body.referrerDomain, 'at', String(input))
    return Response.json({ data: { sessionToken: 'standin-token', sessionId: 'standin', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } })
  }) as typeof globalThis.fetch,
  // The stand-in's own session tokens: "standin:<address>".
  verify: async t => (t?.startsWith('standin:') ? { address: t.slice(8).toLowerCase(), iat: 1 } : null),
  revoked: async () => false,
})

const cors = (req: Request, h: Headers) => {
  const o = req.headers.get('origin')
  if (o && ORIGINS.includes(o)) h.set('access-control-allow-origin', o)
  h.set('access-control-allow-headers', 'authorization, content-type')
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  h.set('x-arcdex-served-by', 'engine')
  h.set('access-control-expose-headers', 'x-arcdex-served-by')
  return h
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, new Headers()) })
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const { address } = await req.json() as { address: string }
      return Response.json({ address: address.toLowerCase(), token: `standin:${address}`, expiresAt: Date.now() + 86_400_000 }, { headers: cors(req, new Headers()) })
    }
    if (url.pathname === '/api/onramp') {
      const r = await onramp(req)
      return new Response(r.body, { status: r.status, headers: cors(req, new Headers(r.headers)) })
    }
    if (url.pathname === '/standin/sessions') return Response.json(sessions, { headers: cors(req, new Headers()) })
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const headers = new Headers(req.headers)
    headers.set('origin', 'https://arcsense.site')
    headers.delete('host')
    const r = await fetch(`${PROD}${url.pathname}${url.search}`, { method: req.method, headers, body }).catch(() => null)
    if (!r) return new Response('{"error":"production engine unreachable"}', { status: 502 })
    const out = new Headers(r.headers)
    const o = req.headers.get('origin')
    if (o && ORIGINS.includes(o)) out.set('access-control-allow-origin', o)
    out.delete('content-encoding')
    out.delete('content-length')
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out })
  },
})
console.log(`onramp stand-in on http://localhost:${PORT}`)
