import { useState } from 'react'
import { useAccount } from 'wagmi'
import { arc } from '../wagmi'
import { useWalletPrompt } from '../lib/walletPrompt'
import { useEmbeddedAddress } from '../lib/identity'
import { ensureArc, txErrorText } from '../lib/tx'
import { t as T } from '../lib/i18n'

/** "Confirm in MetaMask" with an Open button, while a WalletConnect wallet
 * on a phone has a request waiting (see lib/walletPrompt.ts). */
export function WalletPromptHost() {
  const p = useWalletPrompt()
  if (!p) return null
  return (
    <div className="wallet-prompt" role="status">
      <span className="pulse-dot" />
      <span style={{ flex: 1, minWidth: 0 }}>{T('Confirm in {wallet}', { wallet: p.walletName })}</span>
      {p.href
        ? <a className="wallet-prompt-btn" href={p.href}>{T('Open')}</a>
        : <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('Open your wallet app')}</span>}
    </div>
  )
}

/** A slim bar when the connected wallet is on another network — every
 * ARCDEX transaction is on Arc. Hidden while the trading wallet is in use
 * (it's always on Arc) and on pages that switch networks on purpose. */
export function NetworkGuard({ hidden }: { hidden?: boolean }) {
  const { isConnected, chainId } = useAccount()
  const embedded = useEmbeddedAddress()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (hidden || !isConnected || embedded || chainId === arc.id) return null
  return (
    <div className="net-guard" role="alert">
      <span style={{ flex: 1, minWidth: 0 }}>⚠ {T('Your wallet is on another network. ARCDEX trades on Arc.')}{err ? ` ${err}` : ''}</span>
      <button disabled={busy} onClick={() => { setBusy(true); setErr(''); ensureArc().catch(e => setErr(txErrorText(e))).finally(() => setBusy(false)) }}>
        {busy ? T('Check your wallet…') : T('Switch to Arc')}
      </button>
    </div>
  )
}
