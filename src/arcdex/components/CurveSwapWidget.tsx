import { useCallback, useEffect, useMemo, useState } from 'react'
import { openConnectModal } from './ConnectWallet'
import { parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, client, type LaunchpadToken } from '../api/launchpad'
import { useTrader } from '../lib/identity'
import { sendArc, txErrorText } from '../lib/tx'
import { waitForAllowance } from '../lib/rpc'
import { triggerIndex } from '../api/social'
import { rememberHolding } from '../lib/held'
import { t as T } from '../lib/i18n'
import { waitForReceipt } from '../lib/receipts'
import { onBalances } from '../lib/balances'

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/** The launchpad's custom errors, in words a trader can act on. */
const REVERTS: Record<string, string> = {
  ExceedsSnipeLimit: "Buys are capped at $2,000 for the first 10 minutes after launch — try a smaller amount.",
  ExceedsBlockLimit: "Too many buys landed in this block already — try again in a second.",
  SlippageTooHigh: "The price moved past your slippage — try again or raise slippage.",
  InsufficientCurveLiquidity: "Not enough tokens left on the curve for this buy — try a smaller amount.",
  NoContracts: "Smart-contract wallets can't trade on the launchpad — use a regular wallet or your trading wallet.",
  ZeroAmount: "Enter an amount.",
  TokenNotFound: "This token isn't on the launchpad.",
}
const BUY_PRESETS = [10, 25, 50, 100]
const SELL_PRESETS = [25, 50, 100]

type Step = 'idle' | 'approving' | 'checking' | 'swapping' | 'done' | 'error'
interface Props { token: LaunchpadToken; onTraded?: () => void; initialMode?: 'buy' | 'sell' }

const fmtTok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2)

