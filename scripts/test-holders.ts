// Live check of the holder index against Arc mainnet (no database): find a
// token's creation block, scan every Transfer since, and count holders.
//   bun scripts/test-holders.ts [token] [createdIsoHint]
import { headBlock, scanLogs } from '../api/_arcLogs'
import { TRANSFER, creationBlock, deltasOf, mergeDeltas } from '../api/_holdersCore'

const token = (process.argv[2] ?? '0x4b93446882d29e094181b2fae14b126577a2676c').toLowerCase()
const hint = process.argv[3] ? Math.floor(Date.parse(process.argv[3]) / 1000) : null

const t0 = Date.now()
const head = await headBlock()
const from = await creationBlock(token, head, hint)
console.log(`head ${head}, created at block ${from} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${hint ? 'with' : 'no'} hint)`)
if (from === null) process.exit(1)

let at = from - 1
const balances = new Map<string, bigint>()
let slices = 0
let stalls = 0
while (at < head) {
  const t1 = Date.now()
  const res = await scanLogs({ address: token, topics: [TRANSFER] }, at + 1, head, { head, deadline: Date.now() + 14_000, reduce: deltasOf, concurrency: 5 })
  for (const [k, v] of Object.entries(mergeDeltas(res.parts))) balances.set(k, (balances.get(k) ?? 0n) + BigInt(v))
  slices++
  console.log(`  slice ${slices}: blocks ${at + 1}..${res.scannedTo} (${res.scannedTo - at} blocks) in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  // The page polls again after a slice that got nowhere (throttled); so do we.
  if (res.scannedTo <= at) { if (++stalls > 5) throw new Error('no progress'); await new Promise(r => setTimeout(r, 3_000)); continue }
  stalls = 0
  at = res.scannedTo
}
const holders = [...balances].filter(([, v]) => v > 0n)
const negative = [...balances].filter(([, v]) => v < 0n)
console.log(`holders: ${holders.length}  (negative balances: ${negative.length} — must be 0)  total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('top 5:', holders.sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 5).map(([a, v]) => `${a} ${(Number(v) / 1e18).toFixed(0)}`))
if (negative.length) process.exit(1)
