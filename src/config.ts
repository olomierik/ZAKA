/**
 * wagmi configuration — minimal, mainnet only for ENS resolution.
 * ZAKA uses Supabase + Circle SDK, not wagmi for transactions.
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
  },
})
