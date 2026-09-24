import { useEffect, useMemo, useState } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { parseUnits, formatUnits, type Address } from 'viem'
import { arc } from '../wagmi'
import { client } from '../api/launchpad'
import { USDC_ADDRESS, type SwapRoute } from '../api/argusMarket'

export const SWAP_ROUTER_ADDRESS = (import.meta.env.VITE_ARCDEX_SWAP_ROUTER_ADDRESS ?? '') as Address
const routerReady = SWAP_ROUTER_ADDRESS.length === 42

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

const POOLKEY = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] } as const

const ROUTER_ABI = [
  { name: 'swapExactInV4', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'keys', type: 'tuple[]', components: POOLKEY.components }, { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'swapExactInV3', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'poolFee', type: 'uint24' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
] as const

interface Props {
  token: Address
  symbol: string
  priceUsd: number
  route: SwapRoute | null
  routeLoading: boolean
  onTraded?: () => void
}

type Step = 'idle' | 'approving' | 'quoting' | 'swapping' | 'done' | 'error'

export default function ArgusSwapWidget({ token, symbol, priceUsd, route, routeLoading, onTraded }: Props) {
  const { address, isConnected } = useAccount()
  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(3)
  const [step, setStep] = useState<Step>('idle')
  const [msg, setMsg] = useState('')

  const tokenIn = mode === 'buy' ? USDC_ADDRESS : token
  const tokenOut = mode === 'buy' ? token : USDC_ADDRESS
  const decIn = mode === 'buy' ? 6 : 18
  const decOut = mode === 'buy' ? 18 : 6
  const amountIn = useMemo(() => { try { return amount ? parseUnits(amount, decIn) : 0n } catch { return 0n } }, [amount, decIn])

  const { data: balance, refetch: refetchBal } = useReadContract({
    address: tokenIn, abi: ERC20_ABI, functionName: 'balanceOf', args: [address!], chainId: arc.id,
    query: { enabled: !!address },
  })
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenIn, abi: ERC20_ABI, functionName: 'allowance', args: [address!, SWAP_ROUTER_ADDRESS], chainId: arc.id,
    query: { enabled: !!address && routerReady },
  })

  const { writeContract, data: txHash, error: writeError, reset } = useWriteContract()
  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!writeError) return
    setMsg(writeError.message.split('\n')[0].slice(0, 160))
    setStep('error')
  }, [writeError])

  useEffect(() => {
    if (!receipt) return
    if (step === 'approving') { void refetchAllowance(); setStep('idle'); setMsg('Approved — now confirm the swap.'); reset() }
    else if (step === 'swapping') { setStep('done'); setMsg('Swap confirmed.'); setAmount(''); void refetchBal(); onTraded?.(); reset() }
  }, [receipt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rough pre-trade estimate from the market price, net of our 1% fee.
  // The exact figure (pool fee, hook tax, price impact) comes from
  // simulating the real transaction right before it's sent.
  const estimate = amountIn > 0n && priceUsd > 0
    ? mode === 'buy'
      ? (Number(formatUnits(amountIn, 6)) * 0.99) / priceUsd
      : Number(formatUnits(amountIn, 18)) * priceUsd * 0.99
    : 0

  const needsApprove = routerReady && amountIn > 0n && (allowance ?? 0n) < amountIn
  const insufficient = balance !== undefined && amountIn > balance

  function buildCall(minOut: bigint) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    if (!route) throw new Error('No route')
    if (route.kind === 'v4') {
      const keys = mode === 'buy' ? route.buyKeys : route.sellKeys
      return { functionName: 'swapExactInV4' as const, args: [keys, tokenIn, amountIn, minOut, deadline] as const }
    }
    return { functionName: 'swapExactInV3' as const, args: [tokenIn, tokenOut, route.fee, amountIn, minOut, deadline] as const }
  }

  async function submit() {
    if (!address || amountIn === 0n || !route || !routerReady) return
    setMsg('')
    if (needsApprove) {
      setStep('approving')
      // Exact amount, not unlimited — the router never needs more than
      // this trade.
      writeContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [SWAP_ROUTER_ADDRESS, amountIn], chainId: arc.id })
      return
    }
    try {
      setStep('quoting')
      // Simulate the exact transaction first: this is the real output
      // after pool fees, the launch's own tax hook and price impact, and
      // it catches a trade that would revert before the wallet signs it.
      const sim = buildCall(1n)
      const { result } = await client.simulateContract({
        address: SWAP_ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: sim.functionName,
        args: sim.args as never, account: address,
      })
      const out = result as bigint
      const minOut = (out * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
      const call = buildCall(minOut)
      setStep('swapping')
      writeContract({ address: SWAP_ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: call.functionName, args: call.args as never, chainId: arc.id })
    } catch (e) {
      const m = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
      setMsg(`Trade would fail: ${m}`.slice(0, 200))
      setStep('error')
    }
  }

  const busy = step === 'approving' || step === 'quoting' || step === 'swapping'
  const routeText = route?.kind === 'v4' && route.via === 'ARGUS'
    ? (mode === 'buy' ? `USDC → ARGUS → ${symbol}` : `${symbol} → ARGUS → USDC`)
    : (mode === 'buy' ? `USDC → ${symbol}` : `${symbol} → USDC`)

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)' }}>
        {(['buy', 'sell'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setAmount(''); setStep('idle'); setMsg('') }} style={{
            flex: 1, padding: 10, fontSize: '0.875rem', fontWeight: 700, border: 'none', cursor: 'pointer',
            background: mode === m ? (m === 'buy' ? 'var(--green)' : 'var(--red)') : 'transparent',
            color: mode === m ? '#fff' : 'var(--text-muted)',
          }}>{m === 'buy' ? 'Buy' : 'Sell'} {symbol}</button>
        ))}
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>
          <span>{mode === 'buy' ? 'You pay (USDC)' : `You sell (${symbol})`}</span>
          {balance !== undefined && (
            <button onClick={() => setAmount(formatUnits(balance, decIn))} style={{ background: 'none', border: 'none', color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.72rem' }}>
              Balance: {Number(formatUnits(balance, decIn)).toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </button>
          )}
        </div>
        <input type="number" min="0" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, fontSize: '1rem', fontFamily: 'var(--mono)', background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none' }} />
        {mode === 'buy' && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {[5, 10, 25, 100].map(v => (
              <button key={v} onClick={() => setAmount(String(v))} style={{ flex: 1, padding: '6px 0', borderRadius: 6, fontSize: '0.75rem', background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', cursor: 'pointer' }}>${v}</button>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label="You receive (est.)" value={estimate > 0 ? `${estimate.toLocaleString(undefined, { maximumFractionDigits: decOut === 6 ? 2 : 0 })} ${mode === 'buy' ? symbol : 'USDC'}` : '—'} />
        <Row label="Route" value={routeLoading ? 'Finding route…' : route ? routeText : 'No routable pool'} />
        <Row label="Platform fee" value="1% (in USDC)" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)' }}>Max slippage</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 3, 5, 10].map(s => (
              <button key={s} onClick={() => setSlippage(s)} style={{ padding: '2px 8px', borderRadius: 5, fontSize: '0.7rem', cursor: 'pointer', border: '1px solid var(--adx-card-border)', background: slippage === s ? 'var(--adx-accent)' : 'transparent', color: slippage === s ? '#fff' : 'var(--text-muted)' }}>{s}%</button>
            ))}
          </div>
        </div>
      </div>

      {msg && (
        <div style={{ padding: '10px 12px', borderRadius: 8, fontSize: '0.78rem',
          background: step === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          border: `1px solid ${step === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
          color: step === 'error' ? '#fca5a5' : '#86efac' }}>{msg}</div>
      )}

      {!routerReady ? (
        <div style={{ padding: 12, borderRadius: 8, fontSize: '0.78rem', background: 'var(--bg-2)', border: '1px dashed var(--adx-card-border)', color: 'var(--text-muted)', textAlign: 'center' }}>
          Trading opens once the ARCDEX swap router is deployed.
        </div>
      ) : !isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => <button onClick={show} style={btn('var(--adx-accent)')}>Connect Wallet</button>}
        </ConnectKitButton.Custom>
      ) : (
        <button onClick={() => void submit()} disabled={busy || amountIn === 0n || !route || insufficient}
          style={{ ...btn(needsApprove ? 'var(--amber)' : mode === 'buy' ? 'var(--green)' : 'var(--red)'), opacity: busy || amountIn === 0n || !route || insufficient ? 0.5 : 1 }}>
          {insufficient ? 'Insufficient balance'
            : step === 'approving' ? 'Approving…'
            : step === 'quoting' ? 'Checking trade…'
            : step === 'swapping' ? 'Swapping…'
            : needsApprove ? `Approve ${mode === 'buy' ? 'USDC' : symbol}`
            : `${mode === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}
        </button>
      )}

      <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
        Every trade is simulated before your wallet signs it. The token's own launch tax (set by its creator on Argus) applies on top of the 1% platform fee.
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function btn(bg: string): React.CSSProperties {
  return { width: '100%', padding: 14, borderRadius: 10, fontSize: '0.95rem', fontWeight: 700, background: bg, color: '#fff', border: 'none', cursor: 'pointer' }
}
