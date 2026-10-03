// $SENSE buyback and liquidity: what the engine serves (GET /v1/sense/program) and the site
// shows. No imports: the site imports this file too.

export type SenseEntryKind = 'fee' | 'buyback' | 'burn' | 'liquidity' | 'unliquidity'

export interface SenseEntry {
  kind: SenseEntryKind
  tx: string
  block: number
  at: number | null
  usd: number
  /** $SENSE bought or burned. */
  sense?: number
  from?: string
}

export interface SenseProgramView {
  at: number
  /** `started`: the chain has reached `since` (the program's first block is known). */
  program: { since: string; startBlock: number | null; started: boolean; buybackPct: number; liquidityPct: number; feeWallet: string; sense: string; dead: string }
  scannedTo: number
  totals: {
    feesUsd: number
    buybackOwedUsd: number
    buybackUsd: number
    senseBought: number
    senseBurned: number
    liquidityOwedUsd: number
    liquidityUsd: number
    /** Every $SENSE at the dead address, the program's and anyone else's. */
    deadBalance: number | null
  }
  pending: { buybackUsd: number; liquidityUsd: number }
  feeDays: { day: string; usd: number }[]
  actions: SenseEntry[]
  fees: SenseEntry[]
}
