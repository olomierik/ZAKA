// Robinhood Chain swaps straight from the chain, as poolSwaps.ts does for
// Arc: the last ~50 minutes of a pool's swaps from the logs at once, then
// every new one within about a second of its block, so the coin page's
// trades, price and chart pops move as Arc's do. GeckoTerminal (polled far
// less often) still fills in older trades and their makers.
//
// Robinhood Chain's public RPC has no WebSocket and refuses batches, so new
// swaps are polled: one getLogs and one latest-block read every 0.8 s while
// the tab is visible (measured 2026-10-04: ~0.3 s a read, 20 at once fine).
// QuickNode serves Robinhood Chain over WebSocket too, but needs an endpoint
// of the owner's and bills every event. The chain's logs carry no block time
// (blockTimestamp is 0x0) and its blocks come ~10 a second, so a swap's time
// is counted back from the latest block at the measured rate.

import { rpcCall } from '../../../api/_arcLogs'
import { V3_SWAP, V4_INITIALIZE, V4_SWAP, decodeSwapLog, priceFromSqrt, topicAddress, word, type SwapLogLike } from '../../../api/_arcSwaps'
import { NATIVE, RH_RPC, USDG, WETH, rhTokenInfo } from '../lib/robinhood'

/** Uniswap v4's PoolManager on Robinhood Chain (the same address as Arc's): Uniswap's and Pons's v4 pools swap there. */
export const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Uniswap v2-style Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to). */
export const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
/** Uniswap v3's WETH/USDG pool (token0 WETH): ETH's price in dollars, from its own state. */
const WETH_USDG_V3 = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca'

/** Seconds per block, measured 2026-10-04 over 100k blocks (0.102 s). */
const BLOCK_MS = 102
/** Blocks read at once when the page opens (~50 minutes). */
const FIRST_SPAN = 30_000
/** Further back when that found few swaps (~8.5 hours; an address-filtered query may span this far, up to 10k logs). */
const DEEP_SPAN = 300_000
/** Each poll re-reads this many blocks before the last one seen, so a node a block or two behind can't skip a swap. */
const OVERLAP = 30

export interface RhPoolMeta {
  /** A v4 pool's 32-byte id, or a v2/v3 pool's address (lower case). */
  pool: string
  coin: string
  quote: string
  coinDecimals: number
  quoteDecimals: number
}

export interface RhSwap {
  /** `${txHash}:${logIndex}`. */
  id: string
  txHash: string
  block: number
  logIndex: number
  /** ms, estimated from the block number (see above). */
  time: number
  kind: 'buy' | 'sell'
  tokenAmount: number
  quoteAmount: number
  /** The coin's price in the quote, after the swap. */
  price: number
  /** Arrived after the page opened. */
  live?: boolean
}

type RawLog = SwapLogLike & { blockNumber: string; logIndex: string }
const hex = (n: number) => '0x' + Math.max(0, n).toString(16)
const rpc = <T>(method: string, params: unknown[], timeoutMs = 8_000) => rpcCall<T>(RH_RPC, method, params, timeoutMs)

const isV4 = (pool: string) => pool.length === 66
/** A background tab (never outside a browser). */
const hidden = () => typeof document !== 'undefined' && document.hidden

/** What the pool's swaps are read with: v4 swaps by pool id on the PoolManager; v2/v3 swaps by the pool's address. */
function filterOf(m: RhPoolMeta): { address: string; topics: (string | string[])[] } {
  return isV4(m.pool)
    ? { address: RH_POOL_MANAGER, topics: [V4_SWAP, m.pool] }
    : { address: m.pool, topics: [[V3_SWAP, V2_SWAP]] }
}

