// A stand-in engine for checking practice predictions locally: the engine's own server and practice book
// (practice/predict.ts) in memory, against Hyperliquid's real markets, mids and settlements. Nothing is stored.
// Every other HTTP route is passed on to the production engine (as arcsense.site), so the rest of /predict works.
//
//   bun engine/scripts/practice-standin.ts      (port 8790; the site with VITE_ARCDEX_WS_URL=ws://localhost:8790/ws)

import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { MemoryPracticeStore, PredictPractice } from '../src/practice/predict'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('warn')
const PORT = Number(process.env.PORT ?? 8790)
const PROD = process.env.PROD_ENGINE ?? 'https://arcdex-engine-production.up.railway.app'
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')

const practice = new PredictPractice({
  store: new MemoryPracticeStore(),
  info: async body => {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6_000) })
    if (!r.ok) throw new Error(`hyperliquid ${String(body.type)} ${r.status}`)
    return r.json()
  },
})
setInterval(() => { void practice.settleTick() }, 30_000)

const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
api.practice = practice
const cfg = { role: 'all', port: PORT + 1, allowedOrigins: ORIGINS, metricsToken: 'x', maxConnsPerIp: 20, maxMsgsPerSec: 50, maxSubsPerConn: 50, restRatePerSec: 200 } as unknown as Config
const engine = startServer({ cfg, api, health: () => ({ status: 'ok' }) })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    if (url.pathname.startsWith('/v1/practice/')) {
      const r = await fetch(`http://127.0.0.1:${engine.server.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body })
      return new Response(r.body, { status: r.status, headers: r.headers })
    }
    // The rest goes to production as the site would ask, with this page's origin allowed back.
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
console.log(`practice stand-in on http://localhost:${PORT}`)
