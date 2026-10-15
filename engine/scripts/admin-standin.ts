// A stand-in engine for checking /admin locally: the engine's own admin code (sign-in, flags, the sweeper, the routes,
// the trade switch, the fee ledger, the traffic counter) in memory, with no chain. Signatures are checked locally (no
// RPC), so only ordinary wallets can sign in here.
//
//   ADMIN=0x… bun engine/scripts/admin-standin.ts      (default admin: Anvil's first published test account)
//   then run the site with VITE_ARCDEX_WS_URL=ws://localhost:8787/ws and open http://localhost:5173/admin
//
// The fee ledger and the sweeper start with a few made-up rows so every view has something to show.

import { verifyMessage } from 'viem'
import { AdminAuth } from '../src/admin/auth'
import { FeatureFlags } from '../src/admin/flags'
import { Sweeper } from '../src/admin/sweeper'
import { AdminApi } from '../src/admin/api'
import { ControlVerifier } from '../src/bot/control'
import { MemoryBotStore } from '../src/bot/store'
import { FeeLedger } from '../src/fees/ledger'
import { TradeSwitch } from '../src/site/tradeSwitch'
import { Traffic } from '../src/traffic'

const PORT = Number(process.env.PORT ?? 8787)
const ADMIN = (process.env.ADMIN ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266').toLowerCase()
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')

const store = new MemoryBotStore()
const v = new ControlVerifier(null, [], a => verifyMessage(a))
const verify = (m: string, at: number, sig: `0x${string}`, now: number) => v.verifyAnyOf([ADMIN], m, at, sig, now)
const tradeSwitch = new TradeSwitch({ settings: store, audit: store, verify, env: { all: false, venues: [] } })
await tradeSwitch.load()
const ledger = new FeeLedger(store)
const now = Date.now()
await ledger.record([
  { id: 'arc:0xa1:router', at: now - 3_600_000, chain: 'arc', source: 'arc-router', token: '0x3600000000000000000000000000000000000000', symbol: 'USDC', amount: '4.2', amountUsd: 4.2, recipient: '0x274262a0321a0701b0a46a3576e07ae881c286bb', tx: `0x${'a1'.repeat(32)}`, block: 1, status: 'received' },
  { id: 'arc:0xa2:router', at: now - 600_000, chain: 'arc', source: 'arc-router', token: '0x3600000000000000000000000000000000000000', symbol: 'USDC', amount: '1.05', amountUsd: 1.05, recipient: '0x274262a0321a0701b0a46a3576e07ae881c286bb', tx: `0x${'a2'.repeat(32)}`, block: 2, status: 'received' },
])
const traffic = new Traffic(store)
let owed = [{ bot: 'night-owl', position: 'p1', usd: 12.5 }]
const sweeper = new Sweeper({
  store, settings: store, audit: store, minUsd: 10,
  owedFees: () => owed,
  sendOwedFees: async () => { const out = owed.map(f => ({ position: f.position, usd: f.usd, tx: `0x${'b1'.repeat(32)}` })); owed = []; return out },
  relayBalances: async () => [{ holder: 'Relay 56:usdt', token: 'USDT', amount: '42.5', usd: 42.5 }, { holder: 'Relay 792703809:sol', token: 'SOL', amount: '0.01', usd: 1.5 }],
  jupiterBalances: null,
  paused: () => (tradeSwitch.state().on ? null : 'trading is off everywhere (the trade switch)'),
  alert: t => console.log(`[alert] ${t}`),
  schedule: 'off',
})
const auth = new AdminAuth({ admins: [ADMIN], origins: ORIGINS, ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store, alert: t => console.log(`[alert] ${t}`) })
const flags = new FeatureFlags({ settings: store, audit: store, verify })
await flags.load()
const admin = new AdminApi({
  auth, origins: ORIGINS, audit: store, verify, flags, sweeper, ledger, traffic, tradeSwitch,
  trades: async () => ({ source: 'ledger', rows: (await ledger.store.feeRows({ limit: 100 })).map(r => ({ tx: r.tx!, at: r.at, trader: '', token: r.token, side: 'buy' as const, usd: 0, feeUsd: r.amountUsd ?? 0, venue: r.source })), day: { trades: 2, volumeUsd: 0, feesUsd: 5.25 } }),
  bots: () => ({ bots: 4, running: 2, live: 1 }),
})

const cors = (req: Request) => ({ 'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : ORIGINS[0], Vary: 'Origin' })
const json = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
    const r = await admin.handle(req, url, '127.0.0.1')
    if (r) return json(req, r.status, r.body)
    if (url.pathname === '/v1/trading/status') return json(req, 200, tradeSwitch.state())
    if (req.method === 'POST' && url.pathname === '/v1/trading/control') { const c = await tradeSwitch.control(await req.json().catch(() => null)); return json(req, c.status, c.body) }
    if (url.pathname === '/v1/fees/summary') return json(req, 200, await ledger.summary())
    if (url.pathname === '/v1/traffic/beat' && req.method === 'POST') {
      const b = await req.text().then(t => JSON.parse(t) as { id?: string; p?: string }).catch(() => null)
      traffic.beat(b?.id ?? '', '127.0.0.1', Date.now(), b?.p)
      return json(req, 200, await traffic.counts())
    }
    return json(req, 404, { error: 'not in the stand-in' })
  },
})
console.log(`admin stand-in on http://localhost:${PORT} (admin ${ADMIN})`)
