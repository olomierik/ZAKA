// Serves the engine's futures endpoints (/v1/perps/*) on their own, for working on the futures
// screen locally: real RedStone prices and candles, no keeper wallet, no chain stream.
//
//   bun engine/scripts/perps-standin.ts            # http://localhost:8099
//   VITE_ARCDEX_WS_URL=ws://localhost:8099/ws in .env.development.local, then `bun run dev`
//
// The whole flow on a local chain standing in for Arc testnet (real RedStone prices, the real
// keeper, contracts deployed by the engine):
//   anvil --chain-id 5042002 --port 8545   (plus Multicall3's code at 0xcA11…CA11, anvil_setCode)
//   PERPS_RPC=http://127.0.0.1:8545 BOT_WALLET_SECRET=<64 hex> bun engine/scripts/perps-standin.ts
//   fund the keeper address it logs (anvil_setBalance); it deploys within a minute
//   VITE_PERPS_RPC=http://127.0.0.1:8545 for the site
import { WalletVault } from '../src/bot/userLive'
import { MemoryCandleStore } from '../src/perps/candles'
import { PerpsService } from '../src/perps/service'

const settings = new Map<string, string>()
const svc = new PerpsService({
  settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } },
  candleStore: new MemoryCandleStore(), vault: process.env.BOT_WALLET_SECRET ? new WalletVault(process.env.BOT_WALLET_SECRET) : null,
})
await svc.start()
const port = Number(process.env.PORT) || 8099
Bun.serve({
  port,
  fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } })
    const url = new URL(req.url)
    return svc.handle(url, json) ?? json(404, { error: 'not served by the stand-in' })
  },
})
console.log(`futures stand-in on http://localhost:${port}`, svc.keeperAddress ? `keeper ${svc.keeperAddress}` : '(no keeper)')
