// Recent logs from Blockdaemon, which answers 100k-block ranges. Used to
// find a wallet's funding wallets (lib/funding.ts) and the tokens sent to it
// (lib/portfolio.ts).
//
// Deliberately never falls back to the archive endpoints (9k blocks a call):
// that would be dozens of calls on the public RPC every trade also uses. A
// slice that fails is skipped. Callers treat "not found" as the safe answer:
// the passcode is asked, and Portfolio still checks coins bought here and
// the indexes.

import { RECENT_DEPTH, RECENT_RPC, headBlock, hex, rpcCall, type RawLog } from '../../../api/_arcLogs'

const SPAN = 100_000
const DEPTH = 300_000

export interface LogQuery { address?: string | string[]; topics: (string | null)[] }

const getLogs = (filter: LogQuery, a: number, b: number) =>
  rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ ...(filter.address ? { address: filter.address } : {}), topics: filter.topics, fromBlock: hex(a), toBlock: hex(b) }], 10_000)

/** Logs from the last ~2 days (300k blocks), in three calls. */
export async function recentLogs(filter: LogQuery): Promise<RawLog[]> {
  const head = await headBlock()
  const slices: [number, number][] = []
  for (let to = head; to > head - DEPTH && to > 0; to -= SPAN) slices.push([Math.max(0, to - SPAN + 1), to])
  const parts = await Promise.all(slices.map(([a, b]) => getLogs(filter, a, b).catch(() => [] as RawLog[])))
  return parts.flat()
}

/** Logs in the blocks after `after`, but no further back than Blockdaemon
 * serves (RECENT_DEPTH, ~3.5 days). `scannedTo` is the last block of the
 * unbroken range that answered from the start, so a caller that resumes
 * from it never skips a slice that failed (later slices are simply read
 * again). */
export async function recentLogsSince(filter: LogQuery, after: number): Promise<{ logs: RawLog[]; scannedTo: number }> {
  const head = await headBlock()
  const from = Math.max(after + 1, head - RECENT_DEPTH + 1, 0)
  const slices: [number, number][] = []
  for (let a = from; a <= head; a += SPAN) slices.push([a, Math.min(head, a + SPAN - 1)])
  const parts = await Promise.all(slices.map(([a, b]) => getLogs(filter, a, b).catch(() => null)))
  const failed = parts.indexOf(null)
  const scannedTo = failed === -1 ? head : slices[failed][0] - 1
  return { logs: parts.flatMap(p => p ?? []), scannedTo: Math.max(scannedTo, after) }
}
