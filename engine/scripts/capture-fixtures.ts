// Capture real Arc mainnet data for the engine's tests: a recent launch
// from each active Argus Portal, and Uniswap v4 / v3 swaps — each run
// through the real adapter / parser with every RPC answer recorded, so the
// tests replay genuine chain data offline.
//   bun engine/scripts/capture-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { rpcCall, hex, type RawLog } from '../../api/_arcLogs'
import { ARGUS_USDC_V3, POOL_MANAGER, V3_SWAP, V4_SWAP } from '../../api/_arcSwaps'
import { HttpRpc } from '../src/chain/http'
import { PoolRegistry } from '../src/dex/pools'
import { MakerResolver, QuoteOracle, TradeParser } from '../src/dex/trades'
import { ArgusAdapter, P7_LAUNCH, P8_LAUNCHED, PORTAL7, PORTAL8 } from '../src/launchpads/argus'
import { RecordingRpc } from '../test/helpers/recordRpc'

const BD = 'https://rpc.blockdaemon.mainnet.arc.io'
const http = new HttpRpc([BD, 'https://rpc.mainnet.arc.io'])
const head = parseInt(await rpcCall<string>(BD, 'eth_blockNumber', []), 16)
const logs = (filter: object, back: number) => rpcCall<RawLog[]>(BD, 'eth_getLogs', [{ ...filter, fromBlock: hex(head - back), toBlock: hex(head) }], 20_000)

const out: Record<string, unknown> = { capturedAt: new Date().toISOString(), head }

// ── launches ────────────────────────────────────────────────────────────
for (const [name, address, topic, back] of [['p7', PORTAL7, P7_LAUNCH, 3_000], ['p8', PORTAL8, P8_LAUNCHED, 60_000]] as const) {
  const found = await logs({ address, topics: [topic] }, back)
  const log = found[found.length - 1]
  if (!log) throw new Error(`no ${name} launch in the last ${back} blocks`)
  const rpc = new RecordingRpc(http)
  const pools = new PoolRegistry(rpc)
  const launch = await new ArgusAdapter().parseLaunch(log, { rpc, pools })
  out[`${name}Launch`] = { log, recording: rpc.calls, expected: launch, pool: launch?.pool ? pools.get(launch.pool) ?? null : null }
  console.log(name, launch?.symbol, launch?.name, launch?.pool?.slice(0, 12), launch?.quote)
}

// ── swaps ───────────────────────────────────────────────────────────────
const v4 = (await logs({ address: POOL_MANAGER, topics: [V4_SWAP] }, 300)).slice(-12)
const v3 = (await logs({ address: ARGUS_USDC_V3, topics: [V3_SWAP] }, 20_000)).slice(-3)
{
  const rpc = new RecordingRpc(http)
  const pools = new PoolRegistry(rpc)
  const oracle = new QuoteOracle()
  await oracle.seed(rpc)
  const parser = new TradeParser(pools, oracle, new MakerResolver(rpc, 5), () => null)
  const expected = []
  for (const l of [...v3, ...v4]) expected.push(await parser.parse(l))
  out.swaps = { logs: [...v3, ...v4], recording: rpc.calls, expected, pools: pools.all() }
  console.log('swaps parsed:', expected.filter(Boolean).length, 'of', v3.length + v4.length, '— pools', pools.size)
}

mkdirSync(new URL('../test/fixtures', import.meta.url), { recursive: true })
writeFileSync(new URL('../test/fixtures/mainnet.json', import.meta.url), JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
console.log('saved engine/test/fixtures/mainnet.json')
