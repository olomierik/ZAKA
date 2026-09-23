import { useEffect, useState, useCallback } from 'react'
import { createPublicClient, http, parseAbi, formatUnits } from 'viem'
import { arc } from '../wagmi'
import {
  hasStoredWallet, isUnlocked, currentAddress, createWallet, unlock, lock,
  exportPrivateKey, deleteWallet,
} from '../lib/embeddedWallet'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const client = createPublicClient({ chain: arc, transport: http(arc.rpcUrls.default.http[0]) })

function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }

type View = 'locked' | 'unlocked' | 'create' | 'import' | 'export'

export default function TradingWalletPanel() {
  const [view, setView]       = useState<View>(hasStoredWallet() ? 'locked' : 'create')
  const [passcode, setPasscode] = useState('')
  const [passcode2, setPasscode2] = useState('')
  const [importKey, setImportKey] = useState('')
  const [error, setError]     = useState('')
  const [address, setAddress] = useState<string | null>(currentAddress())
  const [balance, setBalance] = useState<string | null>(null)
  const [exported, setExported] = useState('')
  const [copied, setCopied]   = useState(false)

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
    if (passcode !== passcode2) { setError('Passcodes do not match'); return }
    try {
      const addr = await createWallet(passcode)
      setAddress(addr); setView('unlocked'); setPasscode(''); setPasscode2('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to create wallet') }
  }

  async function doImport() {
    setError('')
    if (passcode !== passcode2) { setError('Passcodes do not match'); return }
    try {
      const { importPrivateKey } = await import('../lib/embeddedWallet')
      const addr = await importPrivateKey(importKey.trim(), passcode)
      setAddress(addr); setView('unlocked'); setPasscode(''); setPasscode2(''); setImportKey('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to import key') }
  }

  async function doUnlock() {
    setError('')
    try {
      const addr = await unlock(passcode)
      setAddress(addr); setView('unlocked'); setPasscode('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Wrong passcode') }
  }

  function doLock() { lock(); setAddress(null); setBalance(null); setView('locked') }

  async function doExport() {
    setError('')
    try { setExported(await exportPrivateKey(passcode)); setPasscode('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Wrong passcode') }
  }

  function doDelete() {
    if (!confirm('This permanently deletes the wallet from this browser. Make sure you exported the key if it holds funds. Continue?')) return
    deleteWallet(); setAddress(null); setBalance(null); setExported(''); setView('create')
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 10px', borderRadius: 7, fontSize: '0.8rem', background: 'var(--bg-2)',
    border: '1px solid var(--card-border)', color: 'var(--text)', outline: 'none', width: '100%',
  }
  const btnStyle: React.CSSProperties = {
    padding: '9px', borderRadius: 7, fontSize: '0.8rem', fontWeight: 700,
    background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
  }

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: '0.82rem' }}>Trading wallet</span>
        {view === 'unlocked' && <button onClick={doLock} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.68rem' }}>Lock</button>}
      </div>

      {error && <div style={{ fontSize: '0.7rem', color: '#ef4444', marginBottom: 8 }}>{error}</div>}

      {view === 'unlocked' && address && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{short(address)}</span>
            <button onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.68rem' }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: 10 }}>
            ${balance ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
            <span style={{ fontSize: '0.65rem', fontWeight: 500, color: 'var(--text-muted)', marginLeft: 4 }}>USDC</span>
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 10 }}>
            Deposit USDC on Arc mainnet to this address to trade with one click from the terminal.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setView('export')} style={{ ...btnStyle, background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--card-border)' }}>Export key</button>
            <button onClick={doDelete} style={{ ...btnStyle, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Delete</button>
          </div>
        </div>
      )}

      {view === 'locked' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder="Passcode" value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <button onClick={doUnlock} style={btnStyle}>Unlock</button>
          <button onClick={doDelete} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.65rem', cursor: 'pointer' }}>Forgot passcode? Delete & start over</button>
        </div>
      )}

      {view === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
            Generates a key in this browser, encrypted with your passcode. Deposit USDC to trade with one click — a hot wallet for trading, not long-term storage.
          </div>
          <input type="password" placeholder="New passcode (min 6 chars)" value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <input type="password" placeholder="Confirm passcode" value={passcode2} onChange={e => setPasscode2(e.target.value)} style={inputStyle} />
          <button onClick={doCreate} style={btnStyle}>Create wallet</button>
          <button onClick={() => { setView('import'); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '0.68rem', cursor: 'pointer' }}>Import existing key</button>
        </div>
      )}

      {view === 'import' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder="Private key (0x...)" value={importKey} onChange={e => setImportKey(e.target.value)} style={inputStyle} />
          <input type="password" placeholder="Passcode to encrypt it with (min 6)" value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
          <input type="password" placeholder="Confirm passcode" value={passcode2} onChange={e => setPasscode2(e.target.value)} style={inputStyle} />
          <button onClick={doImport} style={btnStyle}>Import</button>
          <button onClick={() => { setView('create'); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.68rem', cursor: 'pointer' }}>← Back</button>
        </div>
      )}

      {view === 'export' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!exported ? (
            <>
              <div style={{ fontSize: '0.68rem', color: '#f59e0b' }}>Re-enter your passcode to reveal the private key. Anyone with it can take everything in this wallet.</div>
              <input type="password" placeholder="Passcode" value={passcode} onChange={e => setPasscode(e.target.value)} style={inputStyle} />
              <button onClick={doExport} style={btnStyle}>Reveal key</button>
            </>
          ) : (
            <>
              <div style={{ fontSize: '0.68rem', color: '#ef4444' }}>Save this somewhere safe. It will not be shown again.</div>
              <div style={{ padding: 8, borderRadius: 6, background: 'var(--bg-2)', fontFamily: 'var(--mono)', fontSize: '0.68rem', wordBreak: 'break-all' }}>{exported}</div>
            </>
          )}
          <button onClick={() => { setView('unlocked'); setExported(''); setError('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.68rem', cursor: 'pointer' }}>← Back</button>
        </div>
      )}
    </div>
  )
}
