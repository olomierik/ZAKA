// The social layer's shared shapes (the build pack's Phase 6): verified PnL from ARCDEX's own router trades on Arc,
// the wash-trade filter, comments, reports and mutes. The engine serves them (engine/src/social); the site reads them
// (src/arcdex/api/socialEngine.ts). No browser or chain libraries here.

/** The windows a board or a profile is computed over. */
export const SOCIAL_PERIODS = ['24h', '7d', '30d', 'all'] as const
export type SocialPeriod = (typeof SOCIAL_PERIODS)[number]
export const isSocialPeriod = (p: unknown): p is SocialPeriod => typeof p === 'string' && (SOCIAL_PERIODS as readonly string[]).includes(p)
export const PERIOD_MS: Record<SocialPeriod, number | null> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: null }

/**
 * How PnL is computed (engine/src/social/pnl.ts; scripts/verify-pnl.ts recomputes it on its own):
 *  - trades are ARCDEX's router trades on Arc (ArcDexSwapRouter v1 and v2, ArcDexCurveRouter), read from their
 *    Swapped events, in chain order;
 *  - a buy's cost is the USDC it paid (fee included); a sale's proceeds are the USDC it received (fee taken);
 *  - each coin keeps an average cost; a sale realizes its proceeds less the average cost of the tokens it sold;
 *  - tokens sold beyond what was bought through ARCDEX (sent in from elsewhere) have no cost here: their proceeds
 *    aren't PnL, and are shown apart ("sold without a cost here");
 *  - a window's PnL is what sales in that window realized, against costs from any time before them.
 * Amounts are exact: micro-USDC integers, sent as decimal strings with 6 places.
 */
export const PNL_METHOD = 'average cost per coin, in chain order, ARCDEX router trades on Arc'

/** The routers whose Swapped events make the trade book: address → the first block it can have one. */
export const SOCIAL_ROUTERS: Record<string, { name: string; from: number }> = {
  '0xc519b929981f5375d67ab3930ffb100f0a606088': { name: 'ArcDexSwapRouter v1', from: 22_548_761 },
  '0xd07583f7db671521aacfda2b4612ad187aa2924e': { name: 'ArcDexSwapRouter v2', from: 22_548_761 },
  '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441': { name: 'ArcDexCurveRouter', from: 22_548_761 },
}
export const SOCIAL_FROM_BLOCK = 22_548_761

/** A board's floor: a wallet needs this much in the window to be ranked. */
export const BOARD_MIN = { trades: 3, sells: 1 }

/**
 * The wash-trade filter (engine/src/social/wash.ts), over each wallet's last 30 days of router trades:
 *  - round trips: a buy and a sale of the same coin by the same wallet within `roundTripSec`, for about the same
 *    tokens (within `tokenTol`) and about the same USDC (within `valueTol`). A wallet with at least `minRoundTrips` of
 *    them making up `share` or more of its volume is farming volume;
 *  - mirrors: two wallets trading the same coin in opposite directions within `mirrorBlocks` blocks, for about the same
 *    tokens (within `tokenTol`). Two wallets that mirror each other `minMirrors` times or more are trading with
 *    themselves (one wallet's profit is the other's loss).
 * A flagged wallet keeps its profile and its PnL; it's left out of every leaderboard, with the reason on its profile.
 */
export const WASH = { days: 30, roundTripSec: 300, tokenTol: 0.1, valueTol: 0.05, minRoundTrips: 5, share: 0.5, mirrorBlocks: 3, minMirrors: 3 }
export type WashReason = 'round-trips' | 'mirror'
export interface WashFlag { trader: string; reasons: WashReason[]; roundTrips: number; roundTripShare: number; mirrors: { with: string; count: number }[] }

export interface SocialStats {
  /** Realized PnL in the window (USDC, 6 places). */
  realized: string
  volume: string
  trades: number
  buys: number
  sells: number
  /** Sales with a cost here that made money / all sales with a cost here. */
  wins: number
  counted: number
  coins: number
  /** Proceeds of tokens sold without an ARCDEX cost (sent in from elsewhere): not PnL. */
  unmatched: string
  first: number | null
  last: number | null
}

export interface LeaderRowV {
  rank: number
  trader: string
  stats: SocialStats
}

export interface SocialBoard {
  at: number
  period: SocialPeriod
  method: string
  /** The trade book is complete to this block, and checked against a fresh scan of the chain to `checkedTo`. */
  scannedTo: number
  checkedTo: number
  rows: LeaderRowV[]
  /** Wallets with a big enough window that the wash-trade filter left out. */
  excluded: { trader: string; reasons: WashReason[]; realized: string }[]
  /** How many wallets traded in the window but fell under BOARD_MIN. */
  thin: number
}

