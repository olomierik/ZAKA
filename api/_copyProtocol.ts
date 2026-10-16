// Copy trading (the build pack's Phase 7; the owner chose engine-held copy wallets on 2026-10-16): what the engine and
// the site share. The engine side is engine/src/copy; the site's page is src/arcdex/pages/CopyPage.tsx.
//
// A follower opens a copy wallet on the engine, funds it with USDC on Arc, and follows leaders: wallets on the
// verified board with enough history and no wash-trade flag. When a leader trades through ARCDEX's routers on Arc,
// the engine mirrors it from the copy wallet within seconds, under the follower's rules.

/** What the copy engine aims for, and the limits on rules and wallets. */
export const COPY = {
  /** A copied trade should land within this of the leader's block. Measured on every copy (GET /v1/copy/status). */
  windowMs: 30_000,
  /** A leader trade older than this when the engine sees it isn't copied (a restart, a lagging socket): too late. */
  staleMs: 60_000,
  /** Rules a follower may have. */
  maxRules: 10,
  /** A rule's most per copied buy, in USD. */
  minPerTradeUsd: 1,
  maxPerTradeUsd: 500,
  /** A rule's slippage cap, in basis points: a copied buy is never made at a price this much worse than the leader's. */
  minSlippageBps: 50,
  maxSlippageBps: 1_500,
  defaultSlippageBps: 300,
  /** Kept in the copy wallet for gas. */
  reserveUsd: 0.3,
  /** All followers of one leader trade together buy at most this share of the coin's pool liquidity. */
  crowdPoolShare: 0.02,
  /** Fees owed are sent to the fee wallet once they reach this (and before any withdrawal). */
  feeSettleUsd: 0.25,
  /** A copy's pre-flight (buying and selling straight back, as the copy wallet) may cost at most this much. */
  maxRoundTripPct: 20,
  /** Copies under this many USD aren't made: gas and the fee would eat them. */
  minTradeUsd: 1,
}

/** Who can be copied: enough verified history, and no wash-trade flag. */
export const LEADER_MIN = { trades: 10, counted: 3, days: 3 }

/** The risk notices a follower accepts, by signing them, before a copy wallet is made. A new version asks again. */
export const COPY_TERMS_VERSION = 1
export const COPY_TERMS = [
  'Copy trading copies losses as faithfully as gains. Meme coins can lose most or all of their value in minutes.',
  'Copies are made after the leader trades, at a different price, and some are skipped (your rules, the safety screen, not enough USDC, a stop).',
  'ARCDEX holds the key of your copy wallet on its server and trades from it for you. It is custodial: only fund it with what you can afford to lose.',
  'Withdrawals go only to the wallet you signed in with, or to a wallet that funded the copy wallet.',
  'Every copied trade pays ARCDEX’s normal trading fee. Gas is paid from the copy wallet.',
  'Past results of a leader don’t predict future ones. Nothing here is investment advice.',
] as const

export type CopySafety = 'not-danger' | 'safe-only'
export const isCopySafety = (v: unknown): v is CopySafety => v === 'not-danger' || v === 'safe-only'

export interface CopyRuleV {
  id: string
  leader: string
  /** The most a copied buy spends, in USD; a smaller leader buy is copied at its own size. */
  maxPerTradeUsd: number
  /** The most a copied buy's price may be worse than the leader's fill, and a copied sale's below its quote. */
  slippageBps: number
  /** not-danger: coins the screen rates Danger are skipped; safe-only: Risky ones too. */
  safety: CopySafety
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type CopyStatus = 'filled' | 'skipped' | 'failed'

export interface CopyExecutionV {
  id: string
  ruleId: string
  leader: string
  /** The leader's trade: its transaction and block time. */
  leaderTx: string
  leaderAt: number
  token: string
  symbol: string | null
  side: 'buy' | 'sell'
  status: CopyStatus
  /** Why it was skipped or failed, in words. */
  reason: string | null
  /** What the copy spent (a buy) or received (a sale), in USD, and the coin's raw amount. */
  usd: number | null
  tokens: string | null
  tx: string | null
  /** From the leader's block to the copy's receipt. */
  latencyMs: number | null
  feeUsd: number | null
  at: number
}

export interface CopyWalletV {
  address: string
  /** USDC on Arc, as last read. */
  balanceUsd: number | null
  /** Fees owed to ARCDEX, sent once they reach COPY.feeSettleUsd and before a withdrawal. */
  feeDueUsd: number
  feesPaidUsd: number
  createdAt: number
}

export interface CopyMe {
  /** Copy trading is on for everyone (the copyTrading flag, a wallet secret on the engine); why not, when it isn't. */
  on: boolean
  why: string | null
  /** The terms version this wallet signed, or null. */
  accepted: number | null
  /** Every rule of this follower paused (its stop switch). */
  stopped: boolean
  wallet: CopyWalletV | null
  rules: CopyRuleV[]
  executions: CopyExecutionV[]
  /** Coins held through each leader's copies: what a leader's sale sells a share of. */
  lots: { leader: string; token: string; tokens: string }[]
}

export interface CopyLeaderV {
  address: string
  realized: string
  volume: string
  trades: number
  winRate: number | null
  first: number | null
  followers: number
}

export interface CopyStats {
  copies: number
  skipped: number
  failed: number
  /** Of copies that filled in the last 7 days: the share that landed within COPY.windowMs, and the middle and 95th
   * percentile times from the leader's block. */
  withinWindow: number | null
  p50Ms: number | null
  p95Ms: number | null
}

/** The text a follower's wallet signs to accept the terms (valid 5 minutes). */
export function copyTermsMessage(follower: string, version: number, at: number): string {
  return [
    'ARCDEX copy trading',
    `Wallet: ${follower.toLowerCase()}`,
    `I accept the copy trading terms, version ${version}:`,
    ...COPY_TERMS.map(t => `- ${t}`),
    `Time: ${new Date(at).toISOString()}`,
  ].join('\n')
}

/** The text a follower's wallet signs to withdraw from its copy wallet (valid 5 minutes, once). */
export function copyWithdrawMessage(follower: string, to: string, amountUsd: number, at: number): string {
  return [
    'ARCDEX copy wallet withdrawal',
    `Wallet: ${follower.toLowerCase()}`,
    `Send: ${amountUsd.toFixed(2)} USDC on Arc`,
    `To: ${to.toLowerCase()}`,
    `Time: ${new Date(at).toISOString()}`,
  ].join('\n')
}

export const SIGNED_FOR_MS = 5 * 60_000
