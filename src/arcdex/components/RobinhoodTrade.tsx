// Buy or sell a Robinhood Chain coin from ARCDEX (lib/across.ts).
//
// Buy: pay USDC on Arc (Arc's gas is USDC too, so the trading wallet trades
// at once); the coin arrives at the same address on Robinhood Chain in
// seconds. Sell: signed on Robinhood Chain, where gas is ETH (a few cents,
// added in one tap from Arc's USDC); the USDC lands on Arc. ARCDEX's fee
// (the swap router's, 2%) comes out of what the trade delivers.
//
// Robinhood's stock tokens can't be bought from some countries
// (lib/robinhood.ts STOCK_RESTRICTED): the buy side checks the visitor's
// country and asks for their word first. Selling is never blocked.

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { useTrader, shortAddr } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { useRouterInfo, pct } from '../lib/routerInfo'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER, FEE_WALLET } from '../lib/platform'
import { visitorCountry } from '../lib/geo'
import { rhEthBalance, rhTokenBalance, rhTx, SELL_GAS_ETH, STOCK_RESTRICTED } from '../lib/robinhood'
import { getAcrossQuote, QUOTE_LIMITS, quoteValue, quoteVerdict, type AcrossQuote, type QuoteRequest } from '../lib/acrossQuote'
import { acrossErrorText, runAcross, type AcrossProgress } from '../lib/across'
import { t as T } from '../lib/i18n'

interface Props {
  token: string
  symbol: string
  /** Null until known (read from the chain). */
  decimals: number | null
  priceUsd: number
  /** One of Robinhood's stock tokens (checked on-chain by the page). */
  stock: boolean
  side?: 'buy' | 'sell'
  initialMode?: 'buy' | 'sell'
  /** The spot screen shows its notes once, under both forms. */
  compact?: boolean
  /** Why this coin can't be bought here (not from a launchpad); selling stays open. */
  buyBlocked?: string
  onTraded?: () => void
}

/** USDC a buy at Cash (max) leaves on Arc for its own gas. */
const GAS_RESERVE = 0.15
/** The gas top-up: $0.50 of ETH on Robinhood Chain, ~10–20 sales. */
const GAS_TOPUP = 0.5
const GAS_TOPUP_UNITS = 500_000n
const BUY_PRESETS = [5, 10, 25, 50]
const SELL_PRESETS = [25, 50, 100]
const ATTEST_KEY = 'arcdex:rh-stock-attest:v1'

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const arcTx = (h: string) => `${ARC_EXPLORER}/tx/${h}`
const fmtTimes = (r: number) => (r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1))

function readAttest(): boolean { try { return localStorage.getItem(ATTEST_KEY) === '1' } catch { return false } }
function writeAttest(v: boolean) { try { if (v) localStorage.setItem(ATTEST_KEY, '1'); else localStorage.removeItem(ATTEST_KEY) } catch { /* blocked */ } }

type Step = 'idle' | 'working' | 'done' | 'error'

