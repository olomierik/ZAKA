// Fast Arc log access, shared by the server (edge functions) and the
// browser. (The leading underscore keeps Vercel from deploying this file as
// its own function.)
//
// Arc's RPCs, measured 2026-09-25:
//   Blockdaemon  rpc.blockdaemon.mainnet.arc.io   100k-block getLogs ranges,
//                handles bursts, CORS *, but keeps only ~900k blocks
//                (≈5 days) of history — older ranges say "pruned".
//   Beam         rpc.beamrpc.com                   full archive, 10k-block
//                ranges, handles bursts.
//   public       rpc.mainnet.arc.io                full archive, 9k-block
//   QuickNode    rpc.quicknode.mainnet.arc.io      ranges, ~2 calls/s each.
// Every endpoint caps one getLogs answer at 20k logs and says where to split.
// So: recent blocks go to Blockdaemon in big spans, older ones to the
// archive endpoints in 9k spans, a few at a time, retried on throttling.

export let RECENT_RPC = 'https://rpc.blockdaemon.mainnet.arc.io'
// Beam twice per rotation: it takes bursts the other two throttle.
export let ARCHIVE_RPCS = ['https://rpc.beamrpc.com', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://rpc.quicknode.mainnet.arc.io']

/** Override the endpoints (the market engine reads them from its env). */
export function setLogEndpoints(recent: string, archive: string[]) {
  if (recent) RECENT_RPC = recent
  if (archive.length) ARCHIVE_RPCS = archive
}
/** Blocks back from the head that Blockdaemon still serves (with margin). */
export const RECENT_DEPTH = 600_000
const RECENT_SPAN = 100_000
const ARCHIVE_SPAN = 9_000

export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockTimestamp?: string
  transactionHash: string
  logIndex: string
  removed?: boolean
}

export class RpcError extends Error {
  constructor(message: string, public code?: number) { super(message) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const hex = (n: number) => '0x' + n.toString(16)

export async function rpcCall<T>(url: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 429) throw new RpcError('rate limited', 429)
  const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } }
  if (j.error) throw new RpcError(j.error.message ?? 'rpc error', j.error.code)
  return j.result as T
}

/** One HTTP request, many calls. Failed entries come back null. */
export async function rpcBatch<T>(url: string, calls: { method: string; params: unknown[] }[], timeoutMs = 10_000): Promise<(T | null)[]> {
  if (calls.length === 0) return []
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 429) throw new RpcError('rate limited', 429)
  const arr = (await res.json()) as { id: number; result?: T; error?: unknown }[]
  if (!Array.isArray(arr)) throw new RpcError('batch not supported')
  const out: (T | null)[] = calls.map(() => null)
  for (const r of arr) if (typeof r.id === 'number' && r.result !== undefined && !r.error) out[r.id] = r.result
  return out
}

/** Latest block, from whichever endpoint answers first. */
export function headBlock(): Promise<number> {
  const urls = [RECENT_RPC, ...new Set(ARCHIVE_RPCS)]
  return new Promise((resolve, reject) => {
    let failed = 0
    for (const u of urls) {
      rpcCall<string>(u, 'eth_blockNumber', [], 5_000)
        .then(h => resolve(parseInt(h, 16)), e => { if (++failed === urls.length) reject(e) })
    }
  })
}

const isThrottle = (e: unknown) => e instanceof RpcError
  ? e.code === 429 || /rate|limit exceeded|too many/i.test(e.message)
  : e instanceof Error && (e.name === 'TimeoutError' || e.name === 'TypeError') // network blip / timeout
const timedOut = (e: unknown) => e instanceof Error && e.name === 'TimeoutError'
const tooMany = (e: unknown) => e instanceof RpcError && /max results|exceeds? max/i.test(e.message)
const pruned = (e: unknown) => e instanceof RpcError && /prun/i.test(e.message)

/** The split point an endpoint suggests ("retry with the range A-B"). */
function suggestedEnd(e: unknown, from: number, to: number): number {
  const m = e instanceof Error ? /range\s+(\d+)\s*-\s*(\d+)/i.exec(e.message) : null
  const b = m ? Number(m[2]) : NaN
  return Number.isFinite(b) && b >= from && b < to ? b : from + Math.floor((to - from) / 2)
}

/** address omitted = every contract (e.g. all Uniswap v3 pools). */
export interface LogFilter { address?: string | string[]; topics: (string | string[] | null)[] }

/** Test hook: see which calls fail and why. */
export const logHooks: { onError?: (url: string, e: unknown) => void } = {}

