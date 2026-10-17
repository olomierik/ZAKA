// Robinhood Chain's trades within seconds (the Trenches' live feed, trench/service.ts): the swaps of the pools its list
// shows, polled once a second from the block after the last one read. v4 pools (Uniswap's, and Pons's after
// graduation) swap through the PoolManager, read by pool id; v2 and v3 pools by address. The chain's public RPC refuses
// batches and its logs carry no block time (blocks come every ~0.1 s), so a swap's time is counted back from the latest
// block, and each trader (the transaction's sender) is read one call at a time, four at once.
//
// New launches: Pons, Clanker and Bankr are read from the chain in the same poll, within about a second (hoodLaunches.ts),
// and their curves and pools join the trades read. Other launchpads still come from the list (GeckoTerminal, read by the
// engine every ~6 minutes).

import { V2_SWAP } from './bsc'
import { POOL_MANAGER, V3_SWAP, V4_SWAP, decodeSwapLog, word } from '../../../api/_arcSwaps'
import { NATIVE, RH_RPC_URL, USDG, WETH } from '../../../api/_rhCore'
import type { TrenchMessage } from '../../../api/_trenchProtocol'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import type { TrenchBook } from './book'
import type { NativePrices } from './prices'
import { jsonRpc, type RawLog } from './bsc'
import { ERC20_SEL, PONS_BUY, PONS_LAUNCH, PONS_LAUNCHER, PONS_SELL, cleanName, decodeHoodInit, decodePonsLaunch, decodePonsTrade, decodeString, decodeUint, initPrice, type HoodInit, type PonsLaunch } from './hoodLaunches'
import { V4_INITIALIZE } from '../../../api/_arcSwaps'

export const HOOD_RPCS = [RH_RPC_URL, 'https://robinhood-rpc.publicnode.com']
const BLOCK_MS = 102
const MAX_SPAN = 300

/** A listed pool: a v4 pool's 32-byte id, or a v2/v3 pool's address. */
export interface HoodPool {
  pool: string; coin: string; quote: string; coinDecimals: number; supply: number
  /** A pool quoted in another listed coin (not USDG, WETH or ETH): that coin's price in the list, its decimals. */
  quoteUsd?: number | null
  quoteDecimals?: number
  /** A Pons bonding curve (its own buy and sale events), not a DEX pool. */
  kind?: 'pons'
}

