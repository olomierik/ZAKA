// The $3 launch fee (owner decision, 2026-09-26).
//
// Paid in USDC to the platform fee wallet as its own transfer, just before
// the launch transaction. ArcLaunchpad itself has no creation fee and is
// immutable, so the app collects it: every launch made through ARCDEX pays
// it; a direct contract call doesn't (enforcing it on-chain needs a new
// launchpad contract).
//
// If the fee goes through but the launch doesn't (cancelled, failed), the
// payment is remembered as a credit for that wallet in this browser, and
// the next launch uses it instead of charging again.

import type { Address, Hex } from 'viem'
import { FEE_WALLET } from './arcd'

export const LAUNCH_FEE_USD = 3
export const LAUNCH_FEE_USDC = 3_000_000n // 6 decimals
export const LAUNCH_FEE_WALLET = FEE_WALLET as Address

const KEY = 'arcdex:launch-fee-credit:v1'
const CREDIT_DAYS = 7

type Credits = Record<string, { tx: Hex; ts: number }>
function read(): Credits {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Credits } catch { return {} }
}
function write(c: Credits) {
  try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* storage blocked: no credit, the fee is asked again */ }
}

/** A fee this wallet paid for a launch that hasn't happened yet. */
export function feeCredit(wallet: string): { tx: Hex; ts: number } | null {
  const c = read()[wallet.toLowerCase()]
  return c && Date.now() - c.ts < CREDIT_DAYS * 86_400_000 ? c : null
}
export function saveFeeCredit(wallet: string, tx: Hex) {
  write({ ...read(), [wallet.toLowerCase()]: { tx, ts: Date.now() } })
}
export function spendFeeCredit(wallet: string) {
  const c = read()
  delete c[wallet.toLowerCase()]
  write(c)
}
