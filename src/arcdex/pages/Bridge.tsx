import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { isAddress, type EIP1193Provider } from 'viem'
import type { BridgeChain, BridgeResult } from '@circle-fin/bridge-kit'
import { openConnectModal } from '../components/ConnectWallet'
import { kit, getBridgeAdapter, tradingWalletAdapter, ensureWalletChain, quoteBridge, BRIDGE_CHAINS, BRIDGE_FEE_BPS, type BridgeQuote } from '../lib/bridgeKit'
import { useEmbeddedAddress } from '../lib/identity'
import { PasscodeField, useWithdrawGuard } from '../components/WithdrawGuard'
import { t as T } from '../lib/i18n'
import { promptWallet, txErrorText } from '../lib/tx'
import { hideWalletPrompt } from '../lib/walletPrompt'

type Dir = 'out' | 'in'
type Adapter = Awaited<ReturnType<typeof getBridgeAdapter>> | ReturnType<typeof tradingWalletAdapter>

const isSolanaAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
/** Bridge Kit's step names, in words. */
const STEP: Record<string, string> = {
  approve: 'Approved USDC', burn: 'Burned on the source chain', fetchAttestation: 'Circle attested the transfer', mint: 'Minted on the destination',
}

const field: React.CSSProperties = {
  padding: '9px 11px', borderRadius: 8, fontSize: '0.9rem', fontFamily: 'var(--mono)', background: 'var(--bg-2)',
  border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none', width: '100%', minWidth: 0,
}
const label: React.CSSProperties = { fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, display: 'block' }

