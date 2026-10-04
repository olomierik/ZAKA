import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { isAddress, type EIP1193Provider } from 'viem'
import type { BridgeChain, BridgeResult } from '@circle-fin/bridge-kit'
import { openConnectModal } from '../components/ConnectWallet'
import { kit, getBridgeAdapter, tradingWalletAdapter, ensureWalletChain, quoteBridge, BRIDGE_CHAINS, BRIDGE_FEE_BPS, type BridgeQuote } from '../lib/bridgeKit'
import { useEmbeddedAddress } from '../lib/identity'
import { PasscodeField, useWithdrawGuard } from '../components/WithdrawGuard'
import { addBridgeDeposit } from '../lib/funding'
import { t as T } from '../lib/i18n'
import { promptWallet, txErrorText } from '../lib/tx'
import { ChainIcon, ChainPicker, ChainStrip, UsdcIcon } from '../components/Chains'
import { COIN_PAGE } from '../components/NavBar'
import type { Page } from '../App'
import { hideWalletPrompt } from '../lib/walletPrompt'

type Dir = 'out' | 'in'
type Adapter = Awaited<ReturnType<typeof getBridgeAdapter>> | ReturnType<typeof tradingWalletAdapter>

const isSolanaAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
/** Bridge Kit's step names, in words. */
const STEP: Record<string, string> = {
  approve: 'Approved USDC', burn: 'Burned on the source chain', fetchAttestation: 'Circle attested the transfer', mint: 'Minted on the destination',
}


