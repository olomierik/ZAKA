import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi'
import { openConnectModal } from './ConnectWallet'
import { parseUnits, formatUnits, maxUint256 } from 'viem'
import { arc } from '../wagmi'
import type { ArcToken } from '../api/radardex'
import { t as T } from '../lib/i18n'

const USDC_ADDR    = '0x3600000000000000000000000000000000000000' as const
// Disabled: this widget was built for the retired ArcDexRouter, which has
// no mainnet deployment (its env var held the *testnet* address — on
// mainnet that's an empty account, so "swaps" silently did nothing while
// users granted it unlimited USDC). Argus coins trade through
// ArgusSwapWidget + ArcDexSwapRouter. Deliberately not read from env so a
// stale VITE_ARCDEX_ROUTER_ADDRESS can't re-enable it. See AGENTS.md.
const ROUTER_ADDR  = '' as `0x${string}`
const FEE_TIER     = 3000 // 0.3% Uniswap V3 pool fee — separate from 1% platform fee

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const

const ROUTER_ABI = [
  {
    name: 'swapExactInputSingle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenIn',            type: 'address' },
        { name: 'tokenOut',           type: 'address' },
        { name: 'fee',                type: 'uint24'  },
        { name: 'amountIn',           type: 'uint256' },
        { name: 'amountOutMinimum',   type: 'uint256' },
        { name: 'sqrtPriceLimitX96',  type: 'uint160' },
        { name: 'deadline',           type: 'uint256' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

interface Props {
  token: ArcToken
}

type SwapMode = 'buy' | 'sell'

export default function SwapWidget({ token }: Props) {
  const { address, isConnected } = useAccount()
  const [mode, setMode]       = useState<SwapMode>('buy')
  const [amountIn, setAmountIn] = useState('')
  const [step, setStep]       = useState<'idle' | 'approving' | 'swapping' | 'done' | 'error'>('idle')
  const [txHash, setTxHash]   = useState('')
  const [errMsg, setErrMsg]   = useState('')

  const tokenIn  = mode === 'buy' ? USDC_ADDR : (token.address as `0x${string}`)
  const tokenOut = mode === 'buy' ? (token.address as `0x${string}`) : USDC_ADDR
  const decimalsIn = mode === 'buy' ? 6 : token.decimals

  const parsedIn = amountIn ? (() => { try { return parseUnits(amountIn, decimalsIn) } catch { return 0n } })() : 0n
  const platformFee = parsedIn * 1n / 100n
  const netIn = parsedIn - platformFee

  // Check allowance
  const { data: allowance } = useReadContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, ROUTER_ADDR],
    query: { enabled: !!address && !!ROUTER_ADDR },
  })

  const { writeContract, error: writeError } = useWriteContract()
  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined })

  // Async wallet/RPC failures (rejected signature, chain switch refused,
  // etc.) surface on the hook's `error`, not as a thrown exception —
  // without this, the button gets stuck on "Approving…"/"Swapping…"
  // forever with no feedback, even though the wallet still shows connected.
  useEffect(() => {
    if (!writeError) return
    setErrMsg(writeError.message.split('\n')[0].slice(0, 160))
    setStep('error')
  }, [writeError])

  const needsApprove = parsedIn > 0n && (allowance ?? 0n) < parsedIn

  async function handleSwap() {
    if (!address || !amountIn || parsedIn === 0n) return
    if (!ROUTER_ADDR) { setErrMsg(T('Swapping this token isn’t available here yet — Argus coins trade from their own page.')); setStep('error'); return }

    setErrMsg('')
    try {
      if (needsApprove) {
        setStep('approving')
        writeContract({
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ROUTER_ADDR, maxUint256],
          chainId: arc.id,
        })
        return
      }

      setStep('swapping')
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
      const minOut = netIn * 95n / 100n // 5% slippage tolerance

      writeContract({
        address: ROUTER_ADDR,
        abi: ROUTER_ABI,
        functionName: 'swapExactInputSingle',
        args: [{
          tokenIn,
          tokenOut,
          fee: FEE_TIER,
          amountIn: parsedIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
          deadline,
        }],
        chainId: arc.id,
      })
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : T('Swap failed'))
      setStep('error')
    }
  }

  const estimated = parsedIn > 0n && token.price > 0
    ? mode === 'buy'
      ? (Number(formatUnits(netIn, 6)) / token.price).toFixed(6)
      : (Number(formatUnits(netIn, token.decimals)) * token.price).toFixed(6)
    : '—'

  return (
    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden',
        border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)' }}>
        {(['buy', 'sell'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex: 1, padding: '10px', fontSize: '0.875rem', fontWeight: 600,
            border: 'none', cursor: 'pointer', transition: 'all 0.15s',
            background: mode === m ? (m === 'buy' ? 'var(--green)' : 'var(--red)') : 'transparent',
            color: mode === m ? '#fff' : 'var(--text-muted)',
          }}>
            {m === 'buy' ? T("Buy") : T("Sell")} {token.symbol}
          </button>
        ))}
      </div>

      {/* Amount input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {mode === 'buy' ? T("USDC to spend") : T('{symbol} to sell', { symbol: token.symbol })}
        </label>
        <input
          type="number" min="0" placeholder="0.00"
          value={amountIn}
          onChange={e => setAmountIn(e.target.value)}
          style={{
            padding: '12px 14px', borderRadius: 8, fontSize: '1rem', fontFamily: 'var(--mono)',
            background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)',
            color: 'var(--text)', outline: 'none', width: '100%',
          }}
        />
      </div>

      {/* Fee breakdown */}
      {parsedIn > 0n && (
        <div style={{ padding: '12px', borderRadius: 8, background: 'var(--bg-2)',
          border: '1px solid var(--adx-card-border)', fontSize: '0.8125rem', display: 'flex',
          flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
            <span>{T("Amount in")}</span>
            <span className="mono">{amountIn} {mode === 'buy' ? T("USDC") : token.symbol}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--orange)' }}>
            <span>{T("Platform fee (1%)")}</span>
            <span className="mono">{formatUnits(platformFee, decimalsIn)} {mode === 'buy' ? T("USDC") : token.symbol}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between',
            borderTop: '1px solid var(--adx-card-border)', paddingTop: 6, color: 'var(--text)' }}>
            <span>{T("You receive (~)")}</span>
            <span className="mono" style={{ color: 'var(--green)' }}>{estimated} {mode === 'buy' ? token.symbol : T("USDC")}</span>
          </div>
        </div>
      )}

      {/* Error */}
      {step === 'error' && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: '0.8125rem' }}>
          {errMsg}
        </div>
      )}

      {/* Success */}
      {receipt && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.1)',
          border: '1px solid rgba(34,197,94,0.3)', color: '#86efac', fontSize: '0.8125rem' }}>{T("Swap confirmed!")}{' '}
          <a href={`https://explorer.mainnet.arc.io/tx/${txHash}`} target="_blank" rel="noreferrer"
            style={{ color: 'var(--adx-accent)' }}>{T("View on explorer ↗")}</a>
        </div>
      )}

      {/* CTA */}
      {!isConnected ? (
        <button onClick={openConnectModal} style={{
              padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700,
              background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer',
              width: '100%',
            }}>{T("Connect Wallet")}</button>
      ) : (
        <button
          onClick={handleSwap}
          disabled={!amountIn || parsedIn === 0n || step === 'approving' || step === 'swapping'}
          style={{
            padding: '14px', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700,
            background: needsApprove ? 'var(--orange)' : mode === 'buy' ? 'var(--green)' : 'var(--red)',
            color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
            opacity: (!amountIn || parsedIn === 0n) ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {step === 'approving' ? T("Approving…") :
           step === 'swapping'  ? T("Swapping…") :
           needsApprove         ? T('Approve {symbol}', { symbol: mode === 'buy' ? 'USDC' : token.symbol }) :
           T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol: token.symbol })}
        </button>
      )}

      <p style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>{T("1% platform fee applies. Gas paid in USDC on Arc mainnet. 5% max slippage. Transactions are irreversible.")}</p>
    </div>
  )
}
