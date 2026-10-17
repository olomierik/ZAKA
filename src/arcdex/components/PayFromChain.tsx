// Buying a coin on Arc, BNB Chain or Robinhood Chain with USDC or ETH from Ethereum, Base or Arbitrum (owner,
// 2026-10-16: "the limitation of having to be on Arc to trade"). One signature on the chain the money is on; the coin
// lands at the same address on the coin's chain about a second later, with $0.50 of that chain's gas added when the
// wallet has none there, so it can be sold later. Through Relay (lib/relayQuote.ts `xevm`, lib/payChains.ts): every
// quote checked before signing (the trader on both sides, exactly the amount, Relay's depository only), valued at the
// market for the price guard, the call simulated from the trader, approvals for exactly the amount. ARCDEX's fee is
// Relay's app fee, SPOT_FEE_BPS (0.5%).

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { pct } from '../lib/routerInfo'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER, SPOT_FEE_BPS } from '../lib/platform'
import { bnbBalance, bscTx } from '../lib/bsc'
import { rhEthBalance, rhTx } from '../lib/robinhood'
import { rhEthUsd } from '../api/rhSwaps'
import { PAY_CHAINS, payBalance, payChain, payTx, richest, type PayBalance } from '../lib/payChains'
import { getRelayQuote, quoteVerdict, relayValueUsd, QUOTE_LIMITS, ARC_ID, BSC_ID, EVM_NATIVE, RH_ID, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayEvm, type RelayProgress } from '../lib/relay'
import { t as T } from '../lib/i18n'
import { useBuyRisk } from '../lib/buyRisk'
import TradeDetails, { HOT } from './TradeDetails'

interface Props {
  /** The coin's chain: Arc, BNB Chain or Robinhood Chain. */
  chainId: number
  token: string
  symbol: string
  /** The coin's market price, for the price guard. */
  priceUsd: number
  buyBlocked?: string
}

const CHAIN_NAME: Record<number, string> = { [ARC_ID]: 'Arc', [BSC_ID]: 'BNB Chain', [RH_ID]: 'Robinhood Chain' }
const GAS_NAME: Record<number, string> = { [ARC_ID]: 'USDC', [BSC_ID]: 'BNB', [RH_ID]: 'ETH' }
/** The coin chain's gas balance under which a buy adds $0.50 of it. */
const LOW_GAS: Record<number, number> = { [ARC_ID]: 0.2, [BSC_ID]: 0.0003, [RH_ID]: 0.00005 }
const GAS_TOPUP_USD = 0.5
const USD_PRESETS = [5, 10, 25, 50]
const ETH_PRESETS = [0.002, 0.005, 0.01, 0.025]

