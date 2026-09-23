// ── One-click quick trade ─────────────────────────────────────────────
// Uses the embedded wallet (if unlocked) to approve-if-needed and execute
// a trade with no external wallet popup — the "⚡ 5 USDC" pattern.

import { parseAbi, maxUint256 } from 'viem'
import { isUnlocked, currentAddress, getEmbeddedWalletClient } from './embeddedWallet'
import { LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, client as publicClient } from '../api/launchpad'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_ABI = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

export class WalletLockedError extends Error {
  constructor() { super('Unlock your trading wallet first') }
}

/** Buy `token` on its ArcLaunchpad curve for `usdcAmount` (raw 6dp units)
 * using the embedded wallet. Approves USDC to the launchpad first if this
 * is the wallet's first trade (one extra tx, invisible to the user beyond
 * a short wait — no popup either way). */
export async function quickBuyLaunchpad(token: `0x${string}`, usdcAmount: bigint): Promise<`0x${string}`> {
  if (!isUnlocked()) throw new WalletLockedError()
  const owner = currentAddress()!
  const wallet = getEmbeddedWalletClient()

  const allowance = await publicClient.readContract({
    address: USDC_ADDR, abi: ERC20_ABI, functionName: 'allowance', args: [owner, LAUNCHPAD_ADDRESS],
  })
  if (allowance < usdcAmount) {
    const approveHash = await wallet.writeContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, maxUint256] })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
  }

  return wallet.writeContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'buy', args: [token, usdcAmount, 0n] })
}
