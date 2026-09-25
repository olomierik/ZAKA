import { useEffect, useState } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import { ConnectButton } from '../components/ConnectWallet'
import { formatUnits } from 'viem'
import { arc } from 'wagmi/chains'
import { getTokens, type ArcToken } from '../api/radardex'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const ERC20_ABI = [
  {
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

interface TokenBalance extends ArcToken {
  balance: number
  valueUsdc: number
}

interface Props {
  navigate: (p: Page) => void
}

export default function Portfolio({ navigate }: Props) {
  const { address, isConnected } = useAccount()
  const [tokens,   setTokens]   = useState<ArcToken[]>([])
  const [balances, setBalances] = useState<TokenBalance[]>([])
  const [loading,  setLoading]  = useState(false)

  useEffect(() => { getTokens().then(setTokens) }, [])

  const contracts = tokens.slice(0, 100).map(t => ({
    address: t.address as `0x${string}`,
    abi:     ERC20_ABI,
    functionName: 'balanceOf' as const,
    args:    [address!] as const,
    chainId: arc.id,
  }))

  const { data: rawBalances } = useReadContracts({
    contracts,
    query: { enabled: !!address && tokens.length > 0 },
  })

  useEffect(() => {
    if (!rawBalances || !tokens.length) return
    setLoading(true)
    const result: TokenBalance[] = []
    rawBalances.forEach((r, i) => {
      if (r.status !== 'success' || !r.result) return
      const t = tokens[i]
      const raw = r.result
      const balance = parseFloat(formatUnits(raw, t.decimals))
      if (balance < 1e-9) return
      const valueUsdc = balance * t.price
      result.push({ ...t, balance, valueUsdc })
    })
    result.sort((a, b) => b.valueUsdc - a.valueUsdc)
    setBalances(result)
    setLoading(false)
  }, [rawBalances, tokens])

  const totalValue = balances.reduce((s, b) => s + b.valueUsdc, 0)

  if (!isConnected) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 20, padding: '80px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: '3rem' }}>💼</div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{T("Connect your wallet")}</h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: 340 }}>{T("See your Arc mainnet token holdings valued in USDC.")}</p>
      <ConnectButton />
    </div>
  )

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: 4 }}>{T("Portfolio")}</h1>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          {address?.slice(0,6)}…{address?.slice(-4)}{' '}{T("· Arc Mainnet")}</div>
      </div>

      {/* Total value */}
      <div className="arc-card" style={{ padding: '24px', marginBottom: 20,
        background: 'linear-gradient(135deg,rgba(59,130,246,0.1),rgba(139,92,246,0.1))' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6,
          textTransform: 'uppercase', letterSpacing: '0.06em' }}>{T("Total Portfolio Value")}</div>
        <div style={{ fontSize: '2.5rem', fontWeight: 800, fontFamily: 'var(--mono)' }}>
          ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: 4 }}>
          {balances.length}{' '}{T("token")}{balances.length !== 1 ? T("s") : ''}{' '}{T("on Arc mainnet")}</div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>{T("Loading balances…")}</div>
      )}

      {!loading && balances.length === 0 && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>{T("No token holdings found on Arc mainnet.")}</div>
      )}

      {balances.map(b => {
        const pct = totalValue > 0 ? (b.valueUsdc / totalValue) * 100 : 0
        return (
          <div
            key={b.address}
            className="arc-card glow-hover"
            onClick={() => navigate({ name: 'token', address: b.address })}
            style={{ padding: '16px 20px', marginBottom: 12, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 16 }}
          >
            {b.logoUrl ? (
              <img src={b.logoUrl} width={40} height={40} style={{ borderRadius: '50%' }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} alt="" />
            ) : (
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: `hsl(${parseInt(b.address.slice(2,4),16)*1.4}deg 60% 40%)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, color: '#fff', fontSize: '0.875rem',
              }}>{b.symbol.slice(0,2)}</div>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{b.symbol}</span>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>
                  ${b.valueUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                <span className="mono">{b.balance.toLocaleString()} {b.symbol}</span>
                <span>{pct.toFixed(1)}{T("% of portfolio")}</span>
              </div>
              {/* Portfolio bar */}
              <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2, width: `${pct}%`,
                  background: 'linear-gradient(90deg,var(--adx-accent),#8b5cf6)',
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
