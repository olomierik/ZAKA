import { useState } from 'react'
import { sendSupport, type SupportCategory } from '../api/social'
import { useTrader } from '../lib/identity'
import { t, N_ } from '../lib/i18n'

// Contact support (fomo's avatar menu → Contact support). Messages go to a
// private table only ARCDEX's team can read (RLS: no public access); the
// sender is the signed-in wallet, so the team can look up its trades.

const CATEGORIES: [SupportCategory, string][] = [
  ['trade', N_('A trade')], ['deposit', N_('Deposit')], ['withdraw', N_('Withdraw or send')], ['account', N_('Account or wallet')],
  ['bug', N_('Something is broken')], ['idea', N_('Idea or feedback')], ['other', N_('Something else')],
]

export default function SupportModal({ onClose }: { onClose: () => void }) {
  const trader = useTrader()
  const [category, setCategory] = useState<SupportCategory>('trade')
  const [message, setMessage] = useState('')
  const [tx, setTx] = useState('')
  const [contact, setContact] = useState('')
  const [state, setState] = useState<'' | 'sending' | { ticket: number | null } | { error: string }>('')

  async function send() {
    setState('sending')
    try {
      const ticket = await sendSupport(trader, { category, message: message.trim(), contact: contact.trim() || undefined, tx_hash: tx.trim() || undefined })
      setState({ ticket })
    } catch (e) { setState({ error: e instanceof Error ? e.message : t('Could not send — try again') }) }
  }

  const sent = typeof state === 'object' && 'ticket' in state
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{t('Contact support')}</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        {!trader.address ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('Connect or unlock a wallet first, so we can look up your trades.')}</div>
        ) : sent ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: '2rem' }}>✓</div>
            <b>{t('Message sent')}{state.ticket ? ` · #${state.ticket}` : ''}</b>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('The ARCDEX team reads every message. If you left a contact, we will reply there.')}</div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={onClose}>{t('Done')}</button>
          </div>
        ) : (
          <>
            <label className="field-label">{t('What is it about?')}
              <select className="field" value={category} onChange={e => setCategory(e.target.value as SupportCategory)}>
                {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
              </select>
            </label>
            <label className="field-label">{t('What happened?')}
              <textarea className="field" rows={5} maxLength={2000} value={message} onChange={e => setMessage(e.target.value)} placeholder={t('Tell us what you did, what you expected and what you saw.')} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
            </label>
            <label className="field-label">{t('Transaction hash (optional)')}
              <input className="field" value={tx} onChange={e => setTx(e.target.value)} placeholder="0x…" style={{ fontFamily: 'var(--mono)' }} />
            </label>
            <label className="field-label">{t('How can we reach you? (optional)')}
              <input className="field" value={contact} maxLength={120} onChange={e => setContact(e.target.value)} placeholder={t('X, Telegram or email')} />
            </label>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('Never share your passcode or private key. ARCDEX support will never ask for them.')}</div>
            {typeof state === 'object' && 'error' in state && <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>{state.error}</div>}
            <button className="btn-primary" disabled={state === 'sending' || message.trim().length < 5} onClick={() => void send()}>{state === 'sending' ? t('Sending…') : t('Send message')}</button>
          </>
        )}
      </div>
    </div>
  )
}
