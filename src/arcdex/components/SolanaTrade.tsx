// Buy or sell a Solana coin from ARCDEX (lib/relay.ts, 2026-10-04).
//
// Pay with (or, selling, be paid in):
//   • USDC on Arc: signed on Arc (the trading wallet trades at once); the coin lands in the Solana wallet in about a
//     second, with Solana's fees paid by Relay. A sale is signed on Solana and its USDC lands on Arc.
//   • SOL, or USDC on Solana (2026-10-05, owner: "users with Solana wallets can't buy"): a swap on Solana alone, signed
//     by the Solana wallet (Phantom/Solflare/Backpack, or the trading wallet's own Solana key). No Arc wallet needed.
// ARCDEX's fee (the swap router's, 2%) is Relay's app fee.

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
import { solBalance, solTokenBalance, solTx, solAccount, SELL_GAS_SOL, SOL_USDC, type SolHolding } from '../lib/solana'
import { connectSolanaWallet, disconnectSolanaWallet, pickSolSigner, useSolanaWallets, type SolanaWallets, type SolSigner } from '../lib/solanaWallet'
import { getRelayQuote, QUOTE_LIMITS, quoteVerdict, relayValue, relayValueUsd, SOL_NATIVE, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayEvm, runRelaySolana, type RelayProgress } from '../lib/relay'
import { solUsd } from '../api/solanaMarket'
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

/** What a trade pays with (a buy) or is paid in (a sale): USDC on Arc, SOL, or USDC on Solana. */
type Route = 'arc' | 'sol' | 'usdc'
const ROUTE_LABEL: Record<Route, string> = { arc: 'USDC on Arc', sol: 'SOL', usdc: 'USDC (Solana)' }
const SOL_PRESETS = [0.05, 0.1, 0.25, 0.5]
/** SOL kept back when paying with SOL: a trade's fees and a token account. */
const SOL_RESERVE = 0.01

