import { useEffect, useState, useCallback } from 'react'
import { createPublicClient, http, parseAbi, formatUnits } from 'viem'
import { arc } from '../wagmi'
import {
  hasStoredWallet, isUnlocked, currentAddress, createWallet, unlock, lock,
  exportPrivateKey, deleteWallet, hasPasskey, enablePasskey, disablePasskey, passkeySupport,
} from '../lib/embeddedWallet'
import { t as T } from '../lib/i18n'
import { useTrader } from '../lib/identity'
import { DepositModal, WithdrawModal } from './CashModals'
import type { Page } from '../App'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const client = createPublicClient({ chain: arc, transport: http(arc.rpcUrls.default.http[0]) })

function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }

type View = 'locked' | 'unlocked' | 'create' | 'import' | 'export' | 'security'

export default function TradingWalletPanel({ navigate }: { navigate?: (p: Page) => void } = {}) {
  const trader = useTrader()
  const [cashModal, setCashModal] = useState<'deposit' | 'withdraw' | null>(null)
  const [view, setView]       = useState<View>(hasStoredWallet() ? 'locked' : 'create')
  const [passcode, setPasscode] = useState('')
  const [passcode2, setPasscode2] = useState('')
  const [importKey, setImportKey] = useState('')
  const [error, setError]     = useState('')
  const [address, setAddress] = useState<string | null>(currentAddress())
  const [balance, setBalance] = useState<string | null>(null)
  const [exported, setExported] = useState('')
  const [copied, setCopied]   = useState(false)
  const [twoFa, setTwoFa]     = useState(hasPasskey())
  const [support, setSupport] = useState<'yes' | 'maybe' | 'no'>('maybe')
  const [busy, setBusy]       = useState(false)
  useEffect(() => { void passkeySupport().then(setSupport) }, [])

  const refreshBalance = useCallback((addr: string) => {
    void client.readContract({ address: USDC_ADDR, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr as `0x${string}`] })
      .then(b => setBalance(formatUnits(b, 6)))
      .catch(() => setBalance(null))
  }, [])

  useEffect(() => {
    if (address) { refreshBalance(address); const iv = setInterval(() => refreshBalance(address), 8000); return () => clearInterval(iv) }
  }, [address, refreshBalance])

  async function doCreate() {
    setError('')
    if (passcode !== passcode2) { setError(T("Passcodes do not match")); return }
    try {
      const addr = await createWallet(passcode)
      setAddress(addr); setView('unlocked'); setPasscode(''); setPasscode2('')
    } catch (e) { setError(e instanceof Error ? e.message : T("Failed to create wallet")) }
  }

  async function doImport() {
    setError('')
    if (passcode !== passcode2) { setError(T("Passcodes do not match")); return }
    try {
      const { importPrivateKey } = await import('../lib/embeddedWallet')
      const addr = await importPrivateKey(importKey.trim(), passcode)
      setAddress(addr); setView('unlocked'); setPasscode(''); setPasscode2(''); setImportKey('')
    } catch (e) { setError(e instanceof Error ? e.message : T("Failed to import key")) }
  }

  async function doUnlock() {
    setError(''); setBusy(true)
    try {
      const addr = await unlock(passcode)
      setAddress(addr); setView('unlocked'); setPasscode('')
    } catch (e) { setError(e instanceof Error ? e.message : T("Wrong passcode")) } finally { setBusy(false) }
  }

  async function doTwoFa() {
    setError(''); setBusy(true)
    try {
      if (twoFa) await disablePasskey(passcode); else await enablePasskey(passcode)
      setTwoFa(hasPasskey()); setPasscode(''); setView('unlocked')
    } catch (e) { setError(e instanceof Error ? e.message : T("Could not change 2FA")) } finally { setBusy(false) }
  }

  function doLock() { lock(); setAddress(null); setBalance(null); setView('locked') }

  async function doExport() {
    setError('')
    try { setExported(await exportPrivateKey(passcode)); setPasscode('') }
    catch (e) { setError(e instanceof Error ? e.message : T("Wrong passcode")) }
  }

  function doDelete() {
    if (!confirm(T('This permanently deletes the wallet from this browser. Make sure you exported the key if it holds funds. Continue?'))) return
    deleteWallet(); setAddress(null); setBalance(null); setExported(''); setView('create')
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 10px', borderRadius: 7, fontSize: '0.8rem', background: 'var(--bg-2)',
    border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none', width: '100%',
  }
  const btnStyle: React.CSSProperties = {
    padding: '9px', borderRadius: 7, fontSize: '0.8rem', fontWeight: 700,
    background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
  }

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: '0.82rem' }}>{T("Trading wallet")}</span>
        {view === 'unlocked' && <button onClick={doLock} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.68rem' }}>{T("Lock")}</button>}
      </div>

      {error && <div style={{ fontSize: '0.7rem', color: '#ef4444', marginBottom: 8 }}>{error}</div>}

      {view === 'unlocked' && address && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{short(address)}</span>
            <button onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              style={{ background: 'none', border: 'none', color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.68rem' }}>
              {copied ? T("Copied") : T("Copy")}
            </button>
          </div>
          <div style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: 10 }}>
            ${balance ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
            <span style={{ fontSize: '0.65rem', fontWeight: 500, color: 'var(--text-muted)', marginLeft: 4 }}>{T("USDC")}</span>
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 10 }}>{T("Deposit USDC on Arc mainnet to this address to trade with one click from the terminal.")}</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => setCashModal('deposit')} style={btnStyle}>{T("Deposit")}</button>
            <button onClick={() => setCashModal('withdraw')} style={{ ...btnStyle, background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--adx-card-border)' }}>{T("Withdraw")}</button>
          </div>
          {navigate && (
            <button onClick={() => navigate({ name: 'portfolio' })} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 8, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.72rem' }}>
              <span>{T("▤ Your coins")}</span><b style={{ color: 'var(--adx-accent)' }}>{T("Portfolio →")}</b>
            </button>
          )}
          <button onClick={() => { setView('security'); setError('') }} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 8, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', border: `1px solid ${twoFa ? 'rgba(34,197,94,0.35)' : 'var(--adx-card-border)'}`, color: 'var(--text)', cursor: 'pointer', fontSize: '0.72rem' }}>
            <span>{T("🔑 2FA (passkey)")}</span>
            <b style={{ color: twoFa ? 'var(--green)' : 'var(--text-muted)' }}>{twoFa ? T("On") : T("Off — set up")}</b>
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setView('export')} style={{ ...btnStyle, background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--adx-card-border)' }}>{T("Export key")}</button>
            <button onClick={doDelete} style={{ ...btnStyle, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>{T("Delete")}</button>
          </div>
        </div>
      )}

      {view === 'locked' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder={T("Passcode")} value={passcode} onChange={e => setPasscode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doUnlock() }} style={inputStyle} />
          <button onClick={doUnlock} disabled={busy} style={btnStyle}>{busy ? (twoFa ? T("Confirm with your passkey…") : T("Unlocking…")) : twoFa ? T("Unlock with passcode + passkey") : T("Unlock")}</button>
          {twoFa && <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', textAlign: 'center' }}>{T("🔑 2FA is on — your device will ask for your fingerprint, face or security key.")}</div>}
          <button onClick={doDelete} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.65rem', cursor: 'pointer' }}>{T("Forgot passcode? Delete & start over")}</button>
        </div>
      )}

      {view === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{T("Generates a key in this browser, encrypted with your passcode. Deposit USDC to trade with one click — a hot wallet for trading, not long-term storage.")}</div>
          <input type="password" placeholder={T("New passcode (min 6 chars)")} value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <input type="password" placeholder={T("Confirm passcode")} value={passcode2} onChange={e => setPasscode2(e.target.value)} style={inputStyle} />
          <button onClick={doCreate} style={btnStyle}>{T("Create wallet")}</button>
          <button onClick={() => { setView('import'); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--adx-accent)', fontSize: '0.68rem', cursor: 'pointer' }}>{T("Import existing key")}</button>
        </div>
      )}

      {view === 'import' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder={T("Private key (0x...)")} value={importKey} onChange={e => setImportKey(e.target.value)} style={inputStyle} />
          <input type="password" placeholder={T("Passcode to encrypt it with (min 6)")} value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <input type="password" placeholder={T("Confirm passcode")} value={passcode2} onChange={e => setPasscode2(e.target.value)} style={inputStyle} />
          <button onClick={doImport} style={btnStyle}>{T("Import")}</button>
          <button onClick={() => { setView('create'); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.68rem', cursor: 'pointer' }}>{T("← Back")}</button>
        </div>
      )}

      {view === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b style={{ fontSize: '0.78rem' }}>{twoFa ? T("Turn off passkey 2FA") : T("Protect this wallet with a passkey")}</b>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {twoFa
              ? T("Unlocking will need only your passcode again. You will confirm with your passkey one last time.")
              : T("With 2FA on, unlocking needs your passcode AND your passkey (Windows Hello, Touch ID / Face ID, Android, or a security key). Someone who learns your passcode still cannot open the wallet.")}
          </div>
          {!twoFa && <div style={{ fontSize: '0.68rem', color: '#f59e0b', lineHeight: 1.5 }}>{T("Export and save your key first. If you lose this passkey and have no backup, the funds can't be recovered.")}</div>}
          {!twoFa && support === 'no' && <div style={{ fontSize: '0.68rem', color: '#ef4444' }}>{T("This browser can't use passkeys for 2FA. Try a recent Chrome, Edge or Safari.")}</div>}
          <input type="password" placeholder={T("Passcode")} value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <button onClick={() => void doTwoFa()} disabled={busy || (!twoFa && support === 'no')} style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}>{busy ? T("Waiting for your passkey…") : twoFa ? T("Turn off 2FA") : T("Set up passkey")}</button>
          <button onClick={() => { setView('unlocked'); setError(''); setPasscode('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.68rem', cursor: 'pointer' }}>{T("← Back")}</button>
        </div>
      )}

      {view === 'export' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!exported ? (
            <>
              <div style={{ fontSize: '0.68rem', color: '#f59e0b' }}>{T("Re-enter your passcode")}{twoFa ? T(" (and confirm with your passkey)") : ''}{' '}{T("to reveal the private key. Anyone with it can take everything in this wallet.")}</div>
              <input type="password" placeholder={T("Passcode")} value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
              <button onClick={doExport} style={btnStyle}>{T("Reveal key")}</button>
            </>
          ) : (
            <>
              <div style={{ fontSize: '0.68rem', color: '#ef4444' }}>{T("Save this somewhere safe. It will not be shown again.")}</div>
              <div style={{ padding: 8, borderRadius: 6, background: 'var(--bg-2)', fontFamily: 'var(--mono)', fontSize: '0.68rem', wordBreak: 'break-all' }}>{exported}</div>
            </>
          )}
          <button onClick={() => { setView('unlocked'); setExported(''); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.68rem', cursor: 'pointer' }}>{T("← Back")}</button>
        </div>
      )}

      {cashModal === 'deposit' && trader.address && <DepositModal trader={trader} navigate={p => { setCashModal(null); navigate?.(p) }} onClose={() => { setCashModal(null); if (address) refreshBalance(address) }} />}
      {cashModal === 'withdraw' && trader.address && <WithdrawModal trader={trader} onClose={() => setCashModal(null)} onSent={() => { if (address) refreshBalance(address) }} />}
    </div>
  )
}
