// Copy trading's decisions, pure (the build pack's Phase 7: "copy rules (max size, slippage cap, safety filter, stop
// switch)"; acceptance: "caps respected; tokens failing safety are skipped"). The engine (copy/engine.ts) calls these;
// tests call them directly.

import { COPY, LEADER_MIN, isCopySafety, type CopySafety } from '../../../api/_copyProtocol'
import type { SocialStats, WashFlag } from '../../../api/_socialProtocol'
import type { SafetyReport } from '../intel/scanner'

const ADDR = /^0x[0-9a-f]{40}$/

export interface RuleInput { leader: string; maxPerTradeUsd: number; slippageBps: number; safety: CopySafety; enabled: boolean }

/** A rule from a request body, or why not. */
export function parseRule(b: unknown): RuleInput | string {
  const o = (b ?? {}) as Record<string, unknown>
  const leader = typeof o.leader === 'string' ? o.leader.trim().toLowerCase() : ''
  if (!ADDR.test(leader)) return 'leader must be a wallet address'
  const max = Number(o.maxPerTradeUsd)
  if (!Number.isFinite(max) || max < COPY.minPerTradeUsd || max > COPY.maxPerTradeUsd) return `the most per trade must be between $${COPY.minPerTradeUsd} and $${COPY.maxPerTradeUsd}`
  const slip = o.slippageBps === undefined ? COPY.defaultSlippageBps : Number(o.slippageBps)
  if (!Number.isInteger(slip) || slip < COPY.minSlippageBps || slip > COPY.maxSlippageBps) return `the slippage cap must be between ${COPY.minSlippageBps / 100}% and ${COPY.maxSlippageBps / 100}%`
  const safety = o.safety === undefined ? 'not-danger' : o.safety
  if (!isCopySafety(safety)) return 'safety must be not-danger or safe-only'
  const enabled = o.enabled === undefined ? true : o.enabled
  if (typeof enabled !== 'boolean') return 'enabled must be true or false'
  return { leader, maxPerTradeUsd: Math.round(max * 100) / 100, slippageBps: slip, safety, enabled }
}

/** Whether a wallet can be copied: on the verified record with LEADER_MIN behind it, and no wash-trade flag. */
export function leaderVerdict(t: { periods: { all: SocialStats }; wash: WashFlag | null } | null, now: number): string | null {
  if (!t) return 'this wallet has no verified trades on ARCDEX'
  if (t.wash) return 'this wallet is left out of the leaderboards by the wash-trade filter'
  const all = t.periods.all
  if (all.trades < LEADER_MIN.trades) return `a leader needs ${LEADER_MIN.trades}+ verified trades (this one has ${all.trades})`
  if (all.counted < LEADER_MIN.counted) return `a leader needs ${LEADER_MIN.counted}+ sales with a cost on ARCDEX (this one has ${all.counted})`
  if (all.first === null || now - all.first < LEADER_MIN.days * 86_400_000) return `a leader needs ${LEADER_MIN.days}+ days of trading on ARCDEX`
  return null
}

export type Rating = 'safe' | 'risky' | 'danger' | 'unknown'
/** Hard checks a copy can't go ahead without an answer to. The sell test is the copy's own pre-flight. */
const ESSENTIAL = new Set(['launchpad', 'contract', 'proxy', 'selfdestruct', 'hook', 'liquidity', 'creator', 'bundle', 'wash'])

/** The coin's rating for a copy, from the scanner's report and the rug guard. */
export function screen(r: SafetyReport | null, rugAlarm: string | null): { rating: Rating; why: string | null } {
  if (rugAlarm) return { rating: 'danger', why: `rug guard: ${rugAlarm}` }
  if (!r) return { rating: 'unknown', why: 'ARCDEX has no safety report for this coin' }
  const failed = r.checks.find(c => c.hard && c.ok === false)
  if (failed) return { rating: 'danger', why: `${failed.id}: ${failed.detail}` }
  const open = r.checks.find(c => c.hard && c.ok === null && ESSENTIAL.has(c.id))
  if (open) return { rating: 'unknown', why: `${open.id} not checked yet` }
  const flag = r.checks.find(c => (c.risk && c.ok !== true) || (c.hard && c.ok === null))
  if (flag) return { rating: 'risky', why: `${flag.id}: ${flag.detail}` }
  return { rating: 'safe', why: null }
}

/** Whether a rule's safety level lets a coin with this rating be bought. */
export function safetyBlocks(level: CopySafety, s: { rating: Rating; why: string | null }): string | null {
  if (s.rating === 'danger') return `skipped by the safety screen (Danger: ${s.why})`
  if (s.rating === 'unknown') return `skipped: the safety screen couldn't finish (${s.why})`
  if (level === 'safe-only' && s.rating === 'risky') return `skipped: your rule copies Safe coins only (Risky: ${s.why})`
  return null
}

/** What a copied buy spends: the leader's size, up to the rule's most and what the wallet can spend with the fee. */
export function buySize(leaderPoolUsd: number, maxPerTradeUsd: number, availableUsd: number, feeBps: number): number {
  const affordable = availableUsd / (1 + feeBps / 10_000)
  const usd = Math.min(leaderPoolUsd, maxPerTradeUsd, affordable)
  return Math.floor(usd * 100) / 100
}

/**
 * The fewest tokens a copied buy of `amountMicro` USDC (pool units, 6 decimals) may get: the leader's own price (what
 * reached the pool, its fee taken) less the rule's cap. Enforced on-chain as the swap's minimum.
 */
export function buyFloor(amountMicro: bigint, leader: { usdc: bigint; fee: bigint; tokens: bigint }, slippageBps: number): bigint {
  const pool = leader.usdc - leader.fee
  if (pool <= 0n || leader.tokens <= 0n) return 0n
  return (amountMicro * leader.tokens * BigInt(10_000 - slippageBps)) / (pool * 10_000n)
}

/**
 * What a copied sale sells of the follower's lot: the share of the leader's holding the leader sold. `leaderAfter` is
 * the leader's balance after its sale (null: unknown, so the whole lot). A leader left with 1% or less sold out.
 */
export function sellAmount(lot: bigint, leaderSold: bigint, leaderAfter: bigint | null): bigint {
  if (lot <= 0n) return 0n
  if (leaderAfter === null || leaderSold <= 0n) return lot
  const before = leaderAfter + leaderSold
  if (leaderAfter * 100n <= before) return lot
  const out = (lot * leaderSold) / before
  return out > lot ? lot : out
}

/** Splits one leader trade's room (COPY.crowdPoolShare of the pool) among its followers, in the order given. */
export function allocate(asks: { key: string; usd: number }[], liquidityUsd: number | null): Map<string, number> {
  let room = liquidityUsd && liquidityUsd > 0 ? liquidityUsd * COPY.crowdPoolShare : Infinity
  const out = new Map<string, number>()
  for (const a of asks) {
    const usd = Math.floor(Math.min(a.usd, room) * 100) / 100
    out.set(a.key, usd)
    room -= usd
  }
  return out
}

/** A deterministic order for one trade's followers, different for every trade (no follower is always first). */
export function shuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    const j = h % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** The middle and 95th percentile of a list of times. */
export function percentiles(ms: number[]): { p50: number | null; p95: number | null } {
  if (!ms.length) return { p50: null, p95: null }
  const s = [...ms].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]
  return { p50: at(0.5), p95: at(0.95) }
}
