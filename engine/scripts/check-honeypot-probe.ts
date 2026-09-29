// End-to-end check of the honeypot probe against Arc mainnet (read-only,
// eth_call with state overrides; nothing is sent):
//   1. a real, healthy coin with a deep pool: ok, low round-trip cost
//   2. the same pool with the coin's code swapped for a deliberate honeypot
//      (contracts/test/sim/HoneypotToken.sol, over the coin's own storage):
//      honeypot
//   3. a freshly created pool with no liquidity: untradeable, not honeypot
//
//   forge build contracts/test/sim/HoneypotToken.sol && bun engine/scripts/check-honeypot-probe.ts

import { readFileSync } from 'node:fs'
import { keccak256, encodeAbiParameters } from 'viem'
import { RECENT_RPC, headBlock, hex, rpcCall, type RawLog } from '../../api/_arcLogs'
import { POOL_MANAGER, V4_INITIALIZE } from '../../api/_arcSwaps'
import { HttpRpc } from '../src/chain/http'
import { PoolRegistry } from '../src/dex/pools'
import { probeHoneypot } from '../src/intel/honeypot'

const rpc = new HttpRpc([RECENT_RPC, 'https://rpc.beamrpc.com'])
const pools = new PoolRegistry(rpc)
let failures = 0
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++ }

// ARCOON, a graduated Peach coin with a deep USDC pool (2026-09-30).
const healthy = await pools.resolve('0xa2ed014384e061ec2aaccea186d41798dcf4da29264c44a676d3006fdc252ae0')
if (!healthy) throw new Error('ARCOON pool not found')

console.log('1. a healthy coin')
const r1 = await probeHoneypot(rpc, healthy)
check(r1.verdict === 'ok', `verdict ${r1.verdict}`)
check((r1.roundTripLossPct ?? 100) < 10, `round trip costs ${r1.roundTripLossPct}% (pool fees both ways)`)
check(r1.buyTaxPct === 0 && r1.transferTaxPct === 0, `no tax in the token (buy ${r1.buyTaxPct}%, transfer ${r1.transferTaxPct}%)`)

console.log('2. the same pool, the coin swapped for a honeypot')
// The trap uses OpenZeppelin's layout: check the coin keeps balances at slot 0 first.
const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [POOL_MANAGER, 0n]))
const [viaCall, viaSlot] = await Promise.all([
  rpcCall<string>(RECENT_RPC, 'eth_call', [{ to: healthy.base, data: '0x70a08231' + POOL_MANAGER.slice(2).padStart(64, '0') }, 'latest']),
  rpcCall<string>(RECENT_RPC, 'eth_getStorageAt', [healthy.base, slot, 'latest']),
])
check(BigInt(viaCall) === BigInt(viaSlot) && BigInt(viaCall) > 0n, `the coin keeps balances at slot 0 (pool holds ${Number(BigInt(viaCall)) / 1e18} tokens)`)
const trap = JSON.parse(readFileSync('contracts/out/HoneypotToken.sol/HoneypotToken.json', 'utf8')).deployedBytecode.object
const r2 = await probeHoneypot(rpc, healthy, 1, { [healthy.base]: { code: trap } })
check(r2.verdict === 'honeypot', `verdict ${r2.verdict}${r2.error ? ` (revert ${r2.error.slice(0, 10)})` : ''}`)
check(r2.error?.startsWith('0x') === true, 'the revert is reported')

console.log('3. a pool with no liquidity')
const head = await headBlock()
const inits = await rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ address: POOL_MANAGER, topics: [V4_INITIALIZE], fromBlock: hex(head - 20_000), toBlock: hex(head) }], 30_000)
let empty = null
for (const l of inits.reverse()) {
  const p = await pools.fromInitialize(l)
  if (!p) continue
  const r = await probeHoneypot(rpc, p)
  if (r.error?.startsWith('no liquidity')) { empty = r; break }
}
check(empty?.verdict === 'untradeable', `verdict ${empty?.verdict ?? 'none found'}: "${empty?.error}"`)

console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL HONEYPOT PROBE CHECKS PASSED')
process.exit(failures ? 1 : 0)