/** One swap log, or null when it isn't one of this pool's. */
export function decodeRhSwap(l: RawLog, m: RhPoolMeta, timeOf: (block: number) => number): RhSwap | null {
  if (l.removed) return null
  const v4 = isV4(m.pool)
  if (v4 ? l.address.toLowerCase() !== RH_POOL_MANAGER || l.topics[1]?.toLowerCase() !== m.pool : l.address.toLowerCase() !== m.pool) return null
  const coinIs0 = m.coin < m.quote
  const block = parseInt(l.blockNumber, 16)
  const logIndex = parseInt(l.logIndex, 16)
  const base = { id: `${l.transactionHash.toLowerCase()}:${logIndex}`, txHash: l.transactionHash.toLowerCase(), block, logIndex, time: timeOf(block) }
  if (!v4 && l.topics[0] === V2_SWAP) {
    if (!l.data || l.data.length < 2 + 64 * 4) return null
    const [in0, in1, out0, out1] = [0, 1, 2, 3].map(i => BigInt('0x' + word(l.data, i)))
    const coinIn = coinIs0 ? in0 : in1, coinOut = coinIs0 ? out0 : out1
    const quoteIn = coinIs0 ? in1 : in0, quoteOut = coinIs0 ? out1 : out0
    const buy = coinOut > 0n
    const tokenAmount = Number(buy ? coinOut : coinIn) / 10 ** m.coinDecimals
    const quoteAmount = Number(buy ? quoteIn : quoteOut) / 10 ** m.quoteDecimals
    if (!(tokenAmount > 0)) return null
    return { ...base, kind: buy ? 'buy' : 'sell', tokenAmount, quoteAmount, price: quoteAmount / tokenAmount }
  }
  if (!v4 && l.topics[0] !== V3_SWAP) return null
  const d = decodeSwapLog(l, { v4, baseIs0: coinIs0, baseDecimals: m.coinDecimals, quoteDecimals: m.quoteDecimals })
  if (!d || !(d.baseAmount > 0)) return null
  return { ...base, kind: d.side === 'BUY' ? 'buy' : 'sell', tokenAmount: d.baseAmount, quoteAmount: d.quoteAmount, price: d.price }
}

const byRecency = (a: RhSwap, b: RhSwap) => b.block - a.block || b.logIndex - a.logIndex

// ── block times ──────────────────────────────────────────────────────────

interface Clock { block: number; ms: number; rate: number }
interface Block { number: string; timestamp: string }

/** The latest block, timed by this browser's clock as it arrives: block times are whole seconds and
 * run ~1 s behind, so a swap just in would read "2s ago". `ts` is the block's own time. */
const latestBlock = async (): Promise<{ block: number; ms: number; ts: number }> => {
  const b = await rpc<Block>('eth_getBlockByNumber', ['latest', false])
  return { block: parseInt(b.number, 16), ms: Date.now() - 150, ts: parseInt(b.timestamp, 16) * 1000 }
}
/** A block's time from the latest one read, never in the future. */
const timeAt = (c: Clock) => (block: number) => Math.min(Date.now(), c.ms + (block - c.block) * c.rate)

// ── loading and watching ─────────────────────────────────────────────────

/** The pool's latest swaps, newest first: the last ~50 minutes, or ~8.5 hours when that found few. */
export async function loadRhSwaps(m: RhPoolMeta): Promise<{ swaps: RhSwap[]; head: number }> {
  const head = await latestBlock()
  const clock: Clock = { block: head.block, ms: head.ms, rate: BLOCK_MS }
  const read = async (from: number, to: number) => {
    const logs = await rpc<RawLog[]>('eth_getLogs', [{ ...filterOf(m), fromBlock: hex(from), toBlock: hex(to) }], 12_000)
    return logs.map(l => decodeRhSwap(l, m, timeAt(clock))).filter((s): s is RhSwap => !!s)
  }
  let swaps = await read(head.block - FIRST_SPAN, head.block)
  if (swaps.length < 50) {
    // Few swaps lately: read further back, timing it against that block's own clock.
    const from = head.block - DEEP_SPAN
    const older = await Promise.all([
      read(from, head.block - FIRST_SPAN - 1),
      rpc<Block>('eth_getBlockByNumber', [hex(from), false]),
    ]).then(([list, b]) => {
      const rate = (head.ts - parseInt(b.timestamp, 16) * 1000) / DEEP_SPAN
      if (rate > 20 && rate < 2_000) clock.rate = rate
      return list.map(s => ({ ...s, time: timeAt(clock)(s.block) }))
    }).catch(() => [] as RhSwap[])
    swaps = [...swaps.map(s => ({ ...s, time: timeAt(clock)(s.block) })), ...older]
  }
  return { swaps: swaps.sort(byRecency), head: head.block }
}

