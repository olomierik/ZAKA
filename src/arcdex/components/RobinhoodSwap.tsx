// A Robinhood Chain coin paid for with ETH or USDG held on Robinhood Chain, or sold for them (owner, 2026-10-18: "once
// he is on Robinhood the platform should detect the assets available to trade on that chain"). One transaction on
// Robinhood Chain at the trader's own address, through Relay's same-chain swap (lib/relayQuote.ts, chain 'robinhood'):
// ETH goes to Relay's router with the call; USDG is approved for exactly the amount to its approval proxy. ARCDEX's 0.5%
// (SPOT_FEE_BPS) is Relay's app fee. RobinhoodTrade.tsx shows it when "Pay with" is ETH or USDG.

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import type { Trader } from '../lib/identity'
import { pct } from '../lib/routerInfo'
import { onBalances } from '../lib/balances'
import { FEE_WALLET, SPOT_FEE_BPS } from '../lib/platform'
import { reportTrade } from '../lib/analytics'
import { rhEthBalance, rhTokenBalance, rhTx, SELL_GAS_ETH, type RhBalance } from '../lib/robinhood'
import { rhEthUsd } from '../api/rhSwaps'
import { getRelayQuote, QUOTE_LIMITS, quoteVerdict, relayValueUsd, EVM_NATIVE, RH_USDG, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayEvm, type RelayProgress } from '../lib/relay'
import { t as T } from '../lib/i18n'
import type { BuyRisk } from '../lib/buyRisk'
import TradeDetails, { HOT } from './TradeDetails'

export type RhPay = 'eth' | 'usdg'
export const RH_PAY_LABEL: Record<RhPay, string> = { eth: 'ETH', usdg: 'USDG' }

/** ETH kept back when paying with ETH: the trade's own gas. */
const ETH_RESERVE = SELL_GAS_ETH
const ETH_PRESETS = [0.001, 0.002, 0.005, 0.01]
const USD_PRESETS = [5, 10, 25, 50]
const SELL_PRESETS = [25, 50, 100]

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const fmtTimes = (r: number) => (r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1))

type Step = 'idle' | 'working' | 'done' | 'error'

interface Props {
  trader: Trader
  token: string
  symbol: string
  decimals: number | null
  priceUsd: number
  mode: 'buy' | 'sell'
  pay: RhPay
  buyRisk: BuyRisk
  /** Why this coin can't be bought here; selling stays open. */
  buyBlocked?: string
  /** Stock tokens: the buyer's country and word, checked by RobinhoodTrade. */
  gateOk: boolean
  initialAmount?: number
  onTraded?: () => void
}

