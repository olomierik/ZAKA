// Buy or sell a BNB Chain coin (four.meme's) from ARCDEX (2026-10-05), at the trader's own EVM address there: the
// trading wallet signs on BNB Chain with the same key (no pop-ups), a connected wallet is switched to BNB Chain.
//
//   • Graduated (PancakeSwap): through Relay (lib/relay.ts), paid with USDC on Arc (the coin lands on BNB Chain in
//     seconds), BNB or USDT; sold for any of the three. ARCDEX's 2% is Relay's app fee.
//   • On its curve: four.meme's own TokenManager2 (lib/fourMeme.ts), paid with the coin's quote (BNB, or USDT for a
//     USDT coin) and sold for it. ARCDEX takes no fee there; four.meme takes its own (about 1%).
// Gas on BNB Chain is BNB: "Add BNB" turns Arc USDC into BNB at the same address (Relay, no ARCDEX fee).

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { useRouterInfo, pct } from '../lib/routerInfo'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER, FEE_WALLET } from '../lib/platform'
import { bnbBalance, bscTokenBalance, bscTx, bscAddress, SELL_GAS_BNB, type BscHolding } from '../lib/bsc'
import { getRelayQuote, QUOTE_LIMITS, quoteVerdict, relayValue, relayValueUsd, EVM_NATIVE, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayEvm, type RelayProgress } from '../lib/relay'
import { fourErrorText, fourQuoteBuy, fourQuoteSell, fourMinOut, runFourBuy, runFourSell, type FourQuote, type FourStep } from '../lib/fourMeme'
import { isContractWallet } from '../lib/across'
import { bnbUsd, BSC_USDT, type FourInfo } from '../api/bscMarket'
import { t as T } from '../lib/i18n'

interface Props {
  token: string
  symbol: string
  decimals: number | null
  priceUsd: number
  /** four.meme's word on the coin: on its curve (traded on four.meme's contract) or graduated (traded through Relay). */
  four?: FourInfo | null
  side?: 'buy' | 'sell'
  initialMode?: 'buy' | 'sell'
  compact?: boolean
  buyBlocked?: string
  onTraded?: () => void
}

type Route = 'arc' | 'bnb' | 'usdt'
const ROUTE_LABEL: Record<Route, string> = { arc: 'USDC on Arc', bnb: 'BNB', usdt: 'USDT' }
const GAS_RESERVE = 0.15
/** "Add BNB": $0.50 of USDC on Arc → BNB, about five trades' gas; or more, to buy a curve coin with. */
const GAS_TOPUP = 0.5
const BNB_ADD = [0.5, 5, 10, 25]
const BUY_PRESETS = [5, 10, 25, 50]
const BNB_PRESETS = [0.01, 0.02, 0.05, 0.1]
const SELL_PRESETS = [25, 50, 100]
/** BNB kept back when paying with BNB: the trade's gas. */
const BNB_RESERVE = 0.0005
/** The curve's slippage: four.meme's price moves with every trade. */
const CURVE_SLIPPAGE_BPS = 500

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const arcTx = (h: string) => `${ARC_EXPLORER}/tx/${h}`
const fmtTimes = (r: number) => (r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1))
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

type Step = 'idle' | 'working' | 'done' | 'error'

