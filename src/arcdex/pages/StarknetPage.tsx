// /starknet — Starknet swaps through AVNU (2026-10-12; the build pack's Phase 2, "Starknet native").
//
// A Starknet wallet (Ready/Argent X, Braavos) connects through the Starknet wallet API. Quotes are AVNU's, live, and
// show everything the pack asks for before a signature: amounts, the minimum received, the route, price impact,
// slippage, fees, the quote's age, the token addresses and the approval (exactly the amount, to AVNU's Exchange).
// Each transaction is checked word by word (starknet/avnu.ts) before the wallet sees it, then followed to its receipt.
//
// Swapping is off until the owner switches it on (VITE_STARKNET_SWAPS=on); quotes still show. A wallet can always be
// checked on Sepolia with a 0 STRK transfer to itself, the pack's "signed testnet transaction".

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { useLogo } from '../lib/logo'
import { AVNU_EXCHANGE, ETH, SN, SN_FEE, STARKNET_SWAPS, STRK, voyagerContract, voyagerTx, type SnNetwork } from '../starknet/net'
import { parseUnits, sameFelt, units } from '../starknet/felt'
import { snBalance, snReceipt, type SnReceipt } from '../starknet/rpc'
import { AvnuError, avnuBuild, avnuQuote, avnuTokens, minReceived, routeNames, swapVerdict, type AvnuQuote, type SnToken } from '../starknet/avnu'
import { connectWallet, iconOf, INSTALL, invoke, switchNetwork, useSnWallet } from '../starknet/wallet'

const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb'
// The three to start with, with the logos AVNU's list gives them, until (or if) the list loads.
const FALLBACK: SnToken[] = [
  { address: STRK, symbol: 'STRK', name: 'Starknet', decimals: 18, logo: 'https://assets.coingecko.com/coins/images/26433/small/starknet.png', volumeUsd: 0 },
  { address: USDC, symbol: 'USDC', name: 'USDC', decimals: 6, logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png', volumeUsd: 0 },
  { address: ETH, symbol: 'ETH', name: 'Ethereum', decimals: 18, logo: 'https://imagedelivery.net/0xPAQaDtnQhBs8IzYRIlNg/e07829b7-0382-4e03-7ecd-a478c5aa9f00/logo', volumeUsd: 0 },
]
/** Left in the wallet when selling all of its STRK: Starknet's fees are paid in STRK. */
const STRK_RESERVE = 1n * 10n ** 18n

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const num = (n: number, dp = 6) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: dp }) : '—')
/** Starknet's fees are often a few millionths of a STRK: shown to two significant digits. */
const gasText = (n: number) => (n > 0 && n < 0.000001 ? '< 0.000001' : n > 0 && n < 0.0001 ? n.toPrecision(2) : num(n, 4))
const usd = (n: number | undefined) => (n == null || !Number.isFinite(n) ? '' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e)
  if (/reject|denied|cancel|abort/i.test(m)) return T('You cancelled it in your wallet.')
  return e instanceof AvnuError ? T(m.split(': ')[0]) + (m.includes(': ') ? `: ${m.split(': ').slice(1).join(': ')}` : '') : m.slice(0, 220)
}

function TokenLogo({ t, size = 24 }: { t: SnToken; size?: number }) {
  const { url, onError } = useLogo(t.logo, size)
  return url ? <img className="sk-logo" src={url} onError={onError} width={size} height={size} alt="" /> : <span className="sk-logo blank" style={{ width: size, height: size }}>{t.symbol.slice(0, 1)}</span>
}

function TokenPicker({ tokens, onPick, onClose }: { tokens: SnToken[]; onPick: (t: SnToken) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return tokens.slice(0, 60)
    return tokens.filter(t => t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || (s.length >= 6 && t.address.toLowerCase().includes(s.replace(/^0x0*/, '')))).slice(0, 60)
  }, [q, tokens])
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card sk-picker" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('Choose a token')}</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <input className="sk-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={T('Name, ticker or address')} />
        <div className="sk-list">
          {list.map(t => (
            <button key={t.address} onClick={() => { onPick(t); onClose() }}>
              <TokenLogo t={t} size={28} />
              <span><b>{t.symbol}</b><small>{t.name}</small></span>
              <code>{short(t.address)}</code>
            </button>
          ))}
          {!list.length && <div className="fx-empty">{T('No verified token matches.')}</div>}
        </div>
        <p className="fx-fine">{T('AVNU’s verified Starknet tokens.')}</p>
      </div>
    </div>
  )
}

