// Trading Arc, BNB Chain and Robinhood Chain from a Solana wallet (2026-10-05, owner: "Solana wallets connect, transact,
// swap and bridge; buy other chains' coins with SOL and USDC on Solana; attract Solana meme users").
//
//   buy       SOL or USDC on Solana → the coin, signed in the Solana wallet, delivered to the trader's ARCDEX account
//             (lib/solAccount.ts: opened from that wallet's signature) in a second or two, with $0.50 of the chain's gas
//             added when the account has none, so the coin can be sold later.
//   sell      the coin → SOL or USDC, signed by the account on its chain (one tap), paid to the Solana wallet.
//   deposit   SOL or USDC on Solana → USDC on Arc (the account's cash).
//   withdraw  USDC on Arc → SOL or USDC in the Solana wallet.
// All through Relay (lib/relayQuote.ts `xin` / `xout`): every quote checked before signing, valued at the market for the
// price guard, approvals for the exact amount. ARCDEX's fee is Relay's app fee: 2% on trades, 0.5% on deposits and
// withdrawals (as the bridge's).

import { useCallback, useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { openConnectModal } from './ConnectWallet'
import { PasscodeField, useWithdrawGuard } from './WithdrawGuard'
import { SolanaWalletBar, solSignerOf } from './SolanaTrade'
import { client as arcClient } from '../api/launchpad'
import { solUsd } from '../api/solanaMarket'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { useRouterInfo, pct } from '../lib/routerInfo'
import { onBalances } from '../lib/balances'
import { ARC_EXPLORER } from '../lib/platform'
import { accountOwner, isUnlocked } from '../lib/embeddedWallet'
import { solBalance, solTokenBalance, solTx, type SolHolding } from '../lib/solana'
import { connectSolanaWallet, phantomLink, pickSolSigner, useSolanaWallets } from '../lib/solanaWallet'
import { openSolAccount } from '../lib/solAccount'
import { bnbBalance, bscClient, bscTokenBalance, bscTx } from '../lib/bsc'
import { rhClient, rhEthBalance, rhTokenBalance, rhTx } from '../lib/robinhood'
import { getRelayQuote, quoteVerdict, relayValueUsd, QUOTE_LIMITS, ARC_ID, BSC_ID, RH_ID, SOL_NATIVE, SOL_USDC, type RelayQuote, type RelayRequest } from '../lib/relayQuote'
import { ARC_USDC } from '../lib/acrossQuote'
import { relayErrorText, runRelayEvm, runRelaySolana, type RelayProgress } from '../lib/relay'
import { t as T } from '../lib/i18n'

export type CrossMode = 'buy' | 'sell' | 'deposit' | 'withdraw'

interface Props {
  chainId: number
  /** The EVM token: the coin, or Arc's USDC for deposits and withdrawals. */
  token: string
  symbol: string
  /** Read from the chain when not known. */
  decimals?: number | null
  /** The coin's market price (1 for USDC). */
  priceUsd: number
  /** Which modes the tabs offer (a coin page: buy and sell; Deposit: deposit; Withdraw: withdraw). */
  modes: CrossMode[]
  initialMode?: CrossMode
  buyBlocked?: string
  compact?: boolean
  onDone?: () => void
}

const CHAIN_NAME: Record<number, string> = { [ARC_ID]: 'Arc', [BSC_ID]: 'BNB Chain', [RH_ID]: 'Robinhood Chain' }
const GAS_NAME: Record<number, string> = { [ARC_ID]: 'USDC', [BSC_ID]: 'BNB', [RH_ID]: 'ETH' }
/** The chain's gas balance under which a buy adds $0.50 of it (in the gas coin's units). */
const LOW_GAS: Record<number, number> = { [ARC_ID]: 0.2, [BSC_ID]: 0.0003, [RH_ID]: 0.00005 }
const GAS_TOPUP_USD = 0.5
const SOL_PRESETS = [0.05, 0.1, 0.25, 0.5]
const USD_PRESETS = [5, 10, 25, 50]
const PCT_PRESETS = [25, 50, 100]
/** SOL kept back when paying with SOL: the transaction's fees. */
const SOL_RESERVE = 0.005
/** What deposits and withdrawals pay: 0.5%, as the bridge. */
const BRIDGE_FEE_BPS = 50
/** USDC a withdrawal's Max leaves on Arc: gas comes out of the same balance (0.15 USDC). */
const ARC_GAS_KEEP = 150_000n

const explorerTx = (chainId: number, h: string) => (chainId === BSC_ID ? bscTx(h) : chainId === RH_ID ? rhTx(h) : `${ARC_EXPLORER}/tx/${h}`)
const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3))
const fmtUsd = (n: number) => (n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`)

async function coinBalance(chainId: number, token: string, owner: string, decimals: number): Promise<{ raw: bigint; amount: number }> {
  if (chainId === BSC_ID) { const b = await bscTokenBalance(token, owner, decimals); return { raw: b.raw, amount: b.amount } }
  if (chainId === RH_ID) { const b = await rhTokenBalance(token, owner, decimals); return { raw: b.raw, amount: b.amount } }
  const raw = await arcClient.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] })
  return { raw, amount: Number(formatUnits(raw, decimals)) }
}
async function gasBalance(chainId: number, owner: string, arcCash: number | null): Promise<number | null> {
  if (chainId === BSC_ID) return bnbBalance(owner)
  if (chainId === RH_ID) return (await rhEthBalance(owner)).amount
  return arcCash
}

export default function SolanaCross({ chainId, token, symbol, decimals: given, priceUsd, modes, initialMode, buyBlocked, compact, onDone }: Props) {
  const [readDecimals, setReadDecimals] = useState<number | null>(null)
  useEffect(() => {
    if (given != null) return
    let live = true
    const reader = chainId === BSC_ID ? bscClient : chainId === RH_ID ? rhClient : arcClient
    void reader.readContract({ address: token as Address, abi: erc20Abi, functionName: 'decimals' }).then(d => { if (live) setReadDecimals(Number(d)) }).catch(() => {})
    return () => { live = false }
  }, [given, token, chainId])
  const decimals = given ?? readDecimals ?? 18
  const trader = useTrader()
  const me = trader.address
  const kind = trader.kind ?? 'wallet'
  const sol = useSolanaWallets()
  const signer = solSignerOf(sol, trader.kind)
  const solAddr = signer === 'trading' ? sol.trading : signer === 'external' ? sol.external?.address ?? null : null
  const info = useRouterInfo()
  const [mode, setMode] = useState<CrossMode>(initialMode ?? modes[0])
  const [cur, setCur] = useState<'sol' | 'usdc'>('sol')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<RelayQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState('')
  const [step, setStep] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [costOk, setCostOk] = useState(false)
  const [opening, setOpening] = useState(false)
  const [solBal, setSolBal] = useState<number | null>(null)
  const [usdcBal, setUsdcBal] = useState<SolHolding | null>(null)
  const [holding, setHolding] = useState<{ raw: bigint; amount: number } | null>(null)
  const [gas, setGas] = useState<number | null>(null)
  const [solPrice, setSolPrice] = useState(0)
  const { cash, refresh: refreshCash } = useCash(chainId === ARC_ID ? me : null)
  const busy = step === 'working'
  const paying = mode === 'buy' || mode === 'deposit'
  const bridging = mode === 'deposit' || mode === 'withdraw'
  const feeBps = bridging ? BRIDGE_FEE_BPS : info?.feeBps ?? 200

  useEffect(() => {
    if (solPrice > 0) return
    void solUsd().then(setSolPrice)
    const id = setInterval(() => { void solUsd().then(setSolPrice) }, 30_000)
    return () => clearInterval(id)
  }, [solPrice])

  const refresh = useCallback(() => {
    if (solAddr) {
      void solBalance(solAddr).then(setSolBal).catch(() => {})
      void solTokenBalance(solAddr, SOL_USDC).then(setUsdcBal).catch(() => {})
    } else { setSolBal(null); setUsdcBal(null) }
    if (me) {
      void coinBalance(chainId, token, me, decimals).then(setHolding).catch(() => {})
      void gasBalance(chainId, me, cash).then(setGas).catch(() => {})
    } else { setHolding(null); setGas(null) }
  }, [solAddr, me, chainId, token, decimals, cash])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 15_000)
    const off = onBalances(refresh)
    return () => { clearInterval(id); off() }
  }, [refresh])

  const amountNum = Number(amount) || 0
  const inDecimals = paying ? (cur === 'sol' ? 9 : 6) : decimals
  const amountIn = (() => { if (!(amountNum > 0)) return 0n; try { return parseUnits(amount, inDecimals) } catch { return 0n } })()
  // What Max and the % chips sell: all of it, less gas when the coin is Arc's USDC itself.
  const sellRaw = holding ? (chainId === ARC_ID && token.toLowerCase() === ARC_USDC ? (holding.raw > ARC_GAS_KEEP ? holding.raw - ARC_GAS_KEEP : 0n) : holding.raw) : null
  const lowGas = gas !== null && gas < (LOW_GAS[chainId] ?? 0)
  const addGas = mode === 'buy' && lowGas
  const maxIn = paying
    ? (cur === 'sol' ? (solBal !== null ? Math.max(0, solBal - SOL_RESERVE) : null) : usdcBal ? usdcBal.amount : null)
    : (holding ? holding.amount : null)
  const insufficient = amountNum > 0 && (paying
    ? (cur === 'sol' ? solBal !== null && amountNum + SOL_RESERVE > solBal + 1e-12 : usdcBal !== null && amountIn > usdcBal.raw)
    : holding !== null && amountIn > holding.raw)

  const request = useCallback((): RelayRequest | null => {
    if (!(amountIn > 0n) || !me || !solAddr) return null
    const currency = cur === 'sol' ? SOL_NATIVE : SOL_USDC
    return paying
      ? { side: 'xin', evmChain: chainId, mint: token, inToken: currency, amount: amountIn, evm: me, sol: solAddr, feeBps, ...(addGas ? { gasUsd: GAS_TOPUP_USD } : {}) }
      : { side: 'xout', evmChain: chainId, mint: token, outToken: currency, amount: amountIn, evm: me, sol: solAddr, feeBps }
  }, [amountIn, me, solAddr, cur, paying, chainId, token, feeBps, addGas])

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
  }, [amountIn, me, solAddr, cur, mode, chainId, token, feeBps, addGas, busy])

  // The price guard: what goes in and what comes out, at market prices (SOL at its price, USDC $1, the coin at its own).
  const unit = cur === 'sol' ? solPrice : 1
  const out = quote ? Number(formatUnits(quote.expectedOut, quote.outDecimals)) : 0
  const minOut = quote ? Number(formatUnits(quote.minOut, quote.outDecimals)) : 0
  const inputUsd = paying ? amountNum * unit : amountNum * priceUsd
  const outUsd = paying ? out * priceUsd : out * unit
  // A gas top-up is in Relay's fee, and arrives as gas on the coin's chain: the trade is valued without it.
  const topup = quote ? quote.gasTopupUsd : 0
  const value = quote && unit > 0 && priceUsd > 0 ? relayValueUsd({ appFeeUsd: quote.appFeeUsd, relayFeeUsd: Math.max(0, quote.relayFeeUsd - topup) }, inputUsd - topup, outUsd) : null
  const verdict = quote ? quoteVerdict(value) : null
  const refused = verdict === 'refuse' || verdict === 'off-market'
  const impactPct = value ? Math.max(0, value.impact * 100) : null
  const cost = value ? Math.max(0, value.cost * 100) : null
  const needsTick = verdict === 'confirm' || verdict === 'unpriced'

  // Money leaving the account for a Solana wallet that isn't its own asks as any other send does.
  const ownSol = !!solAddr && (solAddr === accountOwner() || solAddr === sol.trading)
  const guard = useWithdrawGuard(trader, !paying && !ownSol && solAddr ? solAddr : '')
  const noSolFees = paying && cur === 'usdc' && solBal !== null && solBal < 0.0005
  // A withdrawal of Arc's USDC pays its gas from the same USDC.
  const noGasToSell = mode === 'sell' && lowGas && (gas ?? 0) <= 0
  const noBuy = mode === 'buy' && !!buyBlocked
  // A sale needs the coin's decimals: unknown until the chain answers.
  const decimalsKnown = given != null || readDecimals !== null
  const blocked = (!paying && !decimalsKnown) || busy || !quote || quoting || insufficient || refused || noBuy || (needsTick && !costOk) || noSolFees || noGasToSell || guard.missing

  async function openAccount() {
    setOpening(true); setStep('idle'); setMsg('')
    try { await openSolAccount() } catch (e) { setStep('error'); setMsg(relayErrorText(e)) } finally { setOpening(false) }
  }

  async function submit() {
    const r = request()
    if (!r || !quote || !signer) return
    setStep('working'); setLinks([])
    const say = (p: RelayProgress) => setMsg(p.step === 'quote' ? T('Checking the trade…')
      : p.step === 'approve' ? T('Approving exactly the amount…')
      : p.step === 'sign' ? (signer === 'external' ? T('Confirm the trade in {wallet}…', { wallet: sol.external?.name ?? 'your wallet' }) : T('Signing…'))
      : p.step === 'send' ? T('Sending…')
      : p.step === 'deliver' ? (paying ? T('On its way to {chain}…', { chain: CHAIN_NAME[chainId] }) : T('On its way to your Solana wallet…'))
      : T('Done'))
    try {
      if (!paying) await guard.confirm()
      const res = paying ? await runRelaySolana(signer, r, quote, say) : await runRelayEvm(kind, r, quote, say)
      const l = [{ label: paying ? T('Solana transaction') : T('{chain} transaction', { chain: CHAIN_NAME[chainId] }), href: paying ? solTx(res.tx) : explorerTx(chainId, res.tx) }]
      if (res.outTx && res.outTx !== res.tx) l.push({ label: T('Delivered'), href: paying ? explorerTx(chainId, res.outTx) : solTx(res.outTx) })
      setLinks(l)
      const got = Number(formatUnits(res.quote.expectedOut, res.quote.outDecimals))
      const outText = paying ? `${fmtTok(got)} ${symbol}` : cur === 'sol' ? `${fmtTok(got)} SOL` : `${fmtUsd(got)} USDC`
      if (res.status === 'refunded') throw new Error(paying ? T('Relay couldn’t fill this trade: it was refunded on Solana.') : T('Relay couldn’t fill this trade: it was refunded on {chain}.', { chain: CHAIN_NAME[chainId] }))
      setMsg(res.status === 'pending' ? T('Still on its way: it lands by itself in a few minutes.')
        : paying ? T('Done: ≈{out} is in your ARCDEX account on {chain}.', { out: outText, chain: CHAIN_NAME[chainId] })
        : T('Done: ≈{out} is in your Solana wallet.', { out: outText }))
      setStep('done'); setAmount('')
      refresh(); refreshCash(); onDone?.()
    } catch (e) {
      setStep('error'); setMsg(relayErrorText(e))
    }
  }

  const title = mode === 'buy' ? T('Buy {symbol}', { symbol }) : mode === 'sell' ? T('Sell {symbol}', { symbol })
    : mode === 'deposit' ? T('Deposit from Solana') : T('Withdraw to Solana')
  const label = insufficient ? T('Insufficient balance')
    : refused && !busy ? T('No fair route')
    : busy ? (paying ? T('Buying…') : T('Selling…'))
    : quoting && !quote ? T('Getting a quote…')
    : mode === 'deposit' ? T('Deposit') : mode === 'withdraw' ? T('Withdraw') : title
  const balLabel = paying
    ? (cur === 'sol' ? (solBal !== null ? `SOL: ${fmtTok(solBal)}` : null) : usdcBal ? `USDC: ${fmtUsd(usdcBal.amount)}` : null)
    : holding ? `${T('Holding')}: ${fmtTok(holding.amount)}` : null
  const outLabel = (n: number) => (paying ? (bridging ? `${fmtUsd(n)} USDC` : `${fmtTok(n)} ${symbol}`) : cur === 'sol' ? `${fmtTok(n)} SOL` : `${fmtUsd(n)} USDC`)

  return (
    <div className="swap-box sol-cross">
      {modes.length > 1 && (
        <div className="rh-modes">
          {modes.map(m => (
            <button key={m} className={mode === m ? `on ${m === 'buy' ? 'buy' : 'sell'}` : ''} onClick={() => { if (!busy) { setMode(m); setAmount(''); setStep('idle'); setMsg(''); setLinks([]) } }}>
              {m === 'buy' ? T('Buy') : T('Sell')} {symbol}
            </button>
          ))}
        </div>
      )}
      <div className="sol-routes" role="group" aria-label={paying ? T('Pay with') : T('Receive')}>
        <span>{paying ? T('Pay with') : T('Receive')}</span>
        {(['sol', 'usdc'] as const).map(c => (
          <button key={c} className={cur === c ? 'on' : ''} disabled={busy} onClick={() => { setCur(c); if (paying) setAmount('') }}>{c === 'sol' ? 'SOL' : T('USDC (Solana)')}</button>
        ))}
      </div>

      <div>
        <div className="rh-field-head">
          <span>{paying ? T('You pay ({c})', { c: cur === 'sol' ? 'SOL' : T('USDC (Solana)') }) : bridging ? T('Amount (USDC)') : T('You sell ({symbol})', { symbol })}</span>
          {balLabel && <button className="link-btn" onClick={() => maxIn !== null && setAmount(!paying && sellRaw !== null ? formatUnits(sellRaw, decimals) : String(cur === 'sol' ? Math.floor(maxIn * 1e6) / 1e6 : Math.floor(maxIn * 100) / 100))}>{balLabel}</button>}
        </div>
        <input type="number" min="0" inputMode="decimal" placeholder="0" value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value); if (!busy) { setStep('idle'); setMsg('') } }} className="swap-input" />
        <div className="rh-chips">
          {paying
            ? (cur === 'sol' ? SOL_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>{v} SOL</button>)
              : USD_PRESETS.map(v => <button key={v} disabled={busy} onClick={() => setAmount(String(v))}>${v}</button>))
            : PCT_PRESETS.map(p => <button key={p} disabled={busy || sellRaw === null} onClick={() => sellRaw !== null && setAmount(formatUnits((sellRaw * BigInt(p)) / 100n, decimals))}>{p === 100 ? T('Max') : `${p}%`}</button>)}
        </div>
      </div>

      <div className="swap-info">
        <Row label={T('You receive (est.)')} value={quote ? outLabel(out) : quoting ? '…' : '—'} sub={quote && outUsd > 0 ? `≈ ${fmtUsd(outUsd)}` : undefined} />
        <Row label={T('Minimum received')} value={quote ? outLabel(minOut) : '—'} />
        <Row label={T('Platform fee')} value={pct(feeBps)} />
        <Row label={T('Relay')} value={quote ? fmtUsd(Math.max(0, quote.relayFeeUsd - topup)) : '—'} />
        {addGas && <Row label={T('Gas added on {chain}', { chain: CHAIN_NAME[chainId] })} value={T('{usd} of {coin}', { usd: fmtUsd(quote && topup > 0 ? topup : GAS_TOPUP_USD), coin: GAS_NAME[chainId] })} />}
        {value && <Row label={T('Price impact')} value={impactPct! < 0.1 ? '< 0.1%' : `${impactPct!.toFixed(1)}%`} color={refused || impactPct! >= QUOTE_LIMITS.confirm * 100 ? 'var(--red)' : impactPct! >= 5 ? 'var(--amber)' : 'var(--green)'} />}
        {value && !refused && <Row label={T('Total cost (fees and price impact)')} value={`${cost!.toFixed(1)}%`} />}
        <Row label={T('Arrives')} value={quote ? (paying ? T('on {chain} in ~{s}s', { chain: CHAIN_NAME[chainId], s: Math.max(2, quote.fillSeconds) }) : T('in your Solana wallet in seconds')) : '—'} />
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
      {noSolFees && <div className="rh-msg error">{T('Add a little SOL to this wallet first.')}</div>}
      {noGasToSell && <div className="rh-msg error">{T('Selling on {chain} needs a little {coin} for gas: buy with SOL once and it’s added, or deposit some.', { chain: CHAIN_NAME[chainId], coin: GAS_NAME[chainId] })}</div>}
      {noBuy && <div className="rh-msg error">{buyBlocked}</div>}
      {!paying && <PasscodeField guard={guard} />}

      {msg && (
        <div className={`rh-msg ${step === 'error' ? 'error' : step === 'done' ? 'done' : 'busy'}`}>
          <span>{msg}</span>
          {links.length > 0 && <span className="rh-links">{links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</span>}
        </div>
      )}

      {!solAddr ? (
        sol.available.length > 0
          ? <button className="rh-btn" onClick={() => void connectSolanaWallet(sol.available[0]).then(() => pickSolSigner('external')).then(() => (isUnlocked() || trader.kind === 'wallet' ? undefined : openSolAccount())).catch(e => { setStep('error'); setMsg(relayErrorText(e)) })}>{T('Connect {w}', { w: sol.available[0] })}</button>
          : <a className="rh-btn" href={phantomLink()} target="_blank" rel="noopener noreferrer">{T('Get Phantom')}</a>
      ) : !me ? (
        sol.external
          ? <button className="rh-btn" disabled={opening} onClick={() => void openAccount()}>{opening ? T('Confirm in {wallet}…', { wallet: sol.external.name }) : T('Open your ARCDEX account')}</button>
          : <button className="rh-btn" onClick={openConnectModal}>{T('Connect Wallet')}</button>
      ) : (
        <button className={`rh-btn ${paying ? 'buy' : 'sell'}`} onClick={() => void submit()} disabled={blocked} style={{ opacity: blocked ? 0.5 : 1 }}>{label}</button>
      )}
      {solAddr && !me && sol.external && <p className="swap-note">{T('Your ARCDEX account holds what you buy on Arc, BNB Chain and Robinhood Chain. {wallet} signs once to open it; the same wallet opens it on any device.', { wallet: sol.external.name })}</p>}
      {solAddr && !compact && <SolanaWalletBar solBal={solBal} />}
      {!compact && <p className="swap-note">{bridging ? T('Through Relay: SOL or USDC on Solana in, USDC on Arc out, or back. 0.5% fee. Every transfer is checked and simulated before it’s sent.') : T('Pay with SOL or USDC from your Solana wallet: the coin lands in your ARCDEX account on {chain} in seconds. Sell it back for SOL or USDC any time. Every trade is checked and simulated before it’s sent.', { chain: CHAIN_NAME[chainId] })}</p>}
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

/** "Pay with SOL or USDC on Solana" under a coin page's own trade forms: open when a Solana wallet is in use. */
export function SolanaPayCard(props: Omit<Props, 'modes'>) {
  const sol = useSolanaWallets()
  const solAccount = !!accountOwner()
  const [open, setOpen] = useState(solAccount || !!sol.external)
  useEffect(() => { if (solAccount || sol.external) setOpen(true) }, [solAccount, sol.external])
  return (
    <div className="sol-pay">
      <button className="sol-pay-h" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sol-pay-mark">◎</span>
        <span><b>{T('Pay with SOL or USDC on Solana')}</b><small>{T('Phantom, Solflare or Backpack · lands in seconds')}</small></span>
        <span className="sol-pay-t">{open ? '−' : '+'}</span>
      </button>
      {open && <SolanaCross {...props} modes={['buy', 'sell']} compact />}
    </div>
  )
}
