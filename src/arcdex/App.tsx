import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { useState } from 'react'
import { wagmiConfig } from './wagmi'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
import TokenPage from './pages/TokenPage'
import Portfolio from './pages/Portfolio'
import './arcdex.css'

const qc = new QueryClient()

export type Page = { name: 'terminal' } | { name: 'token'; address: string } | { name: 'portfolio' }

export default function App() {
  const [page, setPage] = useState<Page>({ name: 'terminal' })

  const navigate = (p: Page) => setPage(p)

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <ConnectKitProvider
          theme="midnight"
          customTheme={{
            '--ck-body-background':        '#0b1628',
            '--ck-body-background-secondary': '#111d33',
            '--ck-primary-button-background': '#3b82f6',
            '--ck-primary-button-hover-background': '#2563eb',
            '--ck-border-radius': '12px',
          }}
        >
          <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
            <NavBar page={page} navigate={navigate} />
            <main style={{ flex: 1, paddingTop: '0' }}>
              {page.name === 'terminal'  && <Terminal navigate={navigate} />}
              {page.name === 'token'     && <TokenPage address={page.address} navigate={navigate} />}
              {page.name === 'portfolio' && <Portfolio navigate={navigate} />}
            </main>
          </div>
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
// ARCDEX build 1790162282
