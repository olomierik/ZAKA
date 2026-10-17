// The wash-trade filter (the build pack's Phase 6: "wash-trade test wallets are filtered"; 02: "leaderboards invite
// wash trading and fake PnL"). The rules and their numbers are WASH in api/_socialProtocol.ts:
//
//  - round trips (volume farming): a wallet buys a coin and sells about the same tokens for about the same USDC within
//    five minutes, again and again, until that's most of its volume;
//  - mirrors (trading with itself through the pool): two wallets trade the same coin in opposite directions within a
//    few blocks for about the same tokens, again and again, so one's profit is the other's loss.
//
// A flagged wallet keeps its profile and its numbers; boards leave it out and its profile says why. The rules read only
// router trades (the same book PnL comes from), over the last 30 days.

import { WASH, type WashFlag, type WashReason } from '../../../api/_socialProtocol'
import { chainOrder, type BookTrade } from './pnl'

const near = (a: bigint, b: bigint, tol: number) => {
  const big = a > b ? a : b, d = a > b ? a - b : b - a
  if (big === 0n) return true
  // d / big <= tol, in integers (tol in parts per million).
  return d * 1_000_000n <= big * BigInt(Math.round(tol * 1_000_000))
}

/** One wallet's round trips: each sale paired with at most one earlier buy of the same coin it nearly undoes. */
export function roundTrips(trades: readonly BookTrade[]): { pairs: number; volume: bigint; total: bigint } {
  const sorted = [...trades].sort(chainOrder)
  const used = new Set<string>()
  let pairs = 0, volume = 0n, total = 0n
  for (const t of sorted) total += t.usdc
  for (const s of sorted) {
    if (s.side !== 'sell') continue
    for (let i = sorted.length - 1; i >= 0; i--) {
      const b = sorted[i]
      if (b.side !== 'buy' || b.token !== s.token || used.has(b.id) || chainOrder(b, s) >= 0) continue
      if (s.at - b.at > WASH.roundTripSec * 1000) break
      if (!near(s.tokens, b.tokens, WASH.tokenTol) || !near(s.usdc, b.usdc, WASH.valueTol)) continue
      used.add(b.id)
      pairs++
      volume += b.usdc + s.usdc
      break
    }
  }
  return { pairs, volume, total }
}

/** Pairs of wallets trading the same coin against each other: `${a}|${b}` (a < b) → how many times. */
export function mirrors(trades: readonly BookTrade[]): Map<string, number> {
  const byToken = new Map<string, BookTrade[]>()
  for (const t of trades) (byToken.get(t.token) ?? byToken.set(t.token, []).get(t.token)!).push(t)
  const out = new Map<string, number>()
  for (const list of byToken.values()) {
    list.sort(chainOrder)
    // Each trade counts once for each other wallet it mirrors.
    const counted = new Set<string>()
    for (let i = 0; i < list.length; i++) {
      const x = list[i]
      for (let j = i + 1; j < list.length && list[j].block - x.block <= WASH.mirrorBlocks; j++) {
        const y = list[j]
        if (y.trader === x.trader || y.side === x.side || !near(x.tokens, y.tokens, WASH.tokenTol)) continue
        const [a, b] = x.trader < y.trader ? [x.trader, y.trader] : [y.trader, x.trader]
        const key = `${a}|${b}`
        if (counted.has(`${key}:${x.id}`) || counted.has(`${key}:${y.id}`)) continue
        counted.add(`${key}:${x.id}`)
        counted.add(`${key}:${y.id}`)
        out.set(key, (out.get(key) ?? 0) + 1)
      }
    }
  }
  return out
}

/** Every wallet the rules flag, over `trades` (the book's last WASH.days days). */
export function washFlags(trades: readonly BookTrade[], now: number): Map<string, WashFlag> {
  const since = now - WASH.days * 86_400_000
  const recent = trades.filter(t => t.at >= since)
  const byTrader = new Map<string, BookTrade[]>()
  for (const t of recent) (byTrader.get(t.trader) ?? byTrader.set(t.trader, []).get(t.trader)!).push(t)
  const flags = new Map<string, WashFlag>()
  const flag = (trader: string): WashFlag => flags.get(trader) ?? flags.set(trader, { trader, reasons: [], roundTrips: 0, roundTripShare: 0, mirrors: [] }).get(trader)!
  const add = (f: WashFlag, r: WashReason) => { if (!f.reasons.includes(r)) f.reasons.push(r) }
  for (const [trader, list] of byTrader) {
    const rt = roundTrips(list)
    const share = rt.total === 0n ? 0 : Number((rt.volume * 10_000n) / rt.total) / 10_000
    if (rt.pairs >= WASH.minRoundTrips && share >= WASH.share) {
      const f = flag(trader)
      f.roundTrips = rt.pairs
      f.roundTripShare = share
      add(f, 'round-trips')
    }
  }
  for (const [key, count] of mirrors(recent)) {
    if (count < WASH.minMirrors) continue
    const [a, b] = key.split('|')
    for (const [me, other] of [[a, b], [b, a]] as const) {
      const f = flag(me)
      add(f, 'mirror')
      f.mirrors.push({ with: other, count })
    }
  }
  for (const f of flags.values()) f.mirrors.sort((x, y) => y.count - x.count)
  return flags
}
