// BNB Chain's launches and trades within seconds (the Trenches' live feed, trench/service.ts): four.meme's
// TokenManager2, where every four.meme coin launches and trades on its curve, and the PancakeSwap pools of the
// graduated coins the list shows. One eth_getLogs a second for both, from the block after the last one read
// (BNB Chain's blocks come every ~0.45 s, and its logs carry their block's time).
//
//   TokenCreate(creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee)   a launch
//   TokenPurchase / TokenSale(token, account, price, amount, cost, fee, offers, funds)        a curve trade: price and
//                       cost in the coin's quote (18 decimals), `offers` the coins left for sale (of 800M), `funds`
//                       what the curve holds
//   LiquidityAdded(base, offers, quote, funds)                                                 graduated to PancakeSwap
//   PancakeSwap v2 Swap / v3 Swap                                                              a graduated coin's trade
//
// A coin's quote (BNB, USDT, USD1…) comes from four.meme's helper (api/_bscCore.ts readFour) before its first trade is
// priced; until then its events wait (15 seconds at most). PancakeSwap swaps name a router, so their trader is the
// transaction's sender, read in one batch a second.

import { decodeAbiParameters, parseAbiParameters, toEventSelector } from 'viem'
import { V3_SWAP, decodeSwapLog, word } from '../../../api/_arcSwaps'
import { BNB_NATIVE, BSC_RPC_SERVER, BSC_USD1, BSC_USDC, BSC_USDT, BUSD, FDUSD, FOUR, WBNB, readFour } from '../../../api/_bscCore'
import type { TrenchMessage } from '../../../api/_trenchProtocol'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import type { TrenchBook } from './book'
import type { NativePrices } from './prices'

export const FOUR_CREATE = toEventSelector('TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)')
export const FOUR_PURCHASE = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942'
export const FOUR_SALE = '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19'
export const FOUR_LIQUIDITY = toEventSelector('LiquidityAdded(address,uint256,address,uint256)')
export const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
export const PCS_V3_SWAP = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83'
/** Logs on publicnode first: BNB Chain's own dataseed limits eth_getLogs. */
export const BSC_LOG_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org']

const FOR_SALE = 800_000_000
const STABLES = new Set([BSC_USDT, BSC_USDC, BUSD, FDUSD, BSC_USD1])
const MAX_SPAN = 60
const WAIT_MS = 15_000

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string; removed?: boolean }

/** A graduated coin's PancakeSwap pool, from the chain's list. */
export interface BscPool { pool: string; kind: 'v2' | 'v3'; coin: string; quote: string; coinDecimals: number; supply: number }

export type FourEvent =
  | { k: 'create'; token: string; creator: string; name: string; symbol: string; supply: number }
  | { k: 'trade'; token: string; account: string; buy: boolean; price: number; amount: number; cost: number; offers: number; funds: number }
  | { k: 'graduated'; token: string }

const addr = (w: string) => `0x${w.slice(24)}`.toLowerCase()
const e18 = (data: string, i: number) => Number(BigInt('0x' + word(data, i))) / 1e18

/** A four.meme manager log as an event, or null. */
export function decodeFourLog(l: RawLog): FourEvent | null {
  if (l.removed || l.address.toLowerCase() !== FOUR.manager || !l.data) return null
  const t = l.topics[0]?.toLowerCase()
  try {
    if (t === FOUR_CREATE) {
      const [creator, token, , name, symbol, supply] = decodeAbiParameters(parseAbiParameters('address,address,uint256,string,string,uint256,uint256,uint256'), l.data as `0x${string}`)
      return { k: 'create', token: token.toLowerCase(), creator: creator.toLowerCase(), name: String(name).slice(0, 48), symbol: String(symbol).slice(0, 24), supply: Number(supply) / 1e18 || 1e9 }
    }
    if ((t === FOUR_PURCHASE || t === FOUR_SALE) && l.data.length >= 2 + 64 * 8) {
      return { k: 'trade', token: addr(word(l.data, 0)), account: addr(word(l.data, 1)), buy: t === FOUR_PURCHASE, price: e18(l.data, 2), amount: e18(l.data, 3), cost: e18(l.data, 4), offers: e18(l.data, 6), funds: e18(l.data, 7) }
    }
    if (t === FOUR_LIQUIDITY && l.data.length >= 2 + 64) return { k: 'graduated', token: addr(word(l.data, 0)) }
  } catch { return null }
  return null
}