export interface PnlPointV { at: number; tx: string; token: string; pnl: string; cumulative: string }
export interface PositionV { token: string; held: string; cost: string; bought: string; sold: string; realized: string; trades: number; last: number }

export interface SocialTrader {
  at: number
  trader: string
  method: string
  scannedTo: number
  checkedTo: number
  periods: Record<SocialPeriod, SocialStats>
  /** Rank on each period's board, or null (not ranked, or left out). */
  ranks: Record<SocialPeriod, number | null>
  wash: WashFlag | null
  history: PnlPointV[]
  positions: PositionV[]
  /** How many router trades the numbers come from. */
  tradeCount: number
}

// ── Comments, reports, mutes ──────────────────────────────────────────────

/** A comment's target: a thesis (its id), or a coin (chain and address). */
export type CommentTarget = `thesis:${number}` | `coin:${string}:${string}`
/** What can be reported. */
export type ReportTarget = CommentTarget | `comment:${string}` | `profile:${string}`

const EVM = /^0x[0-9a-f]{40}$/
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const COIN_CHAINS = ['arc', 'robinhood', 'solana', 'bsc'] as const

/** The target as stored (EVM addresses lower-cased), or null when it isn't one. */
export function parseCommentTarget(v: unknown): CommentTarget | null {
  if (typeof v !== 'string' || v.length > 120) return null
  const t = /^thesis:([1-9][0-9]{0,14})$/.exec(v)
  if (t) return `thesis:${Number(t[1])}`
  const c = /^coin:([a-z]+):([0-9A-Za-z]+)$/.exec(v)
  if (c && (COIN_CHAINS as readonly string[]).includes(c[1])) {
    if (c[1] === 'solana') return SOL.test(c[2]) ? `coin:solana:${c[2]}` : null
    const a = c[2].toLowerCase()
    return EVM.test(a) ? `coin:${c[1]}:${a}` : null
  }
  return null
}

export function parseReportTarget(v: unknown): ReportTarget | null {
  const ct = parseCommentTarget(v)
  if (ct) return ct
  if (typeof v !== 'string' || v.length > 120) return null
  const m = /^comment:(c_[0-9a-z]{6,40})$/.exec(v)
  if (m) return `comment:${m[1]}`
  const p = /^profile:(0x[0-9a-fA-F]{40})$/.exec(v)
  if (p) return `profile:${p[1].toLowerCase()}`
  return null
}

export const REPORT_REASONS = ['spam', 'scam', 'abuse', 'impersonation', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]
export const isReportReason = (r: unknown): r is ReportReason => typeof r === 'string' && (REPORT_REASONS as readonly string[]).includes(r)

export const SOCIAL_LIMITS = {
  commentChars: 280,
  noteChars: 280,
  commentsPerDay: 30,
  commentGapMs: 10_000,
  reportsPerDay: 20,
  mutesMax: 1_000,
  /** A comment or thesis that this many different wallets report is hidden until an admin looks at it. */
  autoHideReporters: 3,
}

/**
 * A comment's text as stored: control and zero-width characters out, runs of blank lines cut to one, trimmed.
 * Null when nothing's left or it's too long. It's always shown as text, never as HTML.
 */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!s || s.length > max) return null
  return s
}

export interface CommentV {
  id: string
  target: CommentTarget
  author: string
  body: string
  at: number
  /** Removed by its author: the text is gone. */
  deleted?: boolean
}

export interface ModerationState {
  /** Theses hidden from the site (by reports or an admin). */
  theses: number[]
  /** Wallets an admin banned from posting: their theses and comments are hidden too. */
  banned: string[]
}

export interface MyView { mutes: string[]; reports: string[] }

export const MODERATION_ACTIONS = ['hide', 'restore', 'dismiss', 'ban', 'unban'] as const
export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

/** The exact text an admin wallet signs to moderate (valid 5 minutes, once). */
export function moderationMessage(action: ModerationAction, target: string, reason: string, at: number): string {
  return `ARCDEX moderation\nSite: arcsense.site\n${action.toUpperCase()} ${target}\nReason: ${reason}\nAt: ${new Date(at).toISOString()}`
}

export interface ReportGroup {
  target: ReportTarget
  reports: number
  reasons: Partial<Record<ReportReason, number>>
  latest: number
  /** What was reported, as it was when first reported. */
  snapshot: { author: string | null; body: string | null } | null
  state: 'open' | 'hidden' | 'restored' | 'dismissed'
  notes: { reporter: string; reason: ReportReason; note: string | null; at: number }[]
}
