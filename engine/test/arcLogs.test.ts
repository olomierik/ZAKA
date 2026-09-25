// scanLogs must make progress even when it can't finish: a range that runs
// into its deadline returns the contiguous part it completed (regression:
// a catch-up round that never finished never moved the cursor).
import { afterEach, describe, expect, test } from 'bun:test'
import { ARCHIVE_RPCS, RECENT_RPC, scanLogs, setLogEndpoints } from '../../api/_arcLogs'

const realFetch = globalThis.fetch
const endpoints = [RECENT_RPC, [...ARCHIVE_RPCS]] as const
afterEach(() => { globalThis.fetch = realFetch; setLogEndpoints(endpoints[0], [...endpoints[1]]) })

/** Fake JSON-RPC endpoint: one log per block, `ms` per call, and a result cap. */
function fakeRpc(ms: number, cap = Infinity) {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [{ fromBlock: string; toBlock: string }] }
    const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16)
    await new Promise(r => setTimeout(r, ms))
    if (to - from + 1 > cap) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `query exceeds max results ${cap}, retry with the range ${from}-${from + cap - 1}` } }))
    const logs = Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: '0x' + (from + i).toString(16) }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: logs }))
  }) as unknown as typeof fetch
}

describe('scanLogs', () => {
  test('splits where the endpoint says and returns everything in order', async () => {
    setLogEndpoints('http://recent.test', ['http://archive.test'])
    fakeRpc(1, 300)
    const r = await scanLogs({ topics: [] }, 1_000_000, 1_001_999, { head: 1_002_000, reduce: l => l.length })
    expect(r.scannedTo).toBe(1_001_999)
    expect(r.parts.reduce((a, b) => a + b, 0)).toBe(2_000)
  })

  test('a range that runs out of time keeps the part it finished', async () => {
    setLogEndpoints('http://recent.test', ['http://archive.test'])
    fakeRpc(400, 500) // 500 blocks per call, 0.4s each
    const from = 1_000_000
    const r = await scanLogs({ topics: [] }, from, from + 19_999, { head: from + 20_000, reduce: l => l.length, deadline: Date.now() + 2_500 })
    expect(r.scannedTo).toBeGreaterThan(from)          // progress…
    expect(r.scannedTo).toBeLessThan(from + 19_999)    // …but not all of it
    expect(r.parts.reduce((a, b) => a + b, 0)).toBe(r.scannedTo - from + 1) // exactly the prefix
  })
})
