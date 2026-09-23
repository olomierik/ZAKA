import { createConfig, http } from 'wagmi'
import { getDefaultConfig } from 'connectkit'
import { defineChain } from 'viem'

// Arc mainnet — not in wagmi/chains yet, defined inline
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'], webSocket: ['wss://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

export const USDC_ADDRESS  = '0x3600000000000000000000000000000000000000' as const
export const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const
export const V3_FACTORY    = '0xf0db7b58379503491d857db50ac9ece64c653918' as const
export const MULTICALL3    = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export const wagmiConfig = createConfig(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  getDefaultConfig({
    chains:    [arc],
    transports: { [arc.id]: http('https://rpc.mainnet.arc.io') },
    walletConnectProjectId: (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? 'e5f3a751de0ba10999179b7f1e2d557b',
    appName:   'ARCDEX',
    appDescription: 'Arc Mainnet DEX Terminal — trade any Arc token with a 1% fee',
    appUrl:    'https://zakaapp-drab.vercel.app',
    appIcon:   '/arcdex-icon.png',
  }) as Parameters<typeof createConfig>[0]
)