/** A PancakeSwap swap of a listed pool: coins, quote and the coin's price in the quote. */
export function decodePancake(l: RawLog, p: BscPool): { buy: boolean; tokens: number; quote: number; price: number } | null {
  if (l.removed || l.address.toLowerCase() !== p.pool || !l.data) return null
  const coinIs0 = p.coin < p.quote
  const t = l.topics[0]?.toLowerCase()
  if (t === V2_SWAP && p.kind === 'v2') {
    if (l.data.length < 2 + 64 * 4) return null
    const [in0, in1, out0, out1] = [0, 1, 2, 3].map(i => BigInt('0x' + word(l.data, i)))
    const coinOut = coinIs0 ? out0 : out1, coinIn = coinIs0 ? in0 : in1
    const quoteIn = coinIs0 ? in1 : in0, quoteOut = coinIs0 ? out1 : out0
    const buy = coinOut > 0n
    const tokens = Number(buy ? coinOut : coinIn) / 10 ** p.coinDecimals
    const quote = Number(buy ? quoteIn : quoteOut) / 1e18
    return tokens > 0 && quote > 0 ? { buy, tokens, quote, price: quote / tokens } : null
  }
  if ((t === PCS_V3_SWAP || t === V3_SWAP) && p.kind === 'v3') {
    const d = decodeSwapLog(l, { v4: false, baseIs0: coinIs0, baseDecimals: p.coinDecimals, quoteDecimals: 18 })
    return d && d.baseAmount > 0 ? { buy: d.side === 'BUY', tokens: d.baseAmount, quote: d.quoteAmount, price: d.price } : null
  }
  return null
}

interface Rpc { call<T>(method: string, params: unknown[]): Promise<T>; batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> }

export function jsonRpc(urls: string[], fetcher: typeof fetch = fetch): Rpc {
  let ix = 0
  const post = async (body: unknown) => {
    let last: unknown = null
    for (let n = 0; n < urls.length; n++) {
      const url = urls[(ix + n) % urls.length]
      try {
        const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) })
        if (!r.ok) throw new Error(`${r.status}`)
        const j = await r.json()
        if (!Array.isArray(j) && (j as { error?: { message?: string } }).error) throw new Error((j as { error: { message?: string } }).error.message ?? 'rpc error')
        ix = (ix + n) % urls.length
        return j
      } catch (e) { last = e }
    }
    throw last instanceof Error ? last : new Error('no rpc answered')
  }
  return {
    async call<T>(method: string, params: unknown[]) { return ((await post({ jsonrpc: '2.0', id: 1, method, params })) as { result: T }).result },
    async batch<T>(calls: { method: string; params: unknown[] }[]) {
      if (!calls.length) return []
      const j = (await post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, ...c })))) as { id: number; result?: T }[]
      const out: (T | null)[] = calls.map(() => null)
      if (Array.isArray(j)) for (const r of j) if (typeof r.id === 'number' && r.result !== undefined) out[r.id] = r.result
      return out
    },
  }
}

export interface BscFeedOpts {
  book: TrenchBook
  prices: NativePrices
  publish: (m: TrenchMessage) => void
  pools: () => BscPool[]
  rpc?: Rpc
  helperRpcs?: string[]
  /** four.meme's quotes, for tests. */
  readQuotes?: (tokens: string[]) => Promise<Map<string, { quote: string } | null>>
}

interface Wait { events: { e: FourEvent; at: number }[]; since: number }

export class BscFeed {
  private last = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private quotes = new Map<string, string | null>()
  private supplies = new Map<string, number>()
  private waiting = new Map<string, Wait>()
  private asking = false
  connected = false
  stopped = false
  private rpc: Rpc

  constructor(private o: BscFeedOpts) { this.rpc = o.rpc ?? jsonRpc(BSC_LOG_RPCS) }

