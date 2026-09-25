// Every swap in one pool, straight from Arc — the coin page's candles,
// trades list and live price. GeckoTerminal's copies lag 10-60s behind the
// chain and are often throttled; the chain isn't.
//
// History: eth_getLogs on Blockdaemon (100k-block ranges, answers in
// ~200ms), walking back from the head until there are enough swaps.
// Live: Arc's WebSocket pushes each swap the moment its block lands (~0.5s
// blocks); after a reconnect the gap is backfilled from the logs.
//
// v4: every pool's swaps come from the one PoolManager, with the PoolId as
//     topic1. v3: the pool contract itself emits Swap. Both put amount0,
//     amount1 and sqrtPriceX96 in the first three data words, but v4's
//     amounts are the swapper's deltas and v3's the pool's — so buy/sell
//     flips between them.

import { ARCHIVE_RPCS, RECENT_RPC, hex, rpcBatch, rpcCall, type RawLog } from '../../../api/_arcLogs'
import { ARC_RPC_WS } from './arcRpc'

export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const USDC = '0x3600000000000000000000000000000000000000'
const ARGUS = '0xece5ca8bf9220718e5727754026757512212cb3c'
/** The deep ARGUS/USDC v3 pool — the reference price for ARGUS-quoted coins. */
const ARGUS_USDC_V3 = '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02'

export interface PoolMeta {
  pool: string   // v4 PoolId (66 chars) or v3 pool address
  token: string
  quote: string
  tokenDecimals: number
  quoteDecimals: number
}

export interface PoolSwap {
  id: string // txHash:logIndex
  txHash: string
  block: number
  logIndex: number
  time: number // ms (block timestamp)
  kind: 'buy' | 'sell'
  tokenAmount: number
  quoteAmount: number
  /** Quote per token — the pool's price right after this swap. */
  price: number
  /** Pushed over the WebSocket this session (vs loaded from history). */
  live?: boolean
}

export function poolMeta(pool: string, token: string, quote: string): PoolMeta {
  const q = quote.toLowerCase()
  return { pool: pool.toLowerCase(), token: token.toLowerCase(), quote: q, tokenDecimals: 18, quoteDecimals: q === USDC ? 6 : 18 }
}

const isV4 = (m: PoolMeta) => m.pool.length === 66
function filterOf(m: PoolMeta) {
  return isV4(m) ? { address: POOL_MANAGER, topics: [V4_SWAP, m.pool] } : { address: m.pool, topics: [V3_SWAP] }
}

const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64)
const signed = (w: string) => BigInt.asIntN(256, BigInt('0x' + w))
const abs = (x: bigint) => (x < 0n ? -x : x)

/** Quote per token from a sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96: bigint, m: PoolMeta): number {
  const s = Number(sqrtPriceX96) / 2 ** 96
  const raw1per0 = s * s
  const scale = 10 ** (m.tokenDecimals - m.quoteDecimals)
  return m.token < m.quote ? raw1per0 * scale : raw1per0 > 0 ? scale / raw1per0 : 0
}

export function decodeSwap(l: RawLog & { removed?: boolean }, m: PoolMeta): PoolSwap | null {
  if (l.removed || !l.data || l.data.length < 2 + 64 * 3) return null
  const a0 = signed(word(l.data, 0))
  const a1 = signed(word(l.data, 1))
  const tokenIs0 = m.token < m.quote
  const tokenLeg = tokenIs0 ? a0 : a1
  const quoteLeg = tokenIs0 ? a1 : a0
  if (tokenLeg === 0n) return null
  const buy = isV4(m) ? tokenLeg > 0n : tokenLeg < 0n
  const block = parseInt(l.blockNumber, 16)
  const logIndex = parseInt(l.logIndex, 16)
  return {
    id: `${l.transactionHash.toLowerCase()}:${logIndex}`,
    txHash: l.transactionHash.toLowerCase(),
    block,
    logIndex,
    time: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
    kind: buy ? 'buy' : 'sell',
    tokenAmount: Number(abs(tokenLeg)) / 10 ** m.tokenDecimals,
    quoteAmount: Number(abs(quoteLeg)) / 10 ** m.quoteDecimals,
    price: priceFromSqrt(BigInt('0x' + word(l.data, 2)), m),
  }
}

/** Newest first. */
export const byRecency = (a: PoolSwap, b: PoolSwap) => b.block - a.block || b.logIndex - a.logIndex

