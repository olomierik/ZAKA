import { createConfig, http } from 'wagmi'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import { defineChain } from 'viem'

// Arc mainnet — not in wagmi/chains yet, defined inline
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  // Arc's canonical registry entry (chainid.network's chains.json, chain
  // 5042) declares 18 here — this is the wallet-level "wei" convention
  // wallet_addEthereumChain/wallet_switchEthereumChain expect, distinct
  // from the actual USDC ERC-20 contract's own 6 decimals (which every
  // trade in this app already uses directly via parseUnits(amount, 6),
  // not this field). Declaring 6 here caused MetaMask to silently
  // miscalculate native/gas balance by 10^12x — the wallet reports
  // "connected" fine, but then can't produce a valid signature because
  // its own gas-balance check thinks the account is empty.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'], webSocket: ['wss://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

export const USDC_ADDRESS  = '0x3600000000000000000000000000000000000000' as const
export const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const
export const V3_FACTORY    = '0xf0db7b58379503491d857db50ac9ece64c653918' as const
export const MULTICALL3    = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

const APP_ICON = 'https://arcdex.online/arcdex-icon.png'

/** WalletConnect without the eager start-up. wagmi's connector loads the
 * WalletConnect SDK (~860 KB) and opens its relay socket in setup(), which
 * runs on every page load for every visitor. Its connect() registers every
 * listener it needs, so setup is skipped: the SDK now loads only when
 * someone picks WalletConnect or reconnects a WalletConnect session. */
function lazyWalletConnect(params: Parameters<typeof walletConnect>[0]) {
  const create = walletConnect(params)
  return ((config: Parameters<typeof create>[0]) => ({ ...create(config), async setup() {} })) as typeof create
}

// Same connector ids ConnectKit used (metaMask, coinbaseWalletSDK,
// walletConnect), so wallets connected before reconnect as they were. Other
// browser wallets (Rabby, OKX, Phantom…) announce themselves (EIP-6963) and
// are added automatically. The WalletConnect and Coinbase SDKs load only
// when someone picks them — see ConnectWallet.tsx and lib/reconnect.ts.
export const wagmiConfig = createConfig({
  chains: [arc],
  transports: { [arc.id]: http('https://rpc.mainnet.arc.io') },
  connectors: [
    injected({ target: 'metaMask' }),
    injected({ shimDisconnect: true }),
    lazyWalletConnect({
      projectId: (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? 'e5f3a751de0ba10999179b7f1e2d557b',
      showQrModal: true,
      metadata: { name: 'ARCDEX', description: 'The social trading terminal for Arc', url: 'https://arcdex.online', icons: [APP_ICON] },
    }),
    coinbaseWallet({ appName: 'ARCDEX', appLogoUrl: APP_ICON }),
  ],
})