/** Every new swap in the pool, about a second after its block, while the tab
 * is visible (a hidden tab catches up when it's shown). `known` are the ids
 * already loaded. Returns a stop function. */
export function watchRhSwaps(m: RhPoolMeta, fromBlock: number, known: Iterable<string>, onSwaps: (s: RhSwap[]) => void, everyMs = 800): () => void {
  let stopped = false
  let last = fromBlock
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  const seen = new Set<string>(known)
  const clock: Clock = { block: 0, ms: 0, rate: BLOCK_MS }

  const poll = async () => {
    if (stopped || busy || hidden()) return schedule(everyMs)
    busy = true
    const started = Date.now()
    // Polls start `everyMs` apart (not `everyMs` after the last one ended): a swap shows ~0.4 s
    // after its block on average, plus the read itself (~0.3 s).
    let wait = -1
    try {
      const [head, logs] = await Promise.all([
        latestBlock(),
        rpc<RawLog[]>('eth_getLogs', [{ ...filterOf(m), fromBlock: hex(last - OVERLAP), toBlock: 'latest' }]),
      ])
      clock.block = head.block; clock.ms = head.ms
      const fresh: RhSwap[] = []
      for (const l of logs) {
        const s = decodeRhSwap(l, m, timeAt(clock))
        if (!s || seen.has(s.id)) continue
        seen.add(s.id)
        fresh.push({ ...s, live: true })
      }
      last = Math.max(last, head.block, ...logs.map(l => parseInt(l.blockNumber, 16)))
      // Only the overlap is ever read again, so old ids can go.
      if (seen.size > 4_000) for (const id of [...seen].slice(0, 2_000)) seen.delete(id)
      if (fresh.length && !stopped) onSwaps(fresh.sort(byRecency))
    } catch (e) {
      // Throttled: give the RPC a few seconds. A range too long after a long sleep: start again from the head.
      const msg = e instanceof Error ? e.message : ''
      if (/rate|429|too many/i.test(msg)) wait = 5_000
      else if (/exceed|limit|range/i.test(msg)) last = await latestBlock().then(h => h.block).catch(() => last)
    } finally {
      busy = false
    }
    schedule(wait >= 0 ? wait : Math.max(150, everyMs - (Date.now() - started)))
  }
  const schedule = (ms: number) => { if (!stopped) { if (timer) clearTimeout(timer); timer = setTimeout(() => void poll(), ms) } }
  const onVisible = () => { if (!hidden()) schedule(0) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  schedule(0)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}

// ── a pool's two tokens, from the chain ──────────────────────────────────

/** Blocks one getLogs may span on the public RPC. */
const MAX_RANGE = 10_000_000
const poolTokens = new Map<string, Promise<[string, string] | null>>()

/** A pool's two tokens (lower case, address order), read from the chain, so a
 * link to a pool can start on its swaps before GeckoTerminal answers. A v2/v3
 * pool answers token0()/token1(); a v4 pool's are in its Initialize event,
 * looked for across the chain's history in parallel slices. */
export function rhPoolTokens(pool: string): Promise<[string, string] | null> {
  const p = pool.toLowerCase()
  let v = poolTokens.get(p)
  if (!v) {
    v = (isV4(p) ? v4Tokens(p) : Promise.all([
      rpc<string>('eth_call', [{ to: p, data: '0x0dfe1681' }, 'latest']),
      rpc<string>('eth_call', [{ to: p, data: '0xd21220a7' }, 'latest']),
    ]).then(([a, b]) => (a?.length >= 66 && b?.length >= 66 ? [topicAddress(a), topicAddress(b)] as [string, string] : null)))
      .catch(() => null)
    v.then(x => { if (!x) poolTokens.delete(p) }, () => poolTokens.delete(p))
    poolTokens.set(p, v)
  }
  return v
}

/** Newest slice first, one at a time (the RPC refuses a browser's burst of
 * them): a launchpad's pool is nearly always in the latest ~11 days. */
async function v4Tokens(id: string): Promise<[string, string] | null> {
  const head = (await latestBlock()).block
  for (let to = head; to >= 0; to -= MAX_RANGE) {
    const filter = { address: RH_POOL_MANAGER, topics: [V4_INITIALIZE, id], fromBlock: hex(Math.max(0, to - MAX_RANGE + 1)), toBlock: hex(to) }
    const logs = await rpc<RawLog[]>('eth_getLogs', [filter])
      .catch(() => new Promise(r => setTimeout(r, 600)).then(() => rpc<RawLog[]>('eth_getLogs', [filter])))
    const l = logs.find(x => x.topics[1]?.toLowerCase() === id)
    if (l) return [topicAddress(l.topics[2]), topicAddress(l.topics[3])]
  }
  return null
}

// ── makers ───────────────────────────────────────────────────────────────

const makers = new Map<string, string>()
const asking = new Set<string>()

/** Who sent each transaction (the trader, not the router the pool sees), three
 * reads at a time (the RPC refuses batches). Calls `onFound` as they land. */
export async function resolveRhMakers(txHashes: string[], onFound: () => void): Promise<void> {
  const need = [...new Set(txHashes.map(h => h.toLowerCase()))].filter(h => !makers.has(h) && !asking.has(h)).slice(0, 60)
  need.forEach(h => asking.add(h))
  let i = 0
  const worker = async () => {
    while (i < need.length) {
      const h = need[i++]
      const tx = await rpc<{ from?: string } | null>('eth_getTransactionByHash', [h]).catch(() => null)
      asking.delete(h)
      if (tx?.from) { makers.set(h, tx.from.toLowerCase()); onFound() }
    }
  }
  await Promise.all([worker(), worker(), worker()])
}
export const rhMaker = (txHash: string) => makers.get(txHash.toLowerCase()) ?? null

// ── the quote's price and decimals ───────────────────────────────────────

let ethUsd: { at: number; v: Promise<number | null> } | null = null
/** ETH in dollars, from Uniswap v3's WETH/USDG pool on Robinhood Chain (cached 30s). */
export function rhEthUsd(): Promise<number | null> {
  if (ethUsd && Date.now() - ethUsd.at < 30_000) return ethUsd.v
  const v = rpc<string>('eth_call', [{ to: WETH_USDG_V3, data: '0x3850c7bd' }, 'latest'])
    .then(r => {
      // token0 = WETH (18), token1 = USDG (6).
      const p = priceFromSqrt(BigInt('0x' + word(r, 0)), true, 18, 6)
      return p > 50 && p < 1e6 ? p : null
    })
    .catch(() => null)
  ethUsd = { at: Date.now(), v }
  return v
}

/** Dollars per unit of `quote`: USDG 1, WETH and ETH at ETH's price, else null (the page then prices it off the coin's market price). */
export async function rhQuoteUsd(quote: string): Promise<number | null> {
  const q = quote.toLowerCase()
  if (q === USDG) return 1
  if (q === WETH || q === NATIVE) return rhEthUsd()
  return null
}

const KNOWN_DECIMALS: Record<string, number> = { [USDG]: 6, [WETH]: 18, [NATIVE]: 18 }
/** A quote token's decimals (read once from the chain when it isn't USDG, WETH or ETH). */
export async function rhDecimals(token: string): Promise<number | null> {
  const t = token.toLowerCase()
  if (t in KNOWN_DECIMALS) return KNOWN_DECIMALS[t]
  const info = await rhTokenInfo(t)
  if (info) KNOWN_DECIMALS[t] = info.decimals
  return info?.decimals ?? null
}
