// Execution: paper fills and live orders, behind one set of rules.
//
// Paper (and backtests): an order fills at the first market price at least
// `entryLatencyMs` (buys) or `exitLatencyMs` (sales) after it, which is what
// a live order sees: signed, sent and mined while the market moves. A buy is
// dropped when the price drifted more than `maxDriftPct` from the signal. The
// fill pays the pool's price impact for its size, the pool fee and the
// coin's taxes each way, and gas. Paper never sends a transaction.
//
// Live: the engine's bot wallet executor (trading/live.ts: Universal Router,
// a pre-flight round trip before every buy, simulation before signing, nonce
// management, rebroadcasts, deadlines). Around it: one order per idempotency
// key (a retried request returns the first order's result), one order per
// coin at a time, a timeout, sales retried at rising slippage, and every
// step recorded as an execution event.

import type { Address } from 'viem'
import type { PoolInfo } from '../dex/pools'
import type { LiveExecutor } from '../trading/live'
import { impactOf } from './liquidity'

export interface FillCosts { feePerSide: number; buyTax: number; sellTax: number; gasUsdPerTx: number }

export interface PaperFill { price: number; tokens: number; usd: number; feesUsd: number; at: number; slippagePct: number }

/** A paper buy of `usd` at market price `price` in a pool of depth `liquidity`: what it gets and what it costs. */
export function paperBuy(usd: number, price: number, liquidity: number | null, c: FillCosts, at: number): PaperFill | null {
  if (!(usd > 0) || !(price > 0)) return null
  const impact = impactOf(usd, liquidity)
  if (impact >= 1) return null
  const net = usd * (1 - c.feePerSide) * (1 - c.buyTax) * (1 - impact)
  const tokens = net / price
  const feesUsd = usd - net + c.gasUsdPerTx
  return { price: (usd + c.gasUsdPerTx) / tokens, tokens, usd: usd + c.gasUsdPerTx, feesUsd, at, slippagePct: impact * 100 }
}

/** A paper sale of `tokens` at market price `price`: what it brings in after impact, fee, tax and gas. */
export function paperSell(tokens: number, price: number, liquidity: number | null, c: FillCosts, at: number): PaperFill | null {
  if (!(tokens > 0) || !(price > 0)) return null
  const gross = tokens * price
  const impact = impactOf(gross, liquidity)
  const net = Math.max(0, gross * (1 - impact) * (1 - c.feePerSide) * (1 - c.sellTax) - c.gasUsdPerTx)
  return { price: net / tokens, tokens, usd: net, feesUsd: gross - net, at, slippagePct: impact * 100 }
}

export interface PendingOrder {
  key: string
  positionId: string
  token: string
  side: 'BUY' | 'SELL'
  /** Buys: USD to spend. Sales: the share of the remaining tokens (0–1]. */
  amount: number
  reason: string
  createdAt: number
  dueAt: number
  /** The price when the order was made (the drift check). */
  refPrice: number
  /** Fill at the last known price if no trade arrives by then. */
  staleAt: number
}

export interface ExecutionEvent { at: number; key: string; positionId: string; token: string; mode: 'paper' | 'live' | 'backtest'; kind: 'submitted' | 'filled' | 'failed' | 'retry' | 'timeout' | 'skipped' | 'duplicate'; detail: string; latencyMs?: number; txHash?: string }

export interface OrderResult { ok: boolean; status: 'filled' | 'failed' | 'timeout' | 'skipped' | 'duplicate'; price?: number; tokens?: number; liveTokens?: bigint; usd?: number; feesUsd?: number; gasUsd?: number; txHash?: string; latencyMs?: number; error?: string }

type LiveExec = Pick<LiveExecutor, 'buy' | 'sell' | 'approveForSale' | 'tokenBalance'>

/** Orders through the bot wallet, with idempotency, a per-coin lock, a timeout and retried sales. */
export class LiveOrders {
  private results = new Map<string, Promise<OrderResult>>()
  private busy = new Set<string>()
  private approved = new Set<string>()

  constructor(private o: { exec: LiveExec; pool: (token: string) => PoolInfo | null; event: (e: ExecutionEvent) => void; timeoutMs: () => number; now?: () => number }) {}