async function getLogs(url: string, m: PoolMeta, from: number, to: number): Promise<RawLog[]> {
  return rpcCall<RawLog[]>(url, 'eth_getLogs', [{ ...filterOf(m), fromBlock: hex(from), toBlock: hex(to) }], 10_000)
}

let headCache: { at: number; v: Promise<number> } | null = null
export function latestBlock(): Promise<number> {
  if (headCache && Date.now() - headCache.at < 2_000) return headCache.v
  const v = rpcCall<string>(RECENT_RPC, 'eth_blockNumber', [], 5_000)
    .catch(() => rpcCall<string>(ARCHIVE_RPCS[0], 'eth_blockNumber', [], 5_000))
    .then(h => parseInt(h, 16))
  headCache = { at: Date.now(), v }
  v.catch(() => { headCache = null })
  return v
}

/** Recent swaps, newest first: walks back from the head until it has
 * `maxSwaps` or has covered `maxBlocks` (~14h at 100k). Spans adapt to the
 * pool's pace so a busy pool doesn't pull megabytes at once. */
export async function loadPoolSwaps(m: PoolMeta, opts: { maxBlocks?: number; maxSwaps?: number; toBlock?: number; onProgress?: (newest: PoolSwap[]) => void } = {}): Promise<{ swaps: PoolSwap[]; fromBlock: number; head: number }> {
  const maxBlocks = opts.maxBlocks ?? 100_000
  const maxSwaps = opts.maxSwaps ?? 4_000
  const head = opts.toBlock ?? await latestBlock()
  const floor = Math.max(0, head - maxBlocks + 1)
  let url = RECENT_RPC
  let maxSpan = 100_000
  let span = 4_000
  let to = head
  let fails = 0
  const out: PoolSwap[] = []
  while (to >= floor && out.length < maxSwaps) {
    const from = Math.max(floor, to - span + 1)
    let logs: RawLog[]
    try {
      logs = await getLogs(url, m, from, to)
      fails = 0
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/max results|too large|range/i.test(msg) && span > 200) { span = Math.max(200, Math.floor(span / 3)); continue }
      // Blockdaemon down, throttled or pruned → an archive endpoint.
      if (++fails <= ARCHIVE_RPCS.length) { url = ARCHIVE_RPCS[(fails - 1) % ARCHIVE_RPCS.length]; maxSpan = 9_000; span = Math.min(span, maxSpan); continue }
      break // keep what we have
    }
    const batch: PoolSwap[] = []
    for (const l of logs) { const s = decodeSwap(l, m); if (s) batch.push(s) }
    out.push(...batch)
    // The newest swaps first, so a page can draw before the rest arrives.
    if (batch.length) opts.onProgress?.(batch.sort(byRecency))
    const density = logs.length / (to - from + 1)
    to = from - 1
    span = Math.max(500, Math.min(maxSpan, density > 0 ? Math.floor(2_500 / density) : maxSpan))
  }
  out.sort(byRecency)
  return { swaps: out.slice(0, maxSwaps), fromBlock: to + 1, head }
}

// ── makers ───────────────────────────────────────────────────────────
// The Swap event names the router, not the trader: the maker is the
// transaction's sender, fetched in batches of 50 per request.
const makerOf = new Map<string, string>()
export async function resolveMakers(txHashes: string[]): Promise<Map<string, string>> {
  const need = [...new Set(txHashes.map(h => h.toLowerCase()))].filter(h => !makerOf.has(h)).slice(0, 300)
  const batches: string[][] = []
  for (let i = 0; i < need.length; i += 50) batches.push(need.slice(i, i + 50))
  await Promise.all(batches.map(async batch => {
    const call = (url: string) => rpcBatch<{ from?: string }>(url, batch.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })), 8_000)
    const res = await call(RECENT_RPC).catch(() => call(ARCHIVE_RPCS[0])).catch(() => [] as ({ from?: string } | null)[])
    res.forEach((t, j) => { if (t?.from) makerOf.set(batch[j], t.from.toLowerCase()) })
  }))
  return makerOf
}
export const knownMaker = (txHash: string) => makerOf.get(txHash.toLowerCase()) ?? null

