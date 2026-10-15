// The passcode check on funds leaving the trading wallet (lib/funding.ts has
// the rule): back to a wallet that funded it, or to the trading wallet's own
// address on another chain, goes straight through; anywhere else asks for the
// passcode (and the passkey with 2FA on). An external wallet confirms every
// transfer itself, so it's never asked. An account opened from a Solana wallet
// (2026-10-05, lib/solAccount.ts) has no passcode: that wallet signs a
// confirmation instead, and sending to that wallet itself is never asked.
//
// Where the passcode is asked, the withdraw limits apply too (2026-10-15, lib/withdrawPolicy.ts): a new address takes
// at most $250 in its first 24 hours, and at most $2,500 a day leaves for addresses that didn't fund the wallet.

import { useCallback, useState } from 'react'
import { accountOwner, hasPasskey, verifyPasscode } from '../lib/embeddedWallet'
import { passcodeRule, useFundingWallets } from '../lib/funding'
import { shortAddr, type Trader } from '../lib/identity'
import { t as T } from '../lib/i18n'
import { recordWithdrawal, saveWithdrawAddress, useWithdrawBook, withdrawLimitsOn, withdrawVerdict, WITHDRAW_POLICY, type WithdrawVerdict } from '../lib/withdrawPolicy'

export interface WithdrawGuard {
  /** The trading wallet is sending (the rule applies). */
  guarded: boolean
  funders: string[]
  loadingFunders: boolean
  isFunder: boolean
  needsPasscode: boolean
  /** Confirmed in the Solana wallet the account comes from, not with a passcode. */
  viaSolana: boolean
  /** A passcode is needed and hasn't been typed: the send waits for it. */
  missing: boolean
  passcode: string
  setPasscode: (s: string) => void
  /** Throws "Wrong passcode" when one is needed and doesn't open the wallet, or the limits say no. */
  confirm: () => Promise<void>
  /** The withdraw limits for this transfer: null when they don't apply (a funding wallet, an external wallet). */
  limits: WithdrawVerdict | null
  /** The limits are still being read. */
  limitsLoading: boolean
  /** The limits refuse this amount. */
  overLimit: boolean
  /** Saves the address: its 24 hours start now. */
  saveAddress: () => Promise<void>
  /** Records a transfer that went through (call it after sending). */
  record: (tx: string, usd: number, label: string) => void
}

export function useWithdrawGuard(trader: Pick<Trader, 'address' | 'kind'>, to: string, amountUsd = 0): WithdrawGuard {
  const guarded = trader.kind === 'trading-wallet' && !!trader.address
  const { wallets, loading } = useFundingWallets(trader.address, guarded)
  const [passcode, setPasscode] = useState('')
  const rule = passcodeRule(guarded, trader.address, to, wallets)
  const owner = guarded ? accountOwner() : null
  const isFunder = rule.isFunder
  // A Solana wallet's account sending to that wallet itself is its own money going home.
  const needsPasscode = rule.needsPasscode && !(owner && to === owner)
  const viaSolana = !!owner
  // The limits: wherever the passcode is asked (an Arc address, or a Solana or other chain's address through the bridge).
  const limitsOn = guarded && withdrawLimitsOn()
  const { book } = useWithdrawBook(trader.address, wallets, limitsOn)
  const applies = limitsOn && needsPasscode && to.trim() !== ''
  const limits = applies && book ? withdrawVerdict(book, to, amountUsd, Date.now()) : null
  const limitsLoading = applies && !book
  const overLimit = !!limits && !limits.ok
  const saveAddress = useCallback(async () => { if (trader.address && to.trim()) await saveWithdrawAddress(trader.address, to) }, [trader.address, to])
  const record = useCallback((tx: string, usd: number, label: string) => {
    if (applies && trader.address) void recordWithdrawal(trader.address, { tx: tx.toLowerCase(), to, usd, at: Date.now() }, label)
  }, [applies, trader.address, to])
  const confirm = useCallback(async () => {
    if (limitsLoading) throw new Error(T('Checking your withdraw limits… try again in a moment.'))
    if (limits && !limits.ok) throw new Error(limits.reason ?? T('Over your withdraw limit.'))
    if (!needsPasscode) return
    if (viaSolana) {
      // The Solana wallet signs that this send is its owner's; the signature is checked against that wallet.
      const { signSolanaMessage } = await import('../lib/solanaWallet')
      const { base58Decode } = await import('../lib/solAccount')
      const { ed25519 } = await import('@noble/curves/ed25519')
      const msg = new TextEncoder().encode(`Approve sending from your ARCDEX account to ${to}.\n\nOnly approve this on arcsense.site.\n\n${new Date().toISOString()}`)
      const sig = await signSolanaMessage(msg)
      if (!owner || !ed25519.verify(sig, msg, base58Decode(owner))) throw new Error(T('Confirm in the Solana wallet this account comes from.'))
      return
    }
    if (!passcode) throw new Error(T('Enter your passcode to send to this address.'))
    try { await verifyPasscode(passcode) } catch (e) {
      const m = e instanceof Error ? e.message : ''
      throw new Error(/cancel|timed out|passkey/i.test(m) ? m : T('Wrong passcode'))
    }
  }, [needsPasscode, passcode, viaSolana, owner, to, limits, limitsLoading])
  return {
    guarded, funders: wallets, loadingFunders: loading, isFunder, needsPasscode, viaSolana,
    missing: needsPasscode && !viaSolana && !passcode, passcode, setPasscode, confirm,
    limits, limitsLoading, overLimit, saveAddress, record,
  }
}