export default function RobinhoodSwap({ trader, token, symbol, decimals, priceUsd, mode, pay, buyRisk, buyBlocked, gateOk, initialAmount, onTraded }: Props) {
  const me = trader.address
  const kind = trader.kind ?? 'wallet'
  const feeBps = SPOT_FEE_BPS
  const [amount, setAmount] = useState(initialAmount && initialAmount > 0 ? String(initialAmount) : '')
  const [quote, setQuote] = useState<RelayQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [msg, setMsg] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [costOk, setCostOk] = useState(false)
  const [holding, setHolding] = useState<RhBalance | null>(null)
  const [usdg, setUsdg] = useState<RhBalance | null>(null)
  const [eth, setEth] = useState<number | null>(null)
  const [ethUsd, setEthUsd] = useState(0)
  const busy = step === 'working'

  useEffect(() => { void rhEthUsd().then(v => setEthUsd(v ?? 0)) }, [])
  const refresh = useCallback(() => {
    if (!me) { setHolding(null); setUsdg(null); setEth(null); return }
    void rhTokenBalance(token, me, decimals ?? undefined).then(setHolding).catch(() => {})
    void rhTokenBalance(RH_USDG, me, 6).then(setUsdg).catch(() => {})
    void rhEthBalance(me).then(b => setEth(b.amount)).catch(() => {})
  }, [me, token, decimals])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 15_000)
    const off = onBalances(refresh)
    return () => { clearInterval(id); off() }
  }, [refresh])
  useEffect(() => { setAmount(''); setStep('idle'); setMsg(''); setLink(null) }, [mode, pay])

  const dec = holding?.decimals ?? decimals ?? 18
  const amountNum = Number(amount) || 0
  const inDecimals = mode === 'sell' ? dec : pay === 'usdg' ? 6 : 18
  const amountIn = (() => {
    if (!(amountNum > 0)) return 0n
    try { return parseUnits(amount, inDecimals) } catch { return 0n }
  })()
  const other = pay === 'eth' ? EVM_NATIVE : RH_USDG
  const maxIn = mode === 'sell' ? (holding ? holding.amount : null)
    : pay === 'eth' ? (eth !== null ? Math.max(0, eth - ETH_RESERVE) : null)
    : usdg ? usdg.amount : null
  const insufficient = amountNum > 0 && (mode === 'sell' ? holding !== null && amountIn > holding.raw
    : pay === 'eth' ? eth !== null && amountNum + ETH_RESERVE > eth + 1e-12
    : usdg !== null && amountIn > usdg.raw)
  // Everything here is signed on Robinhood Chain, where gas is ETH.
  const needsGas = !!me && eth !== null && eth < ETH_RESERVE

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n)) return null
    // Without a wallet the quote is only shown: asked as the fee wallet, never sent.
    const base = { chain: 'robinhood' as const, side: 'swap' as const, mint: token, amount: amountIn, evm: me ?? FEE_WALLET, sol: '', feeBps }
    return mode === 'buy' ? { ...base, inToken: other, outToken: token } : { ...base, inToken: token, outToken: other }
  }, [amountIn, mode, token, me, feeBps, other])

  const seq = useRef(0)
  useEffect(() => {
    if (busy) return
    setQuote(null); setQuoteErr(''); setCostOk(false)
    const r = request()
    if (!r) return
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
  }, [amountIn, mode, token, me, busy, pay])

  // Its worth at the market: the coin at its price, ETH at Robinhood Chain's WETH/USDG pool (else Relay's own value for
  // the ETH side), USDG at $1. A route paying far off the market, or losing half the trade, is never sent.
  const outAmount = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minAmount = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const ethRef = ethUsd || (quote && pay === 'eth' ? (mode === 'buy' ? (amountNum > 0 ? quote.inUsd / amountNum : 0) : (outAmount > 0 ? quote.outUsdRelay / outAmount : 0)) : 0)
  const unit = pay === 'eth' ? ethRef : 1
  const outUsd = mode === 'buy' ? outAmount * priceUsd : outAmount * unit
  const inputUsd = mode === 'buy' ? amountNum * unit : amountNum * priceUsd
  const priced = priceUsd > 0 && unit > 0
  const value = quote && priced ? relayValueUsd(quote, inputUsd, outUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const impactHot = refused || (impactPct ?? 0) >= HOT.impactPct
  const costHot = (cost ?? 0) >= HOT.costPct
  const needsCostTick = verdict === 'confirm' || verdict === 'unpriced'
  const noBuy = mode === 'buy' && (!!buyBlocked || !gateOk)
  const blocked = busy || !me || !quote || quoting || insufficient || refused || noBuy || (needsCostTick && !costOk) || needsGas || (mode === 'buy' && buyRisk.blocks)

  async function submit() {
    const r = request()
    if (!r || !me || !quote || (mode === 'buy' && buyRisk.blocks)) return
    setStep('working'); setLink(null)
    const say = (p: RelayProgress) => setMsg(p.step === 'quote' ? T('Checking the trade…')
      : p.step === 'approve' ? T('Approving exactly the amount…')
      : p.step === 'send' ? T('Sending…') : p.step === 'deliver' ? T('Settling…') : T('Done'))
    try {
      const res = await runRelayEvm(kind, r, quote, say)
      setLink(rhTx(res.tx))
      if (res.status === 'refunded') throw new Error(T('Relay couldn’t fill this trade: it was refunded on Robinhood Chain.'))
      reportTrade({ chain: 'robinhood', venue: 'relay', side: mode, address: me, usd: inputUsd, feeUsd: inputUsd * feeBps / 10_000, coin: token, tx: res.tx })
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      setMsg(res.status === 'pending' ? T('Still on its way: it lands by itself in a few minutes.')
        : mode === 'buy' ? T('Bought ≈{out}: it’s in your wallet on Robinhood Chain.', { out: `${fmtTok(got)} ${symbol}` })
        : T('Sold for ≈{out}.', { out: pay === 'eth' ? `${fmtTok(got)} ETH` : `${fmtUsd(got)} USDG` }))
      setAmount(''); setStep('done'); onTraded?.(); refresh()
    } catch (e) {
      setStep('error'); setMsg(relayErrorText(e))
    }
  }

  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (mode === 'buy' ? T('Buying…') : T('Selling…'))
    : quoting && !quote ? T('Getting a quote…')
    : T(mode === 'buy' ? 'Buy {symbol}' : 'Sell {symbol}', { symbol })
  const balanceLabel = mode === 'sell' ? (holding ? `${T('Holding')}: ${fmtTok(holding.amount)}` : null)
    : pay === 'eth' ? (eth !== null ? `ETH: ${fmtTok(eth)}` : null) : usdg ? `USDG: ${fmtUsd(usdg.amount)}` : null
  const outText = (n: number) => (mode === 'buy' ? `${fmtTok(n)} ${symbol}` : pay === 'eth' ? `${fmtTok(n)} ETH` : `${fmtUsd(n)} USDG`)

  return (
    <>
      <div>
        <div className="rh-field-head">
          <span>{mode === 'buy' ? T('You pay ({c})', { c: T('{asset} on Robinhood Chain', { asset: RH_PAY_LABEL[pay] }) }) : T('You sell ({symbol})', { symbol })}</span>
          {balanceLabel && <button className="link-btn" onClick={() => maxIn !== null && setAmount(mode === 'sell' && holding ? formatUnits(holding.raw, holding.decimals) : maxIn > 0 ? String(pay === 'eth' ? Math.floor(maxIn * 1e6) / 1e6 : Math.floor(maxIn * 100) / 100) : '0')}>{balanceLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder={mode === 'buy' && pay === 'usdg' ? '$0' : '0'} value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (step !== 'working') { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {mode === 'buy'
            ? (pay === 'eth' ? ETH_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} ETH</button>)
              : USD_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>))
            : SELL_PRESETS.map(p => <button key={p} disabled={busy || !holding} onClick={() => holding && setAmount(formatUnits((holding.raw * BigInt(p)) / 100n, holding.decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? outText(outAmount) : quoting ? '…' : '—'}
          sub={quote && mode === 'buy' && priceUsd > 0 && verdict !== 'off-market' ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        {value && impactHot && <Row label={T('Price impact')} value={verdict === 'off-market' ? T('{x}× the market price', { x: fmtTimes(value.rate) }) : impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`}
          color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : 'var(--amber)'} />}
        {value && !refused && costHot && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} color={cost! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : 'var(--amber)'} />}
        <TradeDetails hint={T('{fee} fee · {via}', { fee: pct(feeBps), via: 'Relay' })}>
          <Row label={T('Minimum received')} value={quote ? outText(minAmount) : '—'} />
          <Row label={T('Platform fee')} value={T('{pct} (in {c})', { pct: pct(feeBps), c: mode === 'buy' ? RH_PAY_LABEL[pay] : RH_PAY_LABEL[pay] })} />
          <Row label={T('Swap (Relay)')} value={quote ? fmtUsd(quote.relayFeeUsd) : '—'} />
          {value && !impactHot && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color="var(--green)" />}
          {value && !refused && !costHot && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} />}
          <Row label={T('Arrives')} value={quote ? T('in your wallet in seconds') : '—'} />
          <p className="swap-note">{T('Signed on Robinhood Chain from your own wallet there; ETH pays the gas. Checked and simulated before it’s sent; USDG is approved for exactly the amount.')}</p>
        </TradeDetails>
      </div>

      {quoteErr && !busy && <div className="rh-msg error">{quoteErr}</div>}
      {verdict === 'off-market' && !busy && <div className="rh-msg error">{T('This quote pays {x}× {symbol}’s market price, through a pool priced far off the market. ARCDEX won’t send it.', { x: fmtTimes(value!.rate), symbol })}</div>}
      {verdict === 'refuse' && !busy && <div className="rh-msg error">{T('The best route loses {n}% of this trade to price impact, so ARCDEX won’t send it. Try a smaller amount.', { n: impactPct!.toFixed(0) })}</div>}
      {needsCostTick && (
        <label className="rh-tick warn">
          <input type="checkbox" checked={costOk} onChange={e => setCostOk(e.target.checked)} />
          {verdict === 'unpriced' ? T('I understand this quote can’t be checked against a market price.')
            : T('I understand this trade costs {n}% in fees and price impact.', { n: Math.max(cost!, impactPct!).toFixed(1) })}
        </label>
      )}
      {needsGas && <div className="rh-msg error">{T('Trades here are signed on Robinhood Chain, where gas is ETH: deposit a little ETH on Robinhood Chain, or pay with USDC on Arc.')}</div>}
      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {link && <span className="rh-links"><a href={link} target="_blank" rel="noopener noreferrer">{T('Robinhood Chain transaction')} ↗</a></span>}
        </div>
      )}
      {mode === 'buy' && buyRisk.node}
      {me && <button className={`rh-btn ${mode}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>}
    </>
  )
}

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', color }}>{value}{sub && <small style={{ display: 'block', color: 'var(--text-muted)' }}>{sub}</small>}</span>
    </div>
  )
}