  start() { this.loop() }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer) }

  private loop() {
    if (this.stopped) return
    void this.poll().catch(e => { this.connected = false; metrics.inc('trench_bsc_errors'); log.debug('trench bnb: poll failed', { error: errMsg(e) }) })
      .finally(() => { if (!this.stopped) this.timer = setTimeout(() => this.loop(), 1_000) })
  }

  /** One round: the new blocks' logs, in order. */
  async poll(now = Date.now()) {
    const head = parseInt(await this.rpc.call<string>('eth_blockNumber', []), 16)
    if (!this.last) this.last = head - 3
    const from = this.last + 1
    if (from > head) return
    const to = Math.min(head, from + MAX_SPAN)
    const pools = this.o.pools()
    const byPool = new Map(pools.map(p => [p.pool, p]))
    const addresses = [FOUR.manager, ...pools.map(p => p.pool)].slice(0, 400)
    const logs = await this.rpc.call<RawLog[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: addresses, topics: [[FOUR_CREATE, FOUR_PURCHASE, FOUR_SALE, FOUR_LIQUIDITY, V2_SWAP, PCS_V3_SWAP, V3_SWAP]] }])
    this.connected = true
    this.last = to
    const swaps: { l: RawLog; p: BscPool }[] = []
    for (const l of logs) {
      const a = l.address.toLowerCase()
      if (a === FOUR.manager) { const e = decodeFourLog(l); if (e) this.onFour(e, l, now) }
      else { const p = byPool.get(a); if (p) swaps.push({ l, p }) }
    }
    if (swaps.length) await this.onSwaps(swaps, now)
    await this.askQuotes(now)
  }

  private timeOf(l: RawLog, now: number) {
    const ts = l.blockTimestamp && l.blockTimestamp !== '0x0' ? parseInt(l.blockTimestamp, 16) * 1000 : now
    return Math.min(now, ts)
  }

  private quoteUsd(quote: string, now: number): number | null {
    if (quote === BNB_NATIVE || quote === WBNB) return this.o.prices.usd('BNB', now)
    return STABLES.has(quote) ? 1 : null
  }

  private onFour(e: FourEvent, l: RawLog, now: number) {
    metrics.inc('trench_bnb_events')
    const token = e.token
    if (e.k === 'graduated') { this.o.book.markGraduated(token); return }
    if (e.k === 'create') this.supplies.set(token, e.supply)
    const q = this.quotes.get(token)
    if (q === undefined) {
      const w = this.waiting.get(token) ?? { events: [], since: now }
      if (w.events.length < 200) w.events.push({ e, at: this.timeOf(l, now) })
      this.waiting.set(token, w)
      return
    }
    if (q === null) return // four.meme doesn't vouch for it
    this.apply(e, q, this.timeOf(l, now), now)
  }

  private apply(e: FourEvent, quote: string, ts: number, now: number) {
    const { book, publish } = this.o
    const qUsd = this.quoteUsd(quote, now)
    const supply = this.supplies.get(e.token) ?? 1e9
    const qSym = quote === BNB_NATIVE || quote === WBNB ? 'BNB' : quote === BSC_USDT ? 'USDT' : quote === BSC_USD1 ? 'USD1' : quote === BSC_USDC ? 'USDC' : 'USD'
    if (e.k === 'create') {
      if (!qUsd) return
      // The event carries no price: the creator's first buy (usually the same transaction) sets it.
      const wire = book.launch({
        token: e.token, symbol: e.symbol, name: e.name, image: null, launchpad: 'four.meme', quote: qSym, pool: FOUR.manager,
        createdAt: ts, creator: e.creator, priceUsd: 0, mcapUsd: 0, liquidityUsd: 0, progress: 0,
      }, now)
      if (wire) { publish({ t: 'TLAUNCH', c: 'bnb', d: wire }); metrics.inc('trench_launches_bnb') }
      return
    }
    if (e.k !== 'trade' || !qUsd || !(e.amount > 0) || !(e.cost > 0)) return
    const priceUsd = e.price * qUsd
    const st = book.trade({
      token: e.token, wallet: e.account, side: e.buy ? 'buy' : 'sell', usd: e.cost * qUsd, tokens: e.amount, ts,
      priceUsd, mcapUsd: priceUsd * supply, liquidityUsd: e.funds * qUsd,
      progress: Math.max(0, Math.min(100, ((FOR_SALE - e.offers) / FOR_SALE) * 100)),
    })
    if (st) publish({ t: 'TSMART', c: 'bnb', d: st })
  }

  /** Asks four.meme's helper for the quote of coins whose events are waiting, then plays them. */
  private async askQuotes(now: number) {
    if (this.asking || !this.waiting.size) return
    this.asking = true
    try {
      const tokens = [...this.waiting.keys()].filter(t => !this.quotes.has(t)).slice(0, 150)
      const read = this.o.readQuotes ?? ((ts: string[]) => readFour(ts, this.o.helperRpcs ?? BSC_RPC_SERVER))
      const got = tokens.length ? await read(tokens) : new Map()
      for (const [t, info] of got) this.quotes.set(t, info ? info.quote.toLowerCase() : null)
      for (const [t, w] of this.waiting) {
        const q = this.quotes.get(t)
        if (q === undefined) { if (now - w.since > WAIT_MS) this.waiting.delete(t); continue }
        this.waiting.delete(t)
        if (q === null) continue
        for (const x of w.events) this.apply(x.e, q, x.at, now)
      }
      if (this.quotes.size > 100_000) { let n = 0; for (const k of this.quotes.keys()) { this.quotes.delete(k); this.supplies.delete(k); if (++n >= 20_000) break } }
    } catch (e) {
      log.debug('trench bnb: quote read failed', { error: errMsg(e) })
    } finally { this.asking = false }
  }

  /** PancakeSwap swaps: their traders (each transaction's sender) in one batch, then each as a trade. */
  private async onSwaps(swaps: { l: RawLog; p: BscPool }[], now: number) {
    const txs = [...new Set(swaps.map(s => s.l.transactionHash.toLowerCase()))].slice(0, 100)
    const senders = new Map<string, string>()
    try {
      const got = await this.rpc.batch<{ from?: string }>(txs.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })))
      got.forEach((t, i) => { if (t?.from) senders.set(txs[i], t.from.toLowerCase()) })
    } catch { /* traders unknown: trades still count, wallets don't learn */ }
    for (const { l, p } of swaps) {
      const d = decodePancake(l, p)
      if (!d) continue
      const qUsd = this.quoteUsd(p.quote, now)
      if (!qUsd) continue
      const priceUsd = d.price * qUsd
      const st = this.o.book.trade({
        token: p.coin, wallet: senders.get(l.transactionHash.toLowerCase()) ?? null, side: d.buy ? 'buy' : 'sell', usd: d.quote * qUsd, tokens: d.tokens,
        ts: this.timeOf(l, now), priceUsd, mcapUsd: priceUsd * p.supply, progress: 100, graduated: true,
      })
      if (st) this.o.publish({ t: 'TSMART', c: 'bnb', d: st })
    }
  }
}