export default function SolanaTrade({ mint, symbol, decimals, priceUsd, side, initialMode, compact, buyBlocked, onTraded }: Props) {
  const trader = useTrader()
  const me = trader.address
  const sol = useSolanaWallets()
  const info = useRouterInfo()
  const feeBps = info?.feeBps ?? 200
  const [mode, setMode] = useState<'buy' | 'sell'>(side ?? initialMode ?? 'buy')
  const signer = solSignerOf(sol, trader.kind)
  const solAddr = signer === 'trading' ? sol.trading : signer === 'external' ? sol.external?.address ?? null : null
  // A Solana wallet app trades with its own SOL by default (2026-10-05: its users had no way to buy without an Arc
  // wallet); the trading wallet with USDC on Arc.
  const [picked, setPicked] = useState<Route | null>(null)
  const route: Route = picked ?? (signer === 'external' || !me ? 'sol' : 'arc')
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
  const [usdcSol, setUsdcSol] = useState<SolHolding | null>(null)
  const [solBal, setSolBal] = useState<number | null>(null)
  const [solPrice, setSolPrice] = useState(0)
  const busy = step === 'working'

  // SOL's dollar price, asked again every 30s until GeckoTerminal answers.
  useEffect(() => {
    if (solPrice > 0) return
    void solUsd().then(setSolPrice)
    const id = setInterval(() => { void solUsd().then(setSolPrice) }, 30_000)
    return () => clearInterval(id)
  }, [solPrice])

  // The passcode rule (lib/funding.ts): a buy the trading wallet pays for on Arc, delivered to a Solana wallet app rather
  // than its own Solana address, is money leaving it.
  const elsewhere = route === 'arc' && trader.kind === 'trading-wallet' && signer === 'external'
  const guard = useWithdrawGuard(trader, elsewhere ? solAddr ?? '' : '')

  const refreshSol = useCallback(() => {
    if (!solAddr) { setHolding(null); setSolBal(null); setUsdcSol(null); return }
    void solTokenBalance(solAddr, mint).then(setHolding).catch(() => {})
    void solTokenBalance(solAddr, SOL_USDC).then(setUsdcSol).catch(() => {})
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
  const inDecimals = mode === 'sell' ? dec : route === 'sol' ? 9 : 6
  const amountIn = (() => {
    if (!(amountNum > 0)) return 0n
    try { return parseUnits(amount, inDecimals) } catch { return 0n }
  })()
  const needsGas = !!solAddr && solBal !== null && solBal < SELL_GAS_SOL
  const willTopUp = mode === 'buy' && route === 'arc' && needsGas && topUp && !!me
  const reserve = GAS_RESERVE + (willTopUp ? GAS_TOPUP : 0)
  const maxIn = mode === 'sell' ? (holding ? Number(formatUnits(holding.raw, holding.decimals)) : null)
    : route === 'arc' ? (cash !== null ? Math.max(0, cash - reserve) : null)
    : route === 'sol' ? (solBal !== null ? Math.max(0, solBal - SOL_RESERVE) : null)
    : usdcSol ? usdcSol.amount : null
  const insufficient = amountNum > 0 && (mode === 'sell'
    ? holding !== null && amountIn > holding.raw
    : route === 'arc' ? !!me && cash !== null && amountNum + reserve > cash + 1e-9
    : route === 'sol' ? solBal !== null && amountNum + SOL_RESERVE > solBal + 1e-12
    : usdcSol !== null && amountIn > usdcSol.raw)

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n)) return null
    const base = { chain: 'solana' as const, mint, amount: amountIn, evm: me ?? FEE_WALLET, sol: solAddr ?? QUOTE_ONLY_SOL, feeBps }
    if (route === 'arc') return { ...base, side: mode }
    const other = route === 'sol' ? SOL_NATIVE : SOL_USDC
    return mode === 'buy' ? { ...base, side: 'swap', inToken: other, outToken: mint } : { ...base, side: 'swap', inToken: mint, outToken: other }
  }, [amountIn, mode, mint, me, solAddr, feeBps, route])

  const seq = useRef(0)
  useEffect(() => {
    if (busy) return
    setQuote(null); setQuoteErr(''); setCostOk(false)
    const r = request()
    // A sale needs the Solana wallet that holds the coin; a buy is quoted for a placeholder until one is connected.
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
  }, [amountIn, mode, mint, me, solAddr, feeBps, busy, route])

  // What it delivers, and its worth at the market: the coin at its price, SOL at SOL's, USDC at $1.
  const outAmount = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minAmount = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  // Without GeckoTerminal's SOL price, Relay's own dollar value for the SOL side (the coin is still valued at its market
  // price, so a trap route is still caught).
  const solRef = solPrice || (quote && route === 'sol' ? (mode === 'buy' ? (amountNum > 0 ? quote.inUsd / amountNum : 0) : (outAmount > 0 ? quote.outUsdRelay / outAmount : 0)) : 0)
  const unitUsd = (r: Route) => (r === 'sol' ? solRef : 1)
  const outUsd = mode === 'buy' ? outAmount * priceUsd : outAmount * unitUsd(route)
  const inputUsd = mode === 'buy' ? amountNum * unitUsd(route) : amountNum * priceUsd
  const value = !quote ? null
    : route === 'arc' ? relayValue(quote, amountNum, priceUsd)
    : priceUsd > 0 && (route !== 'sol' || solRef > 0) ? relayValueUsd(quote, inputUsd, outUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const needsCostTick = verdict === 'confirm' || verdict === 'unpriced'

  const noBuy = mode === 'buy' && !!buyBlocked
  // Solana's fees are SOL whichever way it pays: a sale, a swap with USDC, all need some.
  const noSolFees = (mode === 'sell' || route === 'usdc') && solBal !== null && solBal < 0.0003
  const missing: 'evm' | 'sol' | null = route === 'arc' ? (!me ? 'evm' : !solAddr ? 'sol' : null) : !solAddr ? 'sol' : null
  const passcodeMissing = guard.missing && route === 'arc' && mode === 'buy'
  const blocked = busy || !!missing || !quote || quoting || insufficient || refused || noBuy || (needsCostTick && !costOk) || noSolFees || passcodeMissing

  const kind = trader.kind ?? 'wallet'

  async function topUpGas(): Promise<{ ok: boolean; text: string }> {
    if (!me || !solAddr) return { ok: false, text: '' }
    const r = await runRelayEvm(kind, { side: 'gas', chain: 'solana', mint: '', amount: GAS_TOPUP_UNITS, evm: me, sol: solAddr, feeBps: 0 }, null, () => {})
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
    if (!r || !solAddr || !signer || !quote || (route === 'arc' && !me)) return
    setStep('working'); setLinks([]); setProgress(null)
    const say = (p: RelayProgress) => {
      setProgress(p)
      setMsg(p.step === 'quote' ? T('Checking the trade…')
        : p.step === 'approve' ? T('Approving exactly {n} USDC…', { n: amount })
        : p.step === 'sign' ? (signer === 'external' ? T('Confirm the trade in {wallet}…', { wallet: sol.external?.name ?? 'your wallet' }) : T('Signing…'))
        : p.step === 'send' ? T('Sending…')
        : p.step === 'deliver' ? (mode === 'buy' ? T('On its way to your Solana wallet…') : route === 'arc' ? T('On its way to Arc…') : T('Settling…'))
        : T('Done'))
    }
    try {
      if (route === 'arc' && mode === 'buy') await guard.confirm()
      const paidOnArc = route === 'arc' && mode === 'buy'
      const res = paidOnArc ? await runRelayEvm(kind, r, quote, say) : await runRelaySolana(signer, r, quote, say)
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      const out = mode === 'buy' ? `${fmtTok(got)} ${symbol}` : route === 'sol' ? `${fmtTok(got)} SOL` : `${fmtUsd(got)} USDC`
      const l = [{ label: paidOnArc ? T('Arc transaction') : T('Solana transaction'), href: paidOnArc ? arcTx(res.tx) : solTx(res.tx) }]
      if (res.outTx && res.outTx !== res.tx) l.push({ label: T('Delivered'), href: mode === 'sell' && route === 'arc' ? arcTx(res.outTx) : solTx(res.outTx) })
      setLinks(l)
      if (res.status === 'filled') {
        const done = mode === 'buy' ? T('Bought ≈{out}: it’s in your Solana wallet.', { out })
          : route === 'arc' ? T('Sold: ≈{out} USDC is back on Arc.', { out }) : T('Sold for ≈{out}: it’s in your Solana wallet.', { out })
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
        setMsg(paidOnArc ? T('Relay couldn’t fill this buy: your USDC was refunded on Arc.') : T('Relay couldn’t fill this trade: it was refunded on Solana.'))
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
  const balanceLabel = mode === 'sell' ? (holding !== null ? `${T('Holding')}: ${fmtTok(holding.amount)}` : null)
    : route === 'arc' ? (me && cash !== null ? `${T('Cash')}: ${fmtUsd(cash)}` : null)
    : route === 'sol' ? (solBal !== null ? `SOL: ${fmtTok(solBal)}` : null)
    : usdcSol !== null ? `USDC: ${fmtUsd(usdcSol.amount)}` : null
  const outText = (n: number) => (mode === 'buy' ? `${fmtTok(n)} ${symbol}` : route === 'sol' ? `${fmtTok(n)} SOL` : `${fmtUsd(n)} USDC`)

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

      <div className="sol-routes" role="group" aria-label={mode === 'buy' ? T('Pay with') : T('Receive')}>
        <span>{mode === 'buy' ? T('Pay with') : T('Receive')}</span>
        {(['arc', 'sol', 'usdc'] as const).map(r => (
          <button key={r} className={route === r ? 'on' : ''} disabled={busy} onClick={() => { setPicked(r); setAmount('') }}>{T(ROUTE_LABEL[r])}</button>
        ))}
      </div>

      <div>
        <div className="rh-field-head">
          <span>{mode === 'buy' ? T('You pay ({c})', { c: T(ROUTE_LABEL[route]) }) : T('You sell ({symbol})', { symbol })}</span>
          {balanceLabel && <button className="link-btn" onClick={() => maxIn !== null && setAmount(mode === 'sell' && holding ? formatUnits(holding.raw, holding.decimals) : maxIn > 0 ? String(route === 'sol' ? Math.floor(maxIn * 1e6) / 1e6 : Math.floor(maxIn * 100) / 100) : '0')}>{balanceLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder={mode === 'buy' && route !== 'sol' ? '$0' : '0'} value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (step !== 'working') { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {mode === 'buy'
            ? (route === 'sol' ? SOL_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} SOL</button>)
              : BUY_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>))
            : SELL_PRESETS.map(p => <button key={p} disabled={busy || !holding} onClick={() => holding && setAmount(formatUnits((holding.raw * BigInt(p)) / 100n, holding.decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? outText(outAmount) : quoting ? '…' : '—'}
          sub={quote && outUsd > 0 && verdict !== 'off-market' && !(mode === 'sell' && route !== 'sol') ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        <Row label={T('Minimum received')} value={quote ? outText(minAmount) : '—'} />
        <Row label={T('Platform fee')} value={route === 'sol' ? T('{pct} (in SOL)', { pct: pct(feeBps) }) : T('{pct} (in USDC)', { pct: pct(feeBps) })} />
        <Row label={route === 'arc' ? T('Bridge & delivery (Relay)') : T('Swap (Relay)')} value={quote ? fmtUsd(quote.relayFeeUsd) : '—'} />
        {value && <Row label={T('Price impact')} value={verdict === 'off-market' ? T('{x}× the market price', { x: fmtTimes(value.rate) }) : impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`}
          color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : impactPct! >= 5 ? 'var(--amber)' : 'var(--green)'} />}
        {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} color={cost! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : cost! >= 6 ? 'var(--amber)' : undefined} />}
        <Row label={T('Arrives')} value={!quote ? '—' : route !== 'arc' ? T('in your Solana wallet in seconds') : mode === 'buy' ? T('on Solana in ~{s}s', { s: Math.max(2, quote.fillSeconds) }) : T('on Arc in ~{s}s', { s: Math.max(2, quote.fillSeconds) })} />
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

      {mode === 'buy' && route === 'arc' && needsGas && (
        <label className="rh-tick">
          <input type="checkbox" checked={topUp} disabled={busy} onChange={e => setTopUp(e.target.checked)} />
          {T('Also add ${n} of SOL for fees on Solana, so you can sell later.', { n: GAS_TOPUP.toFixed(2) })}
        </label>
      )}
      {(mode === 'sell' || route === 'usdc') && needsGas && (
        <div className="rh-gas">
          <span>{T('Trades signed on Solana pay their fees in SOL (a fraction of a cent each).')}</span>
          {me ? <button className="mk-trade mk-trade-solid mk-trade-sm" disabled={busy} onClick={() => void addGas()}>{T('Add ${n} of SOL', { n: GAS_TOPUP.toFixed(2) })}</button>
            : <span>{T('Add a little SOL to this wallet first.')}</span>}
        </div>
      )}
      {noBuy && <div className="rh-msg error">{buyBlocked}</div>}
      {guard.needsPasscode && route === 'arc' && (mode === 'buy' || needsGas) && <PasscodeField guard={guard} />}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {missing === 'evm' ? (
        <>
          <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
          <Note>{T('Paying with USDC on Arc needs an Arc wallet. Or pay with SOL from your Solana wallet.')}{' '}<button className="link-btn" onClick={() => setPicked('sol')}>{T('Pay with SOL')}</button></Note>
        </>
      ) : missing === 'sol' ? (
        <>
          {sol.available.length > 0
            ? <button className="rh-btn" onClick={() => void connectSolanaWallet(sol.available[0]).then(() => pickSolSigner('external')).catch(e => { setStep('error'); setMsg(relayErrorText(e)) })}>{T('Connect {w}', { w: sol.available[0] })}</button>
            : <button className="rh-btn" onClick={openTradingWallet}>{T('Unlock your trading wallet')}</button>}
          <Note>
            {sol.available.length > 0 ? <>{T('Or unlock your')}{' '}<button className="link-btn" onClick={openTradingWallet}>{T('trading wallet')}</button>{' '}{T('for one-tap trades with no pop-ups. It has a Solana address too.')}</>
              : T('No Solana wallet app found in this browser: install Phantom, or use your trading wallet, which has a Solana address too.')}
            {sol.available.length > 1 && <> {sol.available.slice(1).map(w => <span key={w}> · <button className="link-btn" onClick={() => void connectSolanaWallet(w).then(() => pickSolSigner('external')).catch(() => {})}>{w}</button></span>)}</>}
          </Note>
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
export const SOL_NOTE = () => T('Pay with SOL, USDC on Solana or USDC on Arc, and sell for any of them, through Relay. Every trade is checked and simulated before it’s sent, and approvals are for the exact amount.')

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