export default function RobinhoodTrade({ token, symbol, decimals, priceUsd, stock, side, initialMode, compact, buyBlocked, onTraded }: Props) {
  const trader = useTrader()
  const me = trader.address
  const info = useRouterInfo()
  const feeBps = info?.feeBps ?? 200
  const [mode, setMode] = useState<'buy' | 'sell'>(side ?? initialMode ?? 'buy')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<AcrossQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [progress, setProgress] = useState<AcrossProgress | null>(null)
  const [msg, setMsg] = useState('')
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [costOk, setCostOk] = useState(false)
  const [topUp, setTopUp] = useState(true)
  const { cash, refresh: refreshCash } = useCash(me)
  const [holding, setHolding] = useState<{ raw: bigint; amount: number; decimals: number } | null>(null)
  const [eth, setEth] = useState<number | null>(null)
  const [country, setCountry] = useState<string | null | undefined>(undefined)
  const [attested, setAttested] = useState(readAttest)
  const busy = step === 'working'

  // Balances on Robinhood Chain: the coin, and ETH for gas.
  const refreshRh = useCallback(() => {
    if (!me) { setHolding(null); setEth(null); return }
    void rhTokenBalance(token, me, decimals ?? undefined).then(setHolding).catch(() => {})
    void rhEthBalance(me).then(b => setEth(b.amount)).catch(() => {})
  }, [me, token, decimals])
  useEffect(() => {
    refreshRh()
    const id = setInterval(() => { if (!document.hidden) refreshRh() }, 15_000)
    const off = onBalances(refreshRh)
    return () => { clearInterval(id); off() }
  }, [refreshRh])

  useEffect(() => { if (stock && mode === 'buy') void visitorCountry().then(setCountry) }, [stock, mode])

  const dec = holding?.decimals ?? decimals ?? 18
  const amountNum = Number(amount) || 0
  const amountIn = (() => {
    if (!(amountNum > 0)) return 0n
    try { return parseUnits(amount, mode === 'buy' ? 6 : dec) } catch { return 0n }
  })()
  const needsGas = me !== null && eth !== null && eth < SELL_GAS_ETH
  const willTopUp = mode === 'buy' && needsGas && topUp
  const reserve = GAS_RESERVE + (willTopUp ? GAS_TOPUP : 0)
  const maxBuy = cash !== null ? Math.max(0, cash - reserve) : null
  const insufficient = me !== null && (mode === 'buy'
    ? cash !== null && amountNum > 0 && amountNum + reserve > cash + 1e-9
    : holding !== null && amountIn > holding.raw)

  const request = useCallback((): QuoteRequest | null => (amountIn > 0n
    // Without a wallet the quote is only shown: it's asked as the fee wallet, never sent.
    ? { side: mode, token, amount: amountIn, trader: me ?? FEE_WALLET, feeBps }
    : null), [amountIn, mode, token, me, feeBps])

  // A fresh quote after typing stops, and every 20s while it's on screen (Across's quotes last ~30s).
  const seq = useRef(0)
  useEffect(() => {
    if (busy) return
    setQuote(null); setQuoteErr(''); setCostOk(false)
    const r = request()
    if (!r) return
    const n = ++seq.current
    const ask = () => {
      setQuoting(true)
      getAcrossQuote(r)
        .then(q => { if (seq.current === n) { setQuote(q); setQuoteErr('') } })
        .catch(e => { if (seq.current === n) { setQuote(null); setQuoteErr(acrossErrorText(e)) } })
        .finally(() => { if (seq.current === n) setQuoting(false) })
    }
    const first = setTimeout(ask, 500)
    const again = setInterval(() => { if (!document.hidden) ask() }, 20_000)
    return () => { clearTimeout(first); clearInterval(again) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, mode, token, me, feeBps, busy])

  // What the trade delivers, valued at the coin's market price (its busiest
  // real pool): price impact, and everything it costs. A route through an
  // off-market pool, or one losing half the trade, is never sent.
  const outAmount = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minAmount = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const outUsd = mode === 'buy' ? outAmount * priceUsd : outAmount
  const value = quote ? quoteValue(quote, amountNum, priceUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const needsCostTick = verdict === 'confirm' || verdict === 'unpriced'

  // Stock tokens: the buyer's country, then their word.
  const gate: 'ok' | 'checking' | 'blocked' | 'unknown' | 'attest' = !(stock && mode === 'buy') ? 'ok'
    : country === undefined ? 'checking'
    : country === null ? 'unknown'
    : STOCK_RESTRICTED.has(country) ? 'blocked'
    : attested ? 'ok' : 'attest'

  const sellNoGas = mode === 'sell' && me !== null && eth !== null && eth === 0
  const noBuy = mode === 'buy' && !!buyBlocked
  const blocked = busy || !quote || quoting || insufficient || refused || noBuy || (needsCostTick && !costOk) || gate !== 'ok' || sellNoGas

  const kindOf = () => trader.kind ?? 'wallet'

  /** $0.50 of USDC on Arc → ETH on Robinhood Chain. Returns what happened, in words. */
  async function topUpGas(): Promise<{ ok: boolean; text: string }> {
    if (!me) return { ok: false, text: '' }
    const r = await runAcross(kindOf(), { side: 'gas', token: '', amount: GAS_TOPUP_UNITS, trader: me, feeBps: 0 }, null, () => {})
    setLinks(l => [...l, { label: T('Gas transaction'), href: arcTx(r.depositTx) }])
    refreshRh(); refreshCash()
    return r.status === 'filled' ? { ok: true, text: T('Gas added: you can sell on Robinhood Chain now.') }
      : r.status === 'pending' ? { ok: true, text: T('The gas is still on its way: it lands by itself.') }
      : { ok: false, text: T('Across couldn’t deliver the gas: your USDC was refunded on Arc.') }
  }

  async function addGas() {
    setStep('working'); setLinks([]); setMsg(T('Adding gas: ${n} of ETH on Robinhood Chain…', { n: GAS_TOPUP.toFixed(2) }))
    try { const g = await topUpGas(); setStep(g.ok ? 'done' : 'error'); setMsg(g.text) }
    catch (e) { setStep('error'); setMsg(acrossErrorText(e)) }
  }

  async function submit() {
    const r = request()
    if (!r || !me || !quote) return
    setStep('working'); setLinks([]); setProgress(null)
    const where = mode === 'buy' ? T('Robinhood Chain') : 'Arc'
    const say = (p: AcrossProgress) => {
      setProgress(p)
      setMsg(p.step === 'quote' ? T('Checking the trade…')
        : p.step === 'approve' ? T('Approving exactly {n} {sym}…', { n: amount, sym: mode === 'buy' ? 'USDC' : symbol })
        : p.step === 'send' ? T('Sending…')
        : p.step === 'bridge' ? T('On its way to {where}…', { where })
        : T('Done'))
    }
    try {
      const res = await runAcross(kindOf(), r, quote, say, { approveExtra: willTopUp ? GAS_TOPUP_UNITS : 0n })
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      const out = mode === 'buy' ? `${fmtTok(got)} ${symbol}` : fmtUsd(got)
      const l = [{ label: mode === 'buy' ? T('Arc transaction') : T('Robinhood Chain transaction'), href: mode === 'buy' ? arcTx(res.depositTx) : rhTx(res.depositTx) }]
      if (res.fillTx) l.push({ label: T('Delivered'), href: mode === 'buy' ? rhTx(res.fillTx) : arcTx(res.fillTx) })
      setLinks(l)
      if (res.status === 'filled') {
        const done = mode === 'buy' ? T('Bought ≈{out}: it’s in your wallet on Robinhood Chain.', { out }) : T('Sold: ≈{out} USDC is back on Arc.', { out })
        setAmount('')
        onTraded?.()
        if (willTopUp) {
          setMsg(`${done} ${T('Adding gas…')}`)
          const g = await topUpGas().catch(e => ({ ok: false, text: acrossErrorText(e) }))
          setMsg(`${done} ${g.text}`)
        } else setMsg(done)
        setStep('done')
      } else if (res.status === 'pending') {
        setStep('done'); setMsg(T('Still on its way: it lands by itself in a few minutes.'))
      } else {
        setStep('error')
        setMsg(mode === 'buy' ? T('Across couldn’t fill this buy: your USDC was refunded on Arc.') : T('Across couldn’t fill this sale: it was refunded as USDG on Robinhood Chain.'))
      }
      refreshRh(); refreshCash()
    } catch (e) {
      setStep('error'); setMsg(acrossErrorText(e, mode === 'sell' ? 4663 : 5042))
    } finally {
      setProgress(null)
    }
  }

  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (progress?.step === 'approve' ? T('Approving…') : progress?.step === 'bridge' ? T('Delivering…') : mode === 'buy' ? T('Buying…') : T('Selling…'))
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
          {me && (mode === 'buy'
            ? cash !== null && <button className="link-btn" onClick={() => maxBuy !== null && setAmount(maxBuy > 0 ? maxBuy.toFixed(2) : '0')}>{T('Cash')}: {fmtUsd(cash)}</button>
            : holding !== null && <button className="link-btn" onClick={() => setAmount(formatUnits(holding.raw, holding.decimals))}>{T('Holding')}: {fmtTok(holding.amount)}</button>)}
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
        <Row label={T('Platform fee')} value={mode === 'buy' ? T('{pct} (in {symbol})', { pct: pct(feeBps), symbol }) : T('{pct} (in USDC)', { pct: pct(feeBps) })} />
        <Row label={T('Bridge & gas (Across)')} value={quote ? fmtUsd(quote.bridgeFeeUsd) : '—'} />
        {value && <Row label={T('Price impact')} value={verdict === 'off-market' ? T('{x}× the market price', { x: fmtTimes(value.rate) }) : impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`}
          color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : impactPct! >= 5 ? 'var(--amber)' : 'var(--green)'} />}
        {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} color={cost! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : cost! >= 6 ? 'var(--amber)' : undefined} />}
        <Row label={T('Arrives')} value={quote ? (mode === 'buy' ? T('on Robinhood Chain in ~{s}s', { s: Math.max(2, quote.fillSeconds) }) : T('on Arc in ~{s}s', { s: Math.max(2, quote.fillSeconds) })) : '—'} />
      </div>

      {quoteErr && !busy && <div className="rh-msg error">{quoteErr}</div>}

      {verdict === 'off-market' && !busy && (
        <div className="rh-msg error">{T('This quote pays {x}× {symbol}’s market price: Across would route it through a pool priced far off the market, the way trap pools catch trades. ARCDEX won’t send it.', { x: fmtTimes(value!.rate), symbol })}</div>
      )}
      {verdict === 'refuse' && !busy && (
        <div className="rh-msg error">{T('Across’s best route loses {n}% of this trade to price impact, so ARCDEX won’t send it. A smaller amount may route better; if not, {symbol} has no fair route right now.', { n: impactPct!.toFixed(0), symbol })}</div>
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
          {T('Also add ${n} of ETH for gas on Robinhood Chain, so you can sell later.', { n: GAS_TOPUP.toFixed(2) })}
        </label>
      )}

      {mode === 'sell' && needsGas && (
        <div className="rh-gas">
          <span>{T('Selling is signed on Robinhood Chain, where gas is paid in ETH (a few cents a sale).')}</span>
          <button className="mk-trade mk-trade-solid mk-trade-sm" disabled={busy} onClick={() => void addGas()}>{T('Add ${n} of gas', { n: GAS_TOPUP.toFixed(2) })}</button>
        </div>
      )}

      {noBuy && <div className="rh-msg error">{buyBlocked}</div>}
      {gate === 'blocked' && <div className="rh-msg error">{T('Stock tokens can’t be bought from your country ({c}). You can still sell any you hold.', { c: country ?? '' })}</div>}
      {gate === 'unknown' && <div className="rh-msg error">{T('Your location couldn’t be checked, so stock tokens can’t be bought from here right now.')}</div>}
      {gate === 'attest' && (
        <label className="rh-tick">
          <input type="checkbox" checked={attested} onChange={e => { setAttested(e.target.checked); writeAttest(e.target.checked) }} />
          {T('I am not a US person, and I don’t live in the US, Canada, the UK, Switzerland, the UAE or a sanctioned country.')}
        </label>
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
          <Note>{T('Or unlock your')}{' '}<button className="link-btn" onClick={openTradingWallet}>{T('trading wallet')}</button>{' '}{T('for one-tap trades with no pop-ups.')}</Note>
        </>
      ) : (
        <button className={`rh-btn ${mode}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>
      )}

      {me && !compact && (
        <div className="swap-note">{T('Trading as')}{' '}{trader.kind === 'trading-wallet' ? T('⚡ trading wallet') : T('wallet')} <span style={{ fontFamily: 'var(--mono)' }}>{shortAddr(me)}</span>
          {mode === 'sell' && eth !== null && <> · {T('Gas')}: {eth.toPrecision(2)} ETH</>}
        </div>
      )}
      {!compact && <p className="swap-note">{RH_NOTE()}</p>}
    </div>
  )
}

/** The note under the trade forms. */
export const RH_NOTE = () => T('Bought with USDC on Arc and delivered to your same address on Robinhood Chain by Across; sales come back as USDC on Arc. Every trade is checked and simulated before it’s sent, and approvals are for the exact amount.')

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

