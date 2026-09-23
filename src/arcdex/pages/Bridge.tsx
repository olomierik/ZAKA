import { useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import type { EIP1193Provider } from 'viem'
import { kit, getBridgeAdapter, BRIDGE_DESTINATIONS } from '../lib/bridgeKit'
import type { BridgeResult } from '@circle-fin/bridge-kit'

const inputStyle: React.CSSProperties = {
  padding: '11px 13px', borderRadius: 8, fontSize: '0.9rem', fontFamily: 'var(--mono)',
  background: 'var(--bg-2)', border: '1px solid var(--card-border)', color: 'var(--text)',
  outline: 'none', width: '100%',
}

export default function Bridge() {
  const { address, isConnected, connector } = useAccount()
  const [destination, setDestination] = useState(BRIDGE_DESTINATIONS[0].chain)
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [status, setStatus] = useState<'idle' | 'bridging' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<BridgeResult | null>(null)
  const [errMsg, setErrMsg] = useState('')

  async function handleBridge() {
    if (!address || !connector || !amount) return
    setStatus('bridging'); setErrMsg(''); setResult(null)
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await getBridgeAdapter(provider)
      const res = await kit.bridge({
        from: { adapter, chain: 'Arc' },
        to: {
          chain: destination,
          recipientAddress: recipient.trim() || address,
          useForwarder: true, // Circle's Orbit relayer auto-mints on the destination — one signature total
        },
        amount,
      })
      setResult(res)
      setStatus(res.state === 'success' ? 'done' : 'error')
      if (res.state !== 'success') setErrMsg('Bridge did not complete — see steps below.')
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Bridge failed')
      setStatus('error')
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: 4 }}>Bridge</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 20 }}>
        Move USDC from Arc to another chain via Circle's official Cross-Chain Transfer Protocol (CCTP v2) — native burn-and-mint, no wrapped tokens, no third-party bridge risk.
      </p>

      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>From</label>
          <div style={{ padding: '11px 13px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--card-border)', fontSize: '0.9rem', fontWeight: 700 }}>
            Arc Mainnet <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· USDC</span>
          </div>
        </div>

        <div>
          <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>To</label>
          <select value={destination} onChange={e => setDestination(e.target.value as typeof destination)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {BRIDGE_DESTINATIONS.map(d => <option key={d.chain} value={d.chain}>{d.label}</option>)}
          </select>
        </div>

        <div>
          <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>Amount (USDC)</label>
          <input type="number" min="0" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            Recipient on destination chain <span style={{ opacity: 0.7 }}>(optional — defaults to your own address)</span>
          </label>
          <input placeholder={address ?? '0x…'} value={recipient} onChange={e => setRecipient(e.target.value)} style={inputStyle} />
        </div>

        {status === 'error' && errMsg && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: '0.8rem' }}>
            {errMsg}
          </div>
        )}

        {result && (
          <div style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--card-border)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 700, color: result.state === 'success' ? 'var(--green)' : 'var(--amber)' }}>
              {result.state === 'success' ? '✓ Bridge complete' : `State: ${result.state}`}
            </div>
            {result.steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                <span>{s.name}{s.forwarded ? ' (auto via Circle relayer)' : ''}</span>
                <span style={{ color: s.state === 'success' ? 'var(--green)' : s.state === 'error' ? 'var(--red)' : 'var(--text-muted)' }}>
                  {s.explorerUrl && s.txHash ? (
                    <a href={s.explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{s.state}</a>
                  ) : s.state}
                </span>
              </div>
            ))}
          </div>
        )}

        {!isConnected ? (
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} style={{ padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%' }}>
                Connect Wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        ) : (
          <button onClick={handleBridge} disabled={!amount || status === 'bridging'} style={{
            padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700,
            background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
            opacity: (!amount || status === 'bridging') ? 0.5 : 1,
          }}>
            {status === 'bridging' ? 'Bridging… (waiting on Circle attestation)' : 'Bridge'}
          </button>
        )}

        <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
          One signature: you approve + burn USDC on Arc, Circle's relayer mints it on {BRIDGE_DESTINATIONS.find(d => d.chain === destination)?.label} automatically — usually under a minute for supported chains, no network switch needed.
        </p>
      </div>
    </div>
  )
}
