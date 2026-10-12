// Starknet, as ARCDEX uses it (2026-10-12, the build pack's Phase 2 "Starknet native"): swaps through AVNU, AVNU's own
// aggregator on Starknet (docs.avnu.fi, API v3), signed by the trader's Starknet wallet (Argent X, Braavos, …).
//
// Testnet first, as the pack asks, where it can be: the wallet, its chain and a signed transaction are checked on
// Sepolia. AVNU's Sepolia API has no liquidity sources and no tokens (checked 2026-10-12: /swap/v3/sources and
// /v1/starknet/tokens both empty), so swaps can only be quoted on mainnet. Executing them is off until the owner
// switches it on (VITE_STARKNET_SWAPS=on): quotes, routes and balances show, and nothing is sent.

type Env = { VITE_STARKNET_SWAPS?: string; VITE_STARKNET_FEE_RECIPIENT?: string; VITE_STARKNET_FEE_BPS?: string }
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}

export type SnNetwork = 'mainnet' | 'sepolia'

export interface SnNet {
  id: SnNetwork
  name: string
  /** starknet_chainId: "SN_MAIN" / "SN_SEPOLIA" as hex. */
  chainId: string
  /** Public JSON-RPC endpoints, first answer wins (measured 2026-10-12; Lava, Blast and Nethermind's free RPC are gone). */
  rpcs: string[]
  avnu: string
  explorer: string
}

export const SN: Record<SnNetwork, SnNet> = {
  mainnet: {
    id: 'mainnet', name: 'Starknet', chainId: '0x534e5f4d41494e',
    rpcs: ['https://starknet-rpc.publicnode.com', 'https://starknet.drpc.org', 'https://api.zan.top/public/starknet-mainnet'],
    avnu: 'https://starknet.api.avnu.fi', explorer: 'https://voyager.online',
  },
  sepolia: {
    id: 'sepolia', name: 'Starknet Sepolia', chainId: '0x534e5f5345504f4c4941',
    rpcs: ['https://starknet-sepolia-rpc.publicnode.com', 'https://starknet-sepolia.drpc.org', 'https://api.zan.top/public/starknet-sepolia'],
    avnu: 'https://sepolia.api.avnu.fi', explorer: 'https://sepolia.voyager.online',
  },
}

/** AVNU's Exchange (docs.avnu.fi/resources/contracts): the only contract a swap may approve or call. */
export const AVNU_EXCHANGE = '0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f'

/** The fee tokens, the same address on mainnet and Sepolia. */
export const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
export const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

/** Executing swaps (mainnet): off unless the owner turns it on. */
export const STARKNET_SWAPS = env.VITE_STARKNET_SWAPS === 'on'

/** ARCDEX's fee on Starknet swaps, as AVNU's integrator fee: only once the owner names a Starknet address to receive
 * it (ARCDEX's fee wallet is an EVM address, which Starknet can't pay). */
export const SN_FEE = (() => {
  const recipient = (env.VITE_STARKNET_FEE_RECIPIENT ?? '').trim()
  const bps = Number(env.VITE_STARKNET_FEE_BPS ?? '0')
  const ok = /^0x[0-9a-fA-F]{1,64}$/.test(recipient) && Number.isInteger(bps) && bps > 0 && bps <= 200
  return ok ? { recipient, bps } : null
})()

export const voyagerTx = (net: SnNetwork, hash: string) => `${SN[net].explorer}/tx/${hash}`
export const voyagerContract = (net: SnNetwork, address: string) => `${SN[net].explorer}/contract/${address}`
