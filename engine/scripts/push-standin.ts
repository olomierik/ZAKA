// A stand-in engine for checking alerts by push locally: the engine's own server and alert code (alerts/service.ts) in
// memory, with no chain. The push service is this process: what the engine sends is kept, not forwarded, and read back
// at /__test/sent (the encrypted body, as the browser would get it). Trades and Hyperliquid mids are set by hand.
//
//   bun engine/scripts/push-standin.ts         (port 8788; the site with VITE_ARCDEX_WS_URL=ws://localhost:8788/ws)
//   POST /__test/trade {token, priceUsd, usdValue, side, lagMs}   a trade on an Arc coin, `lagMs` after its block
//   POST /__test/mids {coin: price}                               Hyperliquid's mid prices from now on
//   GET  /__test/sent                                             every push the engine sent, with when

import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { MemoryPushStore, PushAlerts } from '../src/alerts/service'
import { generateVapidKeys } from '../src/alerts/webpush'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('warn')
const PORT = Number(process.env.PORT ?? 8788)
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')
const sent: { at: number; endpoint: string; auth: string; encoding: string; ttl: string; urgency: string; body: string }[] = []
let mids: Record<string, number> = {}

const push = new PushAlerts({
  store: new MemoryPushStore(), keys: await generateVapidKeys(), subject: 'https://arcsense.site',
  fetcher: (async (endpoint: string, init: RequestInit) => {
    const r = new Request(endpoint, init)
    sent.push({ at: Date.now(), endpoint, auth: r.headers.get('authorization') ?? '', encoding: r.headers.get('content-encoding') ?? '', ttl: r.headers.get('ttl') ?? '', urgency: r.headers.get('urgency') ?? '', body: Buffer.from(await r.arrayBuffer()).toString('base64') })
    return new Response(null, { status: 201 })
  }) as unknown as typeof fetch,
  hlMids: async dex => Object.fromEntries(Object.entries(mids).filter(([k]) => (k.includes(':') ? k.split(':')[0] : '') === dex)),
})
await push.load()
setInterval(() => { void push.tickHl() }, 2_000)

const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
api.push = push
const cfg = { role: 'all', port: PORT + 1, allowedOrigins: ORIGINS, metricsToken: 'x', maxConnsPerIp: 20, maxMsgsPerSec: 50, maxSubsPerConn: 50, restRatePerSec: 200 } as unknown as Config
const engine = startServer({ cfg, api, health: () => ({ status: 'ok' }) })

const cors = (req: Request) => ({ 'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : '*', Vary: 'Origin' })
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } })
    if (url.pathname === '/__test/sent') return json(200, { sent })
    if (url.pathname === '/__test/mids' && req.method === 'POST') { mids = await req.json() as Record<string, number>; return json(200, { ok: true }) }
    if (url.pathname === '/__test/trade' && req.method === 'POST') {
      const t = await req.json() as { token: string; priceUsd: number; usdValue: number; side: 'BUY' | 'SELL'; lagMs?: number }
      const at = Date.now() - (t.lagMs ?? 1_500)
      push.onTrade({ tradeId: `t${at}`, chain: 'ARC', token: t.token.toLowerCase(), pair: '', pool: '', quote: '', side: t.side, baseAmount: 1, quoteAmount: 1, tokenAmount: 1, price: 1, priceUsd: t.priceUsd, usdValue: t.usdValue, wallet: null, txHash: '0x1', blockNumber: 1, logIndex: 1, timestamp: at, dex: 'uniswap-v4', launchpad: null, liquidity: null })
      return json(200, { ok: true })
    }
    // Everything else is the engine's own server.
    const r = await fetch(`http://127.0.0.1:${engine.server.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer() })
    return new Response(r.body, { status: r.status, headers: r.headers })
  },
})
console.log(`push stand-in on http://localhost:${PORT}`)
