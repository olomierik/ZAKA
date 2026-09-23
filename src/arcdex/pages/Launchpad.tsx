import { useEffect, useState, useCallback } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { parseUnits } from 'viem'
import { arc } from '../wagmi'
import { getAllLaunchpadTokens, LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, type LaunchpadToken } from '../api/launchpad'
import { isUnlocked } from '../lib/embeddedWallet'
import { quickBuyLaunchpad } from '../lib/quickTrade'
import type { Page } from '../App'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const

interface Props { navigate: (p: Page) => void }

function fmt(n: number, prefix = '$') {
  if (!n || isNaN(n)) return '—'
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(n < 1 ? 6 : 2)}`
}

function CreateTokenForm({ onCreated }: { onCreated: () => void }) {
  const { address, isConnected } = useAccount()
  const [open, setOpen]           = useState(false)
  const [name, setName]           = useState('')
  const [symbol, setSymbol]       = useState('')
  const [description, setDescription] = useState('')
  const [initialBuy, setInitialBuy]   = useState('')
  const [taxPct, setTaxPct]           = useState('3') // 0-3%, fixed forever once launched
  const [step, setStep] = useState<'idle' | 'approving' | 'creating'>('idle')

  const initialBuyWei = initialBuy ? (() => { try { return parseUnits(initialBuy, 6) } catch { return 0n } })() : 0n
  const taxBps = Math.max(0, Math.min(300, Math.round(Number(taxPct || 0) * 100)))

  const { data: allowance } = useReadContract({
    address: USDC_ADDR, abi: ERC20_ABI, functionName: 'allowance',
    args: [address!, LAUNCHPAD_ADDRESS],
    query: { enabled: !!address && LAUNCHPAD_ADDRESS.length === 42 && initialBuyWei > 0n },
  })

  const { writeContract, data: txHash } = useWriteContract()
  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => { if (receipt) { onCreated(); setOpen(false); setName(''); setSymbol(''); setDescription(''); setInitialBuy(''); setStep('idle') } }, [receipt, onCreated])

  // no flat creation fee — only the optional initial buy needs approval first
  const needsApprove = initialBuyWei > 0n && (allowance ?? 0n) < initialBuyWei

  function submit() {
    if (!name || !symbol || LAUNCHPAD_ADDRESS.length !== 42) return
    if (needsApprove) {
      setStep('approving')
      writeContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, initialBuyWei], chainId: arc.id })
      return
    }
    setStep('creating')
    writeContract({
      address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'createToken',
      args: [name, symbol, description, BigInt(taxBps), initialBuyWei], chainId: arc.id,
    })
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem',
        background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
      }}>
        + Launch a token
      </button>
    )
  }

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 20, marginBottom: 20, maxWidth: 440 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontWeight: 700 }}>Launch a token</span>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input placeholder="Token name" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        <input placeholder="Symbol (e.g. MOON)" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().slice(0, 12))} style={inputStyle} />
        <textarea placeholder="Description / metadata URI (optional)" value={description} onChange={e => setDescription(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' as const }} />
        <input type="number" min="0" placeholder="Initial buy in USDC (optional)" value={initialBuy} onChange={e => setInitialBuy(e.target.value)} style={inputStyle} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Your creator tax — fixed forever once launched, max 3%</span>
          <input type="number" min="0" max="3" step="0.1" value={taxPct} onChange={e => setTaxPct(e.target.value)} style={inputStyle} />
        </label>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Free to launch{initialBuy ? ` + $${initialBuy} initial buy` : ''}. 1B fixed supply — 5% to the platform, 95% into the curve, no team pre-mine.
          Every trade also pays a flat 1% platform fee on top of your {taxPct || 0}% tax. You keep 60% of your tax ({((taxBps * 0.6) / 100).toFixed(2)}% of every trade), forever.
        </div>
        {!isConnected ? (
          <ConnectKitButton.Custom>
            {({ show }) => <button onClick={show} style={primaryBtnStyle}>Connect Wallet</button>}
          </ConnectKitButton.Custom>
        ) : (
          <button onClick={submit} disabled={!name || !symbol || step !== 'idle'} style={{ ...primaryBtnStyle, opacity: (!name || !symbol) ? 0.5 : 1 }}>
            {step === 'approving' ? 'Approving USDC…' : step === 'creating' ? 'Launching…' : needsApprove ? 'Approve USDC' : 'Launch token'}
          </button>
        )}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px', borderRadius: 8, fontSize: '0.85rem', background: 'var(--bg-2)',
  border: '1px solid var(--card-border)', color: 'var(--text)', outline: 'none', fontFamily: 'var(--sans)',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '12px', borderRadius: 8, fontSize: '0.875rem', fontWeight: 700,
  background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
}

function LaunchCard({ token: t, navigate, onTraded }: { token: LaunchpadToken; navigate: (p: Page) => void; onTraded: () => void }) {
  const [buying, setBuying] = useState(false)
  const [err, setErr] = useState('')

  async function quickBuy(e: React.MouseEvent) {
    e.stopPropagation()
    if (!isUnlocked()) { setErr('Unlock your trading wallet →'); setTimeout(() => setErr(''), 2500); return }
    setBuying(true); setErr('')
    try {
      await quickBuyLaunchpad(t.address, 5_000_000n) // $5
      onTraded()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Buy failed')
      setTimeout(() => setErr(''), 2500)
    } finally { setBuying(false) }
  }

  return (
    <div onClick={() => navigate({ name: 'token', address: t.address, symbol: t.symbol })}
      style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 16, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700 }}>${t.symbol}</span>
        {t.curve.graduated && (
          <span style={{ fontSize: '0.62rem', background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>✓ GRADUATED</span>
        )}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 10 }}>{t.name}</div>
      <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 8 }}>{fmt(t.priceUsd)}</div>
      {!t.curve.graduated && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ width: `${Math.min(100, t.bondingProgress)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#22c55e)' }} />
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t.bondingProgress.toFixed(1)}% to graduation</div>
        </div>
      )}
      <button onClick={quickBuy} disabled={buying} style={{
        width: '100%', padding: '8px', borderRadius: 7, fontSize: '0.75rem', fontWeight: 700,
        background: 'var(--green)', color: '#fff', border: 'none', cursor: 'pointer', opacity: buying ? 0.6 : 1,
      }}>
        {buying ? 'Buying…' : err || '⚡ Buy $5'}
      </button>
    </div>
  )
}

export default function Launchpad({ navigate }: Props) {
  const [tokens, setTokens]   = useState<LaunchpadToken[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    void getAllLaunchpadTokens().then(t => {
      setTokens(t.sort((a, b) => b.bondingProgress - a.bondingProgress))
      setLoading(false)
    })
  }, [])

  useEffect(() => { load(); const iv = setInterval(load, 10_000); return () => clearInterval(iv) }, [load])

  if (LAUNCHPAD_ADDRESS.length !== 42) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        Launchpad contract not configured yet — set VITE_ARC_LAUNCHPAD_ADDRESS once it's deployed to mainnet.
      </div>
    )
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>Launchpad</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 4 }}>
            Bonding-curve launches on Arc mainnet · $5 to launch · 1% trade fee, 60% to creator
          </p>
        </div>
        <CreateTokenForm onCreated={load} />
      </div>

      {loading ? (
        <div className="loading-state">Loading launches…</div>
      ) : tokens.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No tokens launched yet — be the first.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {tokens.map(t => <LaunchCard key={t.address} token={t} navigate={navigate} onTraded={load} />)}
        </div>
      )}
    </div>
  )
}
