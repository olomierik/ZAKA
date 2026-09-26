import { useCallback, useEffect, useMemo, useState } from 'react'
import { openConnectModal } from './ConnectWallet'
import { parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { client } from '../api/launchpad'
import { USDC_ADDRESS, type SwapRoute } from '../api/argusMarket'
import { useTrader, shortAddr } from '../lib/identity'
import { sendArc, txErrorText } from '../lib/tx'
import { waitForAllowance } from '../lib/rpc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { SWAP_ROUTER_ADDRESS, routerConfigured, useRouterInfo, pct, type RouterInfo } from '../lib/routerInfo'
import { referrerFor, referralLink } from '../lib/referral'
import { getProfile, triggerIndex } from '../api/social'
import ShareCardModal from './ShareCardModal'
import type { CardData } from '../lib/shareCard'
import { setPrefs, usePrefs } from '../lib/prefs'
import { t as T } from '../lib/i18n'

export { SWAP_ROUTER_ADDRESS }

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

const KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
const OUT = [{ name: 'amountOut', type: 'uint256' }] as const
const V4_IN = [{ name: 'keys', type: 'tuple[]', components: KEY }, { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] as const
const V3_IN = [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'poolFee', type: 'uint24' }, { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] as const
const REF = { name: 'referrer', type: 'address' } as const

// v1 and v2 differ only by v2's trailing `referrer` argument.
const ROUTER_V1 = [
  { name: 'swapExactInV4', type: 'function', stateMutability: 'nonpayable', inputs: V4_IN, outputs: OUT },
  { name: 'swapExactInV3', type: 'function', stateMutability: 'nonpayable', inputs: V3_IN, outputs: OUT },
] as const
const ROUTER_V2 = [
  { name: 'swapExactInV4', type: 'function', stateMutability: 'nonpayable', inputs: [...V4_IN, REF], outputs: OUT },
  { name: 'swapExactInV3', type: 'function', stateMutability: 'nonpayable', inputs: [...V3_IN, REF], outputs: OUT },
] as const

const WARN_IMPACT = 5
const CONFIRM_IMPACT = 15

interface Props {
  token: Address
  symbol: string
  tokenImage?: string | null
  priceUsd: number
  marketCapUsd?: number | null
  route: SwapRoute | null
  routeLoading: boolean
  buyTaxBps?: number | null
  sellTaxBps?: number | null
  onTraded?: () => void
  unverified?: boolean
  /** Which side opens first (the phone trade bar's Buy / Sell). */
  initialMode?: 'buy' | 'sell'
}

type Step = 'idle' | 'approving' | 'quoting' | 'swapping' | 'done' | 'error'

const fmtUsd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`
const fmtTok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2)

export default function ArgusSwapWidget({ token, symbol, tokenImage, priceUsd, marketCapUsd, route, routeLoading, buyTaxBps, sellTaxBps, onTraded, unverified, initialMode }: Props) {
  const trader = useTrader()
  const me = trader.address
  const info = useRouterInfo()

  const [mode, setMode] = useState<'buy' | 'sell'>(initialMode ?? 'buy')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(3)
  const [step, setStep] = useState<Step>('idle')
  const [msg, setMsg] = useState('')
  const [balance, setBalance] = useState<bigint | null>(null)
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [impact, setImpact] = useState<number | null>(null)
  const [riskOk, setRiskOk] = useState(false)
  const [share, setShare] = useState<{ card: CardData; text: string } | null>(null)
  const [lastTrade, setLastTrade] = useState<{ kind: 'buy' | 'sell'; usd: number; tokens: number } | null>(null)
  // Quick-trade presets (fomo's pencil): buy in USDC, sell in % of holding.
  const prefs = usePrefs()
  const [editing, setEditing] = useState<string[] | null>(null)
  const presets = mode === 'buy' ? prefs.buyPresets : prefs.sellPresets
  const savePresets = () => {
    if (!editing) return
    const vals = editing.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0).map(v => mode === 'sell' ? Math.min(100, v) : v)
    if (vals.length) setPrefs(mode === 'buy' ? { buyPresets: vals } : { sellPresets: vals })
    setEditing(null)
  }

  const tokenIn = mode === 'buy' ? USDC_ADDRESS : token
  const decIn = mode === 'buy' ? 6 : 18
  const amountIn = useMemo(() => { try { return amount ? parseUnits(amount, decIn) : 0n } catch { return 0n } }, [amount, decIn])
  const feeBps = info?.feeBps ?? 0
  const taxBps = (mode === 'buy' ? buyTaxBps : sellTaxBps) ?? 0

  // Balance + allowance for whichever wallet is trading (works for both the
  // trading wallet and an external one — no wagmi hooks tied to one).
  const refresh = useCallback(async () => {
    if (!me || !routerConfigured) { setBalance(null); setAllowance(0n); return }
    const [b, a] = await Promise.all([
      client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] }),
      client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'allowance', args: [me, SWAP_ROUTER_ADDRESS] }),
    ]).catch(() => [null, 0n] as const)
    setBalance(b); setAllowance(a ?? 0n)
  }, [me, tokenIn])
  useEffect(() => {
    void refresh()
    const id = setInterval(() => { if (!document.hidden) void refresh() }, 12_000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => { setImpact(null); setRiskOk(false) }, [amount, mode])

  // Pre-trade estimate from the market price, net of the platform fee and
  // the coin's creator tax. The exact figure comes from simulating the
  // real transaction just before it's sent.
  const net = (1 - feeBps / 10_000) * (1 - taxBps / 10_000)
  const estimate = amountIn > 0n && priceUsd > 0
    ? mode === 'buy' ? (Number(formatUnits(amountIn, 6)) * net) / priceUsd : Number(formatUnits(amountIn, 18)) * priceUsd * net
    : 0

  const insufficient = balance !== null && amountIn > balance
  const needsApprove = amountIn > 0n && allowance < amountIn

  function callFor(r: RouterInfo, minOut: bigint, referrer: Address) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    if (!route) throw new Error(T('No route'))
    const abi = r.version === 2 ? ROUTER_V2 : ROUTER_V1
    const tail = r.version === 2 ? [referrer] : []
    if (route.kind === 'v4') {
      const keys = mode === 'buy' ? route.buyKeys : route.sellKeys
      return { abi, functionName: 'swapExactInV4' as const, args: [keys, tokenIn, amountIn, minOut, deadline, ...tail] }
    }
    const tokenOut = mode === 'buy' ? token : USDC_ADDRESS
    return { abi, functionName: 'swapExactInV3' as const, args: [tokenIn, tokenOut, route.fee, amountIn, minOut, deadline, ...tail] }
  }

  // One-tap with the trading wallet (signs locally, no pop-up); an external
  // wallet is put on Arc first (lib/tx.ts).
  const send = (req: { address: Address; abi: unknown; functionName: string; args: unknown[] }): Promise<Hex> => sendArc(trader.kind, req as never)

  async function submit() {
    if (!me || !info || !route || amountIn === 0n) return
    setMsg('')
    try {
      if (needsApprove) {
        setStep('approving')
        // Exact amount only — the router never needs more than this trade.
        const h = await send({ address: tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [SWAP_ROUTER_ADDRESS, amountIn] })
        const rc = await client.waitForTransactionReceipt({ hash: h })
        if (rc.status !== 'success') throw new Error(T('Approval failed'))
        // Arc's RPC nodes can trail by a block: wait until the approval is visible.
        await waitForAllowance(client, tokenIn, me, SWAP_ROUTER_ADDRESS, amountIn)
        setAllowance(amountIn)
      }

      setStep('quoting')
      const referrer = info.version === 2 ? await referrerFor(me) : ('0x0000000000000000000000000000000000000000' as Address)
      // Simulate the exact transaction: the real output after pool fees,
      // the coin's tax hook and price impact — and it catches a trade that
      // would revert before anything is signed.
      const sim = callFor(info, 1n, referrer)
      const { result } = await client.simulateContract({ address: SWAP_ROUTER_ADDRESS, abi: sim.abi, functionName: sim.functionName, args: sim.args, account: me } as never)
      const out = result as bigint

      // Price impact vs. the market price (after fee and tax, so it's the
      // cost of size alone).
      const outNum = Number(formatUnits(out, mode === 'buy' ? 18 : 6))
      const imp = estimate > 0 ? Math.max(0, (1 - outNum / estimate) * 100) : 0
      setImpact(imp)
      if (imp >= CONFIRM_IMPACT && !riskOk) {
        setStep('idle')
        setMsg(T("This trade moves the price {pct}% — you'd get {out}. Tick the box to confirm, or trade a smaller amount.", { pct: imp.toFixed(1), out: mode === 'buy' ? fmtTok(outNum) + ' ' + symbol : fmtUsd(outNum) }))
        return
      }

      const minOut = (out * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
      setStep('swapping')
      const call = callFor(info, minOut, referrer)
      const h = await send({ address: SWAP_ROUTER_ADDRESS, abi: call.abi, functionName: call.functionName, args: call.args })
      const rc = await client.waitForTransactionReceipt({ hash: h })
      if (rc.status !== 'success') throw new Error(T('Swap reverted'))

      const usd = mode === 'buy' ? Number(formatUnits(amountIn, 6)) : outNum
      const tokens = mode === 'buy' ? outNum : Number(formatUnits(amountIn, 18))
      setLastTrade({ kind: mode, usd, tokens })
      setStep('done')
      setMsg(T(mode === 'buy' ? 'Bought {amount} {symbol} for {usd}' : 'Sold {amount} {symbol} for {usd}', { amount: fmtTok(tokens), symbol, usd: fmtUsd(usd) }))
      setAmount('')
      setAllowance(a => (a >= amountIn ? a - amountIn : 0n))
      void refresh()
      triggerIndex(true)
      onTraded?.()
    } catch (e) {
      setStep('error')
      setMsg(txErrorText(e))
    }
  }

  async function openShare() {
    if (!lastTrade || !me) return
    const profile = await getProfile(me).catch(() => null)
    const link = referralLink(me, profile)
    const mc = marketCapUsd ? ` at ${fmtUsd(marketCapUsd)} market cap` : ''
    setShare({
      text: `Just ${lastTrade.kind === 'buy' ? 'aped into' : 'took profit on'} $${symbol}${mc} on ARCDEX ⚡ Trade Arc memecoins with me:`,
      card: {
        symbol, tokenImage: tokenImage ?? null,
        headline: lastTrade.kind === 'buy' ? 'BOUGHT' : 'SOLD',
        headlineColor: lastTrade.kind === 'buy' ? '#22c55e' : '#f59e0b',
        lines: [`${fmtUsd(lastTrade.usd)} of $${symbol}`, mc ? mc.trim() : `${fmtTok(lastTrade.tokens)} tokens`, 'on Arc · arcdex.online'],
        trader: profile?.username ? `@${profile.username}` : shortAddr(me),
        traderAddress: me,
        link,
      },
    })
  }

  const busy = step === 'approving' || step === 'quoting' || step === 'swapping'
  const routeText = route?.kind === 'v4' && route.via === 'ARGUS'
    ? (mode === 'buy' ? `USDC → ARGUS → ${symbol}` : `${symbol} → ARGUS → USDC`)
    : (mode === 'buy' ? `USDC → ${symbol}` : `${symbol} → USDC`)
  const needsRiskTick = impact !== null && impact >= CONFIRM_IMPACT

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)' }}>
        {(['buy', 'sell'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setAmount(''); setStep('idle'); setMsg(''); setEditing(null) }} style={{
            flex: 1, padding: 10, fontSize: '0.875rem', fontWeight: 700, border: 'none', cursor: 'pointer',
            background: mode === m ? (m === 'buy' ? 'var(--green)' : 'var(--red)') : 'transparent',
            color: mode === m ? '#fff' : 'var(--text-muted)',
          }}>{m === 'buy' ? T("Buy") : T("Sell")} {symbol}</button>
        ))}
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>
          <span>{mode === 'buy' ? T("You pay (USDC)") : T('You sell ({symbol})', { symbol })}</span>
          {balance !== null && (
            <button onClick={() => setAmount(formatUnits(balance, decIn))} style={{ background: 'none', border: 'none', color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.72rem' }}>
              {mode === 'buy' ? T("Cash") : T("Holding")}: {mode === 'buy' ? fmtUsd(Number(formatUnits(balance, 6))) : fmtTok(Number(formatUnits(balance, 18)))}
            </button>
          )}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder={mode === 'buy' ? '$0' : '0'} value={amount} onChange={e => setAmount(e.target.value)}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, fontSize: '1.05rem', fontFamily: 'var(--mono)', background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none' }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          {editing ? (
            <>
              {editing.map((v, i) => (
                <input key={i} value={v} inputMode="decimal" onChange={e => setEditing(ed => ed && ed.map((x, j) => j === i ? e.target.value : x))}
                  onKeyDown={e => { if (e.key === 'Enter') savePresets() }}
                  style={{ flex: 1, minWidth: 0, padding: '6px 4px', borderRadius: 6, fontSize: '0.78rem', textAlign: 'center', fontFamily: 'var(--mono)', background: 'var(--bg-2)', border: '1px solid var(--adx-accent)', color: 'var(--text)' }} />
              ))}
              <button title={T("Save presets")} onClick={savePresets} style={pencil}>✓</button>
            </>
          ) : (
            <>
              {mode === 'buy'
                ? presets.map(v => <Chip key={v} onClick={() => setAmount(String(v))}>${v}</Chip>)
                : presets.map(p => <Chip key={p} onClick={() => balance !== null && setAmount(formatUnits((balance * BigInt(Math.round(p * 100))) / 10_000n, 18))}>{p >= 100 ? T("Max") : `${p}%`}</Chip>)}
              <button title={T(mode === 'buy' ? 'Edit quick buy presets' : 'Edit quick sell presets')} onClick={() => setEditing(presets.map(String))} style={pencil}>✎</button>
            </>
          )}
        </div>
      </div>

      <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label={T("You receive (est.)")} value={estimate > 0 ? (mode === 'buy' ? `${fmtTok(estimate)} ${symbol}` : fmtUsd(estimate)) : '—'} />
        <Row label={T("Route")} value={routeLoading ? T('Finding route…') : route ? routeText : T('No routable pool')} />
        <Row label={T("Platform fee")} value={info ? T('{pct} (in USDC)', { pct: pct(info.feeBps) }) : '…'} />
        <Row label={T("Creator tax")} value={taxBps ? pct(taxBps) : '0%'} />
        {impact !== null && (
          <Row label={T("Price impact")} value={`${impact.toFixed(2)}%`} color={impact >= CONFIRM_IMPACT ? 'var(--red)' : impact >= WARN_IMPACT ? 'var(--amber)' : undefined} />
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)' }}>{T("Max slippage")}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 3, 5, 10].map(s => (
              <button key={s} onClick={() => setSlippage(s)} style={{ padding: '2px 8px', borderRadius: 5, fontSize: '0.7rem', cursor: 'pointer', border: '1px solid var(--adx-card-border)', background: slippage === s ? 'var(--adx-accent)' : 'transparent', color: slippage === s ? '#fff' : 'var(--text-muted)' }}>{s}%</button>
            ))}
          </div>
        </div>
      </div>

      {needsRiskTick && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.76rem', color: '#fcd34d', cursor: 'pointer' }}>
          <input type="checkbox" checked={riskOk} onChange={e => setRiskOk(e.target.checked)} style={{ marginTop: 2 }} />{T("I understand this trade moves the price")}{' '}{impact!.toFixed(1)}{T("% and I'll get less than the market price.")}</label>
      )}

      {msg && (
        <div style={{ padding: '10px 12px', borderRadius: 8, fontSize: '0.78rem',
          background: step === 'error' ? 'rgba(239,68,68,0.1)' : step === 'done' ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)',
          border: `1px solid ${step === 'error' ? 'rgba(239,68,68,0.3)' : step === 'done' ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.35)'}`,
          color: step === 'error' ? '#fca5a5' : step === 'done' ? '#86efac' : '#fcd34d', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <span>{msg}</span>
          {step === 'done' && lastTrade && <button onClick={() => void openShare()} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--green)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.74rem' }}>{T("Share")}</button>}
        </div>
      )}

      {!routerConfigured ? (
        <Note>{T("Trading opens once the ARCDEX swap router is deployed.")}</Note>
      ) : !me ? (
        <>
          <button onClick={openConnectModal} style={btn('var(--adx-accent)')}>{T("Connect Wallet")}</button>
          <Note>{T("Or unlock your")}{' '}<button className="link-btn" onClick={openTradingWallet}>{T("trading wallet")}</button>{' '}{T("for one-tap trades with no pop-ups.")}</Note>
        </>
      ) : (
        <button onClick={() => void submit()} disabled={busy || amountIn === 0n || !route || insufficient || !info || (needsRiskTick && !riskOk)}
          style={{ ...btn(needsApprove ? 'var(--amber)' : mode === 'buy' ? 'var(--green)' : 'var(--red)'), opacity: busy || amountIn === 0n || !route || insufficient || !info || (needsRiskTick && !riskOk) ? 0.5 : 1 }}>
          {insufficient ? T("Insufficient balance")
            : step === 'approving' ? T("Approving…")
            : step === 'quoting' ? T("Checking trade…")
            : step === 'swapping' ? (mode === 'buy' ? T("Buying…") : T("Selling…"))
            : needsApprove ? T(mode === 'buy' ? 'Approve & buy' : 'Approve & sell')
            : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol })}
        </button>
      )}

      {me && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center' }}>{T("Trading as")}{' '}{trader.kind === 'trading-wallet' ? T("⚡ trading wallet") : T("wallet")} <span style={{ fontFamily: 'var(--mono)' }}>{shortAddr(me)}</span>
          {trader.kind === 'trading-wallet' ? T(" · one-tap, no pop-ups") : ''}
        </div>
      )}

      {unverified && (
        <div style={{ fontSize: '0.7rem', color: '#fcd34d', textAlign: 'center' }}>{T("⚠ Unverified token — anyone can launch a coin with any name. Check the contract before trading.")}</div>
      )}

      <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>{T("Every trade is simulated before it's sent. The coin's creator tax (set on Argus) applies on top of the platform fee.")}</p>

      {share && <ShareCardModal card={share.card} text={share.text} referralsLive={info?.version === 2} onClose={() => setShare(null)} />}
    </div>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', color }}>{value}</span>
    </div>
  )
}

function Chip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ flex: 1, padding: '6px 0', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', cursor: 'pointer' }}>{children}</button>
}

const pencil: React.CSSProperties = { padding: '5px 8px', borderRadius: 6, fontSize: '0.78rem', background: 'transparent', border: '1px solid var(--adx-card-border)', color: 'var(--text-muted)', cursor: 'pointer' }

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 10, borderRadius: 8, fontSize: '0.76rem', background: 'var(--bg-2)', border: '1px dashed var(--adx-card-border)', color: 'var(--text-muted)', textAlign: 'center' }}>{children}</div>
}

function btn(bg: string): React.CSSProperties {
  return { width: '100%', padding: 14, borderRadius: 10, fontSize: '0.95rem', fontWeight: 700, background: bg, color: '#fff', border: 'none', cursor: 'pointer' }
}
