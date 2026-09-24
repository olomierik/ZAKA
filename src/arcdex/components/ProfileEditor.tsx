import { useState } from 'react'
import { socialWrite, type Profile } from '../api/social'
import type { Trader } from '../lib/identity'

// Set your public trader identity: @username (also your referral link),
// display name, picture, bio, X handle. Saving asks the wallet to sign a
// free message the first time (proves the profile is yours).

export default function ProfileEditor({ trader, profile, onSaved, onClose }: { trader: Trader; profile: Profile | null; onSaved: (p: Profile) => void; onClose: () => void }) {
  const [username, setUsername] = useState(profile?.username ?? '')
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '')
  const [avatar, setAvatar] = useState(profile?.avatar_url ?? '')
  const [banner, setBanner] = useState(profile?.banner_url ?? '')
  const [bio, setBio] = useState(profile?.bio ?? '')
  const [x, setX] = useState(profile?.x_handle ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setSaving(true); setErr('')
    try {
      const r = await socialWrite<{ profile: Profile }>(trader, 'profile', { username, display_name: displayName, avatar_url: avatar, bio, x_handle: x,
        // Only when changed: older databases may not have the column yet.
        ...(banner !== (profile?.banner_url ?? '') ? { banner_url: banner } : {}) })
      onSaved(r.profile)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const input: React.CSSProperties = { width: '100%', padding: '9px 11px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontSize: '0.86rem' }
  const label: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4, display: 'block' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 100%)', background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Edit profile</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        <div><span style={label}>Username (3–20: a–z, 0–9, _) — also your referral link</span>
          <input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} maxLength={20} placeholder="satoshi" style={input} /></div>
        <div><span style={label}>Display name</span><input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={40} style={input} /></div>
        <div><span style={label}>Profile picture URL (https://…)</span><input value={avatar} onChange={e => setAvatar(e.target.value.trim())} maxLength={500} placeholder="https://…" style={input} /></div>
        <div><span style={label}>Banner image URL (https://…, wide)</span><input value={banner} onChange={e => setBanner(e.target.value.trim())} maxLength={500} placeholder="https://…" style={input} /></div>
        <div><span style={label}>Bio</span><textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={160} rows={2} style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} /></div>
        <div><span style={label}>X handle</span><input value={x} onChange={e => setX(e.target.value.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, ''))} maxLength={15} placeholder="handle" style={input} /></div>
        {err && <div style={{ fontSize: '0.78rem', color: '#fca5a5' }}>{err}</div>}
        <button onClick={() => void save()} disabled={saving} style={{ padding: 12, borderRadius: 10, border: 'none', background: 'var(--adx-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>The first save asks your wallet to sign a free message proving this profile is yours. No transaction, no gas.</div>
      </div>
    </div>
  )
}
