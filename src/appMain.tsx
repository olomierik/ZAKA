import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { ReconnectLastWallet } from './arcdex/lib/reconnect'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './arcdex/App'
import { wagmiConfig } from './arcdex/wagmi'
import './index.css'

const queryClient = new QueryClient()

export function mountApp(root: HTMLElement) {
  createRoot(root).render(
    <StrictMode>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <ReconnectLastWallet />
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>
  )
}
