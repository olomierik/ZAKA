// Records real Faze launches and trades for engine/test/faze.test.ts. Each
// trade's expected side comes from its own token transfer, and whether it's
// priced in native USDC from native USDC moving to or from Faze in that
// transaction: independent of the adapter's decoding.
//
//   bun engine/scripts/capture-faze.ts
//
// Read-only. Writes engine/test/fixtures/faze.json.

import { writeFileSync } from 'node:fs'
import { headBlock, rpcCall, scanLogs, type RawLog } from '../../api/_arcLogs'
import { topicAddress } from '../../api/_arcSwaps'
import { HttpRpc } from '../src/chain/http'
import { FAZE, FAZE_BOUGHT, FAZE_LAUNCHED, FAZE_SOLD, FazeAdapter } from '../src/launchpads/faze'
import { RecordingRpc } from '../test/helpers/recordRpc'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const head = await headBlock()
const r = await scanLogs<RawLog[]>({ address: FAZE, topics: [[FAZE_LAUNCHED, FAZE_BOUGHT, FAZE_SOLD]] }, head - 900_000, head, { head, reduce: l => l, deadline: Date.now() + 180_000 })
const all = r.parts.flat()
const launches = all.filter(l => l.topics[0] === FAZE_LAUNCHED).slice(-2)
const picked: { log: RawLog; side: 'BUY' | 'SELL'; nativeQuoted: boolean; usdc: number }[] = []
for (const l of all.filter(l => l.topics[0] !== FAZE_LAUNCHED).reverse()) {
  if (picked.length >= 8) break
  const rc = await rpcCall<{ logs: RawLog[] } | null>('https://rpc.beamrpc.com', 'eth_getTransactionReceipt', [l.transactionHash]).catch(() => null)
  if (!rc) continue
  const token = topicAddress(l.topics[1]), trader = topicAddress(l.topics[2])
  const moves = rc.logs.filter(x => x.address.toLowerCase() === token && x.topics[0] === TRANSFER)
  const toTrader = moves.some(x => topicAddress(x.topics[2]) === trader), fromTrader = moves.some(x => topicAddress(x.topics[1]) === trader)
  if (toTrader === fromTrader) continue
  const side = toTrader ? 'BUY' : 'SELL'
  const usdcMoves = rc.logs.filter(x => x.address.toLowerCase() === NATIVE_LOGGER && x.topics[0] === TRANSFER && (topicAddress(x.topics[1]) === FAZE || topicAddress(x.topics[2]) === FAZE))
  const nativeQuoted = usdcMoves.length > 0
  const key = `${side}:${nativeQuoted}`
  if (picked.filter(p => `${p.side}:${p.nativeQuoted}` === key).length >= 2) continue
  // What the trader paid (buy) or got (sell), in native USDC.
  const usdc = usdcMoves.filter(x => topicAddress(side === 'BUY' ? x.topics[2] : x.topics[1]) === FAZE).reduce((s, x) => s + Number(BigInt(x.data)) / 1e18, 0)
  picked.push({ log: l, side, nativeQuoted, usdc })
}

const run = new RecordingRpc(new HttpRpc(['https://rpc.beamrpc.com']))
const ctx = { rpc: run, pools: null as never }
for (const l of launches) console.log('launch', (await new FazeAdapter().parseLaunch(l, ctx))?.symbol ?? 'not native-USDC')
for (const p of picked) {
  const t = await new FazeAdapter().parseTrade(p.log, ctx)
  console.log(`${p.nativeQuoted ? p.side : 'skip (not USDC)'} expected ($${p.usdc.toFixed(4)}), decoded ${t?.side ?? 'skip'} $${t?.usdValue?.toFixed(4)}`)
}
writeFileSync(new URL('../test/fixtures/faze.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), launches, trades: picked, rpc: run.calls }, null, 1))
console.log(`wrote engine/test/fixtures/faze.json (${launches.length} launches, ${picked.length} trades)`)
