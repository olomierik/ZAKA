// Offline test of lib/recentLogs.ts: which block ranges go to Blockdaemon,
// and where a scan that lost a slice says to resume.
// Run: bun scripts/test-recent-logs.ts

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'

const RECENT_DEPTH = 600_000
let head = 1_000_000
let failing = new Set<number>() // fromBlocks whose call fails
let calls: { url: string; from: number; to: number; address: unknown }[] = []

mock.module('../api/_arcLogs', () => ({
  RECENT_DEPTH,
  RECENT_RPC: 'https://blockdaemon.test',
  hex: (n: number) => '0x' + n.toString(16),
  headBlock: async () => head,
  rpcCall: async (url: string, method: string, params: { fromBlock: string; toBlock: string; address?: unknown }[]) => {
    if (method !== 'eth_getLogs') throw new Error('unexpected ' + method)
    const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16)
    calls.push({ url, from, to, address: params[0].address })
    if (failing.has(from)) throw new Error('rate limited')
    return [{ blockNumber: '0x' + from.toString(16) }]
  },
}))

const { recentLogs, recentLogsSince } = await import('../src/arcdex/lib/recentLogs')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const covers = (a: number, b: number) => {
  const r = [...calls].sort((x, y) => x.from - y.from)
  return r[0].from === a && r[r.length - 1].to === b && r.every((c, i) => i === 0 || c.from === r[i - 1].to + 1) && r.every(c => c.to - c.from < 100_000)
}
const q = { address: ['0x36', '0xfe'], topics: ['0xddf2', null, '0xme'] }

console.log('recentLogsSince')
let r = await recentLogsSince(q, 0)
ok(calls.length === 6 && covers(head - RECENT_DEPTH + 1, head), 'a first scan reads what Blockdaemon serves, in 100k-block calls, no gaps or overlaps')
ok(r.scannedTo === head && r.logs.length === 6, '… and is done up to the head')
ok(calls.every(c => c.url === 'https://blockdaemon.test' && Array.isArray(c.address) && (c.address as string[]).length === 2), 'only Blockdaemon, with both log addresses')

calls = []
r = await recentLogsSince(q, 950_000)
ok(calls.length === 1 && covers(950_001, head) && r.scannedTo === head, 'resuming reads only the blocks since')

calls = []
r = await recentLogsSince(q, head)
ok(calls.length === 0 && r.scannedTo === head, 'nothing new: no calls')

calls = []
failing = new Set([head - RECENT_DEPTH + 1 + 200_000]) // the third slice
r = await recentLogsSince(q, 0)
ok(r.scannedTo === head - RECENT_DEPTH + 200_000, 'a failed slice: resume from just before it')
ok(r.logs.length === 5, '… the slices that answered are still returned (reading them again is harmless)')

calls = []
failing = new Set([700_001])
r = await recentLogsSince(q, 700_000)
ok(r.scannedTo === 700_000, 'the first slice failing: resume from the same block')

calls = []
failing = new Set([head - RECENT_DEPTH + 1])
r = await recentLogsSince(q, 10)
ok(r.scannedTo === head - RECENT_DEPTH, "older than Blockdaemon's range and the first slice failing: blocks it can't serve aren't retried forever")

console.log('recentLogs')
calls = []
failing = new Set()
await recentLogs({ topics: ['0xddf2', null, '0xme'] })
ok(calls.length === 3 && covers(head - 300_000 + 1, head), 'the last 300k blocks in three calls, as before')

console.log('ALL RECENT LOGS CHECKS PASSED')