// ── quote prices ─────────────────────────────────────────────────────
let argusUsd: { at: number; v: Promise<number | null> } | null = null
/** ARGUS in USD from the ARGUS/USDC pool's own price (cached 15s). */
function getArgusUsd(): Promise<number | null> {
  if (argusUsd && Date.now() - argusUsd.at < 15_000) return argusUsd.v
  const v = rpcCall<string>(RECENT_RPC, 'eth_call', [{ to: ARGUS_USDC_V3, data: '0x3850c7bd' }, 'latest'], 5_000)
    .catch(() => rpcCall<string>(ARCHIVE_RPCS[0], 'eth_call', [{ to: ARGUS_USDC_V3, data: '0x3850c7bd' }, 'latest'], 5_000))
    .then(r => {
      // token0 = USDC (6), token1 = ARGUS (18): price = USD per ARGUS.
      const p = priceFromSqrt(BigInt('0x' + word(r, 0)), { pool: ARGUS_USDC_V3, token: ARGUS, quote: USDC, tokenDecimals: 18, quoteDecimals: 6 })
      return p > 0 && Number.isFinite(p) ? p : null
    })
    .catch(() => null)
  argusUsd = { at: Date.now(), v }
  return v
}

/** USD value of one unit of `quote` (USDC = 1), or null if unknown. */
export async function quoteUsd(quote: string): Promise<number | null> {
  const q = quote.toLowerCase()
  if (q === USDC) return 1
  if (q === ARGUS) return getArgusUsd()
  return null
}

// ── live ─────────────────────────────────────────────────────────────
/** Pushes every new swap in the pool as its block lands. After a dropped
 * connection it backfills the missed blocks from the logs, so nothing is
 * skipped. Returns an unsubscribe function. */
export function subscribePoolSwaps(m: PoolMeta, onSwaps: (s: PoolSwap[]) => void, fromBlock?: number): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let lastBlock = fromBlock ?? 0
  let backoff = 1_000

  const backfill = async () => {
    if (!lastBlock) return
    try {
      const head = await latestBlock()
      if (head <= lastBlock) return
      const { swaps } = await loadPoolSwaps(m, { toBlock: head, maxBlocks: Math.min(100_000, head - lastBlock), maxSwaps: 2_000 })
      const fresh = swaps.filter(s => s.block > lastBlock)
      lastBlock = Math.max(lastBlock, head)
      if (fresh.length && !closed) onSwaps(fresh.map(s => ({ ...s, live: true })))
    } catch { /* the next swap still arrives live */ }
  }

  const connect = () => {
    if (closed) return
    ws = new WebSocket(ARC_RPC_WS)
    ws.onopen = () => {
      backoff = 1_000
      ws?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', filterOf(m)] }))
      void backfill()
    }
    ws.onmessage = ev => {
      let msg: { method?: string; params?: { result?: RawLog & { removed?: boolean } } }
      try { msg = JSON.parse(ev.data as string) } catch { return }
      const log = msg.method === 'eth_subscription' ? msg.params?.result : undefined
      if (!log) return
      const s = decodeSwap(log, m)
      if (!s) return
      lastBlock = Math.max(lastBlock, s.block)
      onSwaps([{ ...s, live: true }])
    }
    ws.onclose = () => {
      if (closed) return
      retry = setTimeout(connect, backoff)
      backoff = Math.min(15_000, backoff * 2)
    }
    ws.onerror = () => ws?.close()
  }

  // A tab coming back from the background may have missed swaps while the
  // browser throttled it.
  const onVisible = () => { if (!document.hidden) void backfill() }
  document.addEventListener('visibilitychange', onVisible)

  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    document.removeEventListener('visibilitychange', onVisible)
    ws?.close()
  }
}
