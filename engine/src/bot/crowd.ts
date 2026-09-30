// Many bots, one signal (owner's request, 2026-09-30: "all bots receive the
// same signal, which makes a huge buy on the same coin, and the coin's issuer
// sells into it"). Every live bot that takes a signal buys the same coin in
// the same few seconds: together they push the price up against themselves
// (the last one in pays the most), hand the creator a wall of buyers to sell
// into, and then all try to sell at the same take-profit. So a signal's live
// buying is shared out:
//
//   a cap      all bots together buy no more than moves the price a quarter
//              of the take-profit (a +6% Precision trade: about 0.75% of the
//              pool; +10%: 1.25%), never over 2% of the pool, and at most 25
//              bots. A coin whose creator still holds a big share (the
//              "holders" risk flag) gets half: they sell into buyers. The
//              platform's own bot takes only what visitors' bots leave.
//   an order   higher tiers first (once tiers are enforced: bot/tiers.ts),
//              then the bot that has waited longest since its last seat, then
//              a rotation that changes with every signal. A bot left out is
//              told why, and is ahead next time: over a day every bot gets
//              its share.
//   a ladder   each later bot's take-profit is a notch higher (0.25% a seat,
//              1.5% at most), so they don't all sell on the same tick; the
//              first in line, which paid least, sells first.
//
// Paper bots don't move the market, so they aren't capped, but their fills
// pay the live crowd's price impact on top of their own (the live bots buy
// first): paper reads like live even when many bots share a coin.
//
// Measured on 2026-09-30, the most crowded signal had 9 bots, 3 of them live,
// buying $12.80 together: 0.19% of its pool, well under the cap. The creator
// sold within 10 minutes in 28 of 52 signals, into every buyer, not ours in
// particular (their sales ran $2,000–3,800; our bots bought $1–8 each). The
// cap is for when there are many more bots.

import { createHash } from 'node:crypto'

export const CROWD = {
  /** Our bots' combined buying may move the price at most this share of the take-profit… */
  impactShareOfTp: 0.25,
  /** …and never buy over this share of the pool, whatever the take-profit. */
  maxPoolShare: 0.02,
  /** At most this many live bots on one signal. */
  maxBots: 25,
  /** A pool of unknown depth: this much in all. */
  unknownPoolUsd: 50,
  /** Halved when the creator still holds a big share. */
  creatorFlag: 'holders',
  creatorFactor: 0.5,
  minUsd: 1,
  /** Take-profit ladder: each seat this much higher, up to this much. */
  ladderStep: 0.0025,
  ladderMax: 0.015,
  /** A signal's crowd is kept this long (the owner's bot and paper fills read it). */
  keepMs: 10 * 60_000,
}

/** The most all bots together buy on one signal. */
export function crowdCap(o: { liquidityUsd: number | null; takeProfit: number; flags?: string[] }): number {
  const L = o.liquidityUsd ?? 0
  let cap = L > 0
    // A buy of x against depth L moves the price about x / (L/2) (trading/paper.ts costPerSide).
    ? Math.min(CROWD.impactShareOfTp * Math.max(0, o.takeProfit - 1) * (L / 2), CROWD.maxPoolShare * L)
    : CROWD.unknownPoolUsd
  if (o.flags?.includes(CROWD.creatorFlag)) cap *= CROWD.creatorFactor
  return Math.floor(cap * 10) / 10
}

/** The price move a crowd's buying makes in a pool (what a later buyer pays on top). */
export const crowdImpact = (usd: number, liquidityUsd: number | null) => (liquidityUsd && liquidityUsd > 0 && usd > 0 ? usd / (liquidityUsd / 2) : 0)

/** A take-profit a seat further back in line sells at. */
export const laddered = (takeProfit: number, rank: number) => Math.round(takeProfit * (1 + Math.min(rank * CROWD.ladderStep, CROWD.ladderMax)) * 10_000) / 10_000

export interface CrowdCandidate { id: string; priority: number; wantUsd: number; minUsd?: number }
export interface CrowdSeat { id: string; sizeUsd: number; rank: number }
export interface CrowdResult { seats: CrowdSeat[]; left: { id: string; why: string; key: 'crowded' }[]; usedUsd: number; capUsd: number }

const rotation = (key: string, id: string) => createHash('sha256').update(`${key}:${id}`).digest().readUInt32BE(0)

/** Who waited longest, and each signal's crowd. */
export class CrowdBook {
  private servedAt = new Map<string, number>()
  private signals = new Map<string, { at: number; capUsd: number; usedUsd: number; bots: number }>()

  /** Seats the candidates of one signal within its cap: tier first, then the longest wait, then a rotation. */
  allocate(signalId: string, cands: CrowdCandidate[], capUsd: number, now = Date.now()): CrowdResult {
    const order = [...cands].sort((a, b) =>
      b.priority - a.priority
      || (this.servedAt.get(a.id) ?? 0) - (this.servedAt.get(b.id) ?? 0)
      || rotation(signalId, a.id) - rotation(signalId, b.id))
    const seats: CrowdSeat[] = [], left: CrowdResult['left'] = []
    let used = this.signals.get(signalId)?.usedUsd ?? 0
    for (const c of order) {
      const min = c.minUsd ?? CROWD.minUsd
      if (seats.length >= CROWD.maxBots) { left.push({ id: c.id, key: 'crowded', why: `not traded: ${CROWD.maxBots} bots already took this signal (you're ahead next time)` }); continue }
      const size = Math.floor(Math.min(c.wantUsd, capUsd - used) * 10) / 10
      if (size < min) { left.push({ id: c.id, key: 'crowded', why: `not traded: bots already bought $${used.toFixed(2)} of this coin, its cap ($${capUsd.toFixed(2)}, so our buying doesn't move the price against itself; you're ahead next time)` }); continue }
      seats.push({ id: c.id, sizeUsd: size, rank: seats.length })
      used += size
      this.servedAt.set(c.id, now)
    }
    this.note(signalId, capUsd, used, seats.length, now)
    return { seats, left, usedUsd: Math.round(used * 100) / 100, capUsd }
  }

  /** What a signal's crowd has bought so far (live bots), and its cap. */
  of(signalId: string): { capUsd: number; usedUsd: number; bots: number } | null {
    const s = this.signals.get(signalId)
    return s ? { capUsd: s.capUsd, usedUsd: s.usedUsd, bots: s.bots } : null
  }

  /** The platform's own bot: what the visitors' bots left under the cap. */
  leftover(signalId: string, capUsd: number): number {
    const s = this.signals.get(signalId)
    return Math.max(0, Math.floor(((s?.capUsd ?? capUsd) - (s?.usedUsd ?? 0)) * 10) / 10)
  }

  /** Adds a buy outside `allocate` (the platform's bot) to the signal's crowd. */
  take(signalId: string, capUsd: number, usd: number, now = Date.now()) {
    const s = this.signals.get(signalId)
    this.note(signalId, s?.capUsd ?? capUsd, (s?.usedUsd ?? 0) + usd, (s?.bots ?? 0) + 1, now)
  }

  private note(signalId: string, capUsd: number, usedUsd: number, bots: number, now: number) {
    this.signals.set(signalId, { at: now, capUsd, usedUsd, bots })
    for (const [k, v] of this.signals) if (now - v.at > CROWD.keepMs) this.signals.delete(k)
  }
}
