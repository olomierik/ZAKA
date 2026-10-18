// The prediction pool on Arc testnet (contracts/ArcdexPredictPool.sol): what the engine and the site share. No imports:
// the site imports this file too (as engine/src/perps/shared.ts explains).
//
// papertrade.xyz's design for Hyperliquid's prediction markets, with test USDC: a trader buys or sells a side at its
// mid against a pool that starts at $0 and fills from losses. A profit the pool can't pay waits in a first-in,
// first-out queue; every realised loss mints tPOOL, which stakers stake for a share of the pool's fees. The engine's
// key signs every price and settlement (EIP-712), and its keeper fills requests and pays out settled markets.

/** The EIP-712 domain the pool checks (its chain id and address are added per deployment). */
export const PREDICT_POOL_DOMAIN = { name: 'ARCDEX Predict', version: '1' } as const

export const PRICE_TYPES = {
  Price: [
    { name: 'outcome', type: 'uint32' },
    { name: 'side', type: 'uint8' },
    { name: 'px', type: 'uint64' },
    { name: 'ts', type: 'uint64' },
  ],
} as const

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: 'outcome', type: 'uint32' },
    { name: 'fraction', type: 'uint64' },
    { name: 'ts', type: 'uint64' },
  ],
} as const

/** As the contract has them (1e6 = $1, one contract, a price of 100¢). */
export const POOL_ONE = 1_000_000
export const POOL_LIMITS = {
  minOrderUsd: 1,
  minBuyPx: 0.01,
  maxBuyPx: 0.99,
  /** What the site sends as the worst price for a market order: the mid it showed, this much either way. */
  defaultBandPct: 3,
} as const

/** Why the pool refunded a request (RequestRejected's reason). */
export const REJECT_REASON: Record<number, string> = {
  1: 'no price: the market isn’t open',
  2: 'the price moved past your limit',
  3: 'this side is all but decided: no buys under 1¢ or over 99¢',
  4: 'this side is at its open-interest cap',
  5: 'the market is paused or settling',
  6: 'the contracts were paid out first',
}

export interface PredictPoolDeployment {
  chainId: number
  pool: string | null
  token: string | null
  usdc: string | null
  signer: string | null
  block: number | null
  at: number | null
}

export interface PredictPoolStatus {
  enabled: boolean
  chainId: number
  deployment: PredictPoolDeployment | null
  /** What's still missing before the pool trades, in words; null when it runs. */
  waiting: string | null
  keeper: {
    address: string | null
    gasUsdc: number | null
    lastRun: number | null
    filled: number
    rejected: number
    settled: number
    errors: number
    lastError: string | null
  }
}

/** poolState(), as strings of the contract's units (USDC 6 decimals, tPOOL 18). */
export interface PoolStateView {
  at: number
  lpCash: string
  sideBucket: string
  totalQueued: string
  queueLength: number
  trackedLp: string
  totalLocked: string
  totalPending: string
  devFees: string
  totalStaked: string
  mintRate: string
  paused: boolean
  winFeeBps: number
  lossFeeBps: number
  stakerShareBps: number
  requestTimeout: number
  settleDelay: number
  defaultCap: string
  /** The front of the queue, oldest first. */
  queue: { index: number; user: string; amount: string }[]
}

/** A fill or a payout, from the pool's events. */
export interface PoolFill {
  kind: 'buy' | 'sell' | 'settled' | 'rejected'
  requestId: string | null
  trader: string
  outcome: number
  side: 0 | 1
  contracts: string
  usd: string
  px: string | null
  /** A close's P&L for the trader (a win's is after the fee), 6 decimals, signed. */
  pnl: string | null
  reason: number | null
  block: number
  tx: string
  at: number
}

/** A market the pool has traded, with its open interest and settlement state. */
export interface PoolMarketView {
  outcome: number
  oi0: string
  oi1: string
  state: 0 | 1 | 2
  fraction: number | null
  readyAt: number | null
}
