// ── Cross-chain bridge (Circle CCTP v2 via official Bridge Kit) ────────
// Arc is officially CCTP v2-supported (domain 26) — verified directly
// against Circle's own published chain definitions in this package
// (node_modules/@circle-fin/bridge-kit/chains.d.ts), not guessed.
//
// The burn (source, on Arc) always needs the user's own wallet signature
// — that's inherent to CCTP, no relayer can sign on a user's behalf. The
// mint (destination) does NOT need a second signature or network switch:
// Circle's Orbit relayer (`useForwarder: true`) submits it automatically
// once the attestation is ready, so the whole bridge is one signature.

import type { EIP1193Provider } from 'viem'
import { BridgeKit, type BridgeChain } from '@circle-fin/bridge-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'

export const kit = new BridgeKit()

/** Same wallet ArcDexRouter and ArcLaunchpad already send fees to — see
 * AGENTS.md. Not env-configurable: it's a fixed constant on both deployed
 * contracts, so the bridge fee matches that rather than drifting from it. */
export const PLATFORM_FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb'

/** Bridge fee: 0.5% of the transfer, bounded so it's never trivial on tiny
 * transfers or excessive on large ones — same "predictable, capped, no
 * surprises" spirit as ArcDexRouter's swap fee and ArcLaunchpad's caps. */
export const BRIDGE_FEE_BPS = 50
export const BRIDGE_FEE_MIN_USDC = 0.05
export const BRIDGE_FEE_MAX_USDC = 50

export function computeBridgeFee(amount: string): number {
  const n = parseFloat(amount)
  if (!n || n <= 0) return 0
  const fee = (n * BRIDGE_FEE_BPS) / 10_000
  return Math.min(Math.max(fee, BRIDGE_FEE_MIN_USDC), BRIDGE_FEE_MAX_USDC)
}

// Bridge Kit adds this fee ON TOP of the transfer amount (wallet debits
// amount + fee) and auto-splits it 10% to Circle / 90% to our recipient —
// that split is Circle's own mechanic, not something we control. It only
// applies to USDC transfers, which is all this app bridges.
kit.setCustomFeePolicy({
  computeFee: params => computeBridgeFee(params.amount).toFixed(6),
  resolveFeeRecipientAddress: () => PLATFORM_FEE_WALLET,
})

/** Curated subset of the 26 CCTP v2 mainnet chains — the ones with real
 * liquidity/name recognition, so the destination picker isn't a 26-item
 * wall of chains nobody's heard of. */
export const BRIDGE_DESTINATIONS: { label: string; chain: BridgeChain }[] = [
  { label: 'Ethereum',  chain: 'Ethereum' as BridgeChain },
  { label: 'Base',      chain: 'Base' as BridgeChain },
  { label: 'Arbitrum',  chain: 'Arbitrum' as BridgeChain },
  { label: 'Optimism',  chain: 'Optimism' as BridgeChain },
  { label: 'Polygon',   chain: 'Polygon' as BridgeChain },
  { label: 'Avalanche', chain: 'Avalanche' as BridgeChain },
  { label: 'Linea',     chain: 'Linea' as BridgeChain },
  { label: 'Unichain',  chain: 'Unichain' as BridgeChain },
  { label: 'Sonic',     chain: 'Sonic' as BridgeChain },
  { label: 'Solana',    chain: 'Solana' as BridgeChain },
]

/** Builds a Bridge Kit adapter from whatever wallet is actually connected
 * (injected, WalletConnect, Coinbase, etc.) via its own EIP-1193 provider
 * — not hardcoded to `window.ethereum`, which only exists for injected
 * wallets and would silently break WalletConnect sessions. */
export async function getBridgeAdapter(provider: EIP1193Provider) {
  return createViemAdapterFromProvider({ provider })
}
