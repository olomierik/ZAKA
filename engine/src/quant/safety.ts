// The safety layer: a hard rejection before any signal can become an order.
// It builds on the engine's scanner (intel/scanner.ts: launchpad and code
// templates, owner powers such as mint/freeze/pause/blacklist-style trading
// switches/fees/upgrades, the swap hook, the honeypot probe with its buy and
// sell taxes, holders from Transfer logs, bundles, funding clusters, wash
// trading) and the rug guard (bot/rugGuard.ts: liquidity pulls, insider and
// whale dumps), and adds what the signal engine sees in the coin's own trades:
// liquidity for the planned size, holder concentration and the creator's bag.
//
// Critical flags (trade_allowed = false whatever the score):
//   a hard scanner check failed (except the creator one, below), a rug alarm
//   in the last 30 minutes, taxes or round-trip costs over the limit, a pool
//   too thin for the size, or no scan yet
// The creator check: on Argus the creator usually sells out in the first
// minute (58 of 181 Argus coins measured on 2026-10-01; coins whose creator
// had sold out did no worse than the rest). A creator who sold out has no bag
// left to dump: that's a flag, not a rejection. One who sold part of their
// buy and still holds the rest is dumping now: critical.

import type { SafetyReport } from '../intel/scanner'

export interface SafetyVerdict {
  safety_score: number
  risk_flags: string[]
  /** Flags that forbid a buy, in words. */
  critical: string[]
  trade_allowed: boolean
  /** The probe's round trip and buy tax (%), when measured. */
  roundTripPct: number | null
  buyTaxPct: number | null
  scanned: boolean
}

export interface SafetyInput {
  report: SafetyReport | null
  /** A rug alarm in the quarantine window, in words. */
  rugAlarm: string | null
  liquidity: number | null
  /** Price impact of the planned size on entry (%). */
  impactPct: number
  /** Top-10 holders' share of the supply (%), from the coin's trades. */
  top10Pct: number | null
  /** The creator's unsold share of their buy (0–1), or null if they never bought. */
  creatorLeft: number | null
  /** The creator's holding as a share of the supply (%). */
  creatorPct: number | null
  limits: { minSafetyScore: number; minLiquidityUsd: number; maxPriceImpactPct: number; maxRoundTripPct: number }
}

export function assessSafety(i: SafetyInput): SafetyVerdict {
  const flags: string[] = [], critical: string[] = []
  const r = i.report
  let score = r?.score ?? 0
  if (!r) critical.push('no safety scan yet')
  else {
    for (const c of r.checks) {
      if (c.ok === false && c.hard) {
        // The scanner took 30 points for it (intel/scanner.ts): given back, it's a flag here.
        if (c.id === 'creator' && (i.creatorLeft === null || i.creatorLeft <= 0.1)) { flags.push('creator-exited'); score += 30; continue }
        critical.push(`${c.id}: ${c.detail}`)
      } else if (c.ok === null && c.hard) critical.push(`${c.id} not checked yet`)
      else if (c.ok !== true && c.risk) flags.push(c.id)
    }
  }
  const rt = r?.honeypot?.roundTripLossPct ?? null
  const buyTax = r?.honeypot?.buyTaxPct ?? null
  if (rt !== null && rt > i.limits.maxRoundTripPct) critical.push(`a round trip costs ${rt.toFixed(1)}% (over ${i.limits.maxRoundTripPct}%): taxes or fees too high`)
  else if (rt !== null && rt > i.limits.maxRoundTripPct / 2) { flags.push('high-costs'); score -= 5 }
  if (i.rugAlarm) critical.push(`rug guard: ${i.rugAlarm}`)
  if (!i.liquidity || i.liquidity < i.limits.minLiquidityUsd) critical.push(`liquidity $${Math.round(i.liquidity ?? 0).toLocaleString('en-US')} (need $${i.limits.minLiquidityUsd.toLocaleString('en-US')})`)
  if (i.impactPct > i.limits.maxPriceImpactPct) critical.push(`the size would move the price ${i.impactPct.toFixed(1)}% (over ${i.limits.maxPriceImpactPct}%): not exitable at this size`)
  if (i.top10Pct !== null && i.top10Pct > 60) { flags.push('concentrated-holders'); score -= 10 }
  if (i.creatorLeft !== null && i.creatorLeft > 0.1 && i.creatorLeft < 0.5) { critical.push(`the creator sold ${Math.round((1 - i.creatorLeft) * 100)}% of their buy and still holds the rest`) }
  if (i.creatorPct !== null && i.creatorPct > 15) { flags.push('creator-bag'); score -= 10 }
  score = Math.max(0, Math.min(100, score))
  if (score < i.limits.minSafetyScore && !critical.length) critical.push(`safety score ${Math.round(score)} under ${i.limits.minSafetyScore}`)
  return { safety_score: Math.round(score), risk_flags: flags, critical, trade_allowed: critical.length === 0, roundTripPct: rt, buyTaxPct: buyTax, scanned: !!r }
}
