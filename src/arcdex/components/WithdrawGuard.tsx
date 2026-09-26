// The passcode check on funds leaving the trading wallet (lib/funding.ts has
// the rule): back to a wallet that funded it, or to the trading wallet's own
// address on another chain, goes straight through; anywhere else asks for the
// passcode (and the passkey with 2FA on). An external wallet confirms every
// transfer itself, so it's never asked.

import { useCallback, useState } from 'react'
import { hasPasskey, verifyPasscode } from '../lib/embeddedWallet'
import { passcodeRule, useFundingWallets } from '../lib/funding'
import { shortAddr, type Trader } from '../lib/identity'
import { t as T } from '../lib/i18n'

export interface WithdrawGuard {
  /** The trading wallet is sending (the rule applies). */
  guarded: boolean
  funders: string[]
  loadingFunders: boolean
  isFunder: boolean
  needsPasscode: boolean
  passcode: string
  setPasscode: (s: string) => void
  /** Throws "Wrong passcode" when one is needed and doesn't open the wallet. */
  confirm: () => Promise<void>
}

export function useWithdrawGuard(trader: Pick<Trader, 'address' | 'kind'>, to: string): WithdrawGuard {
  const guarded = trader.kind === 'trading-wallet' && !!trader.address
  const { wallets, loading } = useFundingWallets(trader.address, guarded)
  const [passcode, setPasscode] = useState('')
  const { isFunder, needsPasscode } = passcodeRule(guarded, trader.address, to, wallets)
  const confirm = useCallback(async () => {
    if (!needsPasscode) return
    if (!passcode) throw new Error(T('Enter your passcode to send to this address.'))
    try { await verifyPasscode(passcode) } catch (e) {
      const m = e instanceof Error ? e.message : ''
      throw new Error(/cancel|timed out|passkey/i.test(m) ? m : T('Wrong passcode'))
    }
  }, [needsPasscode, passcode])
  return { guarded, funders: wallets, loadingFunders: loading, isFunder, needsPasscode, passcode, setPasscode, confirm }
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
    return <div style={{ fontSize: '0.72rem', color: '#86efac' }}>{T('✓ This wallet funded your trading wallet — no passcode needed.')}</div>
  }
  if (!guard.needsPasscode) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' }}>
      <div style={{ fontSize: '0.72rem', color: '#fcd34d', lineHeight: 1.45 }}>
        {T("This address didn't fund your trading wallet. Enter your passcode to confirm it's you.")}
        {hasPasskey() ? ' ' + T('Your device will also ask for your passkey.') : ''}
      </div>
      <input className="field" type="password" autoComplete="current-password" placeholder={T('Passcode')} value={guard.passcode}
        onChange={e => guard.setPasscode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onEnter?.() }} />
    </div>
  )
}
