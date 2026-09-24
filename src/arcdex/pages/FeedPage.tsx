import { useState } from 'react'
import FeedList from '../components/FeedList'
import type { Page } from '../App'

// Full-page feed (the discovery panel has the compact version).

export default function FeedPage({ navigate }: { navigate: (p: Page) => void }) {
  const [scope, setScope] = useState<'all' | 'following'>('all')
  return (
    <div className="token-page" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Feed</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Trades, theses, wins and new coins — live from ARCDEX.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'following'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{ padding: '5px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', border: '1px solid var(--adx-card-border)', background: scope === s ? 'var(--adx-accent)' : 'transparent', color: scope === s ? '#fff' : 'var(--text-muted)' }}>{s === 'all' ? 'Everyone' : 'Following'}</button>
          ))}
        </div>
      </div>
      <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12 }}>
        <FeedList navigate={navigate} scope={scope} />
      </div>
    </div>
  )
}