export default function Bridge({ initialDir = 'out', navigate }: { initialDir?: Dir; navigate?: (p: Page) => void }) {
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

  /** USDC burned elsewhere and minted to the trading wallet on Arc: the
   * wallet that burned it funded the trading wallet (lib/funding.ts). */
  function noteDeposit(res: BridgeResult) {
    const burn = res.steps.find(s => s.name === 'burn' && s.state === 'success' && s.txHash)
    const recipient = (res.destination.recipientAddress ?? res.destination.address).toLowerCase()
    if (!burn?.txHash || !tradingAddr || res.destination.chain.chain !== 'Arc' || recipient !== tradingAddr.toLowerCase()) return
    const mint = res.steps.find(s => s.name === 'mint' && s.state === 'success')
    void addBridgeDeposit(tradingAddr, { from: res.source.address, usd: Number(res.amount), burnTx: burn.txHash, mintTx: mint?.txHash })
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
      noteDeposit(res)
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
      noteDeposit(res)
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
  const STEPS = ['approve', 'burn', 'fetchAttestation', 'mint']
  const stepState = (name: string) => {
    const r = result?.steps.find(x => x.name === name)
    if (r) return r.state === 'success' ? 'done' : r.state === 'error' ? 'bad' : 'now'
    if (progress.includes(name)) return 'done'
    const next = STEPS.find(x => !progress.includes(x))
    return busy && next === name ? 'now' : 'todo'
  }
  const otherOptions = choices.map(c => c.chain as string)
  const pickOther = (c: string) => setOther(c as BridgeChain)
  const actionLabel = busy ? T("Bridging…") : tooSmall ? T("Amount too small to cover Circle's fees")
    : dir === 'in' ? T('Deposit {amount} USDC to Arc', { amount: n > 0 ? amount : '' }).replace('  ', ' ') : T('Send {amount} USDC to {chain}', { amount: n > 0 ? amount : '', chain: otherDef.label }).replace('  ', ' ')

  return (
    <div className="xs-page">
      <div className="xs-head">
        <h1>{T("Bridge")}</h1>
        <p>{T('Native USDC between Arc and {n} networks, with Circle’s CCTP: no wrapped tokens, no third-party bridge, usually under a minute.', { n: BRIDGE_CHAINS.length })}</p>
        <ChainStrip size={24} onPick={c => { if (dir === 'in' && !BRIDGE_CHAINS.find(x => x.chain === c)?.evm) return; pickOther(c) }} />
      </div>

      <div className="xs-grid">
        <div className="xs-main">
          <div className="xs-card">
            <div className="xs-tabs">
              {(['in', 'out'] as const).map(d => (
                <button key={d} className={dir === d ? 'active' : ''} onClick={() => { if (d !== dir) flip() }}>{d === 'in' ? T('Deposit to Arc') : T('Send from Arc')}</button>
              ))}
            </div>

            <div className="xs-box">
              <div className="xs-box-h">
                <span>{T('From')}</span>
                <ChainPicker value={from} options={otherOptions} onChange={pickOther} fixed={dir === 'out'} />
              </div>
              <div className="xs-amount">
                <input type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T("Amount (USDC)")} />
                <span className="xs-token"><UsdcIcon size={22} />USDC</span>
              </div>
              <div className="xs-box-f">{sender ? <>{fromTrading ? T('From trading wallet') : T('From connected wallet')} · <span className="xs-mono">{sender.slice(0, 6)}…{sender.slice(-4)}</span></> : T('Connect a wallet to see your balance')}</div>
            </div>

            <button className="xs-flip" onClick={flip} aria-label={T("Swap direction")}>⇅</button>

            <div className="xs-box">
              <div className="xs-box-h">
                <span>{T('To')}</span>
                <ChainPicker value={to} options={otherOptions} onChange={pickOther} fixed={dir === 'in'} />
              </div>
              <div className="xs-amount xs-amount-out">
                <b>{quote ? `≈ ${quote.receiveUsdc.toFixed(2)}` : n > 0 && quoting ? '…' : '0.00'}</b>
                <span className="xs-token"><UsdcIcon size={22} />USDC</span>
              </div>
              <div className="xs-box-f">{T('You receive')} · {T('about a minute')}</div>
            </div>

            {dir === 'out' && tradingAddr && address && (
              <div className="xs-seg">
                {[true, false].map(v => (
                  <button key={String(v)} className={fromTradingPref === v ? 'active' : ''} onClick={() => setFromTradingPref(v)}>{v ? T('From trading wallet') : T('From connected wallet')}</button>
                ))}
              </div>
            )}

            <label className="xs-field">
              <span>{toSolana ? T("Solana address to receive") : dir === 'in' ? T("Receive on Arc at") : T("Recipient on {chain}", { chain: otherDef.label })}{' '}{!toSolana && <em>{T("(optional)")}</em>}</span>
              <input placeholder={toSolana ? T("Solana address") : defaultRecipient || '0x…'} value={recipient} onChange={e => setRecipient(e.target.value.trim())} />
              {dir === 'in' && !recipient && tradingAddr && <small>{T("Arrives in your trading wallet, ready to trade.")}</small>}
              {recipient && !recipientOk && <small className="bad">{toSolana ? T("That isn't a Solana address.") : T("That isn't a valid address.")}</small>}
            </label>

            {fromTrading && recipientOk && <PasscodeField guard={guard} />}

            {n > 0 && (
              <div className="xs-quote">
                {quote ? (
                  <>
                    <div><span>{T("Circle's fees (fast transfer + relayer)")}</span><span>{usd(quote.circleUsdc)}</span></div>
                    <div><span>{T("ARCDEX fee ({pct}%, min $0.05)", { pct: (BRIDGE_FEE_BPS / 100).toFixed(2) })}</span><span>{usd(quote.platformUsdc)}</span></div>
                    <div><span>{T("Leaves your wallet on {chain}", { chain: from === 'Arc' ? 'Arc' : otherDef.label })}</span><b>{usd(quote.debitUsdc)}</b></div>
                    <div className="good"><span>{T("Arrives on {chain}", { chain: to === 'Arc' ? 'Arc' : otherDef.label })}</span><b>≈ {usd(quote.receiveUsdc)}</b></div>
                    <div><span>{T('Route')}</span><span>Circle CCTP v2</span></div>
                  </>
                ) : (
                  <div><span>{quoting ? T("Getting Circle's fees…") : T("Couldn't get a quote for this route right now.")}</span></div>
                )}
              </div>
            )}

            {errMsg && <div className="xs-error">{errMsg}</div>}

            {(busy || result) && (
              <div className="xs-progress">
                <div className="xs-progress-h">
                  {result ? (result.state === 'success' ? T("✓ Bridge complete") : T('State: {state}', { state: result.state }))
                    : status === 'switching' ? T("Switching your wallet to {chain}…", { chain: from === 'Arc' ? 'Arc' : otherDef.label })
                    : fromTrading ? T("Sending from your trading wallet…") : T("Confirm in your wallet…")}
                </div>
                <div className="xs-stepper">
                  {STEPS.map(name => {
                    const st = stepState(name)
                    const r = result?.steps.find(x => x.name === name)
                    return (
                      <div key={name} className={`xs-step ${st}`}>
                        <span className="xs-step-dot">{st === 'done' ? '✓' : st === 'bad' ? '!' : ''}</span>
                        <span className="xs-step-label">
                          {T(STEP[name] ?? name)}{r?.forwarded ? T(" (auto via Circle relayer)") : ''}
                          {r?.explorerUrl && r.txHash && <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer"> ↗</a>}
                          {r?.state === 'error' && (r.errorMessage || r.error) ? <small>{txErrorText(r.error ?? new Error(r.errorMessage))}</small> : null}
                        </span>
                      </div>
                    )
                  })}
                </div>
                {!result && progress.includes('burn') && !progress.includes('mint') && <div className="xs-fine">{T("Waiting for Circle's attestation (usually under a minute)…")}</div>}
                {result && result.state !== 'success' && <button className="btn-ghost" onClick={() => void retry()} disabled={busy}>{T("Retry")}</button>}
              </div>
            )}

            {needsWallet ? (
              <button className="btn-primary xs-go" onClick={openConnectModal}>
                {dir === 'in' ? T('Connect the wallet holding your USDC') : T('Connect Wallet')}
              </button>
            ) : (
              <button className="btn-primary xs-go" onClick={() => void handleBridge()} disabled={!(n > 0) || !recipientOk || busy || tooSmall || passcodeMissing}>
                {actionLabel}
              </button>
            )}

            <p className="xs-fine">
              {dir === 'in'
                ? T("You sign on {chain} (approve + burn). Circle's relayer then mints your USDC on Arc automatically — no Arc gas, usually under a minute.", { chain: otherDef.label })
                : T("You sign on Arc (approve + burn). Circle's relayer then mints your USDC on {chain} automatically — no network switch, usually under a minute.", { chain: otherDef.label })}
            </p>
          </div>
        </div>

        <aside className="xs-side">
          <div className="xs-panel">
            <b>{T('Why bridge with ARCDEX')}</b>
            <ul className="xs-why">
              <li><span>◎</span><div><b>{T('Native USDC')}</b><small>{T('Burned on one chain, minted on the other by Circle: no wrapped tokens, no pools.')}</small></div></li>
              <li><span>⚡</span><div><b>{T('About a minute')}</b><small>{T('Fast transfers, and Circle’s relayer mints for you: no gas needed on arrival.')}</small></div></li>
              <li><span>⇄</span><div><b>{T('{n} networks', { n: BRIDGE_CHAINS.length + 1 })}</b><small>{T('Ethereum, Base, Arbitrum, Optimism, Polygon, Solana and more, to and from Arc.')}</small></div></li>
              <li><span>✓</span><div><b>{T('Fees shown first')}</b><small>{T('Circle’s fees and ours are quoted before you sign: what leaves and what arrives.')}</small></div></li>
            </ul>
          </div>
          <div className="xs-panel">
            <b>{T('Supported networks')}</b>
            <div className="xs-nets">
              {BRIDGE_CHAINS.map(c => {
                const usable = dir === 'out' || c.evm
                return (
                  <button key={c.chain} className={`xs-net-item${c.chain === other ? ' active' : ''}`} disabled={!usable} onClick={() => pickOther(c.chain)} title={usable ? c.label : T('Solana can receive USDC from Arc; sending from it needs a Solana wallet.')}>
                    <ChainIcon chain={c.chain} size={22} /><span>{c.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="xs-panel">
            <b>{T('On Arc? Start trading')}</b>
            <p>{T('USDC on Arc trades every coin on ARCDEX, spot and futures.')}</p>
            <div className="xs-row-btns">
              <a className="btn-ghost" href="/app" onClick={e => { if (navigate) { e.preventDefault(); navigate({ name: 'terminal' }) } }}>{T('Markets')}</a>
              <a className="btn-primary" href="/spot" onClick={e => { if (navigate) { e.preventDefault(); navigate(COIN_PAGE) } }}>{T('Buy $ARCDEX')}</a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
