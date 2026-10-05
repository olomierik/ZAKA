// Records real BNB Chain swap logs as fixtures for scripts/test-bsc.ts (2026-10-05): four.meme's TokenPurchase /
// TokenSale events from the last few hundred blocks (with the coin of the newest), and a busy PancakeSwap v2
// pair's Swap events. Reads only; nothing is sent.
// Run: bun scripts/capture-bsc-swaps.ts

import { writeFileSync } from 'node:fs'
import { FOUR } from '../api/_bscCore'
import { FOUR_PURCHASE, FOUR_SALE, V2_SWAP } from '../src/arcdex/api/bscSwaps'

const RPC = 'https://bsc-rpc.publicnode.com'
let id = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
  const j = await r.json() as { result?: T; error?: unknown }
  if (j.error) throw new Error(JSON.stringify(j.error))
  return j.result as T
}
const hex = (n: number) => '0x' + n.toString(16)
const head = parseInt(await rpc<string>('eth_blockNumber', []), 16)
const four = await rpc<{ data: string; topics: string[] }[]>('eth_getLogs', [{ address: FOUR.manager, topics: [[FOUR_PURCHASE, FOUR_SALE]], fromBlock: hex(head - 400), toBlock: hex(head) }])
const coin = four.length ? `0x${four[four.length - 1].data.slice(2 + 24, 2 + 64)}` : null
const gt = await fetch('https://api.geckoterminal.com/api/v2/networks/bsc/tokens/0xeccbb861c0dda7efd964010085488b69317e4444/pools').then(r => r.json()) as { data: { attributes: { address: string }; relationships: { dex: { data: { id: string } }; quote_token: { data: { id: string } } } }[] }
// 龙虾 (a graduated four.meme coin): its PancakeSwap v2 pair.
const v2 = gt.data.find(p => p.relationships.dex.data.id === 'pancakeswap_v2')
if (!v2) throw new Error('no PancakeSwap v2 pair listed for 龙虾')
const pair = v2.attributes.address.toLowerCase()
const swaps = await rpc<unknown[]>('eth_getLogs', [{ address: pair, topics: [V2_SWAP], fromBlock: hex(head - 400), toBlock: hex(head) }])
writeFileSync('scripts/fixtures/bsc-swaps.json', JSON.stringify({
  at: new Date().toISOString(), head,
  four: { coin, logs: four.slice(-30) },
  v2: { pair, coin: '0xeccbb861c0dda7efd964010085488b69317e4444', quote: v2.relationships.quote_token.data.id.replace('bsc_', ''), logs: swaps.slice(-20) },
}, null, 1))
console.log('four.meme logs', four.length, 'coin', coin, '· v2 pair', pair, 'logs', swaps.length)
