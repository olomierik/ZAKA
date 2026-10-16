// Comments on a thesis or a coin (the build pack's Phase 6; engine/src/social/moderation.ts). Text only: a comment is
// shown as text, never as HTML, so nothing in it runs. Hidden ones (reports, an admin) and banned wallets' never come
// back from the engine; muted wallets' are hidden here.

import { useCallback, useEffect, useState } from 'react'
import Ago from './Ago'
import Avatar from './Avatar'
import SocialMenu from './SocialMenu'
import { deleteComment, getProfiles, postComment, type Profile } from '../api/social'
import { getComments } from '../api/socialEngine'
import { SOCIAL_LIMITS, type CommentV } from '../../../api/_socialProtocol'
import { shortAddr, type Trader } from '../lib/identity'
import { useMutes } from '../lib/mutes'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

export default function CommentThread({ target, trader, navigate, compact = false, onCount }: {
  target: string
  trader: Trader
  navigate: (p: Page) => void
  compact?: boolean
  onCount?: (n: number) => void
}) {
  const [list, setList] = useState<CommentV[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const { isMuted } = useMutes(trader)

  const load = useCallback(async () => {
    const c = await getComments(target)
    if (!c) { setList(l => l ?? []); return }
    setList(c)
    const authors = [...new Set(c.map(x => x.author))]
    if (authors.length) setProfiles(await getProfiles(authors).catch(() => new Map()))
  }, [target])
  useEffect(() => {
    setList(null)
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => clearInterval(id)
  }, [load])

  const shown = (list ?? []).filter(c => !isMuted(c.author))
  useEffect(() => { if (list) onCount?.(shown.filter(c => !c.deleted).length) }, [list, shown.length, onCount]) // eslint-disable-line react-hooks/exhaustive-deps

  async function post() {
    const body = draft.trim()
    if (!body) return
    setBusy(true); setErr('')
    try {
      const c = await postComment(trader, target, body)
      setDraft('')
      setList(l => [...(l ?? []), c])
      if (trader.address && !profiles.has(trader.address.toLowerCase())) void getProfiles([trader.address]).then(p => setProfiles(m => new Map([...m, ...p]))).catch(() => {})
    } catch (e) { setErr(e instanceof Error ? e.message : T('Could not post')) } finally { setBusy(false) }
  }
  async function remove(id: string) {
    setErr('')
    try {
      const c = await deleteComment(trader, id)
      setList(l => l?.map(x => (x.id === id ? c : x)) ?? l)
    } catch (e) { setErr(e instanceof Error ? e.message : T('Could not update')) }
  }

  const size = compact ? 22 : 28
  return (
    <div className="comment-thread" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list === null ? <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{T('Loading…')}</div>
        : shown.length === 0 ? <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{T('No comments yet.')}</div>
        : shown.map(c => <CommentItem key={c.id} c={c} profile={profiles.get(c.author)} size={size} trader={trader} navigate={navigate} onDelete={() => void remove(c.id)} onError={setErr} />)}
      {trader.address ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea value={draft} maxLength={SOCIAL_LIMITS.commentChars} rows={1} onChange={e => setDraft(e.target.value)} placeholder={T('Add a comment…')} aria-label={T('Add a comment…')}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post() }}
            style={{ flex: 1, minWidth: 0, resize: 'vertical', padding: '7px 10px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontSize: '0.82rem', fontFamily: 'inherit' }} />
          <button onClick={() => void post()} disabled={busy || !draft.trim()} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: 'var(--adx-accent)', color: 'var(--on-accent)', fontWeight: 700, cursor: 'pointer', opacity: busy || !draft.trim() ? 0.5 : 1, fontSize: '0.78rem' }}>{busy ? '…' : T('Reply')}</button>
        </div>
      ) : <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{T('Connect or unlock a wallet to comment.')}</div>}
      {draft.length > SOCIAL_LIMITS.commentChars - 40 && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{draft.length}/{SOCIAL_LIMITS.commentChars}</div>}
      {err && <div role="alert" style={{ fontSize: '0.74rem', color: '#fca5a5' }}>{err}</div>}
    </div>
  )
}

/** One comment. Its body is a text node: markup in it shows as typed, and nothing in it runs. */
export function CommentItem({ c, profile: p, size, trader, navigate, onDelete, onError }: {
  c: CommentV
  profile?: Profile
  size: number
  trader: Trader
  navigate: (p: Page) => void
  onDelete: () => void
  onError: (msg: string) => void
}) {
  return (
    <div className="comment" style={{ display: 'flex', gap: 8 }}>
      <Avatar address={c.author} url={p?.avatar_url} size={size} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.74rem' }}>
          <button onClick={() => navigate({ name: 'trader', address: c.author })} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', fontWeight: 700, fontFamily: p?.username ? undefined : 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
            {p?.username ? `@${p.username}` : shortAddr(c.author)}
          </button>
          <span style={{ color: 'var(--text-muted)' }}><Ago ts={c.at} /></span>
          <span style={{ marginLeft: 'auto' }}>{!c.deleted && <SocialMenu target={`comment:${c.id}`} author={c.author} trader={trader} onDelete={onDelete} onError={onError} />}</span>
        </div>
        {c.deleted
          ? <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{T('Comment deleted')}</div>
          : <div className="comment-body" style={{ fontSize: '0.84rem', marginTop: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</div>}
      </div>
    </div>
  )
}
