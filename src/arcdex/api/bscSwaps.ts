// BNB Chain swaps straight from the chain (2026-10-05), as rhSwaps.ts does for Robinhood Chain: a coin
// page's trades, price and chart pops within about a second of their block, where GeckoTerminal's
// trades come tens of seconds late.
//
//   a coin on four.meme's curve   TokenManager2's TokenPurchase / TokenSale events. The coin isn't an
//                                 indexed topic, so every four.meme trade is read (a few a block) and the
//                                 coin's kept. Each event names its trader.
//   PancakeSwap v2                the pair's Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)
//   PancakeSwap v3                the pool's Swap, Uniswap v3's with two protocol-fee words added
// Other venues (PancakeSwap Infinity) stay on GeckoTerminal's trades.
//
// The public RPC (measured 2026-10-05): blocks every 0.45s; logs carry their block's time; one getLogs
// may span 5,000 blocks, and only the last ~2 hours are served without a key ("archive requests"), so
// history is read in 4,000-block slices, newest first; batches are accepted (makers are read 20 at a time).

import { rpcCall } from '../../../api/_arcLogs'
import { V3_SWAP, decodeSwapLog, word, type SwapLogLike } from '../../../api/_arcSwaps'
import { BSC_RPC_BROWSER, FOUR } from '../../../api/_bscCore'
import type { ChainFeed, ChainSwap } from '../lib/useChainTrades'

/** Uniswap v2-style Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to): PancakeSwap v2's pairs. */
export const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
/** PancakeSwap v3's Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128). */
export const PCS_V3_SWAP = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83'
/** four.meme's TokenPurchase / TokenSale(token, account, price, amount, cost, fee, offers, funds). */
export const FOUR_PURCHASE = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942'
export const FOUR_SALE = '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19'

export type BscPoolKind = 'four' | 'v2' | 'v3'

export interface BscPoolMeta {
  /** The pool's address (four.meme's manager for a curve coin). */
  pool: string
  kind: BscPoolKind
  coin: string
  quote: string
  coinDecimals: number
  quoteDecimals: number
}

/** Which reader a GeckoTerminal venue's pools take, if any. */
export function bscPoolKind(dex: string): BscPoolKind | null {
  if (dex === 'four-meme') return 'four'
  if (dex === 'pancakeswap_v2') return 'v2'
  if (dex === 'pancakeswap-v3-bsc') return 'v3'
  return null
}

type RawLog = SwapLogLike & { blockNumber: string; logIndex: string; blockTimestamp?: string }

const SLICE = 4_000
const SLICES = 4
const OVERLAP = 6
const hex = (n: number) => '0x' + Math.max(0, n).toString(16)
const rpc = <T>(method: string, params: unknown[], timeoutMs = 10_000) => rpcCall<T>(BSC_RPC_BROWSER, method, params, timeoutMs)
const hidden = () => typeof document !== 'undefined' && document.hidden

export function filterOf(m: BscPoolMeta): { address: string; topics: (string | string[])[] } {
  if (m.kind === 'four') return { address: FOUR.manager, topics: [[FOUR_PURCHASE, FOUR_SALE]] }
  return { address: m.pool, topics: [m.kind === 'v2' ? [V2_SWAP] : [PCS_V3_SWAP, V3_SWAP]] }
}

const big = (data: string, i: number) => BigInt('0x' + word(data, i))
const timeOf = (l: RawLog) => (l.blockTimestamp && l.blockTimestamp !== '0x0' ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now())

/** One log as a swap of this pool's coin, or null. */
export function decodeBscSwap(l: RawLog, m: BscPoolMeta): ChainSwap | null {
  if (l.removed || !l.data) return null
  const block = parseInt(l.blockNumber, 16)
  const logIndex = parseInt(l.logIndex, 16)
  const txHash = l.transactionHash.toLowerCase()
  const base = { id: `${txHash}:${logIndex}`, txHash, time: timeOf(l), block, logIndex }
  if (m.kind === 'four') {
    if (l.address.toLowerCase() !== FOUR.manager || l.data.length < 2 + 64 * 6) return null
    const topic = l.topics[0]?.toLowerCase()
    if (topic !== FOUR_PURCHASE && topic !== FOUR_SALE) return null
    if (`0x${word(l.data, 0).slice(24)}` !== m.coin) return null
    const tokenAmount = Number(big(l.data, 3)) / 10 ** m.coinDecimals
    const quoteAmount = Number(big(l.data, 4)) / 10 ** m.quoteDecimals
    if (!(tokenAmount > 0) || !(quoteAmount > 0)) return null
    return { ...base, kind: topic === FOUR_PURCHASE ? 'buy' : 'sell', tokenAmount, quoteAmount, price: quoteAmount / tokenAmount, maker: `0x${word(l.data, 1).slice(24)}` }
  }
  if (l.address.toLowerCase() !== m.pool) return null
  const coinIs0 = m.coin < m.quote
  if (m.kind === 'v2') {
    if (l.topics[0] !== V2_SWAP || l.data.length < 2 + 64 * 4) return null
    const [in0, in1, out0, out1] = [0, 1, 2, 3].map(i => big(l.data, i))
    const coinIn = coinIs0 ? in0 : in1, coinOut = coinIs0 ? out0 : out1
    const quoteIn = coinIs0 ? in1 : in0, quoteOut = coinIs0 ? out1 : out0
    const buy = coinOut > 0n
    const tokenAmount = Number(buy ? coinOut : coinIn) / 10 ** m.coinDecimals
    const quoteAmount = Number(buy ? quoteIn : quoteOut) / 10 ** m.quoteDecimals
    if (!(tokenAmount > 0) || !(quoteAmount > 0)) return null
    return { ...base, kind: buy ? 'buy' : 'sell', tokenAmount, quoteAmount, price: quoteAmount / tokenAmount }
  }
  if (l.topics[0] !== PCS_V3_SWAP && l.topics[0] !== V3_SWAP) return null
  const d = decodeSwapLog(l, { v4: false, baseIs0: coinIs0, baseDecimals: m.coinDecimals, quoteDecimals: m.quoteDecimals })
  if (!d || !(d.baseAmount > 0)) return null
  return { ...base, kind: d.side === 'BUY' ? 'buy' : 'sell', tokenAmount: d.baseAmount, quoteAmount: d.quoteAmount, price: d.price }
}

