// The parts of the page for an email or social sign-in (privy/state.ts): the account panel under Manage account (its
// addresses, two-step verification, key export, sign out) and the note a send shows when it needs a step-up.

import { useState } from 'react'
import { t as T } from '../lib/i18n'
import { shortAddr } from '../lib/identity'
import { privyEnrollMfa, privyExport, privyReauth, privySignOut, StepUpRequired, usePrivyState } from './state'
import type { StepUpNeed } from './stepUp'

const box: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--amber)', padding: 10, borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid var(--amber-line)', lineHeight: 1.45, display: 'flex', flexDirection: 'column', gap: 8 }

/** Signs out and in again, for a step-up; says why it didn't work. */
function ReauthButton({ label }: { label?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <>
      <button type="button" className="btn-ghost" disabled={busy} style={{ alignSelf: 'flex-start' }} onClick={() => {
        setBusy(true); setErr('')
        void privyReauth().catch((e: unknown) => { if (!(e as { cancelled?: boolean }).cancelled) setErr(T(e instanceof Error ? e.message : 'Could not connect — try again')) }).finally(() => setBusy(false))
      }}>{busy ? T('Opening…') : label ?? T('Sign in again')}</button>
      {err && <span style={{ color: '#fca5a5' }}>{err}</span>}
    </>
  )
}

/** What a send from the Privy wallet needs before it goes (WithdrawGuard's PasscodeField shows it). */
export function PrivyStepUpNote({ need }: { need: StepUpNeed }) {
  if (need === 'none') return null
  if (need === 'mfa') return <div style={box} data-testid="privy-stepup">{T('This address isn’t one of your own. Privy will ask for your two-step verification code before it sends.')}</div>
  return (
    <div style={box} data-testid="privy-stepup">
      <span>{T('This address isn’t one of your own. For your safety, sign in again (email code or social account) before sending to it. With two-step verification on (Manage account), Privy asks for a code instead.')}</span>
      <ReauthButton />
    </div>
  )
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--adx-card-border)' }
const small: React.CSSProperties = { fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.5 }

/** Manage account, for an email or social sign-in: addresses, two-step verification, key export, sign out. */
export function PrivyAccountPanel() {
  const p = usePrivyState()
  const [msg, setMsg] = useState<{ text: string; reauth?: boolean } | null>(null)
  const [busy, setBusy] = useState<'evm' | 'sol' | null>(null)
  if (!p.authenticated) return null

  async function exportKey(which: 'evm' | 'sol') {
    setMsg(null); setBusy(which)
    try {
      await privyExport(which, T('To export a key, sign in again first (or turn on two-step verification).'))
    } catch (e) {
      if (e instanceof StepUpRequired) setMsg({ text: e.message, reauth: true })
      else if (!/cancel|closed|exited/i.test(e instanceof Error ? e.message : '')) setMsg({ text: T(e instanceof Error ? e.message : 'Could not connect — try again') })
    } finally { setBusy(null) }
  }

  return (
    <div style={{ fontSize: '0.84rem' }} data-testid="privy-account">
      <b>{T('Email & social sign-in')}</b>
      <div style={{ ...small, marginTop: 6 }}>
        {T('Signed in as {who}. Privy made an EVM and a Solana wallet for this account; Privy confirms every transaction in its own window.', { who: p.label ?? T('your account') })}
      </div>
      <div style={row}>
        <span>{T('EVM wallet')}<div style={small}>{T('Same address on Arc, Ethereum, Arbitrum, BNB Chain and Robinhood Chain')}</div></span>
        <code style={{ fontSize: '0.74rem', whiteSpace: 'nowrap' }}>{p.evm ? shortAddr(p.evm) : T('Being made…')}</code>
      </div>
      <div style={row}>
        <span>{T('Solana wallet')}</span>
        <code style={{ fontSize: '0.74rem', whiteSpace: 'nowrap' }}>{p.sol ? `${p.sol.slice(0, 4)}…${p.sol.slice(-4)}` : T('Being made…')}</code>
      </div>
      <div style={row}>
        <span>{T('Two-step verification')}<div style={small}>{T('Privy asks for a code before keys or money leave the account. Recommended.')}</div></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ color: p.mfa ? 'var(--green)' : 'var(--text-muted)', fontSize: '0.78rem' }}>{p.mfa ? T('On') : T('Off')}</b>
          <button className="btn-ghost" onClick={() => privyEnrollMfa()}>{p.mfa ? T('Manage') : T('Turn on')}</button>
        </span>
      </div>
      <div style={{ ...row, flexWrap: 'wrap' }}>
        <span>{T('Export keys')}<div style={small}>{T('Privy shows the key in its own window: ARCDEX never sees it. Anyone with the key controls the wallet.')}</div></span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" disabled={!p.evm || !!busy} onClick={() => void exportKey('evm')} data-testid="privy-export-evm">{busy === 'evm' ? '…' : T('EVM key')}</button>
          <button className="btn-ghost" disabled={!p.sol || !!busy} onClick={() => void exportKey('sol')} data-testid="privy-export-sol">{busy === 'sol' ? '…' : T('Solana key')}</button>
        </span>
      </div>
      {msg && <div style={{ ...box, marginTop: 8 }} role="alert"><span>{msg.text}</span>{msg.reauth && <ReauthButton />}</div>}
      <div style={{ ...row, borderBottom: 'none' }}>
        <span>{T('Sign out')}<div style={small}>{T('Your wallets stay with your account: sign in again to use them.')}</div></span>
        <button className="btn-ghost" onClick={() => void privySignOut()}>{T('Sign out')}</button>
      </div>
    </div>
  )
}
