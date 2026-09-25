import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { parseUnits, formatUnits, maxUint256, type Address } from 'viem'
import { arc } from '../wagmi'
import { LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, type LaunchpadToken } from '../api/launchpad'
import { t as T } from '../lib/i18n'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const

type SwapMode = 'buy' | 'sell'

interface Props { token: LaunchpadToken; onTraded?: () => void }

export default function CurveSwapWidget({ token, onTraded }: Props) {
  const { address, isConnected } = useAccount()
  const [mode, setMode] = useState<SwapMode>('buy')
  const [amountIn, setAmountIn] = useState('')
  const [step, setStep] = useState<'idle' | 'approving' | 'swapping' | 'done' | 'error'>('idle')
  const [txHash, setTxHash] = useState('')
  const [errMsg, setErrMsg] = useState('')

  const tokenIn    = mode === 'buy' ? USDC_ADDR : token.address
  const decimalsIn = mode === 'buy' ? 6 : 18

  const parsedIn = amountIn ? (() => { try { return parseUnits(amountIn, decimalsIn) } catch { return 0n } })() : 0n

  const { data: allowance } = useReadContract({
    address: tokenIn as Address,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, LAUNCHPAD_ADDRESS],
    query: { enabled: !!address && LAUNCHPAD_ADDRESS.length === 42 },
  })

  const { writeContract, error: writeError } = useWriteContract()
  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined })

  // writeContract() is fire-and-forget — a rejected signature, a chain the
  // wallet won't switch to, or an RPC error all surface here, async, not
  // as a thrown exception at the call site. Without this, any of those
  // leave the button stuck on "Approving…"/"Swapping…" forever with the
  // wallet otherwise showing perfectly "connected".
  useEffect(() => {
    if (!writeError) return
    setErrMsg(writeError.message.split('\n')[0].slice(0, 160))
    setStep('error')
  }, [writeError])

  const needsApprove = parsedIn > 0n && (allowance ?? 0n) < parsedIn

  // curve pricing: usdcIn -> tokensOut, or tokensIn -> usdcOut. Two additive
  // fee layers, same as the contract: fixed 1% platform swap fee, plus this
  // token's own fixed creator tax (0-3%, set at launch).
  const taxBps = BigInt(token.curve.creatorTaxBps)
  const estimated = (() => {
    if (parsedIn === 0n) return null
    const { vUsdc, vToken } = token.curve
    const k = vUsdc * vToken
    if (mode === 'buy') {
      const platformFee = (parsedIn * 100n) / 10_000n
      const creatorTax = (parsedIn * taxBps) / 10_000n
      const fee = platformFee + creatorTax
      const netIn = parsedIn - fee
      const newVUsdc = vUsdc + netIn
      const newVToken = k / newVUsdc
      const tokensOut = vToken - newVToken
      return { out: tokensOut, decimals: 18, fee }
    } else {
      const newVToken = vToken + parsedIn
      const newVUsdc = k / newVToken
      const grossOut = vUsdc - newVUsdc
      const platformFee = (grossOut * 100n) / 10_000n
      const creatorTax = (grossOut * taxBps) / 10_000n
      const fee = platformFee + creatorTax
      return { out: grossOut - fee, decimals: 6, fee }
    }
  })()

  async function handleSwap() {
    if (!address || !amountIn || parsedIn === 0n) return
    if (LAUNCHPAD_ADDRESS.length !== 42) { setErrMsg(T('Launchpad not deployed yet')); setStep('error'); return }

    setErrMsg('')
    try {
      if (needsApprove) {
        setStep('approving')
        writeContract({ address: tokenIn as Address, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, maxUint256], chainId: arc.id })
        return
      }

      setStep('swapping')
      const minOut = estimated ? (estimated.out * 95n) / 100n : 0n // 5% slippage tolerance

      if (mode === 'buy') {
        writeContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'buy', args: [token.address, parsedIn, minOut], chainId: arc.id })
      } else {
        writeContract({ address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'sell', args: [token.address, parsedIn, minOut], chainId: arc.id })
      }
      onTraded?.()
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : T('Swap failed'))
      setStep('error')
    }
  }

  return (
    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)' }}>
        {(['buy', 'sell'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setAmountIn('') }} style={{
            flex: 1, padding: '10px', fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
            background: mode === m ? (m === 'buy' ? 'var(--green)' : 'var(--red)') : 'transparent',
            color: mode === m ? '#fff' : 'var(--text-muted)',
          }}>
            {m === 'buy' ? T("Buy") : T("Sell")} {token.symbol}
          </button>
        ))}
      </div>

      {!token.curve.graduated && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("Bonding curve ·")}{' '}{token.bondingProgress.toFixed(1)}{T("% to graduation")}<div style={{ marginTop: 4, height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, token.bondingProgress)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#22c55e)' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {mode === 'buy' ? T("USDC to spend") : T('{symbol} to sell', { symbol: token.symbol })}
        </label>
        <input type="number" min="0" placeholder="0.00" value={amountIn} onChange={e => setAmountIn(e.target.value)}
          style={{ padding: '12px 14px', borderRadius: 8, fontSize: '1rem', fontFamily: 'var(--mono)',
            background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none', width: '100%' }} />
      </div>

      {estimated && (
        <div style={{ padding: '12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)',
          fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--orange)' }}>
            <span>{T("Fee (1% +")}{' '}{(token.curve.creatorTaxBps / 100).toFixed(1)}{T("% creator tax)")}</span>
            <span className="mono">{formatUnits(estimated.fee, 6)}{' '}{T("USDC")}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--adx-card-border)', paddingTop: 6, color: 'var(--text)' }}>
            <span>{T("You receive (~)")}</span>
            <span className="mono" style={{ color: 'var(--green)' }}>
              {formatUnits(estimated.out, estimated.decimals)} {mode === 'buy' ? token.symbol : T("USDC")}
            </span>
          </div>
        </div>
      )}

      {step === 'error' && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: '0.8125rem' }}>
          {errMsg}
        </div>
      )}

      {receipt && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#86efac', fontSize: '0.8125rem' }}>{T("Trade confirmed!")}</div>
      )}

      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show} style={{ padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%' }}>{T("Connect Wallet")}</button>
          )}
        </ConnectKitButton.Custom>
      ) : (
        <button onClick={handleSwap} disabled={!amountIn || parsedIn === 0n || step === 'approving' || step === 'swapping'}
          style={{ padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700,
            background: needsApprove ? 'var(--orange)' : mode === 'buy' ? 'var(--green)' : 'var(--red)',
            color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
            opacity: (!amountIn || parsedIn === 0n) ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {step === 'approving' ? T("Approving…") : step === 'swapping' ? T("Swapping…") :
           needsApprove ? T('Approve {symbol}', { symbol: mode === 'buy' ? 'USDC' : token.symbol }) : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol: token.symbol })}
        </button>
      )}

      <p style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>{T("1% platform fee +")}{' '}{(token.curve.creatorTaxBps / 100).toFixed(1)}{T("% creator tax (60% of that goes straight to the creator). Liquidity lives permanently in the curve — no LP to rug.")}</p>
    </div>
  )
}
