// Live positions: the bot wallet's real trades on signals, with the same
// exits as paper trading (trading/paper.ts exitsAt), filled at what each
// sale really paid, gas included. Paper trading keeps running beside it on
// every signal, so the two can be compared.
//
// Limits (all hard): a size cap per trade, positions open at once (scalps
// separately), a daily realized loss after which no new position opens, a
// USDC reserve the wallet never trades below, and slippage caps. A coin whose
// venue the executor can't reach (a launchpad curve, a v3 pool) stays paper.
//
// A sale that fails is retried with more slippage (15%, 35%, 60%); if every
// try fails the position is marked stuck and tried again at every tick.

import type { LaunchInfo } from '../../../api/_marketProtocol'
import type { PoolInfo } from '../dex/pools'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import { canOpen, exitsAt, recordSell, RISK, type Exit, type ExitReason, type Position, type Strategy, type StrategyParams } from '../trading/paper'
import { keyOf, reason, usdcSide, type LiveExecutor } from '../trading/live'
import type { Address, Hex } from 'viem'
import type { Signal } from './types'

export interface LiveLimits {
  /** No trade bigger than this, whatever the strategy's size. */
  maxTradeUsd: number
  /** No new position once today's (UTC) realized live loss reaches this. */
  dailyLossUsd: number
  maxOpen: number
  maxOpenScalp: number
  /** Buys: how far below the quote the fill may be. */
  slippageBps: number
  /** Sales: tried in turn until one goes through. */
  exitSlippageBps: number[]
  /** USDC always left in the wallet (gas for the exits). */
  reserveUsd: number
}

export const DEFAULT_LIMITS: LiveLimits = { maxTradeUsd: 25, dailyLossUsd: 50, maxOpen: 3, maxOpenScalp: 2, slippageBps: 1_000, exitSlippageBps: [1_500, 3_500, 6_000], reserveUsd: 2 }

export interface LiveEvent { at: number; kind: 'buy' | 'sell' | 'skip' | 'error' | 'mode'; text: string; token?: string; symbol?: string; hash?: string }

export class LiveTrader {
  private busy = new Set<string>()
  private opening = new Set<string>()
  /** Coins whose sale is approved (checked once per coin, not before every exit). */
  private approved = new Set<string>()
  readonly events: LiveEvent[] = []
  balance: { usd: number; at: number } | null = null

  constructor(private o: {
    exec: LiveExecutor
    limits: LiveLimits
    /** The bot's positions (paper and live); live ones are added here. */
    positions: () => Position[]
    params: (s: Strategy) => StrategyParams
    save: (p: Position) => void
  }) {}

  get address(): Address { return this.o.exec.address }
  /** The wallet itself (fees and withdrawals for visitors' live bots, bot/userLive.ts). */
  get executor(): LiveExecutor { return this.o.exec }
  get limits() { return this.o.limits }
  live() { return this.o.positions().filter(p => p.mode === 'live') }

  event(e: Omit<LiveEvent, 'at'>) {
    this.events.unshift({ at: Date.now(), ...e })
    this.events.length = Math.min(this.events.length, 60)
    log.info(`live: ${e.kind}`, { text: e.text, token: e.token, hash: e.hash })
  }

  async refreshBalance() {
    this.balance = { usd: await this.o.exec.balanceUsd(), at: Date.now() }
    metrics.set('live_balance_usd', Math.round(this.balance.usd * 100) / 100)
  }