type Positioned = ChainSwap & { block: number; logIndex: number }
const byRecency = (a: Positioned, b: Positioned) => b.block - a.block || b.logIndex - a.logIndex
const decodeAll = (logs: RawLog[], m: BscPoolMeta) => logs.map(l => decodeBscSwap(l, m) as Positioned | null).filter((s): s is Positioned => !!s)

/** The pool's latest swaps, newest first: the last ~30 minutes, or up to ~2 hours when that found few. */
export async function loadBscSwaps(m: BscPoolMeta): Promise<{ swaps: ChainSwap[]; head: number }> {
  const head = parseInt(await rpc<string>('eth_blockNumber', []), 16)
  const read = (from: number, to: number) => rpc<RawLog[]>('eth_getLogs', [{ ...filterOf(m), fromBlock: hex(from), toBlock: hex(to) }], 15_000).then(l => decodeAll(l, m))
  let swaps = await read(head - SLICE + 1, head)
  for (let i = 1; i < SLICES && swaps.length < 50; i++) {
    const to = head - i * SLICE
    const older = await read(to - SLICE + 1, to).catch(() => null)
    if (!older) break // older blocks need a key on the public RPC
    swaps = [...swaps, ...older]
  }
  return { swaps: swaps.sort(byRecency), head }
}

/** Every new swap, about a second after its block, while the tab is visible. Returns a stop function. */
export function watchBscSwaps(m: BscPoolMeta, fromBlock: number, known: Iterable<string>, onSwaps: (s: ChainSwap[]) => void, everyMs = 1_000): () => void {
  let stopped = false
  let last = fromBlock
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  const seen = new Set<string>(known)

  const poll = async () => {
    if (stopped || busy || hidden()) return schedule(everyMs)
    busy = true
    const started = Date.now()
    let wait = -1
    try {
      const head = parseInt(await rpc<string>('eth_blockNumber', []), 16)
      // A tab hidden for long: start again near the head rather than ask for more than one call may span.
      if (head - last > SLICE) last = head - 200
      const logs = await rpc<RawLog[]>('eth_getLogs', [{ ...filterOf(m), fromBlock: hex(last - OVERLAP), toBlock: hex(head) }])
      const fresh: ChainSwap[] = []
      for (const s of decodeAll(logs, m).sort(byRecency)) {
        if (seen.has(s.id)) continue
        seen.add(s.id)
        fresh.push({ ...s, live: true })
      }
      last = Math.max(last, head)
      if (seen.size > 4_000) for (const id of [...seen].slice(0, 2_000)) seen.delete(id)
      if (fresh.length && !stopped) onSwaps(fresh)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/rate|429|too many/i.test(msg)) wait = 5_000
    } finally {
      busy = false
    }
    schedule(wait >= 0 ? wait : Math.max(200, everyMs - (Date.now() - started)))
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

/** The pool as a feed for the coin page (lib/useChainTrades.ts). */
export function bscFeed(m: BscPoolMeta): ChainFeed<number> {
  return {
    key: `bsc:${m.kind}:${m.pool}:${m.coin}:${m.quote}:${m.coinDecimals}`,
    load: () => loadBscSwaps(m).then(r => ({ swaps: r.swaps, cursor: r.head })),
    watch: (head, known, onSwaps) => watchBscSwaps(m, head, known, onSwaps),
  }
}

// ── makers (a PancakeSwap swap names the router, not the trader) ─────────

const makers = new Map<string, string>()
const asking = new Set<string>()

/** Each transaction's sender, 20 to a batch request. Calls `onFound` once they land. */
export async function resolveBscMakers(txHashes: string[], onFound: () => void): Promise<void> {
  const need = [...new Set(txHashes.map(h => h.toLowerCase()))].filter(h => !makers.has(h) && !asking.has(h)).slice(0, 40)
  if (!need.length) return
  need.forEach(h => asking.add(h))
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20)
    try {
      const res = await fetch(BSC_RPC_BROWSER, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map((h, n) => ({ jsonrpc: '2.0', id: n, method: 'eth_getTransactionByHash', params: [h] }))),
        signal: AbortSignal.timeout(10_000),
      })
      const out = await res.json() as { id: number; result?: { from?: string } | null }[]
      for (const r of Array.isArray(out) ? out : []) if (r.result?.from) makers.set(chunk[r.id], r.result.from.toLowerCase())
    } catch { /* asked again next time */ }
    chunk.forEach(h => asking.delete(h))
  }
  onFound()
}
export const bscMaker = (txHash: string) => makers.get(txHash.toLowerCase()) ?? null
