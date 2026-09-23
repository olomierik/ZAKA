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
