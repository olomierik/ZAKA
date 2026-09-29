// Records real Peach launches and curve trades for engine/test/peach.test.ts.
// Each trade's expected side comes from its transaction's own token transfer
// (tokens to the trader = buy, from the trader = sell), independently of the
// adapter's decoding.
//
//   bun engine/scripts/capture-peach.ts
//
// Read-only (Blockdaemon, recent blocks). Writes engine/test/fixtures/peach.json.

import { writeFileSync } from 'node:fs'
import { RECENT_RPC, headBlock, hex, rpcCall, type RawLog } from '../../api/_arcLogs'
import { topicAddress } from '../../api/_arcSwaps'
import { HttpRpc } from '../src/chain/http'
import { PEACH_LAUNCHED, PEACH_LAUNCHER, PEACH_TRADE, PeachAdapter } from '../src/launchpads/peach'
import { RecordingRpc } from '../test/helpers/recordRpc'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const head = await headBlock()
const logs = async (filter: object, blocks: number) => {
  const out: RawLog[] = []
  for (let to = head; to > head - blocks; to -= 100_000) out.push(...await rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ ...filter, fromBlock: hex(to - 99_999), toBlock: hex(to) }], 20_000))
  return out
}

const launches = (await logs({ address: PEACH_LAUNCHER, topics: [PEACH_LAUNCHED] }, 100_000)).slice(-2)
const trades = await logs({ topics: [PEACH_TRADE] }, 400_000)
const picked: { log: RawLog; side: 'BUY' | 'SELL'; usdcGross: number; usdcQuoted: boolean }[] = []
const USDC_LOGGERS = ['0x3600000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffffffffffffe']
for (const l of trades.reverse()) {
  if (picked.length >= 6) break
  const rc = await rpcCall<{ logs: RawLog[] } | null>(RECENT_RPC, 'eth_getTransactionReceipt', [l.transactionHash]).catch(() => null)
    ?? await rpcCall<{ logs: RawLog[] } | null>('https://rpc.beamrpc.com', 'eth_getTransactionReceipt', [l.transactionHash]).catch(() => null)
  if (!rc) continue
  const token = topicAddress(l.topics[1]), trader = topicAddress(l.topics[2])
  const moves = rc.logs.filter(x => x.address.toLowerCase() === token && x.topics[0] === TRANSFER)
  const toTrader = moves.some(x => topicAddress(x.topics[2]) === trader), fromTrader = moves.some(x => topicAddress(x.topics[1]) === trader)
  if (toTrader === fromTrader) continue // can't tell from transfers alone: skip
  const side = toTrader ? 'BUY' : 'SELL'
  if (picked.filter(p => p.side === side).length >= 3) continue
  // Quoted in USDC if USDC moved to or from the curve in this transaction.
  const curve = l.address.toLowerCase()
  const usdcQuoted = rc.logs.some(x => USDC_LOGGERS.includes(x.address.toLowerCase()) && x.topics[0] === TRANSFER && (topicAddress(x.topics[1]) === curve || topicAddress(x.topics[2]) === curve))
  picked.push({ log: l, side, usdcGross: Number(BigInt('0x' + l.data.slice(2 + 4 * 64, 2 + 5 * 64))) / 1e6, usdcQuoted })
}

// Replay once through the adapter, recording what it asks the chain: each
// trade's curve is unknown to a fresh adapter, so it's checked against the template.
const run = new RecordingRpc(new HttpRpc([RECENT_RPC]))
const ctx = { rpc: run, pools: null as never }
const adapter = new PeachAdapter()
for (const l of launches) console.log('launch', (await adapter.parseLaunch(l, ctx))?.symbol)
const fresh = new PeachAdapter()
for (const p of picked) { const t = await fresh.parseTrade(p.log, ctx); console.log(`${p.usdcQuoted ? p.side : 'skip (not USDC)'} expected, decoded ${t?.side ?? 'skip'} $${t?.usdValue} @ ${t?.priceUsd}`) }
// A fake emitter: the same event from a contract that isn't a Peach curve (the launcher itself).
const fake = { ...picked[0].log, address: PEACH_LAUNCHER }
console.log('fake emitter:', await fresh.parseTrade(fake, ctx))
writeFileSync(new URL('../test/fixtures/peach.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), launches, trades: picked, fake, rpc: run.calls }, null, 1))
console.log(`wrote engine/test/fixtures/peach.json (${launches.length} launches, ${picked.length} trades)`)