export default function BscTrade({ token, symbol, decimals, priceUsd, four, side, initialMode, compact, buyBlocked, onTraded }: Props) {
  const trader = useTrader()
  const me = trader.address
  const kind = trader.kind ?? 'wallet'
  const info = useRouterInfo()
  const feeBps = info?.feeBps ?? 200
  const curve = !!four && !four.graduated
  const curveRoute: Route = four?.quote === BSC_USDT ? 'usdt' : 'bnb'
  const [mode, setMode] = useState<'buy' | 'sell'>(side ?? initialMode ?? 'buy')
  const [picked, setPicked] = useState<Route | null>(null)
  const route: Route = curve ? curveRoute : picked ?? 'arc'
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<RelayQuote | null>(null)
  const [fq, setFq] = useState<FourQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [msg, setMsg] = useState('')
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [costOk, setCostOk] = useState(false)
  const { cash, refresh: refreshCash } = useCash(me)
  const [holding, setHolding] = useState<BscHolding | null>(null)
  const [usdt, setUsdt] = useState<BscHolding | null>(null)
  const [bnb, setBnb] = useState<number | null>(null)
  const [bnbPrice, setBnbPrice] = useState(0)
  const busy = step === 'working'

  // BNB's dollar price, asked again every 30s until GeckoTerminal answers.
  useEffect(() => {
    if (bnbPrice > 0) return
    void bnbUsd().then(setBnbPrice)
    const id = setInterval(() => { void bnbUsd().then(setBnbPrice) }, 30_000)
    return () => clearInterval(id)
  }, [bnbPrice])

  const refreshBsc = useCallback(() => {
    if (!me) { setHolding(null); setBnb(null); setUsdt(null); return }
    void bscTokenBalance(token, me, decimals ?? undefined).then(setHolding).catch(() => {})
    void bscTokenBalance(BSC_USDT, me, 18).then(setUsdt).catch(() => {})
    void bnbBalance(me).then(setBnb).catch(() => {})
  }, [me, token, decimals])
  useEffect(() => {
    refreshBsc()
    const id = setInterval(() => { if (!document.hidden) refreshBsc() }, 15_000)
    const off = onBalances(refreshBsc)
    return () => { clearInterval(id); off() }
  }, [refreshBsc])

  const dec = holding?.decimals ?? decimals ?? 18
  const amountNum = Number(amount) || 0
  const inDecimals = mode === 'sell' ? dec : route === 'arc' ? 6 : 18
  const amountIn = (() => {
    if (!(amountNum > 0)) return 0n
    try { return parseUnits(amount, inDecimals) } catch { return 0n }
  })()
  const maxIn = mode === 'sell' ? (holding ? Number(formatUnits(holding.raw, holding.decimals)) : null)
    : route === 'arc' ? (cash !== null ? Math.max(0, cash - GAS_RESERVE) : null)
    : route === 'bnb' ? (bnb !== null ? Math.max(0, bnb - BNB_RESERVE) : null)
    : usdt ? usdt.amount : null
  const insufficient = amountNum > 0 && (mode === 'sell'
    ? holding !== null && amountIn > holding.raw
    : route === 'arc' ? !!me && cash !== null && amountNum + GAS_RESERVE > cash + 1e-9
    : route === 'bnb' ? bnb !== null && amountNum + BNB_RESERVE > bnb + 1e-12
    : usdt !== null && amountIn > usdt.raw)
  // Anything signed on BNB Chain pays its gas in BNB.
  const signsOnBsc = !(mode === 'buy' && route === 'arc')
  const needsGas = signsOnBsc && !!me && bnb !== null && bnb < SELL_GAS_BNB

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n) || curve) return null
    const base = { chain: 'bsc' as const, mint: token, amount: amountIn, evm: me ?? FEE_WALLET, sol: '', feeBps }
    if (route === 'arc') return { ...base, side: mode }
    const other = route === 'bnb' ? EVM_NATIVE : BSC_USDT
    return mode === 'buy' ? { ...base, side: 'swap', inToken: other, outToken: token } : { ...base, side: 'swap', inToken: token, outToken: other }
  }, [amountIn, mode, token, me, feeBps, route, curve])

  const seq = useRef(0)
  useEffect(() => {
    if (busy) return
    setQuote(null); setFq(null); setQuoteErr(''); setCostOk(false)
    if (!(amountIn > 0n)) return
    const r = request()
    const n = ++seq.current
    const ask = () => {
      setQuoting(true)
      const p: Promise<unknown> = curve
        ? (mode === 'buy' ? fourQuoteBuy(token, amountIn) : fourQuoteSell(token, amountIn)).then(q => { if (seq.current === n) { setFq(q); setQuoteErr('') } })
        : getRelayQuote(r!).then(q => { if (seq.current === n) { setQuote(q); setQuoteErr('') } })
      p.catch(e => { if (seq.current === n) { setQuote(null); setFq(null); setQuoteErr(curve ? fourErrorText(e) : relayErrorText(e)) } })
        .finally(() => { if (seq.current === n) setQuoting(false) })
    }
    const first = setTimeout(ask, 500)
    const again = setInterval(() => { if (!document.hidden) ask() }, curve ? 10_000 : 20_000)
    return () => { clearTimeout(first); clearInterval(again) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, mode, token, me, feeBps, busy, route, curve])

  // What it delivers, and its worth at the market: the coin at its price, BNB at BNB's, USDT and USDC at $1.
  const outAmountRaw = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  // Without GeckoTerminal's BNB price, Relay's own dollar value for the BNB side (BNB itself is never the trap: the coin
  // is still valued at its market price).
  const bnbRef = bnbPrice || (quote && route === 'bnb' ? (mode === 'buy' ? (amountNum > 0 ? quote.inUsd / amountNum : 0) : (outAmountRaw > 0 ? quote.outUsdRelay / outAmountRaw : 0)) : 0)
  const unitUsd = (r: Route) => (r === 'bnb' ? bnbRef : 1)
  const outAmount = fq ? Number(formatUnits(fq.side === 'buy' ? fq.tokens : fq.funds, fq.side === 'buy' ? dec : 18))
    : quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minAmount = fq ? Number(formatUnits(fourMinOut(fq, CURVE_SLIPPAGE_BPS), fq.side === 'buy' ? dec : 18))
    : quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const outUsd = mode === 'buy' ? outAmount * priceUsd : outAmount * unitUsd(route)
  const inputUsd = mode === 'buy' ? amountNum * unitUsd(route) : amountNum * priceUsd
  const fourFeeUsd = fq ? Number(formatUnits(fq.fee, 18)) * unitUsd(route) : 0
  const priced = priceUsd > 0 && (route !== 'bnb' || bnbRef > 0)
  const value = fq ? (priced ? relayValueUsd({ appFeeUsd: 0, relayFeeUsd: fourFeeUsd }, inputUsd, outUsd) : null)
    : !quote ? null
    : route === 'arc' ? relayValue(quote, amountNum, priceUsd)
    : priced ? relayValueUsd(quote, inputUsd, outUsd) : null
  const haveQuote = !!quote || !!fq
  const verdict = haveQuote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const needsCostTick = verdict === 'confirm' || verdict === 'unpriced'

  const noBuy = mode === 'buy' && !!buyBlocked
  const blocked = busy || !me || !haveQuote || quoting || insufficient || refused || noBuy || (needsCostTick && !costOk) || needsGas

  async function addBnb(usd: number) {
    if (!me) return
    setStep('working'); setLinks([]); setMsg(T('Adding ${n} of BNB on BNB Chain…', { n: usd.toFixed(2) }))
    try {
      const r = await runRelayEvm(kind, { side: 'gas', chain: 'bsc', mint: '', amount: BigInt(Math.round(usd * 1e6)), evm: me, sol: '', feeBps: 0 }, null, () => {})
      setLinks([{ label: T('Arc transaction'), href: arcTx(r.tx) }])
      refreshBsc(); refreshCash()
      setStep(r.status === 'refunded' ? 'error' : 'done')
      setMsg(r.status === 'filled' ? T('BNB added on BNB Chain.') : r.status === 'pending' ? T('The BNB is still on its way: it lands by itself.') : T('Relay couldn’t deliver the BNB: your USDC was refunded on Arc.'))
    } catch (e) { setStep('error'); setMsg(relayErrorText(e)) }
  }

  async function submit() {
    if (!me || !haveQuote) return
    setStep('working'); setLinks([])
    try {
      if (curve && fq) {
        const say = (s: FourStep) => setMsg(s === 'quote' ? T('Checking the trade…') : s === 'approve' ? T('Approving exactly the amount…') : s === 'send' ? T('Sending…') : T('Done'))
        const tx = fq.side === 'buy'
          ? await runFourBuy(kind, me, token, amountIn, fq, CURVE_SLIPPAGE_BPS, say)
          : await runFourSell(kind, me, token, amountIn, fq, CURVE_SLIPPAGE_BPS, say)
        setLinks([{ label: T('BNB Chain transaction'), href: bscTx(tx) }])
        setMsg(mode === 'buy' ? T('Bought ≈{out} on four.meme’s curve.', { out: `${fmtTok(outAmount)} ${symbol}` }) : T('Sold for ≈{out}.', { out: `${fmtTok(outAmount)} ${ROUTE_LABEL[route]}` }))
      } else {
        const r = request()
        if (!r || !quote) return
        if (route === 'arc' && mode === 'buy' && await isContractWallet(me)) throw new Error(T('A contract wallet may not exist at the same address on BNB Chain: buy with an ordinary wallet or the trading wallet.'))
        const say = (p: RelayProgress) => setMsg(p.step === 'quote' ? T('Checking the trade…')
          : p.step === 'approve' ? T('Approving exactly the amount…')
          : p.step === 'send' ? T('Sending…')
          : p.step === 'deliver' ? (route === 'arc' ? (mode === 'buy' ? T('On its way to BNB Chain…') : T('On its way to Arc…')) : T('Settling…'))
          : T('Done'))
        const res = await runRelayEvm(kind, r, quote, say)
        const paidOnArc = route === 'arc' && mode === 'buy'
        const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
        const l = [{ label: paidOnArc ? T('Arc transaction') : T('BNB Chain transaction'), href: paidOnArc ? arcTx(res.tx) : bscTx(res.tx) }]
        if (res.outTx && res.outTx !== res.tx) l.push({ label: T('Delivered'), href: mode === 'sell' && route === 'arc' ? arcTx(res.outTx) : bscTx(res.outTx) })
        setLinks(l)
        if (res.status === 'refunded') throw new Error(paidOnArc ? T('Relay couldn’t fill this buy: your USDC was refunded on Arc.') : T('Relay couldn’t fill this trade: it was refunded on BNB Chain.'))
        setMsg(res.status === 'pending' ? T('Still on its way: it lands by itself in a few minutes.')
          : mode === 'buy' ? T('Bought ≈{out}: it’s in your wallet on BNB Chain.', { out: `${fmtTok(got)} ${symbol}` })
          : route === 'arc' ? T('Sold: ≈{out} USDC is back on Arc.', { out: fmtUsd(got) }) : T('Sold for ≈{out}.', { out: `${fmtTok(got)} ${ROUTE_LABEL[route]}` }))
      }
      setAmount('')
      setStep('done')
      onTraded?.()
      refreshBsc(); refreshCash()
    } catch (e) {
      setStep('error'); setMsg(curve ? fourErrorText(e) : relayErrorText(e))
    }
  }

  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (mode === 'buy' ? T('Buying…') : T('Selling…'))
    : quoting && !haveQuote ? T('Getting a quote…')
    : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol })
  const balanceLabel = mode === 'sell' ? (holding !== null ? `${T('Holding')}: ${fmtTok(holding.amount)}` : null)
    : route === 'arc' ? (me && cash !== null ? `${T('Cash')}: ${fmtUsd(cash)}` : null)
    : route === 'bnb' ? (bnb !== null ? `BNB: ${fmtTok(bnb)}` : null)
    : usdt !== null ? `USDT: ${fmtUsd(usdt.amount)}` : null
  const outText = (n: number) => (mode === 'buy' ? `${fmtTok(n)} ${symbol}` : route === 'bnb' ? `${fmtTok(n)} BNB` : `${fmtUsd(n)} ${route === 'usdt' ? 'USDT' : 'USDC'}`)
  const relayFee = quote ? quote.relayFeeUsd : 0

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

      {curve ? (
        <div className="sol-routes"><span>{T('On four.meme’s curve: traded with {c}', { c: ROUTE_LABEL[curveRoute] })}</span></div>
      ) : (
        <div className="sol-routes" role="group" aria-label={mode === 'buy' ? T('Pay with') : T('Receive')}>
          <span>{mode === 'buy' ? T('Pay with') : T('Receive')}</span>
          {(['arc', 'bnb', 'usdt'] as const).map(r => (
            <button key={r} className={route === r ? 'on' : ''} disabled={busy} onClick={() => { setPicked(r); setAmount('') }}>{T(ROUTE_LABEL[r])}</button>
          ))}
        </div>
      )}

      <div>
        <div className="rh-field-head">
          <span>{mode === 'buy' ? T('You pay ({c})', { c: T(ROUTE_LABEL[route]) }) : T('You sell ({symbol})', { symbol })}</span>
          {balanceLabel && <button className="link-btn" onClick={() => maxIn !== null && setAmount(mode === 'sell' && holding ? formatUnits(holding.raw, holding.decimals) : maxIn > 0 ? String(route === 'bnb' ? Math.floor(maxIn * 1e6) / 1e6 : Math.floor(maxIn * 100) / 100) : '0')}>{balanceLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder={mode === 'buy' && route !== 'bnb' ? '$0' : '0'} value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (step !== 'working') { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {mode === 'buy'
            ? (route === 'bnb' ? BNB_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} BNB</button>)
              : BUY_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>))
            : SELL_PRESETS.map(p => <button key={p} disabled={busy || !holding} onClick={() => holding && setAmount(formatUnits((holding.raw * BigInt(p)) / 100n, holding.decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={haveQuote ? outText(outAmount) : quoting ? '…' : '—'}
          sub={haveQuote && outUsd > 0 && verdict !== 'off-market' && mode === 'buy' ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        <Row label={T('Minimum received')} value={haveQuote ? outText(minAmount) : '—'} />
        {curve ? (
          <>
            <Row label={T('Platform fee')} value="0%" />
            <Row label={T('four.meme fee')} value={fq ? `${fmtTok(Number(formatUnits(fq.fee, 18)))} ${ROUTE_LABEL[curveRoute]}` : '≈1%'} />
            <Row label={T('Max slippage')} value={`${CURVE_SLIPPAGE_BPS / 100}%`} />
          </>
        ) : (
          <>
            <Row label={T('Platform fee')} value={T('{pct} (in {c})', { pct: pct(feeBps), c: route === 'arc' ? 'USDC' : ROUTE_LABEL[route] })} />
            <Row label={route === 'arc' ? T('Bridge & delivery (Relay)') : T('Swap (Relay)')} value={quote ? fmtUsd(relayFee) : '—'} />
          </>
        )}
        {value && <Row label={T('Price impact')} value={verdict === 'off-market' ? T('{x}× the market price', { x: fmtTimes(value.rate) }) : impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`}
          color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : impactPct! >= 5 ? 'var(--amber)' : 'var(--green)'} />}
        {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} color={cost! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : cost! >= 6 ? 'var(--amber)' : undefined} />}
        <Row label={T('Arrives')} value={!haveQuote ? '—' : route === 'arc' && quote ? (mode === 'buy' ? T('on BNB Chain in ~{s}s', { s: Math.max(2, quote.fillSeconds) }) : T('on Arc in ~{s}s', { s: Math.max(2, quote.fillSeconds) })) : T('in your wallet in seconds')} />
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
      {noBuy && <div className="rh-msg error">{buyBlocked}</div>}

      {me && (needsGas || (route === 'bnb' && mode === 'buy' && bnb !== null && bnb < 0.01)) && (
        <div className="rh-gas">
          <span>{needsGas ? T('Trades signed on BNB Chain pay their gas in BNB (a few cents each).') : T('Add BNB to this wallet from your Arc USDC:')}</span>
          <span className="rh-chips" style={{ marginTop: 0 }}>
            {(needsGas ? [GAS_TOPUP] : BNB_ADD).map(v => <button key={v} disabled={busy || cash === null || cash < v + GAS_RESERVE} onClick={() => void addBnb(v)}>+${v} BNB</button>)}
          </span>
        </div>
      )}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {!me ? (
        <>
          <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
          <Note>{T('Or unlock your')}{' '}<button className="link-btn" onClick={openTradingWallet}>{T('trading wallet')}</button>{' '}{T('for one-tap trades with no pop-ups: it has the same address on BNB Chain.')}</Note>
        </>
      ) : (
        <button className={`rh-btn ${mode}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>
      )}

      {me && !compact && (
        <div className="swap-note sol-wallet-line">
          {T('BNB Chain wallet')}: {trader.kind === 'trading-wallet' ? T('⚡ trading wallet') : T('your wallet')}{' '}
          <a href={bscAddress(me)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)' }}>{short(me)}</a>
          {bnb !== null && <> · BNB {bnb < 0.00001 ? '0' : bnb.toPrecision(2)}</>}
        </div>
      )}
      {!compact && <p className="swap-note">{BSC_NOTE()}</p>}
    </div>
  )
}

/** The note under the trade forms. */
export const BSC_NOTE = () => T('Graduated coins trade through Relay with USDC on Arc, BNB or USDT; coins still on four.meme’s curve trade on four.meme’s own contract. Every trade is checked and simulated before it’s sent, and approvals are for the exact amount.')

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

