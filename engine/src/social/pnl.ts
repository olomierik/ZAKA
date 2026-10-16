// Verified PnL (the build pack's Phase 6: "PnL on profiles matches an independent on-chain recomputation").
//
// The trades are ARCDEX's router trades on Arc, decoded from the routers' own Swapped events, never from anything a
// browser or the Supabase index says. The method is in api/_socialProtocol.ts (PNL_METHOD): average cost per coin in
// chain order, a sale realizing its proceeds less the average cost of what it sold, tokens sold beyond what was bought
// here counted apart. Every amount is a micro-USDC integer, so the numbers are exact and add up to the unit.
// scripts/verify-pnl.ts recomputes them from the chain with its own decoder and its own arithmetic.

import { keccak256, toBytes } from 'viem'
import { PERIOD_MS, SOCIAL_ROUTERS, type PnlPointV, type PositionV, type SocialPeriod, type SocialStats } from '../../../api/_socialProtocol'

export const ARC_USDC = '0x3600000000000000000000000000000000000000'
/** Swapped(address indexed trader, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address feeToken, uint256 fee) */
export const T_SWAPPED = keccak256(toBytes('Swapped(address,address,address,uint256,uint256,address,uint256)'))

export interface RouterLog { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string; blockTimestamp?: string }

export interface BookTrade {
  /** `${tx}:${logIndex}`: one Swapped event. */
  id: string
  router: string
  tx: string
  block: number
  logIndex: number
  /** Block time (ms). */
  at: number
  trader: string
  token: string
  side: 'buy' | 'sell'
  /** USDC paid (a buy, fee included) or received (a sale, fee taken), in micro-USDC. */
  usdc: bigint
  /** Tokens bought or sold, raw. */
  tokens: bigint
  /** The router's fee, in micro-USDC when it was taken in USDC (else 0). */
  fee: bigint
}

