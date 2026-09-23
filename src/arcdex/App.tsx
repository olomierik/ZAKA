import { useState } from 'react'
import NavBar from './components/NavBar'
import Terminal from './pages/Terminal'
import TokenPage from './pages/TokenPage'
import Portfolio from './pages/Portfolio'
import './arcdex.css'

export type Page = { name: 'terminal' } | { name: 'token'; address: string } | { name: 'portfolio' }

export default function App() {
  const [page, setPage] = useState<Page>({ name: 'terminal' })
  const navigate = (p: Page) => setPage(p)

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <NavBar page={page} navigate={navigate} />
      <main style={{ flex: 1, paddingTop: '0' }}>
        {page.name === 'terminal'  && <Terminal navigate={navigate} />}
        {page.name === 'token'     && <TokenPage address={page.address} navigate={navigate} />}
        {page.name === 'portfolio' && <Portfolio navigate={navigate} />}
      </main>
    </div>
  )
}
