// Robinhood Chain's trades within seconds (the Trenches' live feed, trench/service.ts): the swaps of the pools its list
// shows, polled once a second from the block after the last one read. v4 pools (Uniswap's, and Pons's after
// graduation) swap through the PoolManager, read by pool id; v2 and v3 pools by address. The chain's public RPC refuses
// batches and its logs carry no block time (blocks come every ~0.1 s), so a swap's time is counted back from the latest
// block, and each trader (the transaction's sender) is read one call at a time, four at once.
//
// New launches there still come from the list (GeckoTerminal, read by the engine every ~6 minutes): Robinhood Chain's
// launchpads each deploy their own way, and none of them was traced to a launch event yet.

import { V2_SWAP } from './bsc'
import { POOL_MANAGER, V3_SWAP, V4_SWAP, decodeSwapLog, word } from '../../../api/_arcSwaps'
import { NATIVE, RH_RPC_URL, USDG, WETH } from '../../../api/_rhCore'
import type { TrenchMessage } from '../../../api/_trenchProtocol'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import type { TrenchBook } from './book'
import type { NativePrices } from './prices'
import { jsonRpc, type RawLog } from './bsc'

export const HOOD_RPCS = [RH_RPC_URL, 'https://robinhood-rpc.publicnode.com']
const BLOCK_MS = 102
const MAX_SPAN = 300

/** A listed pool: a v4 pool's 32-byte id, or a v2/v3 pool's address. */
export interface HoodPool {
  pool: string; coin: string; quote: string; coinDecimals: number; supply: number
  /** A pool quoted in another listed coin (not USDG, WETH or ETH): that coin's price in the list, its decimals. */
  quoteUsd?: number | null
  quoteDecimals?: number
}

export function decodeHoodSwap(l: RawLog, p: HoodPool): { buy: boolean; tokens: number; quote: number; price: number } | null {
  if (l.removed || !l.data) return null
  const v4 = p.pool.length === 66
  if (v4 ? l.address.toLowerCase() !== POOL_MANAGER || l.topics[1]?.toLowerCase() !== p.pool : l.address.toLowerCase() !== p.pool) return null
  const coinIs0 = p.coin < p.quote
  const quoteDecimals = p.quote === USDG ? 6 : p.quoteDecimals ?? 18
  if (!v4 && l.topics[0] === V2_SWAP) {
    if (l.data.length < 2 + 64 * 4) return null
    const [in0, in1, out0, out1] = [0, 1, 2, 3].map(i => BigInt('0x' + word(l.data, i)))
    const coinOut = coinIs0 ? out0 : out1, coinIn = coinIs0 ? in0 : in1
    const quoteIn = coinIs0 ? in1 : in0, quoteOut = coinIs0 ? out1 : out0
    const buy = coinOut > 0n
    const tokens = Number(buy ? coinOut : coinIn) / 10 ** p.coinDecimals
    const quote = Number(buy ? quoteIn : quoteOut) / 10 ** quoteDecimals
    return tokens > 0 && quote > 0 ? { buy, tokens, quote, price: quote / tokens } : null
  }
  if (v4 ? l.topics[0] !== V4_SWAP : l.topics[0] !== V3_SWAP) return null
  const d = decodeSwapLog(l, { v4, baseIs0: coinIs0, baseDecimals: p.coinDecimals, quoteDecimals })
  return d && d.baseAmount > 0 ? { buy: d.side === 'BUY', tokens: d.baseAmount, quote: d.quoteAmount, price: d.price } : null
}

export interface HoodFeedOpts {
  book: TrenchBook
  prices: NativePrices
  publish: (m: TrenchMessage) => void
  pools: () => HoodPool[]
  rpc?: ReturnType<typeof jsonRpc>
}

export class HoodFeed {
  private last = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private senders = new Map<string, string | null>()
  private rpc: ReturnType<typeof jsonRpc>
  connected = false
  stopped = false

  constructor(private o: HoodFeedOpts) { this.rpc = o.rpc ?? jsonRpc(HOOD_RPCS) }

  start() { this.loop() }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer) }

  private loop() {
    if (this.stopped) return
    void this.poll().catch(e => { this.connected = false; metrics.inc('trench_hood_errors'); log.debug('trench hood: poll failed', { error: errMsg(e) }) })
      .finally(() => { if (!this.stopped) this.timer = setTimeout(() => this.loop(), 1_000) })
  }

  async poll(now = Date.now()) {
    const pools = this.o.pools()
    const head = parseInt(await this.rpc.call<string>('eth_blockNumber', []), 16)
    if (!this.last) this.last = head - 20
    const from = this.last + 1
    if (from > head) return
    const to = Math.min(head, from + MAX_SPAN)
    this.connected = true
    if (!pools.length) { this.last = to; return }
    const v4 = new Map(pools.filter(p => p.pool.length === 66).map(p => [p.pool, p]))
    const other = new Map(pools.filter(p => p.pool.length === 42).map(p => [p.pool, p]))
    const logs = await this.rpc.call<RawLog[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: [POOL_MANAGER, ...other.keys()].slice(0, 400), topics: [[V4_SWAP, V3_SWAP, V2_SWAP]] }])
    this.last = to
    const mine = logs.map(l => ({ l, p: l.address.toLowerCase() === POOL_MANAGER ? v4.get(l.topics[1]?.toLowerCase() ?? '') : other.get(l.address.toLowerCase()) }))
      .filter((x): x is { l: RawLog; p: HoodPool } => !!x.p)
    if (!mine.length) return
    await this.readSenders([...new Set(mine.map(x => x.l.transactionHash.toLowerCase()))])
    const eth = this.o.prices.usd('ETH', now)
    for (const { l, p } of mine) {
      metrics.inc('trench_hood_events')
      const d = decodeHoodSwap(l, p)
      if (!d) continue
      const qUsd = p.quote === USDG ? 1 : p.quote === WETH || p.quote === NATIVE ? eth : p.quoteUsd ?? null
      if (!qUsd) continue
      const priceUsd = d.price * qUsd
      const st = this.o.book.trade({
        token: p.coin, wallet: this.senders.get(l.transactionHash.toLowerCase()) ?? null, side: d.buy ? 'buy' : 'sell', usd: d.quote * qUsd, tokens: d.tokens,
        ts: Math.min(now, now - (head - parseInt(l.blockNumber, 16)) * BLOCK_MS), priceUsd, mcapUsd: p.supply > 0 ? priceUsd * p.supply : null,
      })
      if (st) this.o.publish({ t: 'TSMART', c: 'hood', d: st })
    }
  }

  /** Each transaction's sender, four reads at a time (the RPC refuses batches). */
  private async readSenders(txs: string[]) {
    const todo = txs.filter(h => !this.senders.has(h)).slice(0, 40)
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(h => this.rpc.call<{ from?: string } | null>('eth_getTransactionByHash', [h])
        .then(t => { this.senders.set(h, t?.from?.toLowerCase() ?? null) }).catch(() => {})))
    }
    if (this.senders.size > 20_000) { let n = 0; for (const k of this.senders.keys()) { this.senders.delete(k); if (++n >= 5_000) break } }
  }
}