const addr = (t: string | undefined) => `0x${(t ?? '').slice(-40)}`.toLowerCase()
const word = (data: string, i: number) => { try { return BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'}`) } catch { return 0n } }

/** Chain order: block, then log index. */
export const chainOrder = (a: Pick<BookTrade, 'block' | 'logIndex'>, b: Pick<BookTrade, 'block' | 'logIndex'>) => a.block - b.block || a.logIndex - b.logIndex

/**
 * The trades in a batch of router logs. Only the routers' own Swapped events with a USDC leg count (a coin bought
 * with USDC, or sold for it); anything else is left out. `timeOf` gives a block's time when its log carries none.
 */
export function decodeTrades(logs: RouterLog[], timeOf: (block: number) => number | null = () => null): BookTrade[] {
  const out: BookTrade[] = []
  const seen = new Set<string>()
  for (const l of logs) {
    const router = l.address.toLowerCase()
    if (!SOCIAL_ROUTERS[router] || l.topics[0]?.toLowerCase() !== T_SWAPPED || l.topics.length < 4) continue
    const tx = l.transactionHash.toLowerCase(), logIndex = Number(BigInt(l.logIndex)), block = Number(BigInt(l.blockNumber))
    const id = `${tx}:${logIndex}`
    if (seen.has(id)) continue
    const tokenIn = addr(l.topics[2]), tokenOut = addr(l.topics[3])
    const buy = tokenIn === ARC_USDC
    if (!buy && tokenOut !== ARC_USDC) continue
    if (buy && tokenOut === ARC_USDC) continue
    const amountIn = word(l.data, 0), amountOut = word(l.data, 1)
    const feeToken = addr(`0x${l.data.slice(2 + 64 * 2, 2 + 64 * 3)}`), fee = word(l.data, 3)
    const at = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) * 1000 : timeOf(block)
    if (at === null || !Number.isFinite(at)) continue
    seen.add(id)
    out.push({
      id, router, tx, block, logIndex, at, trader: addr(l.topics[1]),
      token: buy ? tokenOut : tokenIn, side: buy ? 'buy' : 'sell',
      usdc: buy ? amountIn : amountOut, tokens: buy ? amountOut : amountIn,
      fee: feeToken === ARC_USDC ? fee : 0n,
    })
  }
  return out.sort(chainOrder)
}

/** One sale, priced. */
export interface SaleResult {
  trade: BookTrade
  /** Tokens of this sale that had an ARCDEX cost. */
  matched: bigint
  /** The proceeds of those tokens, and their average cost. */
  proceeds: bigint
  cost: bigint
  pnl: bigint
  /** Proceeds of tokens sold without a cost here. */
  unmatched: bigint
}

interface Hold { tokens: bigint; cost: bigint; bought: bigint; sold: bigint; realized: bigint; trades: number; last: number }

/** Walks one wallet's trades in chain order: every sale priced, and what's still held of each coin. */
export function walk(trades: readonly BookTrade[]): { sales: SaleResult[]; holds: Map<string, Hold> } {
  const holds = new Map<string, Hold>()
  const sales: SaleResult[] = []
  for (const t of [...trades].sort(chainOrder)) {
    const h = holds.get(t.token) ?? { tokens: 0n, cost: 0n, bought: 0n, sold: 0n, realized: 0n, trades: 0, last: 0 }
    holds.set(t.token, h)
    h.trades++
    h.last = Math.max(h.last, t.at)
    if (t.side === 'buy') {
      h.tokens += t.tokens
      h.cost += t.usdc
      h.bought += t.usdc
      continue
    }
    h.sold += t.usdc
    if (t.tokens === 0n) { sales.push({ trade: t, matched: 0n, proceeds: 0n, cost: 0n, pnl: 0n, unmatched: t.usdc }); continue }
    const matched = t.tokens < h.tokens ? t.tokens : h.tokens
    const proceeds = (t.usdc * matched) / t.tokens
    // The cost of what's sold comes out of the position, so a position sold in full leaves no cost behind.
    const cost = h.tokens === 0n ? 0n : matched === h.tokens ? h.cost : (h.cost * matched) / h.tokens
    h.tokens -= matched
    h.cost -= cost
    const pnl = proceeds - cost
    h.realized += pnl
    sales.push({ trade: t, matched, proceeds, cost, pnl, unmatched: t.usdc - proceeds })
  }
  return { sales, holds }
}

/** A micro-USDC integer as a decimal string with 6 places ("-12.000500"). */
export function usd6(v: bigint): string {
  const neg = v < 0n, a = neg ? -v : v
  return `${neg ? '-' : ''}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0')}`
}

/** The window's start (ms) for a period, from `now`. */
export const periodStart = (p: SocialPeriod, now: number) => (PERIOD_MS[p] === null ? 0 : now - PERIOD_MS[p]!)

/** A wallet's numbers over a window: sales in it realize against costs from any time before them. */
export function statsOf(trades: readonly BookTrade[], since: number, walked = walk(trades)): SocialStats {
  let realized = 0n, volume = 0n, unmatched = 0n, n = 0, buys = 0, sells = 0, wins = 0, counted = 0
  let first: number | null = null, last: number | null = null
  const coins = new Set<string>()
  for (const t of trades) {
    if (t.at < since) continue
    n++
    volume += t.usdc
    coins.add(t.token)
    if (t.side === 'buy') buys++; else sells++
    first = first === null ? t.at : Math.min(first, t.at)
    last = last === null ? t.at : Math.max(last, t.at)
  }
  for (const s of walked.sales) {
    if (s.trade.at < since) continue
    realized += s.pnl
    unmatched += s.unmatched
    if (s.matched > 0n) { counted++; if (s.pnl > 0n) wins++ }
  }
  return { realized: usd6(realized), volume: usd6(volume), trades: n, buys, sells, wins, counted, coins: coins.size, unmatched: usd6(unmatched), first, last }
}

/** Realized PnL after every sale with a cost, and its running total (a profile's chart). */
export function historyOf(walked: ReturnType<typeof walk>, limit = 500): PnlPointV[] {
  let total = 0n
  const out: PnlPointV[] = []
  for (const s of walked.sales) {
    if (s.matched === 0n) continue
    total += s.pnl
    out.push({ at: s.trade.at, tx: s.trade.tx, token: s.trade.token, pnl: usd6(s.pnl), cumulative: usd6(total) })
  }
  return out.slice(-limit)
}

/** Every coin a wallet traded here, newest first: what it still holds of it (raw) at what cost, and what it realized. */
export function positionsOf(walked: ReturnType<typeof walk>): PositionV[] {
  return [...walked.holds.entries()]
    .map(([token, h]) => ({ token, held: h.tokens.toString(), cost: usd6(h.cost), bought: usd6(h.bought), sold: usd6(h.sold), realized: usd6(h.realized), trades: h.trades, last: h.last }))
    .sort((a, b) => b.last - a.last)
}
