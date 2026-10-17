// The trade guardrails, in one place (the build pack's Phase 2: "slippage ceiling, price-impact cap, min-out, size caps,
// kill switch"). Every trade path reads its limits from here:
//   • price impact and off-market quotes: QUOTE_LIMITS (Across, Relay, Jupiter);
//   • the slippage ceiling: a quote whose minimum received sits more than `maxSlippageBps` under what it expects is
//     refused, so a trade can't fill far below the price shown;
//   • min-out: every route sends a minimum the chain enforces (the trade reverts below it); a quote without one is refused;
//   • the size cap: no single trade over `maxTradeUsd`;
//   • a fresh quote before signing that delivers `driftBeforeSign` less than the one shown stops the trade;
//   • the kill switch: lib/tradeSwitch.ts (`assertTradingOn`), checked before anything is signed.

import { t as T } from './i18n'

export const GUARDRAILS = {
  /** Price impact: a tick box from 15% (impact or all costs), refused from 50%, and refused when a quote pays over 25%
   * more than the market price (a route through an off-market pool, however good it looks). */
  confirm: 0.15,
  refuse: 0.5,
  offMarket: 0.25,
  /** The minimum received may sit at most this far under the expected amount (15%). */
  maxSlippageBps: 1500,
  /** No single trade over this many dollars. */
  maxTradeUsd: 25_000,
  /** The fresh quote taken right before signing may deliver at most this much less than the one shown. */
  driftBeforeSign: 0.03,
} as const

/** Why a quote's minimum received breaks the guardrails, or null. */
export function minOutProblem(expectedOut: bigint, minOut: bigint, ceilingBps: number = GUARDRAILS.maxSlippageBps): string | null {
  if (!(expectedOut > 0n)) return T('This quote delivers nothing.')
  if (!(minOut > 0n)) return T('This quote has no minimum received, so ARCDEX won’t send it.')
  if (minOut > expectedOut) return T('This quote’s minimum is above what it expects to deliver.')
  if ((expectedOut - minOut) * 10_000n > expectedOut * BigInt(ceilingBps)) {
    return T('This quote could fill more than {pct}% under its price, so ARCDEX won’t send it.', { pct: String(ceilingBps / 100) })
  }
  return null
}

/** Why a trade of `usd` dollars is too big, or null (an unknown value isn't held against it). */
export function sizeProblem(usd: number | null | undefined, cap: number = GUARDRAILS.maxTradeUsd): string | null {
  if (usd == null || !Number.isFinite(usd)) return null
  return usd > cap ? T('ARCDEX trades up to {cap} at a time: split this into smaller trades.', { cap: `$${cap.toLocaleString('en-US')}` }) : null
}

/** Whether a fresh quote moved too far from the one shown: worse by more than the drift, or better by more than an
 * off-market route would (the route changed). */
export function driftProblem(shownOut: bigint, freshOut: bigint): 'worse' | 'changed' | null {
  if (shownOut <= 0n) return null
  const shown = Number(shownOut), fresh = Number(freshOut)
  if (fresh < shown * (1 - GUARDRAILS.driftBeforeSign)) return 'worse'
  if (fresh > shown * (1 + GUARDRAILS.offMarket)) return 'changed'
  return null
}