/** A transaction's receipt once Starknet has accepted it (or reverted it); null if it takes over three minutes. */
async function waitReceipt(net: SnNetwork, hash: string, onTick?: (r: SnReceipt | null) => void): Promise<SnReceipt | null> {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    const r = await snReceipt(net, hash).catch(() => null)
    onTick?.(r)
    if (r && (r.execution_status === 'REVERTED' || /ACCEPTED_ON_L[12]/.test(r.finality_status))) return r
    await new Promise(res => setTimeout(res, 2_000))
  }
  return null
}

type TxState = { net: SnNetwork; hash: string; status: 'pending' | 'done' | 'failed' | 'slow'; reason?: string }

function TxLine({ tx }: { tx: TxState }) {
  return (
    <div className={`sk-tx ${tx.status}`}>
      <span>{tx.status === 'pending' ? T('Submitted: waiting for Starknet…') : tx.status === 'done' ? T('Confirmed on Starknet') : tx.status === 'slow' ? T('Still pending after 3 minutes: follow it on the explorer.') : T('Reverted')}{tx.reason ? `: ${tx.reason.slice(0, 160)}` : ''}</span>
      <a href={voyagerTx(tx.net, tx.hash)} target="_blank" rel="noreferrer">{short(tx.hash)} ↗</a>
    </div>
  )
}

