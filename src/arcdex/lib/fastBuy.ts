// Faster buys for the trading wallet (owner, 2026-10-16: "trading speed"). A buy through ArcDexSwapRouter needs an
// approval of exactly the amount first, and until now waited for it: the approval's receipt, then until the node showed
// the allowance, and only then simulated and sent the swap (about two seconds of a three-second buy).
//
// Now the swap is simulated, and its gas measured, as though the approval had already landed: Arc's USDC keeps
// allowances in Circle's FiatToken layout (`allowed`, base slot 10; found by reading overrides back on mainnet,
// 2026-10-16), so a read-only call can set it. Then the approval and the swap are signed and sent back to back (the
// trading wallet signs locally; nonces are consecutive, lib/embeddedWallet.ts), and both receipts are awaited together.
// The approval stays exactly the amount, and the swap still carries its minimum received.
//
// If the approval somehow fails, the swap reverts on-chain for want of allowance and costs only its gas.

import { encodeAbiParameters, keccak256, numberToHex, type Address, type Hex, type PublicClient } from 'viem'
import { ARC_USDC } from './acrossQuote'

/** Arc USDC's `allowed` mapping (FiatToken layout). */
export const USDC_ALLOWANCE_BASE = 10n

const key = (a: string) => numberToHex(BigInt(a), { size: 32 })
const mapSlot = (k: Hex, base: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [k, base]))

/** The storage slot of allowance(owner, spender) on Arc's USDC. */
export function usdcAllowanceSlot(owner: string, spender: string): Hex {
  return mapSlot(key(spender), mapSlot(key(owner), numberToHex(USDC_ALLOWANCE_BASE, { size: 32 })))
}

/** A state override giving `spender` an allowance of `amount` of Arc's USDC from `owner`, for read-only calls. */
export function usdcAllowanceOverride(owner: string, spender: string, amount: bigint) {
  return [{ address: ARC_USDC as Address, stateDiff: [{ slot: usdcAllowanceSlot(owner, spender), value: numberToHex(amount, { size: 32 }) }] }]
}

/** Gas for a call that needs the allowance: measured with it overridden, plus 30%. */
export async function gasWithAllowance(client: PublicClient, from: Address, to: Address, data: Hex, spender: Address, amount: bigint): Promise<bigint> {
  const g = await client.estimateGas({ account: from, to, data, stateOverride: usdcAllowanceOverride(from, spender, amount) })
  return (g * 13n) / 10n
}
