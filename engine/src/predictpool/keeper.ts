// The prediction pool's keeper (contracts/ArcdexPredictPool.sol): reads the pool's events, fills each request with a
// price it signs from Hyperliquid's mid, and pays out settled markets.
//
// - A request is filled with the mid read when its fill is signed, strictly after the request's second (the contract
//   insists), never later than its timeout. With no open market for it on Hyperliquid (not listed, past its end, no
//   book), the keeper signs "no price" (px 0) and the pool refunds it.
// - Every outcome someone holds is asked about until Hyperliquid has settled it (practice/predict.ts settlementOf);
//   then the keeper signs the settlement and proposes it. After the pool's settleDelay it pays out every holder.
// - Now and then: the fee wallet's fees out, the queue harvested where cash waits, the pool's excess to stakers.
//
// The key that signs is the keeper's own (it also sends the transactions). The pool trusts it for every price: see
// contracts/AUDIT-ArcdexPredictPool.md.

import { parseEventLogs, type Account, type Address, type Chain, type Hex, type Log, type PublicClient, type Transport, type WalletClient } from 'viem'
import { PREDICT_POOL_ABI } from './abi'
import { PREDICT_POOL_DOMAIN, PRICE_TYPES, SETTLEMENT_TYPES, POOL_ONE, type PoolFill, type PoolMarketView, type PoolStateView } from './shared'
import type { PracticeSpec } from '../../../api/_practiceProtocol'
import { errMsg, log } from '../log'

/** Where prices and settlements come from: the practice book's Hyperliquid reads (practice/predict.ts). */
export interface PoolMarketData {
  tradeableMid(outcome: number, side: 0 | 1, now?: number): Promise<number | null>
  settlementOf(outcome: number, known: PracticeSpec | null, now?: number): Promise<number | null>
  specOf(outcome: number): PracticeSpec | null
}

export interface OpenRequest {
  id: bigint
  trader: Address
  outcome: number
  side: 0 | 1
  buy: boolean
  amount: bigint
  limitPx: bigint
  createdAt: number // seconds (block time)
}

/** Which requests can be priced now: made in an earlier second than `nowSec`, and not within 3 seconds of their
 *  timeout (the fill would land too late). Oldest first. Pure, for tests. */