const money = (n: number) => `$${(Math.floor(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** The withdraw limits for this transfer: what's left, and why not with a way forward. */
export function WithdrawLimits({ guard }: { guard: WithdrawGuard }) {
  const [saving, setSaving] = useState(false)
  if (guard.limitsLoading) return <div className="wd-limits">{T('Checking your withdraw limits…')}</div>
  const v = guard.limits
  if (!v) return null
  const line = v.isNew
    ? (v.knownFrom !== null
      ? T('New address: up to {left} today, the full amount from {time}.', { left: money(Math.min(v.newLeft, v.dailyLeft)), time: when(v.knownFrom) })
      : T('New address: up to {left} today.', { left: money(Math.min(v.newLeft, v.dailyLeft)) }))
    : T('Daily limit {limit}: {left} left.', { limit: money(WITHDRAW_POLICY.dailyUsd), left: money(v.dailyLeft) })
  return (
    <div className={`wd-limits${v.ok ? '' : ' over'}`} role={v.ok ? undefined : 'alert'}>
      <span>{v.ok ? line : v.reason}</span>
      {v.isNew && v.knownFrom === null && (
        <button type="button" className="link-btn" disabled={saving} onClick={() => { setSaving(true); void guard.saveAddress().finally(() => setSaving(false)) }}>
          {saving ? T('Saving…') : T('Save this address (the full amount from 24 hours from now)')}
        </button>
      )}
    </div>
  )
}

/** One tap to fill in a wallet that funded the trading wallet. */
export function FunderChips({ guard, onPick }: { guard: WithdrawGuard; onPick: (address: string) => void }) {
  if (!guard.guarded) return null
  if (guard.loadingFunders && !guard.funders.length) {
    return <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('Looking up the wallet that funded this one…')}</div>
  }
  if (!guard.funders.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('Send back to the wallet that funded this one (no passcode needed):')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {guard.funders.map(a => (
          <button key={a} type="button" className="btn-ghost" onClick={() => onPick(a)} style={{ fontFamily: 'var(--mono)', fontSize: '0.74rem', padding: '6px 10px' }}>↩ {shortAddr(a)}</button>
        ))}
      </div>
    </div>
  )
}

/** "Your funding wallet ✓", or the passcode box when the address needs it. */
export function PasscodeField({ guard, onEnter }: { guard: WithdrawGuard; onEnter?: () => void }) {
  if (guard.isFunder) {
    return <div style={{ fontSize: '0.72rem', color: 'var(--green)' }}>{T('✓ This wallet funded your trading wallet — no passcode needed.')}</div>
  }
  if (!guard.needsPasscode) return null
  if (guard.viaSolana) {
    return <div style={{ fontSize: '0.72rem', color: 'var(--amber)', padding: 10, borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid var(--amber-line)', lineHeight: 1.45 }}>{T('This address didn’t fund your account. Your Solana wallet will ask you to confirm it’s you.')}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid var(--amber-line)' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--amber)', lineHeight: 1.45 }}>
        {T("This address didn't fund your trading wallet. Enter your passcode to confirm it's you.")}
        {hasPasskey() ? ' ' + T('Your device will also ask for your passkey.') : ''}
      </div>
      <input className="field" type="password" autoComplete="current-password" placeholder={T('Passcode')} value={guard.passcode}
        onChange={e => guard.setPasscode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onEnter?.() }} />
    </div>
  )
}
