// The "⋯" menu on a comment, a thesis or a profile (the build pack's Phase 6: reports and mutes): report it, mute its
// author, or delete your own comment. Reports and mutes need the wallet's sign-in (one signature, then a session).

import { useEffect, useRef, useState } from 'react'
import { REPORT_REASONS, type ReportReason } from '../../../api/_socialProtocol'
import { reportContent } from '../api/social'
import type { Trader } from '../lib/identity'
import { useMutes } from '../lib/mutes'
import { N_, t as T } from '../lib/i18n'

const REASON_LABEL: Record<ReportReason, string> = {
  spam: N_('Spam or ads'), scam: N_('Scam or phishing link'), abuse: N_('Abuse or harassment'), impersonation: N_('Pretends to be someone else'), other: N_('Something else'),
}

export function ReportDialog({ target, trader, onClose, onReported }: { target: string; trader: Trader; onClose: () => void; onReported?: (hidden: boolean) => void }) {
  const [reason, setReason] = useState<ReportReason>('spam')
  const [note, setNote] = useState('')
  const [state, setState] = useState<'' | 'sending' | { hidden: boolean } | { error: string }>('')
  const what = target.startsWith('profile:') ? T('Report this profile') : target.startsWith('thesis:') ? T('Report this thesis') : T('Report this comment')
  async function send() {
    setState('sending')
    try {
      const r = await reportContent(trader, target, reason, note.trim() || undefined)
      setState(r)
      onReported?.(r.hidden)
    } catch (e) { setState({ error: e instanceof Error ? e.message : T('Could not send — try again') }) }
  }
  const done = typeof state === 'object' && 'hidden' in state
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} role="dialog" aria-label={what}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{what}</b><button onClick={onClose} aria-label={T('Close')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        {!trader.address ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{T('Connect or unlock a wallet to report.')}</div>
        ) : done ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: '1.8rem' }}>✓</div>
            <b>{T('Thanks, it’s reported')}</b>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {state.hidden ? T('Enough people reported it: it’s hidden until the ARCDEX team looks at it.') : T('The ARCDEX team reviews reports. It’s hidden once several people report it.')}
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={onClose}>{T('Done')}</button>
          </div>
        ) : (
          <>
            <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {REPORT_REASONS.map(r => (
                <label key={r} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.84rem', cursor: 'pointer' }}>
                  <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />{T(REASON_LABEL[r])}
                </label>
              ))}
            </div>
            <label className="field-label">{T('Anything to add? (optional)')}
              <textarea className="field" rows={3} maxLength={280} value={note} onChange={e => setNote(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
            </label>
            {typeof state === 'object' && 'error' in state && <div role="alert" style={{ fontSize: '0.76rem', color: '#fca5a5' }}>{state.error}</div>}
            <button className="btn-primary" disabled={state === 'sending'} onClick={() => void send()}>{state === 'sending' ? T('Sending…') : T('Send report')}</button>
          </>
        )}
      </div>
    </div>
  )
}

/** "⋯": report, mute the author (not yourself), delete your own comment. */
export default function SocialMenu({ target, author, trader, onDelete, onError, label }: {
  target: string
  author: string
  trader: Trader
  onDelete?: () => void
  onError?: (msg: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [reporting, setReporting] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const { isMuted, toggle } = useMutes(trader)
  const mine = !!trader.address && trader.address.toLowerCase() === author.toLowerCase()
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const item: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text)', fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' }
  const need = () => { if (!trader.address) { onError?.(T('Connect or unlock a wallet first')); setOpen(false); return false } return true }
  return (
    <span ref={box} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" aria-label={label ?? T('More')} aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', padding: '0 4px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>⋯</button>
      {open && (
        <span className="menu-pop" role="menu" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 30, minWidth: 170, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
          {mine && onDelete && <button role="menuitem" style={{ ...item, color: 'var(--red)' }} onClick={() => { setOpen(false); onDelete() }}>{T('Delete')}</button>}
          {!mine && <button role="menuitem" style={item} onClick={() => { if (need()) { setOpen(false); setReporting(true) } }}>{T('Report')}</button>}
          {!mine && (
            <button role="menuitem" style={item} onClick={() => {
              if (!need()) return
              setOpen(false)
              void toggle(author).catch(e => onError?.(e instanceof Error ? e.message : T('Could not update')))
            }}>{isMuted(author) ? T('Unmute this wallet') : T('Mute this wallet')}</button>
          )}
        </span>
      )}
      {reporting && <ReportDialog target={target} trader={trader} onClose={() => setReporting(false)} />}
    </span>
  )
}
