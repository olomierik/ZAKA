// The Arc routers' fee, read from the chain and changed by their owner (/admin's Fees section). The owner's decision D2
// (docs/REPO_MAP.md, 2026-10-15) is 0.5% on spot: ArcDexSwapRouter and ArcDexCurveRouter were deployed at 2% (their
// constructor's), and only their owner can lower it, with setFeeBps(50). Nothing here can send from any other wallet:
// the change is simulated as the signing wallet first, so a wallet that isn't the owner is told so before it signs.

import { parseAbi, type Address, type Hex } from 'viem'
import { client } from '../api/launchpad'
import { CURVE_ROUTER_ADDRESS } from '../api/curves'
import { t as T } from './i18n'
import { SPOT_FEE_BPS } from './platform'
import { waitForReceipt } from './receipts'
import { routerConfigured, SWAP_ROUTER_ADDRESS } from './routerInfo'
import { sendArc } from './tx'

export const FEE_ABI = parseAbi([
  'function owner() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function feeWallet() view returns (address)',
  'function referralShareBps() view returns (uint256)',
  'function MAX_FEE_BPS() view returns (uint256)',
  'function setFeeBps(uint256 newFeeBps)',
])

export type RouterId = 'swap' | 'curve'

export interface RouterFee {
  id: RouterId
  name: string
  address: Address
  owner: Address
  feeBps: number
  maxFeeBps: number
  feeWallet: Address
  referralShareBps: number
}

/** The routers in force on this build: the swap router (VITE_ARCDEX_SWAP_ROUTER_ADDRESS) and the curve router (unless off). */
export function routersInForce(): { id: RouterId; name: string; address: Address }[] {
  const out: { id: RouterId; name: string; address: Address }[] = []
  if (routerConfigured) out.push({ id: 'swap', name: 'ArcDexSwapRouter', address: SWAP_ROUTER_ADDRESS })
  if (/^0x[0-9a-fA-F]{40}$/.test(CURVE_ROUTER_ADDRESS)) out.push({ id: 'curve', name: 'ArcDexCurveRouter', address: CURVE_ROUTER_ADDRESS })
  return out
}

export async function readRouterFee(r: { id: RouterId; name: string; address: Address }): Promise<RouterFee> {
  const read = <T>(functionName: 'owner' | 'feeBps' | 'feeWallet' | 'referralShareBps' | 'MAX_FEE_BPS') =>
    client.readContract({ address: r.address, abi: FEE_ABI, functionName }) as Promise<T>
  const [owner, feeBps, feeWallet, referralShareBps, maxFeeBps] = await Promise.all([
    read<Address>('owner'), read<bigint>('feeBps'), read<Address>('feeWallet'), read<bigint>('referralShareBps').catch(() => 0n), read<bigint>('MAX_FEE_BPS'),
  ])
  return { ...r, owner, feeBps: Number(feeBps), feeWallet, referralShareBps: Number(referralShareBps), maxFeeBps: Number(maxFeeBps) }
}

/** What the fee should be (D2), and whether this router is there. */
export const TARGET_FEE_BPS = SPOT_FEE_BPS
export const atTarget = (r: RouterFee) => r.feeBps === TARGET_FEE_BPS

/**
 * Sets the router's fee from `from` (the router's owner), after simulating it as that wallet; returns the transaction
 * once it's confirmed. Refuses a fee above the router's cap or a wallet that isn't its owner, before anything is signed.
 */
export async function setRouterFee(r: RouterFee, bps: number, from: Address, kind: 'trading-wallet' | 'wallet'): Promise<Hex> {
  if (!Number.isInteger(bps) || bps < 0 || bps > r.maxFeeBps) throw new Error(T('The fee must be between 0 and {max} basis points.', { max: r.maxFeeBps }))
  if (from.toLowerCase() !== r.owner.toLowerCase()) throw new Error(T('Only the router’s owner ({owner}) can change its fee.', { owner: `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}` }))
  const call = { address: r.address, abi: FEE_ABI, functionName: 'setFeeBps' as const, args: [BigInt(bps)] as const }
  await client.simulateContract({ ...call, account: from })
  const hash = await sendArc(kind, call)
  const receipt = await waitForReceipt(hash)
  if (receipt.status !== 'success') throw new Error(T('The transaction reverted on-chain.'))
  return hash
}