export default function Bridge({ initialDir = 'out' }: { initialDir?: Dir }) {
  const { address, connector } = useAccount()
  const tradingAddr = useEmbeddedAddress()
  const [dir, setDir] = useState<Dir>(initialDir)
  const [other, setOther] = useState<BridgeChain>('Base' as BridgeChain)
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [fromTradingPref, setFromTradingPref] = useState(true)
  const [quote, setQuote] = useState<BridgeQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [status, setStatus] = useState<'idle' | 'switching' | 'bridging' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<string[]>([])
  const [result, setResult] = useState<BridgeResult | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const adapterRef = useRef<Adapter | null>(null)

  const otherDef = BRIDGE_CHAINS.find(c => c.chain === other) ?? BRIDGE_CHAINS[0]
  // Solana can only receive: bringing USDC in from it needs a Solana wallet.
  const choices = dir === 'out' ? BRIDGE_CHAINS : BRIDGE_CHAINS.filter(c => c.evm)
  useEffect(() => { if (dir === 'in' && !otherDef.evm) setOther('Base' as BridgeChain) }, [dir, otherDef.evm])

  const from = dir === 'out' ? 'Arc' : other
  const to = dir === 'out' ? other : 'Arc'
  // Out of Arc: the trading wallet can send (one tap). Into Arc: the USDC is
  // on the other chain, so an external wallet signs there.
  const fromTrading = dir === 'out' && fromTradingPref && !!tradingAddr
  const sender = fromTrading ? tradingAddr : address ?? null
  // Arriving on Arc, the trading wallet is where USDC is traded, so it's the default recipient.
  const defaultRecipient = dir === 'in' ? (tradingAddr ?? address ?? '') : (otherDef.evm ? (sender ?? '') : '')
  const recipientAddr = recipient.trim() || defaultRecipient
  const toSolana = dir === 'out' && !otherDef.evm
  const recipientOk = toSolana ? isSolanaAddress(recipientAddr) : isAddress(recipientAddr)
  const n = parseFloat(amount)
  // Sending from the trading wallet to anyone but itself or the wallet that
  // funded it asks for the passcode, like a withdrawal (WithdrawGuard).
  const guard = useWithdrawGuard({ address: tradingAddr, kind: fromTrading ? 'trading-wallet' : null }, fromTrading ? recipientAddr : '')

  // Circle's fees for this route and amount (debounced; stale answers dropped).
  const quoteSeq = useRef(0)
  useEffect(() => {
    setQuote(null)
    if (!(n > 0)) { setQuoting(false); return }
    const seq = ++quoteSeq.current
    setQuoting(true)
    const id = setTimeout(() => {
      quoteBridge(from, to, amount)
        .then(q => { if (seq === quoteSeq.current) setQuote(q) })
        .catch(() => { if (seq === quoteSeq.current) setQuote(null) })
        .finally(() => { if (seq === quoteSeq.current) setQuoting(false) })
    }, 450)
    return () => clearTimeout(id)
  }, [from, to, amount, n])

  function flip() {
    setDir(d => (d === 'out' ? 'in' : 'out'))
    setRecipient(''); setResult(null); setErrMsg(''); setStatus('idle'); setProgress([])
  }

  async function handleBridge() {
    if (!sender || !(n > 0) || !recipientOk) return
    setErrMsg(''); setResult(null); setProgress([])
    if (fromTrading) {
      try { await guard.confirm() } catch (e) { setErrMsg(e instanceof Error ? e.message : T('Wrong passcode')); setStatus('error'); return }
    }
    let provider: EIP1193Provider | null = null
    let prompted = false
    const onStep = (p: unknown) => {
      const m = (p as { method?: string }).method
      if (m) setProgress(prev => (prev.includes(m) ? prev : [...prev, m]))
      // Both signatures are in: nothing left to confirm in the wallet app.
      if (m === 'burn' && prompted) { hideWalletPrompt(); prompted = false }
    }
    try {
      let adapter: Adapter
      if (fromTrading) adapter = tradingWalletAdapter()
      else {
        if (!connector) throw new Error(T('Connect a wallet first'))
        provider = (await connector.getProvider()) as EIP1193Provider
        setStatus('switching')
        await ensureWalletChain(provider, from)
        adapter = await getBridgeAdapter(provider)
        // WalletConnect on a phone: offer to open the wallet app for the approve + burn.
        prompted = await promptWallet()
      }
      adapterRef.current = adapter
      setStatus('bridging')
      kit.on('*' as never, onStep as never)
      // Approve, then burn, as two plain transactions: the kit would otherwise
      // batch them (EIP-5792) where the wallet supports it, which asks
      // MetaMask users to switch to a smart account first.
      const res = await kit.bridge({ from: { adapter, chain: from as BridgeChain }, to: { chain: to as BridgeChain, recipientAddress: recipientAddr, useForwarder: true }, amount, config: { batchTransactions: false } } as never)
      setResult(res)
      setStatus(res.state === 'success' ? 'done' : 'error')
      if (res.state !== 'success') setErrMsg(T("The transfer didn't finish — see the steps below. If the burn went through, your USDC is safe: press Retry to finish it."))
      if (res.state === 'success') { setAmount(''); guard.setPasscode('') }
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      setErrMsg(/insufficient|exceeds balance/i.test(m) && !/allowance/i.test(m) ? T('Not enough USDC (or gas) on {chain} for this transfer.', { chain: from }) : txErrorText(e))
      setStatus('error')
    } finally {
      kit.off('*' as never, onStep as never)
      if (prompted) hideWalletPrompt()
      // Bringing USDC in switched the wallet away from Arc: switch it back for the rest of ARCDEX.
      if (provider && from !== 'Arc') void ensureWalletChain(provider, 'Arc').catch(() => {})
    }
  }

  async function retry() {
    if (!result || !adapterRef.current) return
    setStatus('bridging'); setErrMsg('')
    try {
      const res = await kit.retry(result, { from: adapterRef.current } as never)
      setResult(res)
      setStatus(res.state === 'success' ? 'done' : 'error')
      if (res.state !== 'success') setErrMsg(T("Still not finished — Circle's attestation can take a few minutes. Try again shortly."))
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message.slice(0, 220) : T('Retry failed'))
      setStatus('error')
    }
  }

  const busy = status === 'switching' || status === 'bridging'
  const needsWallet = !sender
  const tooSmall = quote !== null && quote.receiveUsdc <= 0
  const passcodeMissing = fromTrading && guard.needsPasscode && !guard.passcode
  const chainBox = (side: 'from' | 'to') => {
    const isArc = (side === 'from') === (dir === 'out')
    return (
      <div>
        <label style={label}>{side === 'from' ? T('From') : T('To')}</label>
        {isArc ? (
          <div style={{ ...field, fontFamily: 'var(--sans)', fontWeight: 700 }}>{T("Arc Mainnet")} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{T("· USDC")}</span></div>
        ) : (
          <select value={other} onChange={e => setOther(e.target.value as BridgeChain)} style={{ ...field, fontFamily: 'var(--sans)', fontWeight: 700, cursor: 'pointer' }}>
            {choices.map(c => <option key={c.chain} value={c.chain}>{c.label}</option>)}
          </select>
        )}
      </div>
    )
  }

  return (
    <div className="form-page">
      <h1 className="page-title">{T("Bridge")}</h1>
      <p className="page-sub">{T("Move USDC between Arc and other chains with Circle's Cross-Chain Transfer Protocol (CCTP v2): native burn-and-mint, no wrapped tokens, no third-party bridge.")}</p>

      <div style={{ display: 'flex', background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', borderRadius: 9, padding: 3, marginBottom: 10 }}>
        {(['in', 'out'] as const).map(d => (
          <button key={d} onClick={() => { if (d !== dir) flip() }} style={{
            flex: 1, padding: '7px 6px', borderRadius: 7, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem',
            background: dir === d ? 'var(--adx-accent)' : 'transparent', color: dir === d ? '#fff' : 'var(--text-muted)',
          }}>{d === 'in' ? T('Deposit to Arc') : T('Send from Arc')}</button>
        ))}
      </div>

      <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {chainBox('from')}
        <button onClick={flip} aria-label={T("Swap direction")} style={{ alignSelf: 'center', margin: '-4px 0', width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--adx-card-border)', background: 'var(--bg-2)', color: 'var(--text)', fontSize: '0.9rem', cursor: 'pointer' }}>⇅</button>
        {chainBox('to')}

        <div>
          <label style={label}>{T("Amount (USDC)")}</label>
          <input type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} style={field} />
        </div>

        {dir === 'out' && tradingAddr && address && (
          <div style={{ display: 'flex', gap: 6 }}>
            {[true, false].map(v => (
              <button key={String(v)} onClick={() => setFromTradingPref(v)} style={{
                flex: 1, padding: '6px 6px', borderRadius: 7, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${fromTradingPref === v ? 'var(--adx-accent)' : 'var(--adx-card-border)'}`,
                background: fromTradingPref === v ? 'rgba(59,130,246,0.15)' : 'var(--bg-2)', color: fromTradingPref === v ? 'var(--adx-accent)' : 'var(--text-muted)',
              }}>{v ? T('From trading wallet') : T('From connected wallet')}</button>
            ))}
          </div>
        )}

        <div>
          <label style={label}>{toSolana ? T("Solana address to receive") : dir === 'in' ? T("Receive on Arc at") : T("Recipient on {chain}", { chain: otherDef.label })}{' '}
            {!toSolana && <span style={{ opacity: 0.7 }}>{T("(optional)")}</span>}
          </label>
          <input placeholder={toSolana ? T("Solana address") : defaultRecipient || '0x…'} value={recipient} onChange={e => setRecipient(e.target.value.trim())} style={{ ...field, fontSize: '0.85rem' }} />
          {dir === 'in' && !recipient && tradingAddr && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 5 }}>{T("Arrives in your trading wallet, ready to trade.")}</div>}
          {recipient && !recipientOk && <div style={{ fontSize: '0.7rem', color: '#fca5a5', marginTop: 5 }}>{toSolana ? T("That isn't a Solana address.") : T("That isn't a valid address.")}</div>}
        </div>

        {fromTrading && recipientOk && <PasscodeField guard={guard} />}

        {n > 0 && (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {quote ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}><span>{T("Circle's fees (fast transfer + relayer)")}</span><span>{usd(quote.circleUsdc)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}><span>{T("ARCDEX fee ({pct}%, min $0.05)", { pct: (BRIDGE_FEE_BPS / 100).toFixed(2) })}</span><span>{usd(quote.platformUsdc)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{T("Leaves your wallet on {chain}", { chain: from === 'Arc' ? 'Arc' : otherDef.label })}</span><b>{usd(quote.debitUsdc)}</b></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green)' }}><span>{T("Arrives on {chain}", { chain: to === 'Arc' ? 'Arc' : otherDef.label })}</span><b>≈ {usd(quote.receiveUsdc)}</b></div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)' }}>{quoting ? T("Getting Circle's fees…") : T("Couldn't get a quote for this route right now.")}</div>
            )}
          </div>
        )}

        {errMsg && (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: '0.8rem', lineHeight: 1.45 }}>{errMsg}</div>
        )}

        {(busy || result) && (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result ? (
              <>
                <div style={{ fontWeight: 700, color: result.state === 'success' ? 'var(--green)' : 'var(--amber)' }}>{result.state === 'success' ? T("✓ Bridge complete") : T('State: {state}', { state: result.state })}</div>
                {result.steps.map((s, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--text-muted)' }}>
                      <span>{T(STEP[s.name] ?? s.name)}{s.forwarded ? T(" (auto via Circle relayer)") : ''}</span>
                      <span style={{ color: s.state === 'success' ? 'var(--green)' : s.state === 'error' ? 'var(--red)' : 'var(--text-muted)', flexShrink: 0 }}>
                        {s.explorerUrl && s.txHash ? <a href={s.explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{s.state}</a> : s.state}
                      </span>
                    </div>
                    {/* Why a step failed, in the kit's words (or ours for the common ones). */}
                    {s.state === 'error' && (s.errorMessage || s.error) ? <div style={{ color: '#fca5a5', fontSize: '0.72rem', marginTop: 2, wordBreak: 'break-word' }}>{txErrorText(s.error ?? new Error(s.errorMessage))}</div> : null}
                  </div>
                ))}
                {result.state !== 'success' && <button className="btn-ghost" onClick={() => void retry()} disabled={busy}>{T("Retry")}</button>}
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700 }}>{status === 'switching' ? T("Switching your wallet to {chain}…", { chain: from === 'Arc' ? 'Arc' : otherDef.label }) : fromTrading ? T("Sending from your trading wallet…") : T("Confirm in your wallet…")}</div>
                {progress.map(p => <div key={p} style={{ color: 'var(--green)' }}>✓ {T(STEP[p] ?? p)}</div>)}
                {progress.includes('burn') && !progress.includes('mint') && <div style={{ color: 'var(--text-muted)' }}>{T("Waiting for Circle's attestation (usually under a minute)…")}</div>}
              </>
            )}
          </div>
        )}

        {needsWallet ? (
          <button onClick={openConnectModal} style={{ padding: 11, borderRadius: 9, fontSize: '0.88rem', fontWeight: 700, background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%' }}>
            {dir === 'in' ? T('Connect the wallet holding your USDC') : T('Connect Wallet')}
          </button>
        ) : (
          <button onClick={() => void handleBridge()} disabled={!(n > 0) || !recipientOk || busy || tooSmall || passcodeMissing} style={{
            padding: 11, borderRadius: 9, fontSize: '0.88rem', fontWeight: 700, background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
            opacity: !(n > 0) || !recipientOk || busy || tooSmall || passcodeMissing ? 0.5 : 1,
          }}>
            {busy ? T("Bridging…") : tooSmall ? T("Amount too small to cover Circle's fees")
              : dir === 'in' ? T('Deposit {amount} USDC to Arc', { amount: n > 0 ? amount : '' }).replace('  ', ' ') : T('Send {amount} USDC to {chain}', { amount: n > 0 ? amount : '', chain: otherDef.label }).replace('  ', ' ')}
          </button>
        )}

        <p className="swap-note">
          {dir === 'in'
            ? T("You sign on {chain} (approve + burn). Circle's relayer then mints your USDC on Arc automatically — no Arc gas, usually under a minute.", { chain: otherDef.label })
            : T("You sign on Arc (approve + burn). Circle's relayer then mints your USDC on {chain} automatically — no network switch, usually under a minute.", { chain: otherDef.label })}
        </p>
      </div>
    </div>
  )
}
