// Swap logs → normalized trades.
//
// ── Blockchain specifics ────────────────────────────────────────────────
// BUY/SELL comes from the actual token deltas in the Swap event (see
// api/_arcSwaps.ts for the v4 vs v3 sign conventions), never from the
// price move. The Swap event names the router, not the trader, so the
// wallet is the transaction's sender — looked up in micro-batches (one
// request per ~40ms of trades) to stay sub-second without a call per trade.

import { ARGUS, ARGUS_USDC_V3, NATIVE, POOL_MANAGER, QUOTE_PRIORITY, USDC, V3_SWAP, V4_SWAP, decodeSwapLog, liquidityUsd, priceFromSqrt, word, type SwapLogLike } from '../../../api/_arcSwaps'
import type { Trade } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { metrics } from '../metrics'
import type { PoolInfo, PoolRegistry } from './pools'

export const isSwapLog = (l: SwapLogLike) =>
  (l.topics[0] === V4_SWAP && l.address.toLowerCase() === POOL_MANAGER) || (l.topics[0] === V3_SWAP && l.address.toLowerCase() !== POOL_MANAGER)

/** USD value of quote tokens. USDC (ERC-20 or native) is $1; others come
 * from their own USDC-quoted trades as they happen (seeded at start). */
export class QuoteOracle {
  private usdOf = new Map<string, number>()
  usd(token: string): number | null {
    const t = token.toLowerCase()
    if (t === USDC || t === NATIVE) return 1
    return this.usdOf.get(t) ?? null
  }
  /** Called with every trade priced directly in USDC. */
  observe(token: string, priceUsd: number) {
    if (Number.isFinite(priceUsd) && priceUsd > 0) this.usdOf.set(token.toLowerCase(), priceUsd)
  }
  /** ARGUS from its deep ARGUS/USDC v3 pool, before its first trade arrives. */
  async seed(rpc: Rpc) {
    try {
      const r = await rpc.call<string>('eth_call', [{ to: ARGUS_USDC_V3, data: '0x3850c7bd' }, 'latest'])
      const p = priceFromSqrt(BigInt('0x' + word(r, 0)), ARGUS < USDC, 18, 6)
      if (!this.usdOf.has(ARGUS)) this.observe(ARGUS, p)
    } catch { /* first ARGUS/USDC trade will set it */ }
  }
}

/** tx hash → sender, in batches of 100 (Blockdaemon's batch limit), up to
 * 8 in flight — a backfill of tens of thousands of trades resolves in seconds. */
export class MakerResolver {
  private cache = new Map<string, string>()
  private waiting = new Map<string, ((w: string | null) => void)[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = 0

  constructor(private rpc: Rpc, private windowMs = 40) {}

  get(txHash: string): Promise<string | null> {
    const h = txHash.toLowerCase()
    const hit = this.cache.get(h)
    if (hit) return Promise.resolve(hit)
    return new Promise(resolve => {
      const list = this.waiting.get(h)
      if (list) list.push(resolve); else this.waiting.set(h, [resolve])
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.windowMs)
    })
  }

  private async flush() {
    this.timer = null
    if (this.inFlight >= 8) { this.timer = setTimeout(() => void this.flush(), this.windowMs); return }
    const hashes = [...this.waiting.keys()].slice(0, 100)
    if (!hashes.length) return
    const resolvers = hashes.map(h => { const r = this.waiting.get(h)!; this.waiting.delete(h); return r })
    if (this.waiting.size) this.timer = setTimeout(() => void this.flush(), 0)
    this.inFlight++
    const t0 = Date.now()
    let res: ({ from?: string } | null)[] = []
    try { res = await this.rpc.batch<{ from?: string }>(hashes.map(h => ({ method: 'eth_getTransactionByHash', params: [h] }))) }
    catch { metrics.inc('maker_lookup_errors') }
    finally { this.inFlight-- }
    metrics.latency('maker_lookup', Date.now() - t0)
    hashes.forEach((h, i) => {
      const from = res[i]?.from?.toLowerCase() ?? null
      if (from && /^0x[0-9a-f]{40}$/.test(from)) {
        this.cache.set(h, from)
        if (this.cache.size > 200_000) this.cache.delete(this.cache.keys().next().value as string)
      }
      resolvers[i].forEach(r => r(from))
    })
  }
}

export class TradeParser {
  constructor(
    private pools: PoolRegistry,
    private oracle: QuoteOracle,
    private makers: MakerResolver,
    private launchpadOf: (token: string) => string | null,
  ) {}

  async parse(l: SwapLogLike): Promise<Trade | null> {
    const v4 = l.topics[0] === V4_SWAP
    const poolKey = v4 ? l.topics[1]?.toLowerCase() : l.address.toLowerCase()
    if (!poolKey) return null
    const info = await this.pools.resolve(poolKey)
    if (!info) { metrics.inc('swaps_unknown_pool'); return null }
    return this.fromPool(l, info)
  }

  async fromPool(l: SwapLogLike, info: PoolInfo): Promise<Trade | null> {
    const d = decodeSwapLog(l, { v4: info.dex === 'uniswap-v4', baseIs0: info.baseIs0, baseDecimals: info.baseDecimals, quoteDecimals: info.quoteDecimals })
    if (!d || !(d.price > 0) || !Number.isFinite(d.price) || !Number.isFinite(d.baseAmount) || !Number.isFinite(d.quoteAmount)) {
      metrics.inc('trades_rejected')
      return null
    }
    const quoteUsd = this.oracle.usd(info.quote)
    const priceUsd = quoteUsd !== null ? d.price * quoteUsd : null
    // A quote token (EURC, WETH, ARGUS) trading against USDC sets its own USD price.
    if (priceUsd !== null && quoteUsd === 1 && QUOTE_PRIORITY.includes(info.base)) this.oracle.observe(info.base, priceUsd)
    const logIndex = parseInt(l.logIndex, 16)
    const txHash = l.transactionHash.toLowerCase()
    const wallet = await Promise.race([this.makers.get(txHash), new Promise<null>(r => setTimeout(() => r(null), 1_500))])
    return {
      tradeId: `${txHash}:${logIndex}`,
      chain: 'ARC',
      token: info.base,
      pair: `${info.base}/${info.quote}`,
      pool: info.pool,
      quote: info.quote,
      side: d.side,
      baseAmount: d.baseAmount,
      quoteAmount: d.quoteAmount,
      tokenAmount: d.baseAmount,
      price: d.price,
      priceUsd,
      usdValue: quoteUsd !== null ? d.quoteAmount * quoteUsd : null,
      wallet,
      txHash,
      blockNumber: parseInt(l.blockNumber, 16),
      logIndex,
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      dex: info.dex,
      launchpad: this.launchpadOf(info.base),
      liquidity: quoteUsd !== null ? liquidityUsd(d.liquidity, d.sqrtPriceX96, !info.baseIs0, info.quoteDecimals, quoteUsd) : null,
    }
  }
}
