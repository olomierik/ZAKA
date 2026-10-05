// $ARCDEX buyback, burns and liquidity: what the engine serves (GET /v1/coin/program) and the site
// shows. No imports: the site imports this file too.

export type CoinEntryKind = 'fee' | 'buyback' | 'burn' | 'liquidity' | 'unliquidity'

export interface CoinEntry {
  kind: CoinEntryKind
  tx: string
  block: number
  at: number | null
  usd: number
  /** $ARCDEX bought or burned. */
  coin?: number
  from?: string
  /** A fee read from Relay's balance (Solana and BNB Chain trades): no transaction of its own. */
  via?: 'relay'
}

export interface CoinProgramView {
  at: number
  /** `started`: the chain has reached `since` (the program's first block is known). */
  program: { since: string; startBlock: number | null; started: boolean; buybackPct: number; liquidityPct: number; feeWallet: string; coin: string; supply: number; dead: string }
  scannedTo: number
  totals: {
    feesUsd: number
    buybackOwedUsd: number
    buybackUsd: number
    coinBought: number
    coinBurned: number
    liquidityOwedUsd: number
    liquidityUsd: number
    /** Every $ARCDEX at the dead address, the program's and anyone else's. */
    deadBalance: number | null
  }
  pending: { buybackUsd: number; liquidityUsd: number }
  /** Relay's app fees (Solana and BNB Chain trades): all that accrued (in the fees above) and what's still to claim.
   * Missing from engines before 2026-10-05. */
  relay?: { accruedUsd: number; unclaimedUsd: number }
  feeDays: { day: string; usd: number }[]
  actions: CoinEntry[]
  fees: CoinEntry[]
  /** Every $ARCDEX at the dead address (anyone's burns): the total, its share of the supply, the
   * last 24 hours and 7 days, and whether the history has been read to the present. */
  burned: { total: number; pct: number; h24: number; d7: number; count: number; complete: boolean; scannedTo: number }
  burnDays: { day: string; amount: number }[]
  /** The latest burns, newest first. */
  burns: CoinBurn[]
}

export interface CoinBurn { tx: string; block: number; at: number | null; from: string; amount: number }
