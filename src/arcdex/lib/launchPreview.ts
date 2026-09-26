// What a coin will look like the moment it launches, for the create form's
// live preview (as on Argus: "the preview updates as you enter your
// details"): the curve as ArcLaunchpad.createToken opens it, then the
// creator's optional first buy, with the contract's own math (_buy and
// _computeFee in contracts/ArcLaunchpad.sol).

import type { CurveState, LaunchpadToken } from '../api/launchpad'
import type { TokenMetadata } from './mediaUpload'

const V_USDC = 8_000_000_000n                      // INITIAL_VIRTUAL_USDC ($8,000)
const CURVE_TOKENS = 950_000_000n * 10n ** 18n      // 95% of the 1B supply
const V_OFFSET = 200_000_000n * 10n ** 18n          // VIRTUAL_TOKEN_OFFSET
const PLATFORM_FEE_BPS = 100n                       // PLATFORM_SWAP_FEE_BPS (1%)
const GRADUATION = 25_000_000_000n                  // GRADUATION_THRESHOLD_USDC ($25,000)

/** The curve right after launch, with a first buy of `buyUsdc` (6 decimals). */
export function openingCurve(creator: `0x${string}`, taxBps: number, launchedAt: number, buyUsdc: bigint): CurveState {
  let vUsdc = V_USDC, vToken = CURVE_TOKENS + V_OFFSET, rUsdc = 0n, rToken = CURVE_TOKENS
  if (buyUsdc > 0n) {
    const net = buyUsdc - (buyUsdc * PLATFORM_FEE_BPS) / 10_000n - (buyUsdc * BigInt(taxBps)) / 10_000n
    const nextV = vUsdc + net
    const nextT = (vUsdc * vToken) / nextV
    const out = vToken - nextT
    if (out < rToken) { vUsdc = nextV; vToken = nextT; rUsdc = net; rToken -= out } // else the contract reverts
  }
  return { creator, creatorTaxBps: taxBps, launchedAt, vUsdc, vToken, rUsdc, rToken, graduated: rUsdc >= GRADUATION }
}

/** A stand-in address from the name and ticker, so the preview's colors and
 * motion hold still while the creator types elsewhere in the form. */
function standIn(seed: string): `0x${string}` {
  let h = 2166136261, out = ''
  for (let i = 0; out.length < 40; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % Math.max(1, seed.length)) || 0) ^ i, 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return `0x${out.slice(0, 40)}`
}

export interface PreviewInput {
  name: string
  symbol: string
  meta: Omit<TokenMetadata, 'name' | 'symbol'>
  creator: `0x${string}` | null
  taxBps: number
  buyUsdc: bigint
  /** Unix seconds (0: no age or NEW badge). */
  launchedAt: number
}

/** The coin as its launchpad card will show it. */
export function previewToken(p: PreviewInput): LaunchpadToken {
  const curve = openingCurve(p.creator ?? '0x0000000000000000000000000000000000000000', p.taxBps, p.launchedAt, p.buyUsdc)
  return {
    address: standIn(`${p.symbol}|${p.name}`),
    name: p.name, symbol: p.symbol, curve,
    priceUsd: Number(curve.vUsdc) / 1e6 / (Number(curve.vToken) / 1e18),
    bondingProgress: curve.graduated ? 100 : Math.min(100, (Number(curve.rUsdc) / Number(GRADUATION)) * 100),
    metadata: { name: p.name, symbol: p.symbol, ...p.meta },
  }
}