export default function StarknetPage({ navigate }: { navigate: (p: Page) => void }) {
  const sw = useSnWallet()
  const s = sw.session
  const [tokens, setTokens] = useState<SnToken[]>(FALLBACK)
  const [sell, setSell] = useState<SnToken>(FALLBACK[0])
  const [buy, setBuy] = useState<SnToken>(FALLBACK[1])
  const [picking, setPicking] = useState<'sell' | 'buy' | null>(null)
  const [amount, setAmount] = useState('10')
  const [slip, setSlip] = useState(0.01)
  const [quote, setQuote] = useState<{ q: AvnuQuote; at: number } | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [qErr, setQErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [bal, setBal] = useState<Record<string, bigint>>({})
  const [step, setStep] = useState<null | 'quote' | 'build' | 'sign' | 'wait'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tx, setTx] = useState<TxState | null>(null)
  const [tick, setTick] = useState(false)
  const [test, setTest] = useState<{ busy: boolean; tx: TxState | null; err: string | null }>({ busy: false, tx: null, err: null })

  useEffect(() => { document.title = 'Starknet swaps | ARCDEX' }, [])
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null
    const load = () => void avnuTokens('mainnet').then(list => {
      if (!alive || !list.length) return
      setTokens(list)
      // The two picked so far become AVNU's own entries (with their logos).
      const own = (t: SnToken) => list.find(x => sameFelt(x.address, t.address)) ?? t
      setSell(own); setBuy(own)
    }).catch(() => { if (alive) timer = setTimeout(load, 30_000) })
    load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(id) }, [])

  const taker = s?.network === 'mainnet' ? s.address : ''
  const sellAmount = parseUnits(amount, sell.decimals)
  const same = sameFelt(sell.address, buy.address)
  const askKey = `${sell.address}|${buy.address}|${sellAmount ?? ''}|${taker}`

  // AVNU's quote, a moment after typing stops, then again every 15 seconds.
  useEffect(() => {
    setQuote(null); setQErr(null); setTick(false)
    if (!sellAmount || sellAmount <= 0n || same) return
    let alive = true
    const ctl = new AbortController()
    const run = async () => {
      setQuoting(true)
      try {
        const q = await avnuQuote({ net: 'mainnet', sellToken: sell.address, buyToken: buy.address, sellAmount, taker }, ctl.signal)
        if (alive) { setQuote({ q, at: Date.now() }); setQErr(null) }
      } catch (e) { if (alive && !ctl.signal.aborted) { setQuote(null); setQErr(errText(e)) } }
      finally { if (alive) setQuoting(false) }
    }
    const t = setTimeout(() => void run(), 450)
    const id = setInterval(() => { if (document.visibilityState === 'visible') void run() }, 15_000)
    return () => { alive = false; ctl.abort(); clearTimeout(t); clearInterval(id) }
  }, [askKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Balances of the two tokens, for the wallet on Starknet.
  const loadBalances = useCallback(async () => {
    if (!taker) { setBal({}); return }
    const [a, b] = await Promise.all([snBalance('mainnet', sell.address, taker).catch(() => null), snBalance('mainnet', buy.address, taker).catch(() => null)])
    setBal(prev => ({ ...prev, ...(a !== null ? { [sell.address]: a } : {}), ...(b !== null ? { [buy.address]: b } : {}) }))
  }, [taker, sell.address, buy.address])
  useEffect(() => { void loadBalances() }, [loadBalances])

  const sellBal = bal[sell.address]
  const buyBal = bal[buy.address]
  const q = quote?.q ?? null
  const buyAmount = q ? BigInt(q.buyAmount) : null
  const minEst = buyAmount !== null ? (buyAmount * BigInt(Math.round((1 - slip) * 1_000_000))) / 1_000_000n : null
  const verdict = q ? swapVerdict(q) : null
  const age = quote ? Math.max(0, Math.round((now - quote.at) / 1000)) : null
  const short_ = sellAmount !== null && sellBal !== undefined && sellAmount > sellBal
  const rate = q && sellAmount ? units(BigInt(q.buyAmount), buy.decimals) / units(sellAmount, sell.decimals) : null

  const setMax = () => {
    if (sellBal === undefined) return
    const max = sameFelt(sell.address, STRK) ? (sellBal > STRK_RESERVE ? sellBal - STRK_RESERVE : 0n) : sellBal
    setAmount(String(units(max, sell.decimals)))
  }

  async function swap() {
    if (!s || !sellAmount || !q) return
    setErr(null); setTx(null)
    try {
      setStep('quote')
      const ask = { net: 'mainnet' as const, sellToken: sell.address, buyToken: buy.address, sellAmount, taker: s.address, slippage: slip }
      const fresh = await avnuQuote(ask)
      // A fresh quote paying 3% less than the one on screen stops here, so nothing is signed that wasn't shown.
      if (BigInt(fresh.buyAmount) * 100n < BigInt(q.buyAmount) * 97n) { setQuote({ q: fresh, at: Date.now() }); throw new Error(T('The price moved: check the new quote before swapping.')) }
      const v = swapVerdict(fresh)
      if (!v.ok) throw new Error(T('This swap would lose {pct}% to price impact: it’s refused.', { pct: v.lossPct.toFixed(1) }))
      if (v.confirm && !tick) throw new Error(T('Tick the box to accept the price impact first.'))
      setStep('build')
      const calls = await avnuBuild(fresh, ask)
      setStep('sign')
      const hash = await invoke(s.wallet, calls)
      setTx({ net: 'mainnet', hash, status: 'pending' })
      setStep('wait')
      const r = await waitReceipt('mainnet', hash)
      setTx({ net: 'mainnet', hash, status: !r ? 'slow' : r.execution_status === 'REVERTED' ? 'failed' : 'done', reason: r?.revert_reason })
      void loadBalances()
      setTimeout(() => void loadBalances(), 4_000)
    } catch (e) { setErr(errText(e)) }
    finally { setStep(null) }
  }

  async function testnetCheck() {
    if (!s) return
    setTest({ busy: true, tx: null, err: null })
    try {
      if (s.network !== 'sepolia') await switchNetwork(s.wallet, 'sepolia')
      // The account on Sepolia, as the wallet has it there.
      const { address } = await connectWallet(s.wallet)
      const hash = await invoke(s.wallet, [{ contractAddress: STRK, entrypoint: 'transfer', calldata: [address, '0x0', '0x0'] }])
      setTest({ busy: true, tx: { net: 'sepolia', hash, status: 'pending' }, err: null })
      const r = await waitReceipt('sepolia', hash)
      setTest({ busy: false, tx: { net: 'sepolia', hash, status: !r ? 'slow' : r.execution_status === 'REVERTED' ? 'failed' : 'done', reason: r?.revert_reason }, err: null })
    } catch (e) { setTest(t => ({ busy: false, tx: t.tx, err: errText(e) })) }
    finally { void sw.refresh() }
  }

  let action: JSX.Element
  if (!STARKNET_SWAPS) action = <button className="fx-go" disabled>{T('Swaps open soon')}</button>
  else if (!s) action = <button className="fx-go fx-go-primary" onClick={() => document.getElementById('sk-wallet')?.scrollIntoView({ behavior: 'smooth' })}>{T('Connect a Starknet wallet')}</button>
  else if (s.network !== 'mainnet') action = <button className="fx-go fx-go-primary" onClick={() => void switchNetwork(s.wallet, 'mainnet').then(sw.refresh).catch(e => setErr(errText(e)))}>{T('Switch your wallet to Starknet')}</button>
  else if (short_) action = <button className="fx-go" disabled>{T('Not enough {sym}', { sym: sell.symbol })}</button>
  else if (verdict && !verdict.ok) action = <button className="fx-go" disabled>{T('Price impact too high')}</button>
  else action = <button className="fx-go fx-go-primary" disabled={!q || step !== null || (verdict?.confirm && !tick)} onClick={() => void swap()}>{step === 'quote' ? T('Checking the price…') : step === 'build' ? T('Checking the transaction…') : step === 'sign' ? T('Confirm in your wallet…') : step === 'wait' ? T('Waiting for Starknet…') : T('Swap')}</button>

  return (
    <div className="xs-page sk-page">
      <div className="xs-head">
        <h1>Starknet</h1>
        <p>{T('Swap Starknet tokens at the best price across Starknet’s exchanges, routed by AVNU. Your wallet signs every transaction; ARCDEX never holds your coins.')}</p>
      </div>
      <div className="xs-grid">
        <div className="xs-main">
          <div className="xs-card">
            <div className="xs-box">
              <div className="xs-box-h"><span>{T('You pay')}</span>{sellBal !== undefined && <button className="link-btn" onClick={setMax}>{T('Balance')}: {num(units(sellBal, sell.decimals))} · {T('Max')}</button>}</div>
              <div className="sk-row">
                <input className="sk-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/,/g, '.').replace(/[^0-9.]/g, ''))} placeholder="0" />
                <button className="sk-token" onClick={() => setPicking('sell')}><TokenLogo t={sell} /> <b>{sell.symbol}</b> ▾</button>
              </div>
              <div className="xs-box-f">{q?.sellAmountInUsd ? usd(q.sellAmountInUsd) : ' '}</div>
            </div>
            <button className="sk-flip" onClick={() => { setSell(buy); setBuy(sell); setAmount('') }} aria-label={T('Swap the two tokens')}>⇅</button>
            <div className="xs-box xs-box-to">
              <div className="xs-box-h"><span>{T('You receive')}</span>{buyBal !== undefined && <span>{T('Balance')}: {num(units(buyBal, buy.decimals))}</span>}</div>
              <div className="sk-row">
                <div className="sk-amount sk-out">{buyAmount !== null ? num(units(buyAmount, buy.decimals)) : quoting ? '…' : '0'}</div>
                <button className="sk-token" onClick={() => setPicking('buy')}><TokenLogo t={buy} /> <b>{buy.symbol}</b> ▾</button>
              </div>
              <div className="xs-box-f">{q?.buyAmountInUsd ? usd(q.buyAmountInUsd) : ' '}</div>
            </div>

            {same && <div className="fx-hint-bad">{T('Pick two different tokens.')}</div>}
            {qErr && <div className="fx-hint-bad">⚠ {qErr}</div>}

            {q && sellAmount !== null && sellAmount > 0n && (
              <div className="fx-summary sk-details">
                <div><span>{T('Rate')}</span><b>1 {sell.symbol} = {num(rate ?? 0, 8)} {buy.symbol}</b></div>
                <div><span>{T('Minimum received')}</span><b>{minEst !== null ? `${num(units(minEst, buy.decimals))} ${buy.symbol}` : '—'}</b></div>
                <div><span>{T('Price impact')}</span><b className={q.priceImpact < 0 ? (verdict!.confirm ? 'fx-down' : '') : 'fx-up'}>{q.priceImpact >= 0 ? '+' : '−'}{Math.abs(q.priceImpact / 100).toFixed(2)}%</b></div>
                <div><span>{T('Max slippage')}</span><b>{[0.005, 0.01, 0.02].map(v => <button key={v} className={`hl-slip${slip === v ? ' active' : ''}`} onClick={() => setSlip(v)}>{v * 100}%</button>)}</b></div>
                <div><span>{T('Route')}</span><b className="sk-route">{routeNames(q.routes).join(' · ')}</b></div>
                <div><span>{T('AVNU fee')}</span><b>{(Number(BigInt(q.fee.avnuFeesBps)) / 100).toFixed(2)}% {usd(q.fee.avnuFeesInUsd)}</b></div>
                <div><span>{T('ARCDEX fee')}</span><b>{SN_FEE ? `${(SN_FEE.bps / 100).toFixed(2)}% ${usd(q.fee.integratorFeesInUsd)}` : T('None')}</b></div>
                <div><span>{T('Network fee (est.)')}</span><b>{BigInt(q.gasFees) > 0n ? `${gasText(units(BigInt(q.gasFees), 18))} STRK ${q.gasFeesInUsd != null && q.gasFeesInUsd < 0.01 ? '< $0.01' : usd(q.gasFeesInUsd)}` : T('Once a wallet is connected')}</b></div>
                <div><span>{T('Quote')}</span><b>{age === null ? '—' : T('{n}s old, refreshed every 15s', { n: age })}{quoting ? ' …' : ''}</b></div>
                <div><span>{T('Approval')}</span><b>{T('Exactly {amount} {sym} to', { amount: num(units(sellAmount, sell.decimals)), sym: sell.symbol })} <a href={voyagerContract('mainnet', AVNU_EXCHANGE)} target="_blank" rel="noreferrer">AVNU {short(AVNU_EXCHANGE)} ↗</a></b></div>
                <div><span>{T('Tokens')}</span><b><a href={voyagerContract('mainnet', sell.address)} target="_blank" rel="noreferrer">{sell.symbol} {short(sell.address)} ↗</a> · <a href={voyagerContract('mainnet', buy.address)} target="_blank" rel="noreferrer">{buy.symbol} {short(buy.address)} ↗</a></b></div>
              </div>
            )}
            {verdict?.confirm && verdict.ok && <label className="fxb-check"><input type="checkbox" checked={tick} onChange={e => setTick(e.target.checked)} /> {T('I accept losing about {pct}% to price impact', { pct: verdict.lossPct.toFixed(1) })}</label>}

            {action}
            {!STARKNET_SWAPS && <div className="fx-fine">{T('Quotes are live from AVNU. Sending swaps is switched off for now.')}</div>}
            {err && <div className="fx-hint-bad">⚠ {err}</div>}
            {tx && <TxLine tx={tx} />}
          </div>
        </div>

        <aside className="xs-side">
          <div className="xs-panel" id="sk-wallet">
            <b>{T('Starknet wallet')}</b>
            {s ? (
              <>
                <div className="sk-acct">
                  {iconOf(s.wallet) && <img src={iconOf(s.wallet)} width={20} height={20} alt="" />}
                  <span>{s.wallet.name}</span>
                  <code>{short(s.address)}</code>
                </div>
                <div className={`sk-net ${s.network === 'mainnet' ? 'ok' : 'warn'}`}>{s.network ? SN[s.network].name : T('A network ARCDEX doesn’t use ({id})', { id: s.chainId })}</div>
                <button className="link-btn" onClick={sw.disconnect}>{T('Disconnect')}</button>
              </>
            ) : sw.wallets.length ? (
              <div className="sk-wallets">
                {sw.wallets.map(w => (
                  <button key={w.id} className="btn-ghost" onClick={() => void sw.connect(w)}>{iconOf(w) && <img src={iconOf(w)} width={18} height={18} alt="" />} {T('Connect {name}', { name: w.name })}</button>
                ))}
              </div>
            ) : (
              <>
                <p>{T('No Starknet wallet found in this browser. Install one, then reload:')}</p>
                <div className="sk-wallets">{INSTALL.map(i => <a key={i.name} className="btn-ghost" href={i.url} target="_blank" rel="noreferrer">{i.name} ↗</a>)}</div>
              </>
            )}
            {sw.error && <div className="fx-hint-bad">⚠ {sw.error}</div>}
          </div>

          <div className="xs-panel">
            <b>{T('Check your wallet on testnet')}</b>
            <p>{T('Signs a transfer of 0 STRK to yourself on Starknet Sepolia, then waits for it to be confirmed. Nothing of value moves; the testnet fee is paid in Sepolia STRK.')}</p>
            <button className="btn-ghost" disabled={!s || test.busy} onClick={() => void testnetCheck()}>{test.busy ? T('Waiting for Sepolia…') : T('Send a 0 STRK test transaction')}</button>
            {!s && <small className="fx-fine">{T('Connect a wallet first.')}</small>}
            {test.tx && <TxLine tx={test.tx} />}
            {test.err && <div className="fx-hint-bad">⚠ {test.err}</div>}
            <small className="fx-fine"><a href="https://faucet.starknet.io" target="_blank" rel="noreferrer">{T('Sepolia STRK from the Starknet Foundation’s faucet')} ↗</a></small>
          </div>

          <div className="xs-panel">
            <b>{T('Before you sign')}</b>
            <ol className="xs-steps">
              <li>{T('AVNU finds the best route across Starknet’s exchanges and quotes it.')}</li>
              <li>{T('ARCDEX checks the transaction AVNU builds: an approval of exactly your amount to AVNU’s Exchange, your address as the one paid, and a minimum within your slippage.')}</li>
              <li>{T('Your wallet signs; the swap settles on Starknet in seconds, and you can follow it on Voyager.')}</li>
            </ol>
            <button className="link-btn" onClick={() => navigate({ name: 'routes' })}>{T('Every supported route')} →</button>
          </div>
        </aside>
      </div>

      {picking && <TokenPicker tokens={tokens} onPick={t => { if (picking === 'sell') setSell(t); else setBuy(t) }} onClose={() => setPicking(null)} />}
    </div>
  )
}