/** How long a coin launched while watching keeps its pool or curve in the read (the list carries it after). */
const LAUNCH_KEEP_MS = 2 * 3_600_000
const MAX_ADDRESSES = 400
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x' + '0'.repeat(64)
/** ~10 minutes of Robinhood Chain blocks (0.102 s each). */
const FRESH_BLOCKS = 6_000
/** A Pons curve's realQuoteReserve(): the ETH on it (api/rhmarket.ts reads the same for the list). */
const REAL_QUOTE_RESERVE = '0x4f1f58fd'
interface Curve { coin: string; supply: number; thresholdEth: number; netEth: number; at: number }

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
  /** Coins launched while watching: Pons curves by address, Clanker and Bankr pools by id. */
  private curves = new Map<string, Curve>()
  private launchedPools = new Map<string, HoodPool & { at: number }>()
  /** Pools a launchpad hook opened for a coin that wasn't new. */
  private notLaunches = new Set<string>()
  /** When each launched Pons curve's ETH was last read from the curve itself. */
  private reserveReadAt = new Map<string, number>
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
    this.prune(now)
    const listed = this.o.pools()
    // Listed Pons curves are read like the ones launched while watching (their own buy and sale events).
    for (const p of listed) if (p.kind === 'pons' && !this.curves.has(p.pool)) this.curves.set(p.pool, { coin: p.coin, supply: p.supply, thresholdEth: 4.2, netEth: 0, at: 0 })
    const pools = [...listed.filter(p => p.kind !== 'pons'), ...this.launchedPools.values()]
    const head = parseInt(await this.rpc.call<string>('eth_blockNumber', []), 16)
    if (!this.last) this.last = head - 20
    const from = this.last + 1
    if (from > head) return
    const to = Math.min(head, from + MAX_SPAN)
    this.connected = true
    const v4 = new Map(pools.filter(p => p.pool.length === 66).map(p => [p.pool, p]))
    const other = new Map(pools.filter(p => p.pool.length === 42).map(p => [p.pool, p]))
    // The newest curves first: the address list has room for 400.
    const curves = [...this.curves.entries()].sort((a, b) => b[1].at - a[1].at).map(([c]) => c)
    const address = [POOL_MANAGER, PONS_LAUNCHER, ...curves, ...other.keys()].slice(0, MAX_ADDRESSES)
    const logs = await this.rpc.call<RawLog[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address, topics: [[V4_SWAP, V3_SWAP, V2_SWAP, V4_INITIALIZE, PONS_LAUNCH, PONS_BUY, PONS_SELL]] }])
    this.last = to
    const tsOf = (l: RawLog) => Math.min(now, now - (head - parseInt(l.blockNumber, 16)) * BLOCK_MS)

    // Launches first, so the same batch's first trades (usually the creator's buy) land on them.
    for (const l of logs) {
      const pl = decodePonsLaunch(l)
      if (pl) { await this.ponsLaunched(pl, tsOf(l), now).catch(e => log.debug('trench hood: pons launch not read', { error: errMsg(e) })); continue }
      const hi = decodeHoodInit(l)
      if (hi) await this.poolLaunched(hi, l, tsOf(l), now).catch(e => log.debug('trench hood: launch not read', { error: errMsg(e) }))
    }
    for (const p of this.launchedPools.values()) if (!v4.has(p.pool)) v4.set(p.pool, p)

    const eth = this.o.prices.usd('ETH', now)
    // Pons curves' buys and sales: progress counts the ETH on the curve against its graduation threshold.
    for (const l of logs) {
      const c = this.curves.get(l.address.toLowerCase())
      const d = c ? decodePonsTrade(l) : null
      if (!c || !d || !eth) continue
      metrics.inc('trench_hood_events')
      c.netEth = Math.max(0, c.netEth + (d.buy ? d.eth : -d.eth))
      const priceUsd = d.price * eth
      const st = this.o.book.trade({
        token: c.coin, wallet: d.trader, side: d.buy ? 'buy' : 'sell', usd: d.eth * eth, tokens: d.tokens, ts: tsOf(l),
        priceUsd, mcapUsd: c.supply > 0 ? priceUsd * c.supply : null, liquidityUsd: c.at ? c.netEth * eth : undefined,
        progress: c.at && c.thresholdEth > 0 ? Math.min(100, (c.netEth / c.thresholdEth) * 100) : undefined,
      })
      if (st) this.o.publish({ t: 'TSMART', c: 'hood', d: st })
    }
    // The counted ETH drifts (fees, a missed block): the curves that traded are read again, at most every 5 seconds each.
    const touched = [...new Set(logs.map(l => l.address.toLowerCase()))].filter(a => this.curves.get(a)?.at && now - (this.reserveReadAt.get(a) ?? 0) > 5_000).slice(0, 10)
    await Promise.all(touched.map(async a => {
      this.reserveReadAt.set(a, now)
      const r = await this.rpc.call<string>('eth_call', [{ to: a, data: REAL_QUOTE_RESERVE }, 'latest']).catch(() => null)
      const c = this.curves.get(a)
      if (c && r && r !== '0x') c.netEth = Number(decodeUint(r)) / 1e18
    }))

    const mine = logs.map(l => ({ l, p: l.address.toLowerCase() === POOL_MANAGER ? v4.get(l.topics[1]?.toLowerCase() ?? '') : other.get(l.address.toLowerCase()) }))
      .filter((x): x is { l: RawLog; p: HoodPool } => !!x.p)
    if (!mine.length) return
    await this.readSenders([...new Set(mine.map(x => x.l.transactionHash.toLowerCase()))])
    for (const { l, p } of mine) {
      const d = decodeHoodSwap(l, p)
      if (!d) continue
      metrics.inc('trench_hood_events')
      const qUsd = p.quote === USDG ? 1 : p.quote === WETH || p.quote === NATIVE ? eth : p.quoteUsd ?? null
      if (!qUsd) continue
      const priceUsd = d.price * qUsd
      const st = this.o.book.trade({
        token: p.coin, wallet: this.senders.get(l.transactionHash.toLowerCase()) ?? null, side: d.buy ? 'buy' : 'sell', usd: d.quote * qUsd, tokens: d.tokens,
        ts: tsOf(l), priceUsd, mcapUsd: p.supply > 0 ? priceUsd * p.supply : null,
      })
      if (st) this.o.publish({ t: 'TSMART', c: 'hood', d: st })
    }
  }

  /** A coin's name, symbol, decimals and supply, read from its contract (four calls at once: the RPC refuses batches). */
  private async coinMeta(token: string) {
    const ask = (data: string) => this.rpc.call<string>('eth_call', [{ to: token, data }, 'latest']).catch(() => null)
    const [name, symbol, decimals, supply] = await Promise.all([ask(ERC20_SEL.name), ask(ERC20_SEL.symbol), ask(ERC20_SEL.decimals), ask(ERC20_SEL.totalSupply)])
    const dec = Number(decodeUint(decimals)) || 18
    return { name: cleanName(decodeString(name), 48), symbol: cleanName(decodeString(symbol), 24), decimals: dec, supply: Number(decodeUint(supply)) / 10 ** dec }
  }

  private async ponsLaunched(pl: PonsLaunch, ts: number, now: number) {
    if (this.curves.get(pl.curve)?.at) return
    const c: Curve = { coin: pl.token, supply: 1e9, thresholdEth: pl.thresholdEth, netEth: 0, at: now }
    this.curves.set(pl.curve, c)
    const m = await this.coinMeta(pl.token)
    if (m.supply > 0) c.supply = m.supply
    const wire = this.o.book.launch({
      token: pl.token, symbol: m.symbol, name: m.name || m.symbol, image: null, launchpad: 'Pons', quote: 'ETH', pool: pl.curve,
      createdAt: ts, creator: pl.creator, priceUsd: 0, mcapUsd: 0, liquidityUsd: 0, progress: 0,
    }, now)
    if (wire) { this.o.publish({ t: 'TLAUNCH', c: 'hood', d: wire }); metrics.inc('trench_launches_hood') }
  }

  /** Whether the coin was minted in this transaction or in the last ~10 minutes: a launch, not a new pool for an old coin
   * (Bankr's hook also opens pools for coins that exist already: 480 of 488 seen on 2026-10-17). */
  private async mintedRecently(coin: string, l: RawLog): Promise<boolean> {
    const rc = await this.rpc.call<{ logs?: RawLog[] } | null>('eth_getTransactionReceipt', [l.transactionHash]).catch(() => null)
    if (rc?.logs?.some(x => x.address.toLowerCase() === coin && x.topics[0]?.toLowerCase() === TRANSFER && x.topics[1] === ZERO_TOPIC)) return true
    const at = parseInt(l.blockNumber, 16)
    const mints = await this.rpc.call<RawLog[]>('eth_getLogs', [{ fromBlock: `0x${Math.max(0, at - FRESH_BLOCKS).toString(16)}`, toBlock: l.blockNumber, address: coin, topics: [TRANSFER, ZERO_TOPIC] }]).catch(() => [])
    return mints.length > 0
  }

  private async poolLaunched(i: HoodInit, l: RawLog, ts: number, now: number) {
    if (this.launchedPools.has(i.poolId) || this.notLaunches.has(i.poolId)) return
    if (!(await this.mintedRecently(i.coin, l))) {
      this.notLaunches.add(i.poolId)
      if (this.notLaunches.size > 5_000) this.notLaunches.clear()
      return
    }
    const m = await this.coinMeta(i.coin)
    this.launchedPools.set(i.poolId, { pool: i.poolId, coin: i.coin, quote: i.quote, coinDecimals: m.decimals, supply: m.supply, at: now })
    const qUsd = i.quote === USDG ? 1 : this.o.prices.usd('ETH', now)
    // The pool's starting price, only when it gives a launch-sized market cap; otherwise the first trade sets it.
    const opening = qUsd ? initPrice(i, m.decimals) * qUsd : 0
    const priceUsd = opening * m.supply >= 500 && opening * m.supply <= 50_000_000 ? opening : 0
    await this.readSenders([l.transactionHash.toLowerCase()])
    const wire = this.o.book.launch({
      token: i.coin, symbol: m.symbol, name: m.name || m.symbol, image: null, launchpad: i.launchpad, quote: i.quote === USDG ? 'USDG' : 'ETH', pool: i.poolId,
      createdAt: ts, creator: this.senders.get(l.transactionHash.toLowerCase()) ?? null,
      priceUsd, mcapUsd: priceUsd * m.supply, liquidityUsd: 0, progress: null,
    }, now)
    if (wire) { this.o.publish({ t: 'TLAUNCH', c: 'hood', d: wire }); metrics.inc('trench_launches_hood') }
  }

  private prune(now: number) {
    for (const [k, c] of this.curves) if (c.at && now - c.at > LAUNCH_KEEP_MS) this.curves.delete(k)
    for (const [k, p] of this.launchedPools) if (now - p.at > LAUNCH_KEEP_MS) this.launchedPools.delete(k)
    for (const k of this.reserveReadAt.keys()) if (!this.curves.has(k)) this.reserveReadAt.delete(k)
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
