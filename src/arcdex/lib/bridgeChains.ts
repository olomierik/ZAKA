// The networks USDC moves between and Arc (Circle's CCTP v2, lib/bridgeKit.ts). Kept apart from the
// bridge kit so screens that only show the networks (Swap, the home page) don't load Circle's library.

export interface BridgeNetwork { label: string; chain: string; evm: boolean }

export const BRIDGE_NETWORKS: BridgeNetwork[] = [
  { label: 'Base', chain: 'Base', evm: true },
  { label: 'Ethereum', chain: 'Ethereum', evm: true },
  { label: 'Arbitrum', chain: 'Arbitrum', evm: true },
  { label: 'Optimism', chain: 'Optimism', evm: true },
  { label: 'Polygon', chain: 'Polygon', evm: true },
  { label: 'Avalanche', chain: 'Avalanche', evm: true },
  { label: 'Linea', chain: 'Linea', evm: true },
  { label: 'Unichain', chain: 'Unichain', evm: true },
  { label: 'World Chain', chain: 'WorldChain', evm: true },
  { label: 'Sonic', chain: 'Sonic', evm: true },
  { label: 'Solana', chain: 'Solana', evm: false },
]
