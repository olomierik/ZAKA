// Safety for the site's coin board and lists (2026-10-04, owner: "attract users and avoid buying rugs"): the safety
// scanner's checks for every coin a page shows, not only the ones a trading rule picked. The site asks for the coins it
// shows (GET /v1/safety?tokens=…) and turns the answer into Safe / Risky / Danger (src/arcdex/lib/safety.ts).
//
// A coin with no report yet is queued and answered as "not scanned" until its scan lands (the page asks again every
// 20 seconds). A young coin gets the full scan (sell test, holders, funding); an older one the sell test alone: reading
// days of transfers for holders would take far longer, and selling back is what matters most.

import type { CoinSafety } from '../../../api/_marketProtocol'
import type { SafetyReport } from '../intel/scanner'

export const BOARD = {
  /** Coins one request may ask for. */
  maxTokens: 120,
  /** Coins waiting for a scan; past it, the oldest asks are dropped (asked again on the next poll). */
  maxQueue: 400,
  /** Scans at once (the deep scan's own limiter still caps them together with the bots'). */
  concurrency: 2,
  /** A report older than this is refreshed. */
  freshMs: 10 * 60_000,
  /** Coins younger than this get the full scan; older ones the sell test alone. */
  deepUnderMs: 6 * 3_600_000,
  /** How long a sell test alone holds. */
  probeTtlMs: 30 * 60_000,
} as const

/** A report as the site reads it: the hard and risk checks it failed, whether it sold back, its launcher's record. */
export function boardView(r: SafetyReport | null, launcher: { coins: number; dumps: number } | null, creator: string | null = null): CoinSafety {
  if (!r) return { at: 0, fails: [], risks: [], sellable: null, launcher, deep: false, creator }
  const fails = r.checks.filter(c => c.hard && c.ok === false).map(c => ({ id: c.id, detail: c.detail }))
  const risks = r.checks.filter(c => c.risk && c.ok === false).map(c => ({ id: c.id, detail: c.detail }))
  // No sell test on a launchpad curve: the curve itself buys back.
  const hp = r.checks.find(c => c.id === 'honeypot')
  const sellable = hp ? hp.ok : true
  const deep = r.checks.some(c => c.id === 'holders' && c.ok !== null)
  return { at: r.at, fails, risks, sellable, launcher, deep, creator }
}
