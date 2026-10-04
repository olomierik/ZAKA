// Buy or sell a Solana coin from ARCDEX (lib/relay.ts, 2026-10-04).
//
// Buy: pay USDC on Arc (signed on Arc: the trading wallet trades at once); the coin lands in the Solana wallet in about
// a second, with Solana's fees paid by Relay. Sell: signed on Solana by the wallet holding the coin (the trading wallet's
// own Solana key, or Phantom/Solflare/Backpack), a fraction of a cent of SOL in fees (added in one tap from Arc's USDC);
// the USDC lands on Arc. ARCDEX's fee (the swap router's, 2%) is Relay's app fee, in USDC.

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { PasscodeField, useWithdrawGuard } from './WithdrawGuard'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { useRouterInfo, pct } from '../lib/routerInfo'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER, FEE_WALLET } from '../lib/platform'
import { solBalance, solTokenBalance, solTx, solAccount, SELL_GAS_SOL, type SolHolding } from '../lib/solana'
import { connectSolanaWallet, disconnectSolanaWallet, pickSolSigner, useSolanaWallets, type SolanaWallets, type SolSigner } from '../lib/solanaWallet'
import { getRelayQuote, QUOTE_LIMITS, quoteVerdict, relayValue, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayBuy, runRelaySell, type RelayProgress } from '../lib/relay'
import { t as T } from '../lib/i18n'
import { ed25519 } from '@noble/curves/ed25519'
import { base58 } from '../../../api/_solCore'

interface Props {
  mint: string
  symbol: string
  decimals: number | null
  priceUsd: number
  side?: 'buy' | 'sell'
  initialMode?: 'buy' | 'sell'
  compact?: boolean
  /** Why this coin can't be bought here (not from a launchpad, or its mint is dangerous); selling stays open. */
  buyBlocked?: string
  onTraded?: () => void
}

const GAS_RESERVE = 0.15
/** The SOL top-up: $0.50 of USDC on Arc → SOL, a hundred sales' fees. */
const GAS_TOPUP = 0.5
const GAS_TOPUP_UNITS = 500_000n
const BUY_PRESETS = [5, 10, 25, 50]
const SELL_PRESETS = [25, 50, 100]

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const arcTx = (h: string) => `${ARC_EXPLORER}/tx/${h}`
const fmtTimes = (r: number) => (r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1))
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
/** A valid Solana address for quotes shown before a Solana wallet is there: never sent to. */
const QUOTE_ONLY_SOL = base58(ed25519.getPublicKey(new Uint8Array(32).fill(7)))

type Step = 'idle' | 'working' | 'done' | 'error'

