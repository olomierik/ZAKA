import { useEffect, useState } from 'react'
import Avatar from '../components/Avatar'
import { getClanLeaderboard, getClanOf, socialWrite, triggerIndex, type Clan, type ClanRank, type Period } from '../api/social'
import { useTrader } from '../lib/identity'
import type { Page } from '../App'

// Clans: groups of traders who share their positions, ranked by everyone's
// combined profit and loss. Anyone can start one or join one (one per wallet).

const signed = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`

export default function ClansPage({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const [period, setPeriod] = useState<Period>('24h')
  const [rows, setRows] = useState<ClanRank[] | null>(null)
  const [mine, setMine] = useState<{ clan: Clan; role: string } | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { setRows(null); triggerIndex(); void getClanLeaderboard(period, 100).then(setRows).catch(() => setRows([])) }, [period])
  useEffect(() => { if (trader.address) void getClanOf(trader.address).then(setMine).catch(() => {}) }, [trader.address])

  return (
    <div className="token-page" style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Clans</h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Groups of traders who share their positions, ranked by everyone's combined profit and loss.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['24h', '7d', '30d', 'all'] as Period[]).map(p => <button key={p} onClick={() => setPeriod(p)} className={`disc-sub${period === p ? ' active' : ''}`}>{p.toUpperCase()}</button>)}
        </div>
      </div>

      <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {mine ? (
          <>
            <span style={{ fontSize: '0.86rem' }}>You're in <b>{mine.clan.name}</b>{mine.role === 'owner' ? ' (owner)' : ''}</span>
            <button className="btn-ghost" onClick={() => navigate({ name: 'clan', slug: mine.clan.slug })}>Open my clan</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>{trader.address ? 'Start a clan and invite your trading friends — or join one below.' : 'Connect or unlock a wallet to start or join a clan.'}</span>
            {trader.address && <button className="btn-primary" style={{ padding: '8px 16px' }} onClick={() => setCreating(true)}>+ Create a clan</button>}
          </>
        )}
      </div>

      <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
        {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No clans yet. Be the first to start one.</Empty> : rows.map((c, i) => (
          <button key={c.clan_id} onClick={() => navigate({ name: 'clan', slug: c.slug })} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 16px', background: 'none', border: 'none', borderBottom: '1px solid var(--adx-card-border)', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ width: 24, fontWeight: 800, color: i < 3 ? ['#facc15', '#cbd5e1', '#d97706'][i] : 'var(--text-muted)' }}>{i + 1}</span>
            {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover' }} /> : <Avatar address={c.clan_id.replace(/-/g, '').slice(0, 40).padEnd(40, '0')} size={38} />}
            <span style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>👥 {c.members} member{c.members === 1 ? '' : 's'}</div></span>
            <span style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: c.realized_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(c.realized_pnl)}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>vol ${c.volume_usdc.toFixed(0)}</div>
            </span>
          </button>
        ))}
      </div>

      {creating && <ClanEditor mode="create" onClose={() => setCreating(false)} onDone={slug => navigate({ name: 'clan', slug })} />}
    </div>
  )
}

export function ClanEditor({ mode, clan, onClose, onDone }: { mode: 'create' | 'edit'; clan?: Clan; onClose: () => void; onDone: (slug: string) => void }) {
  const trader = useTrader()
  const [name, setName] = useState(clan?.name ?? '')
  const [slug, setSlug] = useState(clan?.slug ?? '')
  const [motto, setMotto] = useState(clan?.motto ?? '')
  const [avatar, setAvatar] = useState(clan?.avatar_url ?? '')
  const [banner, setBanner] = useState(clan?.banner_url ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setBusy(true); setErr('')
    try {
      if (mode === 'create') {
        await socialWrite(trader, 'clan.create', { name, slug, motto, avatar_url: avatar, banner_url: banner })
        onDone(slug)
      } else {
        await socialWrite(trader, 'clan.update', { name, motto, avatar_url: avatar, banner_url: banner })
        onDone(clan!.slug)
      }
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save') } finally { setBusy(false) }
  }

  const label: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4, display: 'block' }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{mode === 'create' ? 'Create a clan' : 'Edit clan'}</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        <div><span style={label}>Name</span><input className="field" value={name} maxLength={40} onChange={e => { setName(e.target.value); if (mode === 'create' && !slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)) }} /></div>
        {mode === 'create' && <div><span style={label}>Link: arcdex.online/clans/<b>{slug || '…'}</b></span><input className="field" value={slug} maxLength={32} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></div>}
        <div><span style={label}>Motto</span><input className="field" value={motto} maxLength={120} onChange={e => setMotto(e.target.value)} placeholder="Get your money up" /></div>
        <div><span style={label}>Logo image URL (https://…)</span><input className="field" value={avatar} onChange={e => setAvatar(e.target.value.trim())} /></div>
        <div><span style={label}>Banner image URL (https://…)</span><input className="field" value={banner} onChange={e => setBanner(e.target.value.trim())} /></div>
        {err && <div style={{ fontSize: '0.78rem', color: '#fca5a5' }}>{err}</div>}
        <button className="btn-primary" disabled={busy || name.trim().length < 2 || (mode === 'create' && slug.length < 3)} onClick={() => void save()} style={{ opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : mode === 'create' ? 'Create clan' : 'Save'}</button>
        {mode === 'create' && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>You can be in one clan at a time. Your first save asks your wallet to sign a free message.</div>}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.86rem' }}>{children}</div>
}