  /**
   * Opens a live position on a signal, when the limits allow. A visitor's bot
   * passes its own size (sized for its profit target), an id suffix, and the
   * exits and entry numbers the position keeps (`extra`).
   */
  async open(signal: Signal, strategy: Strategy, pool: PoolInfo | null, meta: LaunchInfo, opts: { sizeUsd?: number; idSuffix?: string; extra?: Partial<Position> } = {}) {
    const token = signal.token as Address, symbol = meta.symbol
    const key = keyOf(pool)
    if (!pool || !key || !usdcSide(key, token)) { this.event({ kind: 'skip', token, symbol, text: `$${symbol}: live trading can't reach this coin's venue yet (paper only)` }); return }
    if (this.opening.has(token)) return
    const now = Date.now()
    const allowed = canOpen(this.live(), token, now, { maxOpen: this.o.limits.maxOpen, maxOpenScalp: this.o.limits.maxOpenScalp, cooldownMin: RISK.cooldownMin, cooldownMinScalp: RISK.cooldownMinScalp, dailyLossUsd: this.o.limits.dailyLossUsd }, strategy)
    if (!allowed.ok) { this.event({ kind: 'skip', token, symbol, text: `$${symbol}: not bought (${allowed.why})` }); return }
    const size = Math.min(opts.sizeUsd ?? this.o.params(strategy).sizeUsd, this.o.limits.maxTradeUsd)
    this.opening.add(token)
    try {
      await this.refreshBalance()
      const bal = this.balance!.usd
      if (bal < size + this.o.limits.reserveUsd) { this.event({ kind: 'skip', token, symbol, text: `$${symbol}: not bought (wallet has $${bal.toFixed(2)}; a $${size} trade keeps $${this.o.limits.reserveUsd} back)` }); return }
      const f = await this.o.exec.buy(pool, token, size, this.o.limits.slippageBps)
      const qty = Number(f.tokens) / 10 ** pool.baseDecimals
      const price = f.usd / qty
      const p: Position = {
        ...opts.extra,
        id: `${signal.id}:live${opts.idSuffix ? `:${opts.idSuffix}` : ''}`, mode: 'live', strategy, token, symbol, launchpad: meta.launchpad, signalId: signal.id,
        openedAt: f.at, marketEntry: price, entryPrice: price, sizeUsd: f.usd, qty, remaining: qty, cost: 0, peak: price,
        tp1Done: false, fills: [{ at: f.at, price, qty, usd: f.usd, reason: 'entry' }],
        status: 'open', closedAt: null, exitReason: null, pnlUsd: null,
        txs: [{ kind: 'buy', hash: f.hash, at: f.at, usd: f.usd, gasUsd: f.gasUsd }], gasUsd: f.gasUsd, stuck: null, rawQty: f.tokens.toString(),
      }
      this.o.positions().push(p)
      this.o.save(p)
      metrics.inc('live_buys')
      this.event({ kind: 'buy', token, symbol, hash: f.hash, text: `Bought $${symbol} for $${f.usd.toFixed(2)} (${strategy})` })
      // Approve the sale now, so an exit never waits on an approval.
      this.busy.add(p.id)
      try {
        for (const a of await this.o.exec.approveForSale(token)) { p.txs!.push({ kind: 'approve', hash: a.hash, at: a.at, gasUsd: a.gasUsd }); p.gasUsd = (p.gasUsd ?? 0) + a.gasUsd }
        this.approved.add(token.toLowerCase())
      } catch (e) { this.event({ kind: 'error', token, symbol, text: `$${symbol}: approving the sale failed (${reason(e)}); retried at the exit` }) }
      finally { this.busy.delete(p.id) }
      this.o.save(p)
    } catch (e) {
      metrics.inc('live_buy_errors')
      this.event({ kind: 'error', token, symbol, hash: (e as { hash?: string }).hash, text: `$${symbol}: buy failed (${reason(e)})` })
    } finally {
      this.opening.delete(token)
      void this.refreshBalance().catch(() => {})
    }
  }

  /** A new price for a live position (and whether it was the creator selling). */
  onPrice(p: Position, price: number, now: number, creatorSold: boolean) {
    if (p.status !== 'open' || !(price > 0)) return
    const params = p.exits ?? this.o.params(p.strategy)
    const exits: Exit[] = creatorSold && params.exitOnCreatorSell ? [{ qty: p.remaining, reason: 'creator' }] : exitsAt(p, price, now, params)
    p.peak = Math.max(p.peak, price)
    if (exits.length) void this.sell(p, exits)
  }