export default function SolanaTrade({ mint, symbol, decimals, priceUsd, side, initialMode, compact, buyBlocked, onTraded }: Props) {
  const trader = useTrader()
  const me = trader.address
  const sol = useSolanaWallets()
  const info = useRouterInfo()
  const feeBps = info?.feeBps ?? 200
  const [mode, setMode] = useState<'buy' | 'sell'>(side ?? initialMode ?? 'buy')
  const signer = solSignerOf(sol, trader.kind)
  const solAddr = signer === 'trading' ? sol.trading : signer === 'external' ? sol.external?.address ?? null : null
  // The trading wallet's passcode rule (lib/funding.ts): a buy or SOL top-up it pays for, delivered to a Solana wallet app
  // rather than its own Solana address, is money leaving it, so it asks for the passcode (someone with the unlocked
  // browser could otherwise connect their own wallet app and buy into it).
  const elsewhere = trader.kind === 'trading-wallet' && signer === 'external'
  const guard = useWithdrawGuard(trader, elsewhere ? solAddr ?? '' : '')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<RelayQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [progress, setProgress] = useState<RelayProgress | null>(null)
  const [msg, setMsg] = useState('')
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [costOk, setCostOk] = useState(false)
  const [topUp, setTopUp] = useState(true)
  const { cash, refresh: refreshCash } = useCash(me)
  const [holding, setHolding] = useState<SolHolding | null>(null)
  const [solBal, setSolBal] = useState<number | null>(null)
  const busy = step === 'working'

  const refreshSol = useCallback(() => {
    if (!solAddr) { setHolding(null); setSolBal(null); return }
    void solTokenBalance(solAddr, mint).then(setHolding).catch(() => {})
    void solBalance(solAddr).then(setSolBal).catch(() => {})
  }, [solAddr, mint])
  useEffect(() => {
    refreshSol()
    const id = setInterval(() => { if (!document.hidden) refreshSol() }, 15_000)
    const off = onBalances(refreshSol)
    return () => { clearInterval(id); off() }
  }, [refreshSol])

  const dec = holding?.decimals ?? decimals ?? 6
  const amountNum = Number(amount) || 0
  const amountIn = (() => {
    if (!(amountNum > 0)) return 0n
    try { return parseUnits(amount, mode === 'buy' ? 6 : dec) } catch { return 0n }
  })()
  const needsGas = !!solAddr && solBal !== null && solBal < SELL_GAS_SOL
  const willTopUp = mode === 'buy' && needsGas && topUp
  const reserve = GAS_RESERVE + (willTopUp ? GAS_TOPUP : 0)
  const maxBuy = cash !== null ? Math.max(0, cash - reserve) : null
  const insufficient = mode === 'buy'
    ? !!me && cash !== null && amountNum > 0 && amountNum + reserve > cash + 1e-9
    : holding !== null && amountIn > holding.raw

  const request = useCallback((): RelayRequest | null => (amountIn > 0n
    // Without a wallet the quote is only shown: it's asked for the fee wallet and a placeholder Solana address, never sent.
    ? { side: mode, mint, amount: amountIn, evm: me ?? FEE_WALLET, sol: solAddr ?? QUOTE_ONLY_SOL, feeBps }
    : null), [amountIn, mode, mint, me, solAddr, feeBps])

  const seq = useRef(0)
  useEffect(() => {
    if (busy) return
    setQuote(null); setQuoteErr(''); setCostOk(false)
    const r = request()
    // A sale can only be quoted for the wallet that holds the coin.
    if (!r || (mode === 'sell' && !solAddr)) return
    const n = ++seq.current
    const ask = () => {
      setQuoting(true)
      getRelayQuote(r)
        .then(q => { if (seq.current === n) { setQuote(q); setQuoteErr('') } })
        .catch(e => { if (seq.current === n) { setQuote(null); setQuoteErr(relayErrorText(e)) } })
        .finally(() => { if (seq.current === n) setQuoting(false) })
    }
    const first = setTimeout(ask, 500)
    const again = setInterval(() => { if (!document.hidden) ask() }, 20_000)
    return () => { clearTimeout(first); clearInterval(again) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, mode, mint, me, solAddr, feeBps, busy])

  const outAmount = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minAmount = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const outUsd = mode === 'buy' ? outAmount * priceUsd : outAmount
  const value = quote ? relayValue(quote, amountNum, priceUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const needsCostTick = verdict === 'confirm' || verdict === 'unpriced'

  const noBuy = mode === 'buy' && !!buyBlocked
  const sellNoGas = mode === 'sell' && solBal !== null && solBal < 0.0003
  const missing = !me ? 'evm' : !solAddr ? 'sol' : null
  const passcodeMissing = guard.needsPasscode && mode === 'buy' && !guard.passcode
  const blocked = busy || !!missing || !quote || quoting || insufficient || refused || noBuy || (needsCostTick && !costOk) || sellNoGas || passcodeMissing

  const kind = trader.kind ?? 'wallet'

  async function topUpGas(): Promise<{ ok: boolean; text: string }> {
    if (!me || !solAddr) return { ok: false, text: '' }
    const r = await runRelayBuy(kind, { side: 'gas', mint: '', amount: GAS_TOPUP_UNITS, evm: me, sol: solAddr, feeBps: 0 }, null, () => {})
    setLinks(l => [...l, { label: T('SOL transaction'), href: arcTx(r.tx) }])
    refreshSol(); refreshCash()
    return r.status === 'filled' ? { ok: true, text: T('SOL added: you can sell on Solana now.') }
      : r.status === 'pending' ? { ok: true, text: T('The SOL is still on its way: it lands by itself.') }
      : { ok: false, text: T('Relay couldn’t deliver the SOL: your USDC was refunded on Arc.') }
  }

  async function addGas() {
    setStep('working'); setLinks([]); setMsg(T('Adding ${n} of SOL on Solana…', { n: GAS_TOPUP.toFixed(2) }))
    try { await guard.confirm(); const g = await topUpGas(); setStep(g.ok ? 'done' : 'error'); setMsg(g.text) }
    catch (e) { setStep('error'); setMsg(relayErrorText(e)) }
  }

  async function submit() {
    const r = request()
    if (!r || !me || !solAddr || !signer || !quote) return
    setStep('working'); setLinks([]); setProgress(null)
    const say = (p: RelayProgress) => {
      setProgress(p)
      setMsg(p.step === 'quote' ? T('Checking the trade…')
        : p.step === 'approve' ? T('Approving exactly {n} USDC…', { n: amount })
        : p.step === 'sign' ? (signer === 'external' ? T('Confirm the sale in {wallet}…', { wallet: sol.external?.name ?? 'your wallet' }) : T('Signing…'))
        : p.step === 'send' ? T('Sending…')
        : p.step === 'deliver' ? (mode === 'buy' ? T('On its way to your Solana wallet…') : T('On its way to Arc…'))
        : T('Done'))
    }
    try {
      if (mode === 'buy') await guard.confirm()
      const res = mode === 'buy' ? await runRelayBuy(kind, r, quote, say) : await runRelaySell(signer, r, quote, say)
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      const out = mode === 'buy' ? `${fmtTok(got)} ${symbol}` : fmtUsd(got)
      const l = [{ label: mode === 'buy' ? T('Arc transaction') : T('Solana transaction'), href: mode === 'buy' ? arcTx(res.tx) : solTx(res.tx) }]
      if (res.outTx) l.push({ label: T('Delivered'), href: mode === 'buy' ? solTx(res.outTx) : arcTx(res.outTx) })
      setLinks(l)
      if (res.status === 'filled') {
        const done = mode === 'buy' ? T('Bought ≈{out}: it’s in your Solana wallet.', { out }) : T('Sold: ≈{out} USDC is back on Arc.', { out })
        setAmount('')
        onTraded?.()
        if (willTopUp) {
          setMsg(`${done} ${T('Adding SOL…')}`)
          const g = await topUpGas().catch(e => ({ ok: false, text: relayErrorText(e) }))
          setMsg(`${done} ${g.text}`)
        } else setMsg(done)
        setStep('done')
      } else if (res.status === 'pending') {
        setStep('done'); setMsg(T('Still on its way: it lands by itself in a few minutes.'))
      } else {
        setStep('error')
        setMsg(mode === 'buy' ? T('Relay couldn’t fill this buy: your USDC was refunded on Arc.') : T('Relay couldn’t fill this sale: it was refunded on Solana.'))
      }
      refreshSol(); refreshCash()
    } catch (e) {
      setStep('error'); setMsg(relayErrorText(e))
    } finally {
      setProgress(null)
    }
  }

  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (progress?.step === 'approve' ? T('Approving…') : progress?.step === 'deliver' ? T('Delivering…') : mode === 'buy' ? T('Buying…') : T('Selling…'))
    : quoting && !quote ? T('Getting a quote…')
    : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol })

  return (
    <div className={`swap-box${side ? ` swap-side-${side}` : ''}`}>
      {!side && (
        <div className="rh-modes">
          {(['buy', 'sell'] as const).map(m => (
            <button key={m} className={mode === m ? `on ${m}` : ''} onClick={() => { if (!busy) { setMode(m); setAmount(''); setStep('idle'); setMsg(''); setLinks([]) } }}>
              {m === 'buy' ? T('Buy') : T('Sell')} {symbol}
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="rh-field-head">
          <span>{mode === 'buy' ? T('You pay (USDC on Arc)') : T('You sell ({symbol})', { symbol })}</span>
          {mode === 'buy'
            ? me && cash !== null && <button className="link-btn" onClick={() => maxBuy !== null && setAmount(maxBuy > 0 ? maxBuy.toFixed(2) : '0')}>{T('Cash')}: {fmtUsd(cash)}</button>
            : holding !== null && <button className="link-btn" onClick={() => setAmount(formatUnits(holding.raw, holding.decimals))}>{T('Holding')}: {fmtTok(holding.amount)}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder={mode === 'buy' ? '$0' : '0'} value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (step !== 'working') { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {mode === 'buy'
            ? BUY_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>)
            : SELL_PRESETS.map(p => <button key={p} disabled={busy || !holding} onClick={() => holding && setAmount(formatUnits((holding.raw * BigInt(p)) / 100n, holding.decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? (mode === 'buy' ? `${fmtTok(outAmount)} ${symbol}` : `${fmtUsd(outAmount)} USDC`) : quoting ? '…' : '—'}
          sub={quote && mode === 'buy' && priceUsd > 0 && verdict !== 'off-market' ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        <Row label={T('Minimum received')} value={quote ? (mode === 'buy' ? `${fmtTok(minAmount)} ${symbol}` : `${fmtUsd(minAmount)} USDC`) : '—'} />
        <Row label={T('Platform fee')} value={T('{pct} (in USDC)', { pct: pct(feeBps) })} />
        <Row label={T('Bridge & delivery (Relay)')} value={quote ? fmtUsd(quote.relayFeeUsd) : '—'} />
        {value && <Row label={T('Price impact')} value={verdict === 'off-market' ? T('{x}× the market price', { x: fmtTimes(value.rate) }) : impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`}
          color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : impactPct! >= 5 ? 'var(--amber)' : 'var(--green)'} />}
        {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} color={cost! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : cost! >= 6 ? 'var(--amber)' : undefined} />}
        <Row label={T('Arrives')} value={quote ? (mode === 'buy' ? T('on Solana in ~{s}s', { s: Math.max(2, quote.fillSeconds) }) : T('on Arc in ~{s}s', { s: Math.max(2, quote.fillSeconds) })) : '—'} />
      </div>

      {quoteErr && !busy && <div className="rh-msg error">{quoteErr}</div>}
      {verdict === 'off-market' && !busy && (
        <div className="rh-msg error">{T('This quote pays {x}× {symbol}’s market price: the route goes through a pool priced far off the market, the way trap pools catch trades. ARCDEX won’t send it.', { x: fmtTimes(value!.rate), symbol })}</div>
      )}
      {verdict === 'refuse' && !busy && (
        <div className="rh-msg error">{T('The best route loses {n}% of this trade to price impact, so ARCDEX won’t send it. A smaller amount may route better.', { n: impactPct!.toFixed(0) })}</div>
      )}
      {needsCostTick && (
        <label className="rh-tick warn">
          <input type="checkbox" checked={costOk} onChange={e => setCostOk(e.target.checked)} />
          {verdict === 'unpriced' ? T('I understand this quote can’t be checked against a market price.')
            : T('I understand this trade costs {n}% in fees and price impact.', { n: Math.max(cost!, impactPct!).toFixed(1) })}
        </label>
      )}

      {mode === 'buy' && needsGas && (
        <label className="rh-tick">
          <input type="checkbox" checked={topUp} disabled={busy} onChange={e => setTopUp(e.target.checked)} />
          {T('Also add ${n} of SOL for fees on Solana, so you can sell later.', { n: GAS_TOPUP.toFixed(2) })}
        </label>
      )}
      {mode === 'sell' && needsGas && me && (
        <div className="rh-gas">
          <span>{T('Selling is signed on Solana, where fees are paid in SOL (a fraction of a cent a sale).')}</span>
          <button className="mk-trade mk-trade-solid mk-trade-sm" disabled={busy} onClick={() => void addGas()}>{T('Add ${n} of SOL', { n: GAS_TOPUP.toFixed(2) })}</button>
        </div>
      )}
      {noBuy && <div className="rh-msg error">{buyBlocked}</div>}
      {guard.needsPasscode && (mode === 'buy' || needsGas) && <PasscodeField guard={guard} />}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {missing === 'evm' ? (
        <>
          <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
          <Note>{T('Or unlock your')}{' '}<button className="link-btn" onClick={openTradingWallet}>{T('trading wallet')}</button>{' '}{T('for one-tap trades with no pop-ups. It has a Solana address too.')}</Note>
        </>
      ) : missing === 'sol' ? (
        <>
          <button className="rh-btn" onClick={openTradingWallet}>{T('Unlock your trading wallet')}</button>
          {sol.available.length > 0 && (
            <Note>{T('Or connect')}{' '}{sol.available.map((w, i) => <span key={w}>{i > 0 && ' · '}<button className="link-btn" onClick={() => void connectSolanaWallet(w).catch(e => { setStep('error'); setMsg(relayErrorText(e)) })}>{w}</button></span>)}</Note>
          )}
        </>
      ) : (
        <button className={`rh-btn ${mode}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>
      )}

      {solAddr && !compact && <SolanaWalletBar solBal={solBal} />}
      {!compact && <p className="swap-note">{SOL_NOTE()}</p>}
    </div>
  )
}

/** Which Solana wallet trades: the one picked, else the trading wallet's when the trading wallet trades, else the app's. */
export function solSignerOf(sol: SolanaWallets, kind: string | null | undefined): SolSigner | null {
  if (sol.picked === 'trading' && sol.trading) return 'trading'
  if (sol.picked === 'external' && sol.external) return 'external'
  return kind === 'trading-wallet' && sol.trading ? 'trading' : sol.external ? 'external' : sol.trading ? 'trading' : null
}

/** The Solana wallet in use, its SOL, and the way to switch or connect one (above the forms, and in the trade sheet). */
export function SolanaWalletBar({ solBal }: { solBal?: number | null }) {
  const trader = useTrader()
  const sol = useSolanaWallets()
  const signer = solSignerOf(sol, trader.kind)
  const addr = signer === 'trading' ? sol.trading : signer === 'external' ? sol.external?.address ?? null : null
  const [bal, setBal] = useState<number | null>(null)
  useEffect(() => {
    if (solBal !== undefined || !addr) return
    let live = true
    const read = () => solBalance(addr).then(b => { if (live) setBal(b) }).catch(() => {})
    void read()
    const off = onBalances(read)
    return () => { live = false; off() }
  }, [addr, solBal])
  const sb = solBal !== undefined ? solBal : bal
  const connect = (w: string) => void connectSolanaWallet(w).then(() => pickSolSigner('external')).catch(() => {})
  if (!addr) return (
    <div className="swap-note sol-wallet-line">
      {T('Solana wallet')}: <button className="link-btn" onClick={openTradingWallet}>{T('trading wallet')}</button>
      {sol.available.map(w => <span key={w}> · <button className="link-btn" onClick={() => connect(w)}>{w}</button></span>)}
    </div>
  )
  return (
    <div className="swap-note sol-wallet-line">
      {T('Solana wallet')}: {signer === 'trading' ? T('⚡ trading wallet') : sol.external?.name}{' '}
      <a href={solAccount(addr)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)' }}>{short(addr)}</a>
      {sb !== null && <> · SOL {sb < 0.0001 ? '0' : sb.toPrecision(2)}</>}
      {sol.trading && sol.external && <> · <button className="link-btn" onClick={() => pickSolSigner(signer === 'trading' ? 'external' : 'trading')}>{T('Use {w}', { w: signer === 'trading' ? sol.external.name : T('trading wallet') })}</button></>}
      {signer === 'external' && <> · <button className="link-btn" onClick={() => void disconnectSolanaWallet()}>{T('Disconnect')}</button></>}
      {!sol.external && signer === 'trading' && sol.available.map(w => <span key={w}> · <button className="link-btn" onClick={() => connect(w)}>{T('Connect {w}', { w })}</button></span>)}
    </div>
  )
}

/** The note under the trade forms. */
export const SOL_NOTE = () => T('Bought with USDC on Arc and delivered to your Solana wallet by Relay; sales come back as USDC on Arc. Every trade is checked and simulated before it’s sent, and approvals are for the exact amount.')

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', color }}>{value}{sub && <small style={{ display: 'block', color: 'var(--text-muted)' }}>{sub}</small>}</span>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 8, borderRadius: 8, fontSize: '0.74rem', background: 'var(--bg-2)', border: '1px dashed var(--adx-card-border)', color: 'var(--text-muted)', textAlign: 'center' }}>{children}</div>
}
