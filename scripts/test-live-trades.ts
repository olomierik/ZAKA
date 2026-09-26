// Offline test of the coin page's live data: trade ages (lib/ago.ts),
// merging GeckoTerminal's trades with the chain's (api/poolSwaps.ts) and the
// live holder count (api/holders.ts).
// Run: bun scripts/test-live-trades.ts

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'

// The Supabase and chain readers are passed in as stubs; keep their modules offline.
mock.module('../src/arcdex/api/social', () => ({ getHolderScans: async () => [], getIndexedBalances: async () => new Map() }))

const { agoShort } = await import('../src/arcdex/lib/ago')
const { geckoSwap, mergeSwaps } = await import('../src/arcdex/api/poolSwaps')
const { liveHolderCount } = await import('../src/arcdex/api/holders')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

console.log('ages')
const now = Date.UTC(2026, 8, 26, 12, 0, 0)
const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h
const cases: [number, string][] = [[0, '0s'], [59 * s, '59s'], [60 * s, '1m'], [59 * m + 59 * s, '59m'], [h, '1h'], [23 * h, '23h'], [d, '1d'], [29 * d, '29d'], [30 * d, '1mo'], [45 * d, '1mo'], [70 * d, '2mo'], [364 * d, '11mo'], [366 * d, '1y'], [800 * d, '2y'], [-5 * s, '0s']]
for (const [ago, want] of cases) ok(agoShort(now - ago, now) === want, `${ago / 1000}s ago → ${want} (got ${agoShort(now - ago, now)})`)

console.log('merging GeckoTerminal with the chain')
const tx = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const gt = (n: number, logIndex: number | null, block: number, kind: 'buy' | 'sell' = 'buy') => geckoSwap({ txHash: tx(n).toUpperCase().replace('0X', '0x'), maker: '0xabc', kind, usd: 10 * n, tokenAmount: 100 * n, priceUsd: 0.1, timestamp: block * 500, block, logIndex }, true)
const chain = (n: number, logIndex: number, block: number) => ({ id: `${tx(n)}:${logIndex}`, txHash: tx(n), block, logIndex, time: block * 500, kind: 'buy' as const, tokenAmount: 100 * n, quoteAmount: 10 * n, price: 0.1 })

let list = mergeSwaps(null, [gt(1, 3, 100), gt(2, null, 101)])!
ok(list.length === 2 && list[0].block === 101, 'GeckoTerminal trades show at once, newest first')
ok(list.every(x => x.gecko && x.priceUsd === 0.1 && x.usd! > 0), 'they carry their USD price and size (they move the chart)')
ok(list.find(x => x.block === 100)!.id === `${tx(1)}:3`, "with a log index in its id, a GeckoTerminal trade gets the chain's own id")
const same = mergeSwaps(list, [gt(1, 3, 100)])
ok(same === list, 'the same GeckoTerminal trade again changes nothing')
list = mergeSwaps(list, [chain(1, 3, 100)])!
ok(list.length === 2 && !list.find(x => x.block === 100)!.gecko, "the chain's copy replaces GeckoTerminal's (same id)")
list = mergeSwaps(list, [chain(2, 7, 101)])!
ok(list.length === 2 && list.every(x => !x.gecko), "…and one GeckoTerminal couldn't match by id is replaced by its transaction")
const again = mergeSwaps(list, [gt(2, null, 101), gt(1, 3, 100)])
ok(again === list, 'GeckoTerminal never re-adds a swap the chain already has')
list = mergeSwaps(list, [gt(3, 1, 105, 'sell')])!
ok(list.length === 3 && list[0].kind === 'sell' && list[0].live, 'a newer GeckoTerminal trade lands on top, live')

console.log('live holders')
const T0 = '0x' + 'cc'.repeat(20)
const addr = (c: string) => '0x' + c.repeat(40)
const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const log = (from: string, to: string, v: bigint) => ({ address: T0, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)], data: '0x' + v.toString(16).padStart(64, '0'), blockNumber: '0x1', transactionHash: tx(9), logIndex: '0x0' })
const POOLM = addr('8'), NEW = addr('1'), SELLER = addr('2'), PARTIAL = addr('3')
const indexed = new Map([[POOLM, 1000n], [SELLER, 50n], [PARTIAL, 40n]])
let scanned = 500
let scanCalls = 0
const deps = {
  scans: async () => { scanCalls++; return [{ token: T0, holders: 3, scanned_to: scanned }] },
  balances: async (_t: string, hs: string[]) => new Map(hs.filter(a => indexed.has(a)).map(a => [a, indexed.get(a)!])),
  logs: async (_t: string, from: number) => (from === scanned + 1 ? [log(POOLM, NEW, 5n), log(SELLER, POOLM, 50n), log(PARTIAL, POOLM, 10n)] : []),
}
const cache = { scannedTo: -1, balances: new Map<string, bigint>() }
ok(await liveHolderCount(T0, cache, deps) === 3, '3 indexed + a new buyer (+1) − a holder who sold everything (−1) = 3')
deps.logs = async () => [log(POOLM, NEW, 5n), log(POOLM, addr('4'), 7n)]
ok(await liveHolderCount(T0, cache, deps) === 5, 'two new buyers since the index: 5')
deps.logs = async () => []
ok(await liveHolderCount(T0, cache, deps) === 3, 'nothing new since the index: its own count')
const before = scanCalls
deps.logs = async () => [log(POOLM, NEW, 5n)]
await liveHolderCount(T0, cache, deps)
ok(scanCalls - before === 1, 'wallets already looked up are not fetched again (one scan read)')
deps.logs = async () => [log(POOLM, addr('5'), 1n)]
deps.scans = async () => { scanCalls++; const r = [{ token: T0, holders: 3, scanned_to: scanned }]; scanned += 10; return r }
ok(await liveHolderCount(T0, { scannedTo: -1, balances: new Map() }, deps) === 'moved', 'the index moving mid-read is detected (asked again)')
ok(await liveHolderCount(T0, cache, { ...deps, scans: async () => [] }) === null, 'a token the index does not have: no live count')
console.log('ALL LIVE TRADES CHECKS PASSED')
