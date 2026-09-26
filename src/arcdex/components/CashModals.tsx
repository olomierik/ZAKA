import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { socialWrite } from '../api/social'
import CardDeposit from './CardDeposit'
import { shortAddr, type Trader } from '../lib/identity'
import { useCash, useSendUsdc } from '../lib/usdc'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// fomo-style cash flows: Deposit (USDC on Arc, or bridge from another
// chain), Withdraw (to any Arc address) and Send cash to a trader with a
// note. Everything is plain USDC on Arc — gas is paid in USDC too.

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b style={{ fontSize: '1rem' }}>{title}</b>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function DepositModal({ trader, navigate, onClose, initial = 'crypto' }: { trader: Trader; navigate: (p: Page) => void; onClose: () => void; initial?: 'crypto' | 'bridge' | 'card' }) {
  const [mode, setMode] = useState<'crypto' | 'bridge' | 'card'>(initial)
  const { refresh } = useCash(trader.address)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const addr = trader.address
  useEffect(() => { if (addr) void QRCode.toDataURL(addr, { margin: 1, width: 220, color: { dark: '#0b1628', light: '#ffffff' } }).then(setQr).catch(() => {}) }, [addr])

  const opt = (m: typeof mode, title: string, sub: string, icon: string) => (
    <button onClick={() => setMode(m)} style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', padding: 12, borderRadius: 10, cursor: 'pointer', color: 'var(--text)', background: mode === m ? 'rgba(59,130,246,0.12)' : 'var(--bg-2)', border: `1px solid ${mode === m ? 'var(--adx-accent)' : 'var(--adx-card-border)'}` }}>
      <span style={{ fontSize: '1.2rem' }}>{icon}</span>
      <span><b style={{ display: 'block', fontSize: '0.86rem' }}>{title}</b><span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{sub}</span></span>
    </button>
  )

  return (
    <Modal title={T("Deposit with")} onClose={onClose}>
      {!addr ? <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>{T("Connect a wallet or create a trading wallet (right panel) first.")}</div> : (
        <>
          {opt('crypto', T('Crypto'), T('Send USDC on Arc from any wallet or exchange'), '⎘')}
          {opt('bridge', T('From another chain'), T('Move USDC to Arc with Circle CCTP (Ethereum, Base, …)'), '⇄')}
          {opt('card', T('Card, Apple Pay, Google Pay'), T('Buy USDC straight to Arc'), '💳')}
          {mode === 'crypto' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 4 }}>
              {qr && <img src={qr} alt={T("Deposit address QR code")} style={{ width: 180, height: 180, borderRadius: 10 }} />}
              <div style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', wordBreak: 'break-all', textAlign: 'center' }}>{addr}</div>
              <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(addr); setCopied(true) }}>{copied ? T("Copied ✓") : T("Copy address")}</button>
              <div style={{ fontSize: '0.72rem', color: '#fcd34d', textAlign: 'center', lineHeight: 1.5 }}>{T("Send only")}{' '}<b>{T("USDC on the Arc network")}</b>{' '}{T("to this address")}{trader.kind === 'trading-wallet' ? T(" (your one-tap trading wallet)") : ''}{T(". Other tokens or networks can be lost.")}</div>
            </div>
          )}
          {mode === 'bridge' && <button className="btn-primary" onClick={() => { onClose(); navigate({ name: 'bridge', dir: 'in' }) }}>{T("Open Bridge")}</button>}
          {mode === 'card' && <CardDeposit trader={trader} onSettled={refresh} />}
        </>
      )}
    </Modal>
  )
}

export function WithdrawModal({ trader, onClose }: { trader: Trader; onClose: () => void }) {
  const { cash, refresh } = useCash(trader.address)
  const send = useSendUsdc(trader)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function go() {
    setBusy(true); setMsg(null)
    try {
      const h = await send(to.trim(), amount)
      setMsg({ ok: true, text: `Sent $${amount} — tx ${shortAddr(h)}` }); setAmount(''); refresh()
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      setMsg({ ok: false, text: /rejected|denied/i.test(m) ? T('You cancelled the transaction.') : m.slice(0, 180) })
    } finally { setBusy(false) }
  }

  return (
    <Modal title={T("Withdraw USDC")} onClose={onClose}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Available:")}{' '}<b className="sensitive" style={{ color: 'var(--text)' }}>{cash === null ? '…' : `$${cash.toFixed(2)}`}</b></div>
      <input className="field" placeholder={T("Arc address 0x…")} value={to} onChange={e => setTo(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="field" type="number" min="0" placeholder={T("Amount (USDC)")} value={amount} onChange={e => setAmount(e.target.value)} />
        <button className="btn-ghost" onClick={() => cash !== null && setAmount(Math.max(0, cash - 0.05).toFixed(2))}>{T("Max")}</button>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("Arc gas is paid in USDC — Max leaves $0.05 for it. Only send to an address on the Arc network.")}</div>
      {msg && <div style={{ fontSize: '0.78rem', color: msg.ok ? '#86efac' : '#fca5a5' }}>{msg.text}</div>}
      <button className="btn-primary" disabled={busy || !to || !amount} onClick={() => void go()} style={{ opacity: busy || !to || !amount ? 0.5 : 1 }}>{busy ? T("Sending…") : T("Withdraw")}</button>
    </Modal>
  )
}

export function SendCashModal({ trader, to, toName, onClose }: { trader: Trader; to: string; toName: string; onClose: () => void }) {
  const { cash, refresh } = useCash(trader.address)
  const send = useSendUsdc(trader)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function go() {
    setBusy(true); setMsg(null)
    try {
      const h = await send(to, amount)
      if (note.trim()) await socialWrite(trader, 'transfer.note', { tx_hash: h, note: note.trim() }).catch(() => {})
      setMsg({ ok: true, text: `Sent $${amount} to ${toName}` }); setAmount(''); setNote(''); refresh()
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      setMsg({ ok: false, text: /rejected|denied/i.test(m) ? T('You cancelled the transaction.') : m.slice(0, 180) })
    } finally { setBusy(false) }
  }

  return (
    <Modal title={T('Send cash to {name}', { name: toName })} onClose={onClose}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Your cash:")}{' '}<b className="sensitive" style={{ color: 'var(--text)' }}>{cash === null ? '…' : `$${cash.toFixed(2)}`}</b></div>
      <input className="field" type="number" min="0" placeholder="$0" value={amount} onChange={e => setAmount(e.target.value)} style={{ fontSize: '1.2rem', fontFamily: 'var(--mono)' }} />
      <textarea className="field" placeholder={T("Add a note (optional)")} maxLength={200} rows={2} value={note} onChange={e => setNote(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{note.length}{T("/200 · Sent instantly as USDC on Arc to")}{' '}{shortAddr(to)}.</div>
      {msg && <div style={{ fontSize: '0.78rem', color: msg.ok ? '#86efac' : '#fca5a5' }}>{msg.text}</div>}
      <button className="btn-primary" disabled={busy || !amount || !trader.address} onClick={() => void go()} style={{ opacity: busy || !amount || !trader.address ? 0.5 : 1 }}>{!trader.address ? T("Connect a wallet to send") : busy ? T("Sending…") : T("Send")}</button>
    </Modal>
  )
}
