// ArcDexSwapRouter's swap functions (contracts/ArcDexSwapRouter.sol), shared by the swap widget and copy trading
// (lib/copyTrade.ts), so both build exactly the same calls. v1 and v2 differ only by v2's trailing `referrer`.

import type { Address } from 'viem'
import type { SwapRoute } from '../api/argusMarket'
import type { RouterInfo } from './routerInfo'

const KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
const OUT = [{ name: 'amountOut', type: 'uint256' }] as const
const V4_IN = [{ name: 'keys', type: 'tuple[]', components: KEY }, { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] as const
const V3_IN = [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'poolFee', type: 'uint24' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] as const
const REF = { name: 'referrer', type: 'address' } as const

// v1 and v2 differ only by v2's trailing `referrer` argument.
export const ROUTER_V1 = [
  { name: 'swapExactInV4', type: 'function', stateMutability: 'nonpayable', inputs: V4_IN, outputs: OUT },
  { name: 'swapExactInV3', type: 'function', stateMutability: 'nonpayable', inputs: V3_IN, outputs: OUT },
] as const
export const ROUTER_V2 = [
  { name: 'swapExactInV4', type: 'function', stateMutability: 'nonpayable', inputs: [...V4_IN, REF], outputs: OUT },
  { name: 'swapExactInV3', type: 'function', stateMutability: 'nonpayable', inputs: [...V3_IN, REF], outputs: OUT },
] as const

/** The router's fee wallet and a trader's bound referrer: where the Universal Router route sends ARCDEX's fee, as the
 * router itself would. */
export const ROUTER_FEES = [
  { name: 'feeWallet', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'referrerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'address' }] },
] as const

/** The router call for a swap of `amountIn` of `tokenIn` into `tokenOut` along `route` (a v4 path or a v3 pool), with
 * at least `minOut` back. `buy` picks the path's direction. */
export function routerCall(info: RouterInfo, route: SwapRoute, o: { buy: boolean; tokenIn: Address; tokenOut: Address; amountIn: bigint; minOut: bigint; referrer: Address; deadline: bigint }) {
  const abi = info.version === 2 ? ROUTER_V2 : ROUTER_V1
  const tail = info.version === 2 ? [o.referrer] : []
  if (route.kind === 'v4') {
    return { abi, functionName: 'swapExactInV4' as const, args: [o.buy ? route.buyKeys : route.sellKeys, o.tokenIn, o.amountIn, o.minOut, o.deadline, ...tail] }
  }
  if (route.kind === 'v3') return { abi, functionName: 'swapExactInV3' as const, args: [o.tokenIn, o.tokenOut, route.fee, o.amountIn, o.minOut, o.deadline, ...tail] }
  throw new Error('not a router route')
}
