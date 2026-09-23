import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import App from './App'
import { wagmiConfig } from './wagmi'

const queryClient = new QueryClient()

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <StrictMode>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <ConnectKitProvider theme="midnight">
            <App />
          </ConnectKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>
  )
}