  /** Sells all of a live position now (a failed safety check, the owner's order). */
  closeNow(p: Position, why: ExitReason) {
    if (p.status === 'open') void this.sell(p, [{ qty: p.remaining, reason: why }])
  }

  private async sell(p: Position, exits: Exit[]) {
    if (this.busy.has(p.id)) return
    this.busy.add(p.id)
    try {
      await this.checkApproval(p)
      for (const e of exits) {
        if (p.status !== 'open') break
        const pool = this.poolOf(p)
        if (!pool) { this.stuck(p, 'the pool is unknown'); return }
        const bal = await this.o.exec.tokenBalance(p.token as Address)
        const all = e.qty >= p.remaining * (1 - 1e-9)
        // All that's left: the wallet's balance (a token tax may have taken some). Part: that share of it.
        const amount = all ? bal : (bal * BigInt(Math.round((e.qty / p.remaining) * 1_000_000))) / 1_000_000n
        if (amount === 0n) { recordSell(p, e.qty, 0, Date.now(), e.reason); continue }
        let lastErr: unknown = null, done = false
        for (const bps of this.o.limits.exitSlippageBps) {
          try {
            const f = await this.o.exec.sell(pool, p.token as Address, amount, bps)
            p.txs = [...(p.txs ?? []), { kind: 'sell', hash: f.hash, at: f.at, usd: f.usd, gasUsd: f.gasUsd }]
            p.gasUsd = (p.gasUsd ?? 0) + f.gasUsd
            recordSell(p, e.qty, f.usd, f.at, e.reason)
            p.stuck = null
            metrics.inc('live_sells')
            const closed = (p.status as Position['status']) === 'closed'
            this.event({ kind: 'sell', token: p.token, symbol: p.symbol, hash: f.hash, text: `Sold ${all ? 'all' : 'part'} of $${p.symbol} for $${f.usd.toFixed(2)} (${e.reason})${closed ? `, P&L ${p.pnlUsd! >= 0 ? '+' : '−'}$${Math.abs(p.pnlUsd!).toFixed(2)}` : ''}` })
            done = true
            break
          } catch (err) { lastErr = err }
        }
        if (!done) { this.stuck(p, reason(lastErr)); return }
        this.o.save(p)
      }
    } catch (e) {
      this.stuck(p, errMsg(e))
    } finally {
      this.busy.delete(p.id)
      this.o.save(p)
    }
  }

  private async checkApproval(p: Position) {
    if (this.approved.has(p.token.toLowerCase())) return
    const fresh = await this.o.exec.approveForSale(p.token as Address)
    this.approved.add(p.token.toLowerCase())
    for (const a of fresh) { p.txs = [...(p.txs ?? []), { kind: 'approve', hash: a.hash, at: a.at, gasUsd: a.gasUsd }]; p.gasUsd = (p.gasUsd ?? 0) + a.gasUsd }
  }

  private stuck(p: Position, why: string) {
    metrics.inc('live_sell_errors')
    if (p.stuck !== why) this.event({ kind: 'error', token: p.token, symbol: p.symbol, text: `$${p.symbol}: sale failed (${why}); trying again` })
    p.stuck = why
  }

  private pools: (token: string) => PoolInfo | null = () => null
  /** Where a position's coin trades (set by the bot: the coin's main pool). */
  setPools(fn: (token: string) => PoolInfo | null) { this.pools = fn }
  private poolOf(p: Position) { return this.pools(p.token) }

  /** Every 15s: time exits and stuck sales, at the coin's current price. */
  tick(now: number, priceOf: (token: string) => number | null) {
    for (const p of this.live()) {
      if (p.status !== 'open') continue
      const price = priceOf(p.token)
      if (price) this.onPrice(p, price, now, false)
    }
    if (!this.balance || now - this.balance.at > 30_000) void this.refreshBalance().catch(e => log.debug('live: balance read failed', { error: errMsg(e) }))
  }

  todayPnlUsd(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10)
    return this.live().filter(p => p.closedAt && new Date(p.closedAt).toISOString().slice(0, 10) === day).reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
  }
}

export type { Hex }
