import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { reconnectLastWallet } from './arcdex/lib/reconnect'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './arcdex/App'
import { wagmiConfig } from './arcdex/wagmi'
import './index.css'

const queryClient = new QueryClient()

export function mountApp(root: HTMLElement) {
  reconnectLastWallet(wagmiConfig)
  createRoot(root).render(
    <StrictMode>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>
  )
}
