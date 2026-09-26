// ── One-click quick trade ─────────────────────────────────────────────
// Uses the embedded wallet (if unlocked) to approve-if-needed and execute
// a trade with no external wallet popup — the "⚡ 5 USDC" pattern.

import { parseAbi } from 'viem'
import { isUnlocked, currentAddress, getEmbeddedWalletClient } from './embeddedWallet'
import { LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, client as publicClient, getCurve } from '../api/launchpad'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_ABI = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
/** Quick buys accept at most this much price movement. */
const QUICK_SLIPPAGE_BPS = 500n

export class WalletLockedError extends Error {
  constructor() { super('Unlock your trading wallet first') }
}

/** Buy `token` on its ArcLaunchpad curve for `usdcAmount` (raw 6dp units)
 * using the embedded wallet. Approves exactly `usdcAmount` of USDC to the
 * launchpad first when needed (one extra tx, no popup either way). */
export async function quickBuyLaunchpad(token: `0x${string}`, usdcAmount: bigint): Promise<`0x${string}`> {
  if (!isUnlocked()) throw new WalletLockedError()
  const owner = currentAddress()!
  const wallet = getEmbeddedWalletClient()

  // Minimum out from the live curve, same math as the contract (1% platform fee + creator tax).
  const curve = await getCurve(token)
  if (!curve) throw new Error('Token not on the launchpad')
  const fee = (usdcAmount * 100n) / 10_000n + (usdcAmount * BigInt(curve.creatorTaxBps)) / 10_000n
  const tokensOut = curve.vToken - (curve.vUsdc * curve.vToken) / (curve.vUsdc + usdcAmount - fee)
  const minOut = (tokensOut * (10_000n - QUICK_SLIPPAGE_BPS)) / 10_000n

  const allowance = await publicClient.readContract({
    address: USDC_ADDR, abi: ERC20_ABI, functionName: 'allowance', args: [owner, LAUNCHPAD_ADDRESS],
  })
  if (allowance < usdcAmount) {
    const approveHash = await wallet.writeContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, usdcAmount] })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
  }

  const call = { address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'buy' as const, args: [token, usdcAmount, minOut] as const }
  await publicClient.simulateContract({ ...call, account: owner })
  return wallet.writeContract(call)
}
