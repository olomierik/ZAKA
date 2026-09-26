// Logs from the last ~2 days (300k blocks) in three calls to Blockdaemon,
// which answers 100k-block ranges. Used to find a wallet's funding wallets
// (lib/funding.ts) and the tokens sent to it (lib/portfolio.ts).
//
// Deliberately never falls back to the archive endpoints (9k blocks a call):
// that would be dozens of calls on the public RPC every trade also uses. A
// slice that fails is skipped. Callers treat "not found" as the safe answer:
// the passcode is asked, and Portfolio still checks coins bought here and
// the indexes.

import { RECENT_RPC, headBlock, hex, rpcCall, type RawLog } from '../../../api/_arcLogs'

const SPAN = 100_000
const DEPTH = 300_000

export async function recentLogs(filter: { address?: string; topics: (string | null)[] }): Promise<RawLog[]> {
  const head = await headBlock()
  const slices: [number, number][] = []
  for (let to = head; to > head - DEPTH && to > 0; to -= SPAN) slices.push([Math.max(0, to - SPAN + 1), to])
  const parts = await Promise.all(slices.map(([a, b]) =>
    rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ ...(filter.address ? { address: filter.address } : {}), topics: filter.topics, fromBlock: hex(a), toBlock: hex(b) }], 10_000)
      .catch(() => [] as RawLog[]),
  ))
  return parts.flat()
}
