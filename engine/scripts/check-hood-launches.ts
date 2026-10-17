// Live check, nothing sent: runs the engine's Robinhood Chain reader (src/trench/hood.ts) against mainnet, starting a few
// minutes back, and prints the launches it finds (Pons, Clanker, Bankr) and how many of their trades it read.
//   bun engine/scripts/check-hood-launches.ts [minutesBack=5] [seconds=60]
import { TrenchBook } from '../src/trench/book'
import { HoodFeed, HOOD_RPCS } from '../src/trench/hood'
import { jsonRpc } from '../src/trench/bsc'
import { NativePrices } from '../src/trench/prices'
import type { TrenchMessage } from '../../api/_trenchProtocol'

const minutes = Number(process.argv[2] ?? 5), seconds = Number(process.argv[3] ?? 60)
const book = new TrenchBook('hood', undefined, () => false)
const prices = new NativePrices()
prices.start()
const launches: TrenchMessage[] = []
let smart = 0
const rpc = jsonRpc(HOOD_RPCS)
const feed = new HoodFeed({ book, prices, pools: () => [], rpc, publish: m => { if (m.t === 'TLAUNCH') launches.push(m); else smart++ } })
const head = parseInt(await rpc.call<string>('eth_blockNumber', []), 16)
;(feed as unknown as { last: number }).last = head - Math.round((minutes * 60_000) / 102)
console.log(`reading from ${minutes} min back (block ${head - Math.round((minutes * 60_000) / 102)}) for ${seconds}s…`)
// Wait for an ETH price before reading, so trades are priced.
for (let i = 0; i < 20 && !prices.usd('ETH'); i++) await new Promise(r => setTimeout(r, 500))
const t0 = Date.now()
while (Date.now() - t0 < seconds * 1000) {
  await feed.poll().catch(e => console.log('poll failed:', e instanceof Error ? e.message : e))
  await new Promise(r => setTimeout(r, 1_000))
}
prices.stop()
const ls = book.recentLaunches(100)
console.log(`\n${ls.length} launches:`)
for (const l of ls) console.log(`  ${l.lp.padEnd(8)} ${String(l.s).padEnd(12)} ${l.a}  ${Math.round((Date.now() - l.c) / 1000)}s ago  mc $${Math.round(l.m)}  trades ${l.b}/${l.x}  progress ${l.g === null ? '—' : l.g.toFixed(1) + '%'}`)
console.log(`\nETH $${prices.usd('ETH')}; TLAUNCH messages ${launches.length}`)
process.exit(ls.length ? 0 : 1)
