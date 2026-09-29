// Records real Arc mainnet answers for engine/test/v4Launches.test.ts: the
// pool Initialize of one launch each on Aka.fun, o1 and Minara, one Argus
// launch (its adapter's, so the generic detector must leave it), and a new
// pool for a coin that already existed (not a launch).
//
//   bun engine/scripts/capture-v4-launches.ts
//
// Read-only (Beam, full archive). Writes engine/test/fixtures/v4-launches.json.

import { writeFileSync } from 'node:fs'
import { hex, type RawLog } from '../../api/_arcLogs'
import { POOL_MANAGER, V4_INITIALIZE, topicAddress } from '../../api/_arcSwaps'
import { HttpRpc } from '../src/chain/http'
import { PoolRegistry } from '../src/dex/pools'
import { V4LaunchDetector } from '../src/launchpads/v4Launches'
import { RecordingRpc } from '../test/helpers/recordRpc'

const rpc = new RecordingRpc(new HttpRpc(['https://rpc.beamrpc.com']))

// From engine/scripts/discover-launchpads.ts (2026-09-30).
const LAUNCHES = [
  { launchpad: 'Aka.fun', token: '0x6cf4e84588ae60f18c23a049bc55202d951a8e3d', block: 22876848 },
  { launchpad: 'o1', token: '0x28f986a61e078795639f239675582a12b4cf7f01', block: 21163352 },
  { launchpad: 'Minara', token: '0x1e849f5960f02503939cbcbd44ab99b6dfcc4735', block: 21136026 },
  { launchpad: 'ARGUS', token: '0x8d1a01160068e44c6ca11bf7807ae62498fb37dd', block: 23397051 },
]

type Receipt = { logs: RawLog[] }
async function initializeOf(token: string, block: number): Promise<RawLog> {
  const receipts = await rpc.call<Receipt[]>('eth_getBlockReceipts', [hex(block)])
  const ts = (await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex(block), false])).timestamp
  for (const r of receipts) for (const l of r.logs) {
    if (l.address.toLowerCase() === POOL_MANAGER && l.topics[0] === V4_INITIALIZE && (topicAddress(l.topics[2]) === token || topicAddress(l.topics[3]) === token)) return { ...l, blockTimestamp: l.blockTimestamp ?? ts }
  }
  throw new Error(`no Initialize for ${token} in block ${block}`)
}

const cases: { label: string; expect: string | null; log: RawLog }[] = []
for (const x of LAUNCHES) cases.push({ label: `${x.launchpad} launch`, expect: x.launchpad === 'ARGUS' ? null : x.launchpad, log: await initializeOf(x.token, x.block) })

// A new pool for a coin that already had code: scan recent Initializes for one.
const head = parseInt(await rpc.call<string>('eth_blockNumber', []), 16)
const recent = await rpc.call<RawLog[]>('eth_getLogs', [{ address: POOL_MANAGER, topics: [V4_INITIALIZE], fromBlock: hex(head - 9_000), toBlock: hex(head) }])
const pools = new PoolRegistry(rpc)
for (const l of recent.reverse()) {
  const info = await pools.fromInitialize(l)
  if (!info) continue
  const code = await rpc.call<string>('eth_getCode', [info.base, hex(parseInt(l.blockNumber, 16) - 1)])
  if (code !== '0x') { cases.push({ label: 'new pool for an existing coin', expect: null, log: l }); break }
}

// Run the detector once, recording only the answers it (and the pool registry) needs.
const run = new RecordingRpc(new HttpRpc(['https://rpc.beamrpc.com']))
const detector = new V4LaunchDetector(run, () => false)
const reg = new PoolRegistry(run)
for (const c of cases) {
  const info = await reg.fromInitialize(c.log)
  const got = info ? await detector.detect(c.log, info) : null
  console.log(`${c.label}: ${got ? `${got.launchpad} ${got.symbol} by ${got.creator}` : 'not a launch'} (expected ${c.expect ?? 'not a launch'})`)
}
writeFileSync(new URL('../test/fixtures/v4-launches.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), cases, rpc: run.calls }, null, 1))
console.log('wrote engine/test/fixtures/v4-launches.json')
