// The futures contract's trades, read from its events (opened, closed, liquidated, cancelled)
// from the block it was deployed in, then as new blocks come: every trader's history, and the
// latest trades for the screen. Kept in memory (rebuilt from the chain after a restart).

import { parseEventLogs, type Address, type PublicClient } from 'viem'
import { PERPS_ABI } from './abi'
import { symbolOf } from './shared'
import { errMsg, log } from '../log'

export interface PerpsTrade {
  /** opened | closed | liquidated | takeProfit | stopLoss | cancelled */
  kind: 'opened' | 'closed' | 'liquidated' | 'takeProfit' | 'stopLoss' | 'cancelled'
  positionId: string | null
  requestId: string | null
  trader: string
  market: string | null
  isLong: boolean | null
  size: string | null // 6 decimals
  collateral: string | null
  price: string | null // 8 decimals
  pnl: string | null // signed, 6 decimals
  fees: string | null // borrow + closing (or opening) fee
  payout: string | null
  reason: string | null
  block: number
  tx: string
  at: number // ms (block time)
}

const CLOSE_KIND = ['closed', 'takeProfit', 'stopLoss', 'liquidated'] as const
const CHUNK = 10_000n
const KEEP = 20_000

export class PerpsEvents {
  private trades: PerpsTrade[] = []
  private cursor: bigint | null = null
  private markets: string[] = []
  private blockTimes = new Map<bigint, number>()
  private busy = false
  /** Position id → its market and side (closing events don't carry the side). */
  private sides = new Map<string, boolean>()

  constructor(private client: PublicClient, private perps: Address, private fromBlock: number | null) {}

  setMarkets(feeds: string[]) {
    this.markets = feeds
  }

  /** Reads the events since the last call (at most 10 chunks of 10,000 blocks at a time). */
  async poll() {
    if (this.busy) return
    this.busy = true
    try {
      const head = await this.client.getBlockNumber()
      let from: bigint = this.cursor ?? BigInt(this.fromBlock ?? Number(head > 50_000n ? head - 50_000n : 0n))
      for (let i = 0; i < 10 && from <= head; i++) {
        const to: bigint = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
        const logs = await this.client.getLogs({ address: this.perps, fromBlock: from, toBlock: to })
        await this.ingest(logs)
        from = to + 1n
        this.cursor = from
      }
    } catch (e) {
      log.warn('perps events: read failed', { error: errMsg(e) })
    } finally {
      this.busy = false
    }
  }

  private async timeOf(block: bigint): Promise<number> {
    const t = this.blockTimes.get(block)
    if (t) return t
    const b = await this.client.getBlock({ blockNumber: block })
    const ms = Number(b.timestamp) * 1000
    this.blockTimes.set(block, ms)
    if (this.blockTimes.size > 5_000) this.blockTimes.clear()
    return ms
  }

  async ingest(raw: Parameters<typeof parseEventLogs>[0]['logs']) {
    const logs = parseEventLogs({ abi: PERPS_ABI, logs: raw, strict: false })
    for (const l of logs) {
      const base = { block: Number(l.blockNumber), tx: l.transactionHash as string, at: await this.timeOf(l.blockNumber as bigint) }
      const a = l.args as Record<string, unknown>
      if (l.eventName === 'PositionOpened') {
        this.sides.set(String(a.positionId), Boolean(a.isLong))
        this.push({
          kind: 'opened', positionId: String(a.positionId), requestId: null, trader: String(a.trader).toLowerCase(),
          market: this.markets[Number(a.marketId)] ?? null, isLong: Boolean(a.isLong), size: String(a.size), collateral: String(a.collateral),
          price: String(a.entryPrice), pnl: null, fees: String(a.openFee), payout: null, reason: null, ...base,
        })
      } else if (l.eventName === 'PositionClosed') {
        const id = String(a.positionId)
        this.push({
          kind: CLOSE_KIND[Number(a.reason)] ?? 'closed', positionId: id, requestId: null, trader: String(a.trader).toLowerCase(),
          market: this.markets[Number(a.marketId)] ?? null, isLong: this.sides.get(id) ?? null, size: null, collateral: null,
          price: String(a.price), pnl: String(a.pnl), fees: String(BigInt(a.borrowFee as bigint) + BigInt(a.closeFee as bigint)),
          payout: String(a.payout), reason: null, ...base,
        })
      } else if (l.eventName === 'RequestCancelled') {
        this.push({
          kind: 'cancelled', positionId: null, requestId: String(a.id), trader: String(a.account).toLowerCase(), market: null, isLong: null,
          size: null, collateral: null, price: null, pnl: null, fees: null, payout: null, reason: String(a.reason), ...base,
        })
      }
    }
  }

  private push(t: PerpsTrade) {
    this.trades.push(t)
    if (this.trades.length > KEEP) this.trades.splice(0, this.trades.length - KEEP)
  }

  /** Newest first: one trader's, or everyone's opens and closes. */
  list(account: string | null, limit: number): PerpsTrade[] {
    const a = account?.toLowerCase() ?? null
    const out: PerpsTrade[] = []
    for (let i = this.trades.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.trades[i]
      if (a ? t.trader === a : t.kind !== 'cancelled') out.push(t)
    }
    return out
  }

  static feedsOf(markets: { p: { feedId: string } }[]) {
    return markets.map(m => symbolOf(m.p.feedId))
  }
}
