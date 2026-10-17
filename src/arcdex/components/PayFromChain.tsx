// Buying a coin on Arc, BNB Chain or Robinhood Chain with USDC or ETH from Ethereum, Base or Arbitrum (owner,
// 2026-10-16: "the limitation of having to be on Arc to trade"), and selling it back there (2026-10-17). A buy is one
// signature on the chain the money is on; the coin lands at the same address on the coin's chain about a second later,
// with $0.50 of that chain's gas added when the wallet has none there, so it can be sold later. A sale is one signature
// on the coin's chain; USDC or ETH lands at the same address on Ethereum, Base or Arbitrum. Through Relay
// (lib/relayQuote.ts `xevm` and `xevmout`, lib/payChains.ts): every quote checked before signing (the trader on both
// sides, exactly the amount, Relay's own contracts only), valued at the market for the price guard, the call simulated
// from the trader, approvals for exactly the amount. ARCDEX's fee is Relay's app fee, SPOT_FEE_BPS (0.5%).

import { useCallback, useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { pct } from '../lib/routerInfo'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER, SPOT_FEE_BPS } from '../lib/platform'
import { chainOfId, reportTrade } from '../lib/analytics'
import { bnbBalance, bscTx } from '../lib/bsc'
import { rhEthBalance, rhTx } from '../lib/robinhood'
import { rhEthUsd } from '../api/rhSwaps'
import { evmReader } from '../lib/across'
import { PAY_CHAINS, payBalance, payChain, payTx, richest, type PayBalance } from '../lib/payChains'
import { getRelayQuote, quoteVerdict, relayValueUsd, QUOTE_LIMITS, ARC_ID, BSC_ID, EVM_NATIVE, RH_ID, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { relayErrorText, runRelayEvm, type RelayProgress } from '../lib/relay'
import { t as T } from '../lib/i18n'
import { useBuyRisk } from '../lib/buyRisk'
import TradeDetails, { HOT } from './TradeDetails'

type Mode = 'buy' | 'sell'

interface Props {
  /** The coin's chain: Arc, BNB Chain or Robinhood Chain. */
  chainId: number
  token: string
  symbol: string
  /** The coin's market price, for the price guard. */
  priceUsd: number
  buyBlocked?: string
  /** Which side the form opens on (the phone's Buy or Sell sheet). */
  initialMode?: Mode
}

const CHAIN_NAME: Record<number, string> = { [ARC_ID]: 'Arc', [BSC_ID]: 'BNB Chain', [RH_ID]: 'Robinhood Chain' }
const GAS_NAME: Record<number, string> = { [ARC_ID]: 'USDC', [BSC_ID]: 'BNB', [RH_ID]: 'ETH' }
/** The coin chain's gas balance under which a buy adds $0.50 of it. */
const LOW_GAS: Record<number, number> = { [ARC_ID]: 0.2, [BSC_ID]: 0.0003, [RH_ID]: 0.00005 }
/** The coin chain's gas balance under which a sale can't pay for its own transactions. */
const NO_GAS: Record<number, number> = { [ARC_ID]: 0.02, [BSC_ID]: 0.00005, [RH_ID]: 0.00001 }
const GAS_TOPUP_USD = 0.5
const USD_PRESETS = [5, 10, 25, 50]
const ETH_PRESETS = [0.002, 0.005, 0.01, 0.025]
const SHARE_PRESETS = [25, 50, 100]

const coinTx = (chainId: number, h: string) => (chainId === BSC_ID ? bscTx(h) : chainId === RH_ID ? rhTx(h) : `${ARC_EXPLORER}/tx/${h}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const fmtUsd = (n: number) => (n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
/** Quotes before a wallet connects are asked for this address, so the price shows first; nothing is ever sent from or to it
 * (Buy and Sell need a connected wallet, and every quote is checked against the address it was asked for). */
const QUOTE_PLACEHOLDER = '0x1111111111111111111111111111111111111111'
const fmtEth = (wei: bigint) => { const n = Number(formatUnits(wei, 18)); return n >= 1 ? n.toFixed(3) : n.toPrecision(3) }

export default function PayFromChain({ chainId, token, symbol, priceUsd, buyBlocked, initialMode = 'buy' }: Props) {
  const trader = useTrader()
  const me = trader.address
  const kind = trader.kind ?? 'wallet'
  const [mode, setMode] = useState<Mode>(initialMode)
  const [from, setFrom] = useState(PAY_CHAINS[0].id)
  const [cur, setCur] = useState<'usdc' | 'eth'>('usdc')
  const [amount, setAmount] = useState('')
  const [bals, setBals] = useState<Record<number, PayBalance>>({})
  const [ethUsd, setEthUsd] = useState(0)
  const [gas, setGas] = useState<number | null>(null)
  const [coin, setCoin] = useState<{ raw: bigint; decimals: number } | null>(null)
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
  const selling = mode === 'sell'
  const buyRisk = useBuyRisk(!selling)
  const pc = payChain(from)!

  useEffect(() => {
    let live = true
    const load = () => void rhEthUsd().then(v => { if (live && v) setEthUsd(v) })
    load()
    const id = setInterval(load, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [])

  const refresh = useCallback(() => {
    if (!me) { setBals({}); setGas(null); setCoin(null); return }
    for (const c of PAY_CHAINS) void payBalance(c.id, me).then(b => setBals(prev => ({ ...prev, [c.id]: b }))).catch(() => {})
    if (chainId === BSC_ID) void bnbBalance(me).then(setGas).catch(() => {})
    else if (chainId === RH_ID) void rhEthBalance(me).then(b => setGas(b.amount)).catch(() => {})
    else setGas(cash)
    // The coin held on its own chain, for selling.
    const reader = evmReader(chainId)
    void Promise.all([
      reader.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [me as Address] }),
      reader.readContract({ address: token as Address, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(([raw, decimals]) => setCoin({ raw, decimals: Number(decimals) })).catch(() => {})
  }, [me, chainId, cash, token])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 20_000)
    const off = onBalances(refresh)
    return () => { clearInterval(id); off() }
  }, [refresh])

  // A buy opens on the chain and currency the trader holds the most of, once.
  useEffect(() => {
    if (picked.current || selling || !ethUsd || Object.keys(bals).length < PAY_CHAINS.length) return
    const best = richest(Object.values(bals), ethUsd)
    if (!best) return
    picked.current = true
    setFrom(best.chainId)
    const usdcUsd = Number(formatUnits(best.usdc, 6)), ethUsdHeld = Number(formatUnits(best.eth, 18)) * ethUsd
    setCur(usdcUsd >= ethUsdHeld ? 'usdc' : 'eth')
  }, [bals, ethUsd, selling])

  const bal = bals[from]
  const amountNum = Number(amount) || 0
  const inDecimals = selling ? coin?.decimals ?? 18 : cur === 'usdc' ? 6 : 18
  const amountIn = (() => { if (!(amountNum > 0)) return 0n; try { return parseUnits(amount, inDecimals) } catch { return 0n } })()
  const keepWei = parseUnits(String(pc.gasKeepEth), 18)
  const maxRaw = selling ? coin?.raw ?? null : bal ? (cur === 'usdc' ? bal.usdc : bal.eth > keepWei ? bal.eth - keepWei : 0n) : null
  const insufficient = amountIn > 0n && maxRaw !== null && amountIn > maxRaw
  // Paying with USDC still needs a little ETH there for the transaction itself; a sale needs the coin chain's gas.
  const noEthForGas = !selling && !!bal && cur === 'usdc' && amountIn > 0n && bal.eth < keepWei / 4n
  const noGasToSell = selling && amountIn > 0n && gas !== null && gas < (NO_GAS[chainId] ?? 0)
  const addGas = !selling && gas !== null && gas < (LOW_GAS[chainId] ?? 0)
  const curToken = cur === 'usdc' ? pc.usdc : EVM_NATIVE
  const curName = cur === 'usdc' ? 'USDC' : 'ETH'

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n)) return null
    const evm = me ?? QUOTE_PLACEHOLDER
    if (selling) return { side: 'xevmout', evmChain: chainId, toChain: from, mint: token, outToken: curToken, amount: amountIn, evm, sol: '', feeBps: SPOT_FEE_BPS }
    return { side: 'xevm', fromChain: from, evmChain: chainId, mint: token, inToken: curToken, amount: amountIn, evm, sol: '', feeBps: SPOT_FEE_BPS, ...(addGas ? { gasUsd: GAS_TOPUP_USD } : {}) }
  }, [amountIn, me, from, chainId, token, curToken, addGas, selling])

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
  }, [amountIn, me, from, cur, chainId, token, addGas, busy, selling])

  // The price guard. A buy: what goes in (USDC $1, ETH at its price, else Relay's own value) against the coin at its
  // market price. A sale: the coin at its market price against what comes out.
  const out = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minOut = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const curUsd = (n: number) => (cur === 'usdc' ? n : ethUsd > 0 ? n * ethUsd : 0)
  const inputUsd = selling ? amountNum * priceUsd : curUsd(amountNum) || (quote?.inUsd ?? 0)
  const outUsd = selling ? curUsd(out) || (quote?.outUsdRelay ?? 0) : out * priceUsd
  const topup = quote ? quote.gasTopupUsd : 0
  const value = quote && inputUsd > 0 && outUsd > 0 && priceUsd > 0 ? relayValueUsd({ appFeeUsd: quote.appFeeUsd, relayFeeUsd: Math.max(0, quote.relayFeeUsd - topup) }, inputUsd - topup, outUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const impactHot = refused || (impactPct ?? 0) >= HOT.impactPct
  const needsTick = verdict === 'confirm' || verdict === 'unpriced'
  const blocked = busy || !quote || quoting || insufficient || refused || (!selling && !!buyBlocked) || (needsTick && !costOk) || noEthForGas || noGasToSell || (!selling && buyRisk.blocks)

  async function submit() {
    const r = request()
    if (!r || !me || !quote || (!selling && buyRisk.blocks)) return
    setStep('working'); setLinks([])
    const signOn = selling ? CHAIN_NAME[chainId] : pc.name
    const landOn = selling ? pc.name : CHAIN_NAME[chainId]
    const say = (p: RelayProgress) => setMsg(p.step === 'quote' ? T('Checking the trade…')
      : p.step === 'approve' ? T('Approving exactly the amount…')
      : p.step === 'send' ? T('Sending…')
      : p.step === 'deliver' ? T('On its way to {chain}…', { chain: landOn })
      : T('Confirm in your wallet…'))
    try {
      const res = await runRelayEvm(kind, r, quote, say)
      const l = [{ label: T('{chain} transaction', { chain: signOn }), href: selling ? coinTx(chainId, res.tx) : payTx(from, res.tx) }]
      if (res.outTx && res.outTx !== res.tx) l.push({ label: T('Delivered'), href: selling ? payTx(from, res.outTx) : coinTx(chainId, res.outTx) })
      setLinks(l)
      if (res.status === 'refunded') throw new Error(T('Relay couldn’t fill this trade: it was refunded on {chain}.', { chain: signOn }))
      { const c = chainOfId(selling ? chainId : from); if (c) reportTrade({ chain: c, venue: 'relay', side: selling ? 'sell' : 'buy', address: me, usd: inputUsd, feeUsd: inputUsd * SPOT_FEE_BPS / 10_000, coin: token, tx: res.tx }) }
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      setMsg(res.status === 'pending' ? T('Still on its way: it lands by itself in a few minutes.')
        : T('Done: ≈{out} is in your wallet on {chain}.', { out: `${fmtTok(got)} ${selling ? curName : symbol}`, chain: landOn }))
      setStep('done'); setAmount('')
      refresh()
    } catch (e) {
      setStep('error'); setMsg(relayErrorText(e))
    }
  }

  const coinNum = coin ? Number(formatUnits(coin.raw, coin.decimals)) : null
  const balLabel = selling
    ? (coinNum !== null ? `${symbol}: ${fmtTok(coinNum)}` : null)
    : bal ? (cur === 'usdc' ? `USDC: ${fmtUsd(Number(formatUnits(bal.usdc, 6)))}` : `ETH: ${fmtEth(bal.eth)}`) : null
  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (selling ? T('Selling…') : T('Buying…'))
    : quoting && !quote ? T('Getting a quote…')
    : selling ? T('Sell {symbol}', { symbol }) : T('Buy {symbol}', { symbol })
  const switchMode = (m: Mode) => { if (busy || m === mode) return; setMode(m); setAmount(''); setStep('idle'); setMsg(''); setLinks([]) }

  return (
    <div className="swap-box sol-cross pay-from">
      <div className="sol-routes" role="group" aria-label={T('Buy or sell')}>
        <button className={!selling ? 'on' : ''} disabled={busy} onClick={() => switchMode('buy')}>{T('Buy')}</button>
        <button className={selling ? 'on' : ''} disabled={busy} onClick={() => switchMode('sell')}>{T('Sell')}</button>
      </div>
      <div className="sol-routes" role="group" aria-label={selling ? T('Receive on') : T('Pay from')}>
        <span>{selling ? T('Receive on') : T('Pay from')}</span>
        {PAY_CHAINS.map(c => {
          const b = bals[c.id]
          const has = !selling && b && (b.usdc > 0n || b.eth > 0n)
          return <button key={c.id} className={from === c.id ? 'on' : ''} disabled={busy} onClick={() => { picked.current = true; setFrom(c.id); if (!selling) setAmount('') }}>{c.name}{has ? ' •' : ''}</button>
        })}
      </div>
      <div className="sol-routes" role="group" aria-label={selling ? T('Receive') : T('Pay with')}>
        <span>{selling ? T('Receive') : T('Pay with')}</span>
        {(['usdc', 'eth'] as const).map(c => (
          <button key={c} className={cur === c ? 'on' : ''} disabled={busy} onClick={() => { picked.current = true; setCur(c); if (!selling) setAmount('') }}>{c === 'usdc' ? 'USDC' : 'ETH'}</button>
        ))}
      </div>

      <div>
        <div className="rh-field-head">
          <span>{selling ? T('You sell ({c})', { c: `${symbol} · ${CHAIN_NAME[chainId]}` }) : T('You pay ({c})', { c: `${curName} · ${pc.name}` })}</span>
          {balLabel && <button className="link-btn" onClick={() => maxRaw !== null && setAmount(formatUnits(maxRaw, inDecimals))}>{balLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder="0" value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (!busy) { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {selling
            ? SHARE_PRESETS.map(p => <button key={p} disabled={busy || !coin || coin.raw === 0n} onClick={() => coin && setAmount(formatUnits((coin.raw * BigInt(p)) / 100n, coin.decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)
            : cur === 'usdc'
              ? USD_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>)
              : ETH_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} ETH</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? `${fmtTok(out)} ${selling ? curName : symbol}` : quoting ? '…' : '—'} sub={quote && outUsd > 0 && !(selling && cur === 'usdc') ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        {value && impactHot && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : 'var(--amber)'} />}
        <TradeDetails hint={T('{fee} fee · {via}', { fee: pct(SPOT_FEE_BPS), via: 'Relay' })}>
          <Row label={T('Minimum received')} value={quote ? `${fmtTok(minOut)} ${selling ? curName : symbol}` : '—'} />
          <Row label={T('Platform fee')} value={pct(SPOT_FEE_BPS)} />
          <Row label={T('Relay')} value={quote ? fmtUsd(Math.max(0, quote.relayFeeUsd - topup)) : '—'} />
          {addGas && <Row label={T('Gas added on {chain}', { chain: CHAIN_NAME[chainId] })} value={T('{usd} of {coin}', { usd: fmtUsd(quote && topup > 0 ? topup : GAS_TOPUP_USD), coin: GAS_NAME[chainId] })} />}
          {value && !impactHot && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color="var(--green)" />}
          {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} />}
          <Row label={T('Arrives')} value={quote ? T('on {chain} in ~{s}s', { chain: selling ? pc.name : CHAIN_NAME[chainId], s: Math.max(2, quote.fillSeconds) }) : '—'} />
          <p className="swap-note">{selling
            ? T('Sell where the coin is: one signature on {chain}, and {cur} lands in the same wallet on {to} in seconds. No bridging. Every trade is checked and simulated before it’s sent.', { chain: CHAIN_NAME[chainId], cur: curName, to: pc.name })
            : T('Pay with USDC or ETH where you hold it: one signature on {from}, and the coin lands in the same wallet on {chain} in seconds. No bridging first. Every trade is checked and simulated before it’s sent.', { from: pc.name, chain: CHAIN_NAME[chainId] })}</p>
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
      {noGasToSell && <div className="rh-msg error">{T('Add a little {coin} on {chain} for the transaction’s gas.', { coin: GAS_NAME[chainId], chain: CHAIN_NAME[chainId] })}</div>}
      {!selling && buyBlocked && <div className="rh-msg error">{buyBlocked}</div>}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {!selling && buyRisk.node}

      {!me
        ? <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
        : <button className={`rh-btn ${selling ? 'sell' : 'buy'}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>}
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

/** "Ethereum, Base or Arbitrum" under a coin page's own trade forms: buy with USDC or ETH there, or sell back to them.
 * Open when the wallet has little cash on the coin's chain (Arc: under $1 of USDC), so money elsewhere is the first way
 * to buy, and on the phone's Sell sheet. */
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
        <span><b>{T('Ethereum, Base or Arbitrum')}</b><small>{T('Buy with USDC or ETH there, or sell back · one signature · no bridging')}</small></span>
        <span className="sol-pay-t">{open ? '−' : '+'}</span>
      </button>
      {open && <PayFromChain {...props} />}
    </div>
  )
}