  private now() { return this.o.now?.() ?? Date.now() }

  private run(key: string, positionId: string, token: string, fn: () => Promise<OrderResult>): Promise<OrderResult> {
    const had = this.results.get(key)
    if (had) { this.o.event({ at: this.now(), key, positionId, token, mode: 'live', kind: 'duplicate', detail: 'the same order was asked for again: the first one stands' }); return had }
    if (this.busy.has(token)) return Promise.resolve({ ok: false, status: 'skipped', error: 'another order on this coin is still going' })
    this.busy.add(token)
    const started = this.now()
    const timeout = new Promise<OrderResult>(r => setTimeout(() => r({ ok: false, status: 'timeout', error: `no confirmation within ${Math.round(this.o.timeoutMs() / 1000)}s` }), this.o.timeoutMs()))
    const p = Promise.race([fn().catch((e: unknown): OrderResult => ({ ok: false, status: 'failed', error: e instanceof Error ? e.message : String(e) })), timeout])
      .then((r: OrderResult) => {
        const latencyMs = this.now() - started
        this.o.event({ at: this.now(), key, positionId, token, mode: 'live', kind: r.ok ? 'filled' : r.status === 'timeout' ? 'timeout' : 'failed', detail: r.ok ? `filled ${r.usd?.toFixed(2)} USD` : r.error ?? r.status, latencyMs, txHash: r.txHash })
        return { ...r, latencyMs }
      })
      .finally(() => this.busy.delete(token))
    this.results.set(key, p)
    if (this.results.size > 5_000) { const first = this.results.keys().next().value; if (first) this.results.delete(first) }
    this.o.event({ at: started, key, positionId, token, mode: 'live', kind: 'submitted', detail: 'sent to the bot wallet' })
    return p
  }

  buy(key: string, positionId: string, token: string, usd: number, slippageBps: number, maxRoundTripPct: number, decimals = 18): Promise<OrderResult> {
    return this.run(key, positionId, token, async () => {
      const pool = this.o.pool(token)
      if (!pool) return { ok: false, status: 'failed', error: 'no Uniswap v4 pool to trade it in' }
      const f = await this.o.exec.buy(pool, token as Address, usd, slippageBps, rt => (rt.lossPct !== null && rt.lossPct > maxRoundTripPct ? `a round trip costs ${rt.lossPct.toFixed(1)}%` : null))
      if (!this.approved.has(token)) { await this.o.exec.approveForSale(token as Address).catch(() => []); this.approved.add(token) }
      const tokens = Number(f.tokens) / 10 ** decimals
      return { ok: true, status: 'filled', tokens, liveTokens: f.tokens, usd: f.usd, gasUsd: f.gasUsd, price: tokens > 0 ? f.usd / tokens : 0, txHash: f.hash }
    })
  }

  /** Sells `amount` (the token's own units), retried at each slippage in turn. */
  sell(key: string, positionId: string, token: string, amount: bigint, slippagesBps: number[], decimals = 18): Promise<OrderResult> {
    return this.run(key, positionId, token, async () => {
      const pool = this.o.pool(token)
      if (!pool) return { ok: false, status: 'failed', error: 'no pool to sell in' }
      let last = ''
      for (const [i, bps] of slippagesBps.entries()) {
        try {
          const f = await this.o.exec.sell(pool, token as Address, amount, bps)
          const tokens = Number(amount) / 10 ** decimals
          return { ok: true, status: 'filled', tokens, liveTokens: amount, usd: f.usd, gasUsd: f.gasUsd, price: tokens > 0 ? f.usd / tokens : 0, txHash: f.hash }
        } catch (e) {
          last = e instanceof Error ? e.message : String(e)
          if (i < slippagesBps.length - 1) this.o.event({ at: this.now(), key, positionId, token, mode: 'live', kind: 'retry', detail: `sale failed at ${bps / 100}% slippage (${last.slice(0, 120)}); trying ${slippagesBps[i + 1] / 100}%` })
        }
      }
      return { ok: false, status: 'failed', error: last || 'the sale failed' }
    })
  }

  /** What the wallet holds of a coin (reconciling an order that timed out). */
  balance(token: string): Promise<bigint> { return this.o.exec.tokenBalance(token as Address) }
}
