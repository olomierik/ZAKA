// A stand-in engine for checking /predict → BTC 5m · 15m locally: it runs the real Up/Down autotrader
// (src/updown, on paper against Polymarket's live markets) and serves /v1/updown/*; every other path goes to the
// production engine. Nothing is signed or sent anywhere.
// Run: bun engine/scripts/updown-standin.ts, then VITE_ARCDEX_API_URL=http://localhost:8099 in .env.development.local.
// UPDOWN_SEED=<file> starts it from a saved paper book (the `updown-paper` setting's JSON), to see past trades.
import { readFileSync } from 'node:fs'
import { UpdownService } from '../src/updown/service'

const settings = new Map<string, string>()
if (process.env.UPDOWN_SEED) settings.set('updown-paper', readFileSync(process.env.UPDOWN_SEED, 'utf8'))
const svc = new UpdownService({ store: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } } })
await svc.load()
svc.start()
const PROD = 'https://arcdex-engine-production.up.railway.app'
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'cache-control': 'no-store' }
Bun.serve({
  port: Number(process.env.PORT ?? 8099),
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    if (url.pathname === '/v1/updown/status') return Response.json(svc.status(), { headers: cors })
    if (url.pathname === '/v1/updown/trades') return Response.json(svc.trades(Number(url.searchParams.get('limit')) || 100), { headers: cors })
    const r = await fetch(PROD + url.pathname + url.search, { method: req.method, headers: { origin: 'https://arcsense.site', 'content-type': req.headers.get('content-type') ?? 'application/json' }, body: req.method === 'GET' ? undefined : await req.text() })
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { ...cors, 'content-type': r.headers.get('content-type') ?? 'application/json' } })
  },
})
console.log('updown stand-in on', process.env.PORT ?? 8099)