export function dueRequests(requests: Iterable<OpenRequest>, nowSec: number, timeout: number, skip?: (id: bigint) => boolean): OpenRequest[] {
  return [...requests]
    .filter(r => nowSec > r.createdAt && nowSec <= r.createdAt + timeout - 3 && !skip?.(r.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** A mid (0–1) as the pool's price: 1e6 = $1, rounded. */
export const toPx = (mid: number) => BigInt(Math.min(POOL_ONE - 1, Math.max(0, Math.round(mid * POOL_ONE))))

/** A revert's error name (StalePrice, Expired…), from viem's error chain; null when it isn't a revert. */
export function revertOf(e: unknown): string | null {
  for (let c = e as { cause?: unknown; data?: { errorName?: string }; shortMessage?: string } | undefined; c; c = c.cause as typeof c) {
    if (c.data?.errorName) return c.data.errorName
  }
  return null
}

/** A keeper transaction's gas limit, with headroom over the estimate (perps/keeper.ts keeperGas explains why). */
export const keeperGas = (estimate: bigint) => (estimate * 13n) / 10n + 30_000n

const KEEP_FILLS = 3_000
const CHUNK = 10_000n
const REDEEM_BATCH = 40

export interface KeeperOptions {
  client: PublicClient
  wallet: WalletClient<Transport, Chain, Account>
  pool: Address
  fromBlock: number | null
  data: PoolMarketData
  now?: () => number
  /** How often the loop runs (ms). */
  everyMs?: number
}

export class PredictPoolKeeper {
  readonly requests = new Map<string, OpenRequest>()
  /** outcome → holders, as `${address}:${side}` (redeemMany skips the ones already empty). */
  readonly holders = new Map<number, Set<string>>()
  readonly markets = new Map<number, { state: 0 | 1 | 2; fraction: number | null; readyAt: number | null; oi0: bigint; oi1: bigint }>()
  /** Specs kept from when an outcome was listed, so a settled one still has a name. */
  readonly specs = new Map<number, PracticeSpec>()
  private fills: PoolFill[] = []
  private cursor: bigint | null = null
  private blockTimes = new Map<bigint, number>()
  private skipUntil = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private lastSlow = 0
  private timeout = 60
  private chainId: number | null = null
  state: PoolStateView | null = null
  lastRun: number | null = null
  filled = 0
  rejected = 0
  settled = 0
  errors = 0
  lastError: string | null = null

  constructor(private o: KeeperOptions) {}

  private now() { return this.o.now?.() ?? Date.now() }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.run(), this.o.everyMs ?? 1_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass: events, fills, then (every 15 seconds) settlement and upkeep. */
  async run() {
    if (this.busy) return
    this.busy = true
    try {
      await this.poll()
      await this.fillDue()
      if (this.now() - this.lastSlow >= 15_000) {
        this.lastSlow = this.now()
        await this.settle()
        await this.upkeep()
      }
      this.lastRun = this.now()
    } catch (e) {
      this.fail('keeper pass failed', e)
    } finally {
      this.busy = false
    }
  }

  private fail(what: string, e: unknown) {
    this.errors++
    this.lastError = `${what}: ${revertOf(e) ?? errMsg(e)}`
    log.warn(`predict pool: ${what}`, { error: this.lastError })
  }

  // ── events ───────────────────────────────────────────────────────────

  async poll() {
    // Uncached: viem keeps the block number for half a block, and a quick second poll would stop short of a new request.
    const head = await this.o.client.getBlockNumber({ cacheTime: 0 })
    let from = this.cursor ?? BigInt(this.o.fromBlock ?? Number(head > 50_000n ? head - 50_000n : 0n))
    for (let i = 0; i < 10 && from <= head; i++) {
      const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
      const logs = await this.o.client.getLogs({ address: this.o.pool, fromBlock: from, toBlock: to })
      await this.ingest(logs)
      from = to + 1n
      this.cursor = from
    }
  }

  private async timeOf(l: Log & { blockTimestamp?: unknown }): Promise<number> {
    const raw = l.blockTimestamp
    if (raw != null) return Number(raw)
    const b = l.blockNumber as bigint
    let t = this.blockTimes.get(b)
    if (t == null) {
      t = Number((await this.o.client.getBlock({ blockNumber: b })).timestamp)
      this.blockTimes.set(b, t)
      if (this.blockTimes.size > 5_000) this.blockTimes.clear()
    }
    return t
  }

  private market(outcome: number) {
    let m = this.markets.get(outcome)
    if (!m) { m = { state: 0, fraction: null, readyAt: null, oi0: 0n, oi1: 0n }; this.markets.set(outcome, m) }
    return m
  }

  private pushFill(f: PoolFill) {
    this.fills.push(f)
    if (this.fills.length > KEEP_FILLS) this.fills.splice(0, this.fills.length - KEEP_FILLS)
  }

  async ingest(logs: Log[]) {
    const evs = parseEventLogs({ abi: PREDICT_POOL_ABI, logs, strict: false })
    for (const ev of evs) {
      const a = ev.args as Record<string, unknown>
      const at = await this.timeOf(ev as never)
      const base = { block: Number(ev.blockNumber), tx: ev.transactionHash as string, at: at * 1000 }
      switch (ev.eventName) {
        case 'RequestCreated': {
          const id = a.id as bigint
          this.requests.set(String(id), {
            id, trader: a.trader as Address, outcome: Number(a.outcome), side: Number(a.side) as 0 | 1, buy: a.buy as boolean,
            amount: a.amount as bigint, limitPx: a.limitPx as bigint, createdAt: at,
          })
          const spec = this.o.data.specOf(Number(a.outcome))
          if (spec) this.specs.set(Number(a.outcome), spec)
          break
        }
        case 'RequestCancelled':
          this.requests.delete(String(a.id))
          break
        case 'RequestRejected': {
          const r = this.requests.get(String(a.id))
          this.requests.delete(String(a.id))
          this.rejected++
          if (r) this.pushFill({ kind: 'rejected', requestId: String(r.id), trader: r.trader, outcome: r.outcome, side: r.side, contracts: '0', usd: r.buy ? String(r.amount) : '0', px: null, pnl: null, reason: Number(a.reason), ...base })
          break
        }
        case 'Filled': {
          this.requests.delete(String(a.id))
          this.filled++
          const outcome = Number(a.outcome), side = Number(a.side) as 0 | 1, buy = a.buy as boolean
          const m = this.market(outcome)
          const n = a.contracts as bigint
          if (side === 0) m.oi0 += buy ? n : -n
          else m.oi1 += buy ? n : -n
          if (buy) {
            let set = this.holders.get(outcome)
            if (!set) { set = new Set(); this.holders.set(outcome, set) }
            set.add(`${(a.trader as string).toLowerCase()}:${side}`)
          }
          this.pushFill({ kind: buy ? 'buy' : 'sell', requestId: String(a.id), trader: a.trader as string, outcome, side, contracts: String(n), usd: String(a.usd), px: String(a.px), pnl: null, reason: null, ...base })
          break
        }
        case 'Closed': {
          const outcome = Number(a.outcome), side = Number(a.side) as 0 | 1
          const pnl = String(a.pnl)
          if (a.settled) {
            this.holders.get(outcome)?.delete(`${(a.trader as string).toLowerCase()}:${side}`)
            const m = this.market(outcome)
            const n = a.contracts as bigint
            if (side === 0) m.oi0 -= n
            else m.oi1 -= n
            this.pushFill({ kind: 'settled', requestId: null, trader: a.trader as string, outcome, side, contracts: String(n), usd: String(a.value), px: null, pnl, reason: null, ...base })
          } else {
            // A sale's P&L: on the sale's own row (the last one for this trader and side in this transaction).
            const row = [...this.fills].reverse().find(f => f.tx === base.tx && f.kind === 'sell' && f.trader.toLowerCase() === (a.trader as string).toLowerCase() && f.side === side)
            if (row) row.pnl = pnl
          }
          break
        }
        case 'SettlementProposed': {
          const m = this.market(Number(a.outcome))
          m.state = 1
          m.fraction = Number(a.fraction) / POOL_ONE
          m.readyAt = Number(a.readyAt)
          break
        }
        case 'SettlementCancelled': {
          const m = this.market(Number(a.outcome))
          m.state = 0; m.fraction = null; m.readyAt = null
          break
        }
        case 'Settled': {
          const m = this.market(Number(a.outcome))
          m.state = 2
          m.fraction = Number(a.fraction) / POOL_ONE
          break
        }
      }
    }
  }

  // ── fills ────────────────────────────────────────────────────────────

  private skip = (id: bigint) => (this.skipUntil.get(String(id)) ?? 0) > this.now()

  private async domain() {
    this.chainId ??= await this.o.client.getChainId()
    return { ...PREDICT_POOL_DOMAIN, chainId: this.chainId, verifyingContract: this.o.pool }
  }

  /** Signs a price for one side (0 = no price). */
  async signPrice(outcome: number, side: 0 | 1, px: bigint, ts: number): Promise<Hex> {
    return this.o.wallet.signTypedData({
      account: this.o.wallet.account, domain: await this.domain(), types: PRICE_TYPES, primaryType: 'Price',
      message: { outcome, side, px, ts: BigInt(ts) },
    })
  }

  async signSettlement(outcome: number, fraction: bigint, ts: number): Promise<Hex> {
    return this.o.wallet.signTypedData({
      account: this.o.wallet.account, domain: await this.domain(), types: SETTLEMENT_TYPES, primaryType: 'Settlement',
      message: { outcome, fraction, ts: BigInt(ts) },
    })
  }

  async fillDue() {
    if (!this.requests.size) return
    const nowMs = this.now()
    // The chain's clock, which the pool checks prices against: a price is signed at the latest block's time, so it's
    // after a request only once a block after the request's second exists.
    const nowSec = Number((await this.o.client.getBlock()).timestamp)
    const due = dueRequests(this.requests.values(), nowSec, this.timeout, this.skip)
    if (!due.length) return
    const mids = new Map<string, bigint>()
    const fills: { id: bigint; px: bigint; ts: bigint; sig: Hex }[] = []
    for (const r of due.slice(0, 30)) {
      const k = `${r.outcome}:${r.side}`
      let px = mids.get(k)
      if (px === undefined) {
        const mid = await this.o.data.tradeableMid(r.outcome, r.side, nowMs).catch(() => null)
        px = mid == null ? 0n : toPx(mid)
        mids.set(k, px)
      }
      fills.push({ id: r.id, px, ts: BigInt(nowSec), sig: await this.signPrice(r.outcome, r.side, px, nowSec) })
    }
    try {
      await this.send('execute', [fills])
    } catch (e) {
      if (fills.length === 1) {
        this.skipUntil.set(String(fills[0].id), this.now() + 20_000)
        this.fail(`fill ${fills[0].id} failed`, e)
        return
      }
      // One bad request shouldn't hold the rest: one at a time.
      for (const f of fills) {
        try { await this.send('execute', [[f]]) } catch (e2) {
          this.skipUntil.set(String(f.id), this.now() + 20_000)
          this.fail(`fill ${f.id} failed`, e2)
        }
      }
    }
    await this.poll()
  }

  private async send(functionName: string, args: readonly unknown[]): Promise<Hex> {
    const c = { address: this.o.pool, abi: PREDICT_POOL_ABI, functionName, args, account: this.o.wallet.account } as const
    const gas = await this.o.client.estimateContractGas(c as never)
    const hash = await this.o.wallet.writeContract({ ...c, chain: this.o.wallet.chain, gas: keeperGas(gas) } as never)
    const r = await this.o.client.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 500 })
    if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`)
    return hash
  }

  // ── settlement ───────────────────────────────────────────────────────

  async settle() {
    const nowMs = this.now()
    const chainSec = Number((await this.o.client.getBlock()).timestamp)
    for (const [outcome, set] of this.holders) {
      const m = this.market(outcome)
      if (!set.size || m.oi0 + m.oi1 <= 0n) continue
      if (m.state === 0) {
        const f = await this.o.data.settlementOf(outcome, this.specs.get(outcome) ?? this.o.data.specOf(outcome), nowMs).catch(() => null)
        if (f == null) continue
        const fraction = BigInt(Math.round(f * POOL_ONE))
        const ts = chainSec
        try {
          await this.send('proposeSettlement', [outcome, fraction, BigInt(ts), await this.signSettlement(outcome, fraction, ts)])
          this.settled++
          log.info('predict pool: settlement proposed', { outcome, fraction: f })
        } catch (e) { this.fail(`settlement of ${outcome} failed`, e) }
      } else if (m.readyAt != null && chainSec >= m.readyAt) {
        const list = [...set]
        for (let i = 0; i < list.length; i += REDEEM_BATCH) {
          const part = list.slice(i, i + REDEEM_BATCH).map(k => k.split(':'))
          try {
            await this.send('redeemMany', [part.map(([u]) => u as Address), part.map(() => outcome), part.map(([, s]) => Number(s))])
          } catch (e) { this.fail(`payout of ${outcome} failed`, e) }
        }
      }
    }
    await this.poll()
  }

  // ── upkeep and the pool's state ──────────────────────────────────────

  async readState(): Promise<PoolStateView> {
    const p = { address: this.o.pool, abi: PREDICT_POOL_ABI } as const
    const [s, head, win, loss, share, timeout, delay, cap] = await Promise.all([
      this.o.client.readContract({ ...p, functionName: 'poolState' }),
      this.o.client.readContract({ ...p, functionName: 'queueHead' }),
      this.o.client.readContract({ ...p, functionName: 'winFeeBps' }),
      this.o.client.readContract({ ...p, functionName: 'lossFeeBps' }),
      this.o.client.readContract({ ...p, functionName: 'stakerShareBps' }),
      this.o.client.readContract({ ...p, functionName: 'requestTimeout' }),
      this.o.client.readContract({ ...p, functionName: 'settleDelay' }),
      this.o.client.readContract({ ...p, functionName: 'defaultCap' }),
    ])
    this.timeout = Number(timeout)
    const len = Number(s.queueLength)
    const queue = await Promise.all(Array.from({ length: Math.min(len, 10) }, (_, i) =>
      this.o.client.readContract({ ...p, functionName: 'queueAt', args: [head + BigInt(i)] }).then(c => ({ index: Number(head) + i, user: c.user, amount: String(c.amount) }))))
    this.state = {
      at: this.now(), lpCash: String(s.lpCash), sideBucket: String(s.sideBucket), totalQueued: String(s.totalQueued), queueLength: len,
      trackedLp: String(s.trackedLp), totalLocked: String(s.totalLocked), totalPending: String(s.totalPending), devFees: String(s.devFees),
      totalStaked: String(s.totalStaked), mintRate: String(s.mintRate), paused: s.paused,
      winFeeBps: Number(win), lossFeeBps: Number(loss), stakerShareBps: Number(share), requestTimeout: Number(timeout), settleDelay: Number(delay),
      defaultCap: String(cap), queue,
    }
    return this.state
  }

  async upkeep() {
    const s = await this.readState()
    try {
      if (BigInt(s.devFees) >= 1_000_000n) await this.send('withdrawDevFees', [])
      if (s.queueLength > 0 && BigInt(s.lpCash) + BigInt(s.sideBucket) > 0n) await this.send('harvest', [32n])
      if (s.queueLength === 0 && BigInt(s.totalStaked) > 0n) {
        const cap = await this.o.client.readContract({ address: this.o.pool, abi: PREDICT_POOL_ABI, functionName: 'stakerRewardCap' })
        if (BigInt(s.trackedLp) > cap && BigInt(s.lpCash) > 0n) await this.send('pushExcess', [])
      }
    } catch (e) { this.fail('upkeep failed', e) }
  }

  // ── reads for the API ────────────────────────────────────────────────

  /** Fills and payouts, newest first: one trader's, or everyone's. */
  list(account: string | null, limit: number): PoolFill[] {
    const a = account?.toLowerCase()
    const out: PoolFill[] = []
    for (let i = this.fills.length - 1; i >= 0 && out.length < limit; i--) {
      const f = this.fills[i]
      if (a ? f.trader.toLowerCase() === a : f.kind !== 'rejected') out.push(f)
    }
    return out
  }

  marketViews(): PoolMarketView[] {
    return [...this.markets].map(([outcome, m]) => ({ outcome, oi0: String(m.oi0), oi1: String(m.oi1), state: m.state, fraction: m.fraction, readyAt: m.readyAt }))
  }
}