export default function CurveSwapWidget({ token, onTraded, initialMode }: Props) {
  const trader = useTrader()
  const me = trader.address
  const [mode, setMode] = useState<'buy' | 'sell'>(initialMode ?? 'buy')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(3)
  const [step, setStep] = useState<Step>('idle')
  const [msg, setMsg] = useState('')
  const [balance, setBalance] = useState<bigint | null>(null)
  const [allowance, setAllowance] = useState(0n)

  const tokenIn = (mode === 'buy' ? USDC_ADDR : token.address) as Address
  const decIn = mode === 'buy' ? 6 : 18
  const amountIn = useMemo(() => { try { return amount ? parseUnits(amount, decIn) : 0n } catch { return 0n } }, [amount, decIn])
  const configured = LAUNCHPAD_ADDRESS.length === 42

  // Balance + allowance for whichever wallet is trading (trading wallet or external).
  const refresh = useCallback(async () => {
    if (!me || !configured) { setBalance(null); setAllowance(0n); return }
    const [b, a] = await Promise.all([
      client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] }),
      client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'allowance', args: [me, LAUNCHPAD_ADDRESS] }),
    ]).catch(() => [null, 0n] as const)
    setBalance(b); setAllowance(a ?? 0n)
  }, [me, tokenIn, configured])
  useEffect(() => {
    void refresh()
    const id = setInterval(() => { if (!document.hidden) void refresh() }, 12_000)
    const off = onBalances(() => void refresh())
    return () => { clearInterval(id); off() }
  }, [refresh])

  // Curve math, same as the contract: a flat 1% platform fee plus this
  // coin's fixed creator tax (0-3%), off the input on buys, off the output on sells.
  const taxBps = BigInt(token.curve.creatorTaxBps)
  const estimate = useMemo(() => {
    if (amountIn === 0n) return null
    const { vUsdc, vToken, rUsdc } = token.curve
    const k = vUsdc * vToken
    if (mode === 'buy') {
      const fee = (amountIn * 100n) / 10_000n + (amountIn * taxBps) / 10_000n
      const netIn = amountIn - fee
      return { out: vToken - k / (vUsdc + netIn), decimals: 18, fee }
    }
    let gross = vUsdc - k / (vToken + amountIn)
    if (gross > rUsdc) gross = rUsdc
    const fee = (gross * 100n) / 10_000n + (gross * taxBps) / 10_000n
    return { out: gross - fee, decimals: 6, fee }
  }, [amountIn, mode, token.curve, taxBps])

  const insufficient = balance !== null && amountIn > balance
  const needsApprove = amountIn > 0n && allowance < amountIn

  const send = (req: { address: Address; abi: unknown; functionName: string; args: unknown[] }): Promise<Hex> => sendArc(trader.kind, req as never)

  async function submit() {
    if (!me || !estimate || amountIn === 0n || !configured) return
    setMsg('')
    try {
      if (needsApprove) {
        setStep('approving')
        // Exactly this trade's amount — the launchpad never gets more.
        const h = await send({ address: tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, amountIn] })
        const rc = await waitForReceipt(h)
        if (rc.status !== 'success') throw new Error(T('Approval failed'))
        // Arc's RPC nodes can trail by a block: don't simulate the trade
        // against one that hasn't seen the approval yet.
        await waitForAllowance(client, tokenIn, me, LAUNCHPAD_ADDRESS, amountIn)
        setAllowance(amountIn)
      }
      const minOut = (estimate.out * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
      const call = { address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: mode, args: [token.address, amountIn, minOut] }
      // Simulate first: the curve's limits (launch cap, per-block cap) and a
      // moved price show up here, before anything is signed.
      setStep('checking')
      await client.simulateContract({ ...call, account: me } as never)
      setStep('swapping')
      const h = await send(call)
      const rc = await waitForReceipt(h)
      if (rc.status !== 'success') throw new Error(T('Swap reverted'))
      const out = Number(formatUnits(estimate.out, estimate.decimals))
      rememberHolding(me, token.address)
      setStep('done')
      setMsg(mode === 'buy'
        ? T('Bought {amount} {symbol} for {usd}', { amount: fmtTok(out), symbol: token.symbol, usd: `$${Number(formatUnits(amountIn, 6)).toFixed(2)}` })
        : T('Sold {amount} {symbol} for {usd}', { amount: fmtTok(Number(formatUnits(amountIn, 18))), symbol: token.symbol, usd: `$${out.toFixed(2)}` }))
      setAmount('')
      setAllowance(a => (a >= amountIn ? a - amountIn : 0n))
      void refresh()
      triggerIndex(true)
      onTraded?.()
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      const known = Object.keys(REVERTS).find(k => m.includes(k))
      setStep('error')
      setMsg(known && !/rejected|denied/i.test(m) ? T(REVERTS[known]) : txErrorText(e))
    }
  }

  function preset(v: number) {
    if (mode === 'buy') { setAmount(String(v)); return }
    if (balance === null) return
    setAmount(formatUnits((balance * BigInt(v)) / 100n, 18))
  }

  const busy = step === 'approving' || step === 'checking' || step === 'swapping'
  const pill = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '5px 0', borderRadius: 6, fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--adx-accent)' : 'var(--adx-card-border)'}`,
    background: active ? 'rgba(59,130,246,0.15)' : 'var(--bg-2)', color: active ? 'var(--adx-accent)' : 'var(--text)',
  })

  return (
    <div className="swap-box">
      <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)' }}>
        {(['buy', 'sell'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setAmount(''); setStep('idle'); setMsg('') }} style={{
            flex: 1, padding: 8, fontSize: '0.82rem', fontWeight: 700, border: 'none', cursor: 'pointer',
            background: mode === m ? (m === 'buy' ? 'var(--green)' : 'var(--red)') : 'transparent',
            color: mode === m ? '#fff' : 'var(--text-muted)',
          }}>{m === 'buy' ? T("Buy") : T("Sell")} {token.symbol}</button>
        ))}
      </div>

      {!token.curve.graduated && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("Bonding curve ·")}{' '}{token.bondingProgress.toFixed(1)}{T("% to graduation")}
          <div style={{ marginTop: 4, height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, token.bondingProgress)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#22c55e)' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <span>{mode === 'buy' ? T("USDC to spend") : T('{symbol} to sell', { symbol: token.symbol })}</span>
          {balance !== null && <span className="mono">{T("Balance")}: {mode === 'buy' ? `$${Number(formatUnits(balance, 6)).toFixed(2)}` : fmtTok(Number(formatUnits(balance, 18)))}</span>}
        </div>
        <input type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="swap-input" />
        <div style={{ display: 'flex', gap: 6 }}>
          {(mode === 'buy' ? BUY_PRESETS : SELL_PRESETS).map(v => (
            <button key={v} onClick={() => preset(v)} style={pill(false)}>{mode === 'buy' ? `$${v}` : `${v}%`}</button>
          ))}
        </div>
      </div>

      {estimate && (
        <div className="swap-info">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--orange)' }}>
            <span>{T("Fee (1% +")}{' '}{(token.curve.creatorTaxBps / 100).toFixed(1)}{T("% creator tax)")}</span>
            <span className="mono">{Number(formatUnits(estimate.fee, 6)).toFixed(4)}{' '}{T("USDC")}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-muted)' }}>{T("Max slippage")}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {[1, 3, 5, 10].map(s => <button key={s} onClick={() => setSlippage(s)} style={{ ...pill(slippage === s), flex: 'none', padding: '2px 8px', fontSize: '0.72rem' }}>{s}%</button>)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--adx-card-border)', paddingTop: 6, color: 'var(--text)' }}>
            <span>{T("You receive (~)")}</span>
            <span className="mono" style={{ color: 'var(--green)' }}>
              {mode === 'buy' ? `${fmtTok(Number(formatUnits(estimate.out, 18)))} ${token.symbol}` : `$${Number(formatUnits(estimate.out, 6)).toFixed(2)}`}
            </span>
          </div>
        </div>
      )}

      {msg && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: '0.8125rem',
          background: step === 'done' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${step === 'done' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          color: step === 'done' ? '#86efac' : '#fca5a5' }}>{msg}</div>
      )}

      {!me ? (
        <button onClick={openConnectModal} style={{ padding: 11, borderRadius: 9, fontSize: '0.88rem', fontWeight: 700, background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%' }}>{T("Connect Wallet")}</button>
      ) : (
        <button onClick={() => void submit()} disabled={!configured || amountIn === 0n || insufficient || busy}
          style={{ padding: 11, borderRadius: 9, fontSize: '0.88rem', fontWeight: 700, width: '100%', border: 'none', cursor: 'pointer',
            background: needsApprove ? 'var(--orange)' : mode === 'buy' ? 'var(--green)' : 'var(--red)', color: '#fff',
            opacity: amountIn === 0n || insufficient || busy ? 0.55 : 1 }}>
          {step === 'approving' ? T("Approving…") : step === 'checking' ? T("Checking…") : step === 'swapping' ? T("Swapping…")
            : insufficient ? T("Insufficient balance")
            : needsApprove ? T('Approve {symbol}', { symbol: mode === 'buy' ? 'USDC' : token.symbol })
            : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol: token.symbol })}
        </button>
      )}

      <p className="swap-note">{T("1% platform fee +")}{' '}{(token.curve.creatorTaxBps / 100).toFixed(1)}{T("% creator tax (60% of that goes straight to the creator). Liquidity lives permanently in the curve — no LP to rug.")}{' '}{T("Approvals are for the exact trade amount only.")}</p>
    </div>
  )
}