const coinTx = (chainId: number, h: string) => (chainId === BSC_ID ? bscTx(h) : chainId === RH_ID ? rhTx(h) : `${ARC_EXPLORER}/tx/${h}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const fmtUsd = (n: number) => (n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
/** Quotes before a wallet connects are asked for this address, so the price shows first; nothing is ever sent from or to it
 * (Buy needs a connected wallet, and every quote is checked against the address it was asked for). */
const QUOTE_PLACEHOLDER = '0x1111111111111111111111111111111111111111'
const fmtEth = (wei: bigint) => { const n = Number(formatUnits(wei, 18)); return n >= 1 ? n.toFixed(3) : n.toPrecision(3) }

export default function PayFromChain({ chainId, token, symbol, priceUsd, buyBlocked }: Props) {
  const trader = useTrader()
  const me = trader.address
  const kind = trader.kind ?? 'wallet'
  const [from, setFrom] = useState(PAY_CHAINS[0].id)
  const [cur, setCur] = useState<'usdc' | 'eth'>('usdc')
  const [amount, setAmount] = useState('')
  const [bals, setBals] = useState<Record<number, PayBalance>>({})
  const [ethUsd, setEthUsd] = useState(0)
  const [gas, setGas] = useState<number | null>(null)
  const [quote, setQuote] = useState<RelayQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [costOk, setCostOk] = useState(false)
  const picked = useRef(false)
  const { cash } = useCash(chainId === ARC_ID ? me : null)
  const busy = step === 'working'
  const buyRisk = useBuyRisk(true)
  const pc = payChain(from)!

  useEffect(() => {
    let live = true
    const load = () => void rhEthUsd().then(v => { if (live && v) setEthUsd(v) })
    load()
    const id = setInterval(load, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [])

  const refresh = useCallback(() => {
    if (!me) { setBals({}); setGas(null); return }
    for (const c of PAY_CHAINS) void payBalance(c.id, me).then(b => setBals(prev => ({ ...prev, [c.id]: b }))).catch(() => {})
    if (chainId === BSC_ID) void bnbBalance(me).then(setGas).catch(() => {})
    else if (chainId === RH_ID) void rhEthBalance(me).then(b => setGas(b.amount)).catch(() => {})
    else setGas(cash)
  }, [me, chainId, cash])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 20_000)
    const off = onBalances(refresh)
    return () => { clearInterval(id); off() }
  }, [refresh])

  // Open on the chain and currency the trader holds the most of, once.
  useEffect(() => {
    if (picked.current || !ethUsd || Object.keys(bals).length < PAY_CHAINS.length) return
    const best = richest(Object.values(bals), ethUsd)
    if (!best) return
    picked.current = true
    setFrom(best.chainId)
    const usdcUsd = Number(formatUnits(best.usdc, 6)), ethUsdHeld = Number(formatUnits(best.eth, 18)) * ethUsd
    setCur(usdcUsd >= ethUsdHeld ? 'usdc' : 'eth')
  }, [bals, ethUsd])

  const bal = bals[from]
  const amountNum = Number(amount) || 0
  const amountIn = (() => { if (!(amountNum > 0)) return 0n; try { return parseUnits(amount, cur === 'usdc' ? 6 : 18) } catch { return 0n } })()
  const keepWei = parseUnits(String(pc.gasKeepEth), 18)
  const maxRaw = bal ? (cur === 'usdc' ? bal.usdc : bal.eth > keepWei ? bal.eth - keepWei : 0n) : null
  const insufficient = amountIn > 0n && maxRaw !== null && amountIn > maxRaw
  // Paying with USDC still needs a little ETH there for the transaction itself.
  const noEthForGas = !!bal && cur === 'usdc' && amountIn > 0n && bal.eth < keepWei / 4n
  const addGas = gas !== null && gas < (LOW_GAS[chainId] ?? 0)

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n)) return null
    return { side: 'xevm', fromChain: from, evmChain: chainId, mint: token, inToken: cur === 'usdc' ? pc.usdc : EVM_NATIVE, amount: amountIn, evm: me ?? QUOTE_PLACEHOLDER, sol: '', feeBps: SPOT_FEE_BPS, ...(addGas ? { gasUsd: GAS_TOPUP_USD } : {}) }
  }, [amountIn, me, from, chainId, token, cur, pc.usdc, addGas])

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
    const first = setTimeout(ask, 400)
    const again = setInterval(() => { if (!document.hidden) ask() }, 20_000)
    return () => { clearTimeout(first); clearInterval(again) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, me, from, cur, chainId, token, addGas, busy])

  // The price guard: what goes in (USDC $1, ETH at its price, else Relay's own value) against the coin at its market price.
  const out = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minOut = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const inputUsd = cur === 'usdc' ? amountNum : ethUsd > 0 ? amountNum * ethUsd : quote?.inUsd ?? 0
  const outUsd = out * priceUsd
  const topup = quote ? quote.gasTopupUsd : 0
  const value = quote && inputUsd > 0 && priceUsd > 0 ? relayValueUsd({ appFeeUsd: quote.appFeeUsd, relayFeeUsd: Math.max(0, quote.relayFeeUsd - topup) }, inputUsd - topup, outUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const impactHot = refused || (impactPct ?? 0) >= HOT.impactPct
  const needsTick = verdict === 'confirm' || verdict === 'unpriced'
  const blocked = busy || !quote || quoting || insufficient || refused || !!buyBlocked || (needsTick && !costOk) || noEthForGas || buyRisk.blocks

  async function submit() {
    const r = request()
    if (!r || !me || !quote || buyRisk.blocks) return
    setStep('working'); setLinks([])
    const say = (p: RelayProgress) => setMsg(p.step === 'quote' ? T('Checking the trade…')
      : p.step === 'approve' ? T('Approving exactly the amount…')
      : p.step === 'send' ? T('Sending…')
      : p.step === 'deliver' ? T('On its way to {chain}…', { chain: CHAIN_NAME[chainId] })
      : T('Confirm in your wallet…'))
    try {
      const res = await runRelayEvm(kind, r, quote, say)
      const l = [{ label: T('{chain} transaction', { chain: pc.name }), href: payTx(from, res.tx) }]
      if (res.outTx && res.outTx !== res.tx) l.push({ label: T('Delivered'), href: coinTx(chainId, res.outTx) })
      setLinks(l)
      if (res.status === 'refunded') throw new Error(T('Relay couldn’t fill this trade: it was refunded on {chain}.', { chain: pc.name }))
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      setMsg(res.status === 'pending' ? T('Still on its way: it lands by itself in a few minutes.')
        : T('Done: ≈{out} is in your wallet on {chain}.', { out: `${fmtTok(got)} ${symbol}`, chain: CHAIN_NAME[chainId] }))
      setStep('done'); setAmount('')
      refresh()
    } catch (e) {
      setStep('error'); setMsg(relayErrorText(e))
    }
  }

  const balLabel = bal ? (cur === 'usdc' ? `USDC: ${fmtUsd(Number(formatUnits(bal.usdc, 6)))}` : `ETH: ${fmtEth(bal.eth)}`) : null
  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? T('Buying…')
    : quoting && !quote ? T('Getting a quote…')
    : T('Buy {symbol}', { symbol })

  return (
    <div className="swap-box sol-cross pay-from">
      <div className="sol-routes" role="group" aria-label={T('Pay from')}>
        <span>{T('Pay from')}</span>
        {PAY_CHAINS.map(c => {
          const b = bals[c.id]
          const has = b && (b.usdc > 0n || b.eth > 0n)
          return <button key={c.id} className={from === c.id ? 'on' : ''} disabled={busy} onClick={() => { picked.current = true; setFrom(c.id); setAmount('') }}>{c.name}{has ? ' •' : ''}</button>
        })}
      </div>
      <div className="sol-routes" role="group" aria-label={T('Pay with')}>
        <span>{T('Pay with')}</span>
        {(['usdc', 'eth'] as const).map(c => (
          <button key={c} className={cur === c ? 'on' : ''} disabled={busy} onClick={() => { picked.current = true; setCur(c); setAmount('') }}>{c === 'usdc' ? 'USDC' : 'ETH'}</button>
        ))}
      </div>

      <div>
        <div className="rh-field-head">
          <span>{T('You pay ({c})', { c: `${cur === 'usdc' ? 'USDC' : 'ETH'} · ${pc.name}` })}</span>
          {balLabel && <button className="link-btn" onClick={() => maxRaw !== null && setAmount(formatUnits(maxRaw, cur === 'usdc' ? 6 : 18))}>{balLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder="0" value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (!busy) { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {cur === 'usdc'
            ? USD_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>)
            : ETH_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} ETH</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? `${fmtTok(out)} ${symbol}` : quoting ? '…' : '—'} sub={quote && outUsd > 0 ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        {value && impactHot && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : 'var(--amber)'} />}
        <TradeDetails hint={T('{fee} fee · {via}', { fee: pct(SPOT_FEE_BPS), via: 'Relay' })}>
          <Row label={T('Minimum received')} value={quote ? `${fmtTok(minOut)} ${symbol}` : '—'} />
          <Row label={T('Platform fee')} value={pct(SPOT_FEE_BPS)} />
          <Row label={T('Relay')} value={quote ? fmtUsd(Math.max(0, quote.relayFeeUsd - topup)) : '—'} />
          {addGas && <Row label={T('Gas added on {chain}', { chain: CHAIN_NAME[chainId] })} value={T('{usd} of {coin}', { usd: fmtUsd(quote && topup > 0 ? topup : GAS_TOPUP_USD), coin: GAS_NAME[chainId] })} />}
          {value && !impactHot && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color="var(--green)" />}
          {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} />}
          <Row label={T('Arrives')} value={quote ? T('on {chain} in ~{s}s', { chain: CHAIN_NAME[chainId], s: Math.max(2, quote.fillSeconds) }) : '—'} />
          <p className="swap-note">{T('Pay with USDC or ETH where you hold it: one signature on {from}, and the coin lands in the same wallet on {chain} in seconds. No bridging first. Every trade is checked and simulated before it’s sent.', { from: pc.name, chain: CHAIN_NAME[chainId] })}</p>
        </TradeDetails>
      </div>

      {quoteErr && !busy && <div className="rh-msg error">{quoteErr}</div>}
      {verdict === 'off-market' && !busy && <div className="rh-msg error">{T('This quote pays {x}× {symbol}’s market price: the route goes through a pool priced far off the market, the way trap pools catch trades. ARCDEX won’t send it.', { x: value!.rate >= 10 ? Math.round(value!.rate).toLocaleString('en-US') : value!.rate.toFixed(1), symbol })}</div>}
      {verdict === 'refuse' && !busy && <div className="rh-msg error">{T('The best route loses {n}% of this trade to price impact, so ARCDEX won’t send it. A smaller amount may route better.', { n: impactPct!.toFixed(0) })}</div>}
      {needsTick && (
        <label className="rh-tick warn">
          <input type="checkbox" checked={costOk} onChange={e => setCostOk(e.target.checked)} />
          {verdict === 'unpriced' ? T('I understand this quote can’t be checked against a market price.') : T('I understand this trade costs {n}% in fees and price impact.', { n: Math.max(cost!, impactPct!).toFixed(1) })}
        </label>
      )}
      {noEthForGas && <div className="rh-msg error">{T('Add a little ETH on {chain} for the transaction’s gas.', { chain: pc.name })}</div>}
      {buyBlocked && <div className="rh-msg error">{buyBlocked}</div>}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {buyRisk.node}

      {!me
        ? <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
        : <button className="rh-btn buy" onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>}
    </div>
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

/** "Pay from Ethereum, Base or Arbitrum" under a coin page's own trade forms: open when the wallet has little cash on
 * the coin's chain (Arc: under $1 of USDC), so money elsewhere is the first way to buy. */
export function PayFromCard(props: Props) {
  const trader = useTrader()
  const { cash } = useCash(props.chainId === ARC_ID ? trader.address : null)
  const low = props.chainId === ARC_ID && trader.address != null && cash !== null && cash < 1
  const [open, setOpen] = useState(low)
  useEffect(() => { if (low) setOpen(true) }, [low])
  return (
    <div className="sol-pay">
      <button className="sol-pay-h" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sol-pay-mark">⇄</span>
        <span><b>{T('Pay from Ethereum, Base or Arbitrum')}</b><small>{T('USDC or ETH · one signature · no bridging')}</small></span>
        <span className="sol-pay-t">{open ? '−' : '+'}</span>
      </button>
      {open && <PayFromChain {...props} />}
    </div>
  )
}
