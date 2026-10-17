// Records a few PumpSwap transactions of a pool whose base is SOL (ALLOX's), for scripts/test-solana.ts: swaps read from
// their own events (src/arcdex/api/solSwaps.ts swapsFromEvents). Reads only; needs ALCHEMY_API_KEY (or SOL_RPC).
//   ALCHEMY_API_KEY=… bun scripts/capture-sol-events.ts
import { writeFileSync } from 'node:fs'
import { swapsFromEvents, type SolTx } from '../src/arcdex/api/solSwaps'

const RPC = process.env.SOL_RPC ?? `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
const pool = 'Ds2fyB2fnz8F1KjZ8WycHMh2u6aRpjy81errtEtY5nEw'
const call = async (method: string, params: unknown[]) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await r.json()) as { result: unknown }).result
}
const sigs = (await call('getSignaturesForAddress', [pool, { limit: 30, commitment: 'confirmed' }])) as { signature: string; err: unknown }[]
const txs: SolTx[] = []
const meta = { pool, mint: 'DneSmn3NenxC8CMm4vTJUpTYfigZZKWWbyymq8MjFkw3', quoteMint: 'So11111111111111111111111111111111111111112' }
let pair = false, single = false
for (const s of sigs.filter(x => !x.err)) {
  const tx = await call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) as SolTx | null
  const n = tx ? (swapsFromEvents(tx, meta) ?? []).length : 0
  // One transaction with a buy and a sell (a volume bot), and one with a single swap.
  if (tx && n === 2 && !pair) { txs.push(tx); pair = true }
  if (tx && n === 1 && !single) { txs.push(tx); single = true }
  if (pair && single) break
}
writeFileSync(new URL('./fixtures/sol-allox.json', import.meta.url), JSON.stringify({ pool, mint: 'DneSmn3NenxC8CMm4vTJUpTYfigZZKWWbyymq8MjFkw3', txs }))
console.log(`recorded ${txs.length} transactions`)
