import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { reconnectLastWallet } from './lib/reconnect'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { wagmiConfig } from './wagmi'

const queryClient = new QueryClient()

const el = document.getElementById('root')
if (el) {
  reconnectLastWallet(wagmiConfig)
  createRoot(el).render(
    <StrictMode>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>
  )
}