let rr = 0
async function getLogsOnce(url: string, f: LogFilter, from: number, to: number, timeoutMs: number): Promise<RawLog[]> {
  return rpcCall<RawLog[]>(url, 'eth_getLogs', [{ ...(f.address ? { address: f.address } : {}), topics: f.topics, fromBlock: hex(from), toBlock: hex(to) }], timeoutMs)
}

/** Logs in [from, to] reduced chunk by chunk; splits wherever an endpoint
 * refuses (too many results), falls back to archive where Blockdaemon has
 * pruned, and retries throttling with backoff. Stops at the deadline or on
 * an error it can't get past, returning what it finished (reachedTo). */
async function fetchRange<R>(f: LogFilter, from: number, to: number, recent: boolean, reduce: (logs: RawLog[]) => R, deadline: number): Promise<{ parts: R[]; reachedTo: number }> {
  const out: R[] = []
  let a = from
  let attempts = 0
  let useRecent = recent
  let forcedEnd: number | null = null
  while (a <= to) {
    const b: number = forcedEnd ?? Math.min(to, a + (useRecent ? RECENT_SPAN : ARCHIVE_SPAN) - 1)
    forcedEnd = null
    const left = deadline - Date.now()
    if (left < 800) break
    const url = useRecent ? RECENT_RPC : ARCHIVE_RPCS[rr++ % ARCHIVE_RPCS.length]
    try {
      const logs = await getLogsOnce(url, f, a, b, Math.min(8_000, left))
      out.push(reduce(logs))
      a = b + 1
      attempts = 0
    } catch (e) {
      logHooks.onError?.(url, e)
      // Too many logs: do the part the endpoint accepts, then carry on.
      if (tooMany(e) && b > a) { forcedEnd = suggestedEnd(e, a, b); continue }
      // A dense range can be megabytes of logs and time out: halve it.
      if (timedOut(e) && b - a > 500 && attempts < 6) { forcedEnd = a + Math.floor((b - a) / 2); attempts++; continue }
      if (useRecent && pruned(e)) { useRecent = false; continue }
      if (useRecent && attempts >= 1) { useRecent = false; attempts = 0; continue } // Blockdaemon down → archive
      if (++attempts > 5 || !isThrottle(e)) break
      await sleep(Math.min(3_000, 300 * 2 ** attempts) + Math.random() * 200)
    }
  }
  return { parts: out, reachedTo: a - 1 }
}

export interface ScanResult<R> {
  /** Last block of the contiguous range that was fully scanned (from - 1 if none). */
  scannedTo: number
  /** Reduced results of that range, in block order. */
  parts: R[]
}

/** Scan [from, to] in parallel, in block order. Stops starting new work
 * near `deadline` and returns the contiguous prefix it finished. */
export async function scanLogs<R>(f: LogFilter, from: number, to: number, opts: {
  head: number
  reduce: (logs: RawLog[]) => R
  deadline?: number
  concurrency?: number
}): Promise<ScanResult<R>> {
  const deadline = opts.deadline ?? Date.now() + 60_000
  const recentStart = opts.head - RECENT_DEPTH
  const chunks: { from: number; to: number; recent: boolean }[] = []
  for (let a = from; a <= to;) {
    const recent = a >= recentStart
    // One call per chunk, so a slow or throttled call only holds up itself.
    const span = recent ? RECENT_SPAN : ARCHIVE_SPAN
    const b = Math.min(to, recent ? a + span - 1 : Math.min(a + span - 1, recentStart - 1))
    chunks.push({ from: a, to: b, recent })
    a = b + 1
  }
  const done: ({ parts: R[]; reachedTo: number } | null)[] = chunks.map(() => null)
  let next = 0
  let failed = Infinity
  const worker = async () => {
    while (next < chunks.length && next < failed && Date.now() < deadline - 1_500) {
      const i = next++
      const c = chunks[i]
      try {
        const r = await fetchRange(f, c.from, c.to, c.recent, opts.reduce, deadline)
        done[i] = r
        // Stopped part-way: nothing after this chunk can join the prefix.
        if (r.reachedTo < c.to) failed = Math.min(failed, i)
      } catch { failed = Math.min(failed, i) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, chunks.length) }, worker))
  const parts: R[] = []
  let scannedTo = from - 1
  for (let i = 0; i < chunks.length && done[i]; i++) {
    parts.push(...done[i]!.parts)
    scannedTo = done[i]!.reachedTo
    if (scannedTo < chunks[i].to) break // partial chunk ends the contiguous prefix
  }
  return { scannedTo, parts }
}
