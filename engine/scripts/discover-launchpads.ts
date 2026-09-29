// Finds how each Arc launch venue launches coins, from real coins: which
// contract the launch transaction goes to, its function selector, and the
// events every contract in it emits. That's what an engine adapter needs
// (engine/src/launchpads/). Evidence, not documentation: every address
// comes from a transaction that created a listed coin.
//
//   bun engine/scripts/discover-launchpads.ts [perVenue=4] [venue-id …]
//
// Read-only. GeckoTerminal's free API (paced) for venues and recent pools;
// Beam (full archive) for code, blocks and receipts.

import { hex, rpcCall } from '../../api/_arcLogs'

const GT = 'https://api.geckoterminal.com/api/v2'
const ARCHIVE = 'https://rpc.beamrpc.com'
const perVenue = Number(process.argv[2] ?? 4)
const only = process.argv.slice(3)

// Plain DEXes: their pools aren't launches (same idea as api/_launchpads.ts GENERIC_DEX).
const GENERIC = /uniswap|pancake|sushi|curve|balancer|algebra|camelot|aerodrome|velodrome|izumi|kyber|maverick|dodo|woofi|fluid|ambient|syncswap|pegd|stable|aero-arc|synthra|archery|unitflow|dyorswap/

let lastGt = 0
async function gt<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastGt + 2_200 - Date.now()
    if (wait > 0) await Bun.sleep(wait)
    lastGt = Date.now()
    const r = await fetch(GT + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (r?.status === 429) { await Bun.sleep(15_000); continue }
    if (!r?.ok) return null
    return await r.json() as T
  }
  return null
}
const rpc = <T>(method: string, params: unknown[]) => rpcCall<T>(ARCHIVE, method, params, 20_000)

type Log = { address: string; topics: string[]; data: string }
type Receipt = { transactionHash: string; from: string; to: string | null; contractAddress: string | null; logs: Log[] }

const head = parseInt(await rpc<string>('eth_blockNumber', []), 16)
const tsOf = async (b: number) => parseInt((await rpc<{ timestamp: string }>('eth_getBlockByNumber', [hex(b), false])).timestamp, 16)
const headTs = await tsOf(head)
/** Seconds per block, measured over the last ~1M blocks. */
const blockTime = (headTs - await tsOf(head - 1_000_000)) / 1_000_000

/** Code at a block, retried: an RPC error is not "no code". */
async function codeAt(token: string, b: number): Promise<string> {
  for (let i = 0; ; i++) {
    try { return await rpc<string>('eth_getCode', [token, hex(b)]) }
    catch (e) { if (i >= 3) throw e; await Bun.sleep(500 * 2 ** i) }
  }
}
/** The block that created `token`: binary search on getCode, starting near
 * the pool's creation time (block time estimated from the chain itself). */
async function creationBlock(token: string, createdAtSec: number): Promise<number | null> {
  const has = async (b: number) => (await codeAt(token, b)) !== '0x'
  if (!(await has(head))) return null
  const guess = Math.max(0, head - Math.round((headTs - createdAtSec) / blockTime))
  let lo = Math.max(0, guess - 50_000), hi = head
  if (await has(lo)) lo = 0
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid }
  return hi
}

const ZERO_TOPIC = '0x' + '0'.repeat(64)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

async function launchTx(token: string, block: number) {
  const receipts = await rpc<Receipt[]>('eth_getBlockReceipts', [hex(block)])
  const t = token.toLowerCase()
  const rc = receipts.find(r => r.contractAddress?.toLowerCase() === t)
    ?? receipts.find(r => r.logs.some(l => l.address.toLowerCase() === t && l.topics[0] === TRANSFER && l.topics[1] === ZERO_TOPIC))
    ?? receipts.find(r => r.logs.some(l => l.address.toLowerCase() === t))
  if (!rc) return null
  const tx = await rpc<{ input: string; to: string | null; from: string }>('eth_getTransactionByHash', [rc.transactionHash])
  return { rc, selector: tx.input.slice(0, 10), to: tx.to?.toLowerCase() ?? null, from: tx.from.toLowerCase() }
}

type Venue = { id: string; name: string }
const venues: Venue[] = []
for (let page = 1; page <= 6; page++) {
  const r = await gt<{ data: { id: string; attributes: { name: string } }[] }>(`/networks/arc/dexes?page=${page}`)
  if (!r?.data.length) break
  venues.push(...r.data.map(d => ({ id: d.id, name: d.attributes.name })))
}
console.log(`block time ${blockTime.toFixed(3)}s`)
console.log(`${venues.length} venues on Arc: ${venues.map(v => v.id).join(', ')}\n`)

const targets = only.length ? only.map(id => venues.find(v => v.id === id) ?? { id, name: id }) : venues.filter(v => !GENERIC.test(v.id))
for (const v of targets) {
  const pools = await gt<{ data: { attributes: { address: string; pool_created_at: string; name: string }; relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } } } }[] }>(`/networks/arc/dexes/${v.id}/pools?page=1&sort=pool_created_at_desc`)
    ?? await gt<any>(`/networks/arc/dexes/${v.id}/pools?page=1`)
  const list = (pools?.data ?? []).slice(0, perVenue)
  console.log(`== ${v.id} (${v.name}): ${pools?.data?.length ?? 0} pools listed`)
  const tos = new Map<string, number>(), sels = new Map<string, number>(), events = new Map<string, number>()
  for (const p of list) {
    const token = p.relationships.base_token.data.id.replace(/^arc_/, '').toLowerCase()
    const quote = p.relationships.quote_token.data.id.replace(/^arc_/, '').toLowerCase()
    const created = Math.floor(Date.parse(p.attributes.pool_created_at) / 1000)
    try {
      const block = await creationBlock(token, created)
      if (block === null) { console.log(`   ${p.attributes.name}: token ${token} has no code`); continue }
      const lt = await launchTx(token, block)
      if (!lt) { console.log(`   ${p.attributes.name}: creation tx not found in block ${block}`); continue }
      const emitted = [...new Set(lt.rc.logs.filter(l => l.address.toLowerCase() !== token).map(l => `${l.address.toLowerCase()}:${l.topics[0]?.slice(0, 10)}(${l.topics.length})`))]
      console.log(`   ${p.attributes.name.padEnd(22)} token ${token} block ${block} pool ${p.attributes.address.slice(0, 12)}… quote ${quote.slice(0, 10)}`)
      console.log(`      tx → ${lt.to} ${lt.selector} from ${lt.from.slice(0, 10)} | emits ${emitted.join(' ')}`)
      if (lt.to) tos.set(lt.to, (tos.get(lt.to) ?? 0) + 1)
      sels.set(lt.selector, (sels.get(lt.selector) ?? 0) + 1)
      for (const e of emitted) events.set(e, (events.get(e) ?? 0) + 1)
    } catch (e) { console.log(`   ${p.attributes.name}: ${(e as Error).message.slice(0, 120)}`) }
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`).join(' | ')
  if (tos.size) console.log(`   ⇒ sent to: ${top(tos)}\n   ⇒ selectors: ${top(sels)}\n   ⇒ events in every launch: ${[...events].filter(([, n]) => n === Math.max(...events.values())).map(([k]) => k).join(' ')}`)
  console.log('')
}
