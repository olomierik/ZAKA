// A stand-in for checking the testnet prediction pool locally, end to end: anvil stands in for Arc testnet (chain
// 5042002, Multicall3 copied from Ethereum), the futures keeper is anvil's first account (it deploys the test USDC
// and funds the pool keeper's gas), and the engine's own pool service makes its keeper wallet, deploys the pool from
// it and runs the keeper on Hyperliquid's real markets, mids and settlements (through the practice book). Practice
// routes are served too; every other HTTP route goes to the production engine (as practice-standin.ts does).
//
//   bun engine/scripts/predict-pool-standin.ts      (engine on port 8790, anvil on 8545)
//   the site, in .env.development.local:
//     VITE_ARCDEX_WS_URL=ws://localhost:8790/ws
//     VITE_PERPS_RPC=http://127.0.0.1:8545
//   then gas for a wallet on the local chain: POST http://localhost:8790/dev/gas?address=0x…

import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { MemoryPracticeStore, PredictPractice } from '../src/practice/predict'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'
import { WalletVault } from '../src/bot/userLive'
import { PredictPoolService } from '../src/predictpool/service'
import { TEST_USDC_ABI } from '../src/perps/abi'
import { TEST_USDC_BYTECODE } from '../src/perps/build'
import { ARC_TESTNET } from '../src/perps/shared'
import type { PerpsService } from '../src/perps/service'

setLogLevel('info')
const PORT = Number(process.env.PORT ?? 8790)
const RPC_PORT = Number(process.env.RPC_PORT ?? 8545)
const RPC = `http://127.0.0.1:${RPC_PORT}`
const PROD = process.env.PROD_ENGINE ?? 'https://arcdex-engine-production.up.railway.app'
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')
const FUNDER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil's first account

const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil'
const ANVIL = [join(homedir(), '.foundry', 'bin', exe)].find(p => existsSync(p)) ?? Bun.which('anvil')
if (!ANVIL) throw new Error('anvil not found: install Foundry')
const anvil = Bun.spawn([ANVIL, '--port', String(RPC_PORT), '--chain-id', String(ARC_TESTNET.id), '--silent'], { stdout: 'ignore', stderr: 'inherit' })
process.on('exit', () => anvil.kill())
const chain = { ...ARC_TESTNET, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient
for (let i = 0; i < 100; i++) { try { await client.getChainId(); break } catch { await Bun.sleep(100) } }
const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never })
// A block every second, as Arc makes them (every half second): a fill is signed at a later block's time than its request's.
await rpc('evm_setIntervalMining', [1])

// Multicall3, as Arc testnet has it (the site batches its reads through it).
const mc = await fetch('https://ethereum-rpc.publicnode.com', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: ['0xcA11bde05977b3631167028862bE2a173976CA11', 'latest'] }),
}).then(r => r.json()) as { result: string }
await rpc('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', mc.result])

// The futures' share: their keeper (anvil's first account) and their test USDC.
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain, transport: http(RPC) })
const hash = await funder.deployContract({ abi: TEST_USDC_ABI, bytecode: TEST_USDC_BYTECODE, args: [funder.account.address, 0n] })
const usdc = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!)
const perps = { algoAccess: () => ({ client, keeper: funder, markets: () => [] }), deployment: { usdc } } as unknown as PerpsService

const practice = new PredictPractice({
  store: new MemoryPracticeStore(),
  info: async body => {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6_000) })
    if (!r.ok) throw new Error(`hyperliquid ${String(body.type)} ${r.status}`)
    return r.json()
  },
})
setInterval(() => { void practice.settleTick() }, 30_000)

const settings = new Map<string, string>()
const pool = new PredictPoolService({
  settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } },
  vault: new WalletVault(randomBytes(32).toString('hex')), perps, data: practice,
  env: { PERPS_RPC: RPC }, stepEveryMs: 3_000,
})
await pool.start()

const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
api.practice = practice
api.predictPool = pool
const cfg = { role: 'all', port: PORT + 1, allowedOrigins: ORIGINS, metricsToken: 'x', maxConnsPerIp: 20, maxMsgsPerSec: 50, maxSubsPerConn: 50, restRatePerSec: 200 } as unknown as Config
const engine = startServer({ cfg, api, health: () => ({ status: 'ok' }) })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const o = req.headers.get('origin')
    const cors: Record<string, string> = o && ORIGINS.includes(o) ? { 'access-control-allow-origin': o } : {}
    // Gas on the local chain for a wallet (anvil_setBalance): the stand-in's own route.
    if (url.pathname === '/dev/gas') {
      const a = url.searchParams.get('address')
      if (!a || !isAddress(a)) return new Response('{"error":"address"}', { status: 400, headers: cors })
      await rpc('anvil_setBalance', [a, '0x8AC7230489E80000']) // 10
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', ...cors } })
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    if (url.pathname.startsWith('/v1/practice/') || url.pathname.startsWith('/v1/predict/pool/')) {
      const r = await fetch(`http://127.0.0.1:${engine.server.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body })
      return new Response(r.body, { status: r.status, headers: r.headers })
    }
    const headers = new Headers(req.headers)
    headers.set('origin', 'https://arcsense.site')
    headers.delete('host')
    const r = await fetch(`${PROD}${url.pathname}${url.search}`, { method: req.method, headers, body }).catch(() => null)
    if (!r) return new Response('{"error":"production engine unreachable"}', { status: 502 })
    const out = new Headers(r.headers)
    if (o && ORIGINS.includes(o)) out.set('access-control-allow-origin', o)
    out.delete('content-encoding')
    out.delete('content-length')
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out })
  },
})
console.log(`prediction pool stand-in on http://localhost:${PORT} (anvil ${RPC}, test USDC ${usdc as Address})`)
