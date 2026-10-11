// What the Hyperliquid pages share: who trades (and whether they may open positions where they are), the one-time
// "Enable trading" steps, and moving USDC between Arc and the Hyperliquid account through Relay.
//
// Nothing here is shown as done before the venue says so: the account's needs come from Hyperliquid itself
// (hl/access.ts accessStatus), deposits and withdrawals are followed through Relay's own status.

import { useCallback, useEffect, useRef, useState } from 'react'
import { t as T } from '../lib/i18n'
import { useTrader, shortAddr } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openConnectModal } from './ConnectWallet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { ARC_EXPLORER } from '../lib/platform'
import { accessStatus, BUILDER, currentAccess, enableTrading, hlEligibility, type EnableStep, type HlAccess, type HlAccessStatus } from '../hl/access'
import { quoteDeposit, quoteWithdraw, type FundingQuote } from '../hl/fundingQuote'
import { runDeposit, runWithdraw, type FundingStep } from '../hl/funding'
import { HL_EXPLORER, HL_TRADING } from '../hl/client'
import type { HlAccountState } from '../hl/account'

export const money = (n: number | null | undefined, dp = 2) => n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
export const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e)
  if (/user rejected|denied|rejected the request/i.test(m)) return T('You cancelled it in your wallet.')
  return m.length > 220 ? `${m.slice(0, 220)}…` : m
}

export interface HlGate {
  access: HlAccess | null
  status: HlAccessStatus | null
  /** Whether this visitor may open positions and deposit (closing and withdrawing are always allowed). */
  eligible: { ok: boolean; country: string | null; why: 'restricted' | 'unknown' | null } | null
  refresh: () => void
  setAccess: (a: HlAccess) => void
}

/** The signers for the trader in use, what the account still needs, and the location rule. */
export function useHlGate(): HlGate {
  const trader = useTrader()
  const [access, setAccess] = useState<HlAccess | null>(() => currentAccess())
  const [status, setStatus] = useState<HlAccessStatus | null>(null)
  const [eligible, setEligible] = useState<HlGate['eligible']>(null)
  const seq = useRef(0)
  useEffect(() => { setAccess(currentAccess()); setStatus(null) }, [trader.address, trader.kind])
  useEffect(() => { void hlEligibility().then(setEligible).catch(() => setEligible({ ok: false, country: null, why: 'unknown' })) }, [])
  const refresh = useCallback(() => {
    const a = currentAccess()
    if (!a) { setStatus(null); return }
    const n = ++seq.current
    void accessStatus(a).then(s => { if (n === seq.current) setStatus(s) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!access) return
    refresh()
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 30_000)
    return () => clearInterval(id)
  }, [access?.user, access?.kind, refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  return { access, status, eligible, refresh, setAccess: a => { setAccess(a); refresh() } }
}

/** One line on why opening is off here, or null. */
export function regionNote(g: HlGate): string | null {
  if (!g.eligible) return T('Checking where you are…')
  if (g.eligible.ok) return null
  if (g.eligible.why === 'unknown') return T('We couldn’t confirm your location, so opening positions is off. Closing positions and withdrawing always work.')
  return T('Hyperliquid isn’t available to US persons, Ontario or sanctioned regions. Closing positions and withdrawing always work.')
}

/** In place of the order buttons while trading isn't switched on (client.ts HL_TRADING). */
export function TradingSoon() {
  return (
    <div className="hl-blocker">
      <button className="fx-go" disabled>{T('Trading opens soon')}</button>
      <div className="fx-fine">{T('Markets, prices and order books are live. Placing orders opens once trading is switched on.')}</div>
    </div>
  )
}

// ── enable trading ───────────────────────────────────────────────────────

const STEP_TEXT: Record<EnableStep, [string, string]> = {
  mode: ['One balance for every market', 'Your account becomes a unified account, Hyperliquid’s recommended mode: one USDC balance for futures on every market and for predictions.'],
  builder: ['Approve ARCDEX’s fee', 'Up to 0.1% of an order’s value, paid to ARCDEX on each trade (0.05% on futures today). You can revoke it at any time on Hyperliquid.'],
  agent: ['A trading key for this browser', 'A key made and kept in this browser places and cancels orders for you, without a pop-up each time. It can never withdraw or move your money.'],
}

export function EnableTradingModal({ gate, onClose, onDone }: { gate: HlGate; onClose: () => void; onDone: () => void }) {
  const needs = (gate.status?.needs ?? []).filter((n): n is EnableStep => n !== 'deposit')
  const [step, setStep] = useState<EnableStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function go() {
    if (!gate.access) return
    setBusy(true); setErr(null)
    try {
      const a = await enableTrading(gate.access, needs, setStep)
      gate.setAccess(a)
      onDone()
    } catch (e) { setErr(errText(e)) }
    finally { setBusy(false); setStep(null) }
  }
  return (
    <div className="modal-back" onClick={busy ? undefined : onClose}>
      <div className="modal-card hl-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('Enable trading')}</b><button className="fxb-x" onClick={onClose} disabled={busy} aria-label={T('Close')}>✕</button></div>
        <p className="fx-fine">{gate.access?.kind === 'local' ? T('Your trading wallet signs each step itself: no pop-ups.') : T('Your wallet asks you to sign each step once. Nothing is sent on-chain and no gas is paid.')}</p>
        <ol className="hl-steps">
          {needs.map(n => (
            <li key={n} className={step === n ? 'on' : ''}>
              <b>{step === n ? '⏳ ' : ''}{T(STEP_TEXT[n][0])}</b>
              <span>{T(STEP_TEXT[n][1])}</span>
            </li>
          ))}
        </ol>
        {err && <div className="fx-hint-bad">⚠ {err}</div>}
        <button className="btn-primary" disabled={busy || !needs.length} onClick={() => void go()}>{busy ? T('Signing…') : T('Enable trading')}</button>
      </div>
    </div>
  )
}

// ── deposit and withdraw ─────────────────────────────────────────────────

const STEP_LABEL: Record<FundingStep, string> = {
  quote: 'Getting a quote…', approve: 'Approving exactly this amount…', sign: 'Signing…', send: 'Sending…', deliver: 'On its way…', done: 'Done',
}

/** Arc USDC in, or back out to Arc, through Relay. Deposits need the location rule; withdrawals never do. */
export function HlFundingModal({ gate, account, initial, onClose, onDone }: {
  gate: HlGate; account: HlAccountState | null; initial: 'deposit' | 'withdraw'; onClose: () => void; onDone: () => void
}) {
  const [tab, setTab] = useState<'deposit' | 'withdraw'>(initial)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<FundingQuote | null>(null)
  const [qErr, setQErr] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<FundingStep | null>(null)
  const [txs, setTxs] = useState<{ step: FundingStep; tx: string }[]>([])
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const user = gate.access?.user ?? null
  const { cash, refresh: refreshCash } = useCash(user)
  const usd = +amount || 0
  // Arc takes gas from the same USDC: a deposit leaves 0.15 for it.
  const maxIn = tab === 'deposit' ? Math.max(0, (cash ?? 0) - 0.15) : Math.max(0, account?.withdrawable ?? 0)
  const tooMuch = usd > maxIn + 1e-9
  const blocked = tab === 'deposit' && gate.eligible?.ok !== true
  const minUsd = tab === 'deposit' ? 5 : 2

  useEffect(() => { setQuote(null); setQErr(null); setResult(null); setTxs([]) }, [tab])
  useEffect(() => {
    setQuote(null); setQErr(null)
    if (!user || !(usd >= minUsd) || tooMuch || blocked) return
    const ctl = new AbortController()
    const id = setTimeout(() => {
      setQuoting(true)
      ;(tab === 'deposit' ? quoteDeposit(user, usd, ctl.signal) : quoteWithdraw(user, usd, ctl.signal))
        .then(q => { if (!ctl.signal.aborted) setQuote(q) })
        .catch(e => { if (!ctl.signal.aborted) setQErr(errText(e)) })
        .finally(() => { if (!ctl.signal.aborted) setQuoting(false) })
    }, 500)
    return () => { ctl.abort(); clearTimeout(id); setQuoting(false) }
  }, [tab, usd, user, tooMuch, blocked, minUsd])

  async function go() {
    if (!gate.access || !quote) return
    setBusy(true); setResult(null); setTxs([])
    const onStep = (s: FundingStep, tx?: string) => { setStep(s); if (tx) setTxs(prev => [...prev, { step: s, tx }]) }
    try {
      const r = tab === 'deposit'
        // Paid by the wallet that owns the Hyperliquid account, so the USDC lands where it trades.
        ? await runDeposit(gate.access.kind === 'local' ? 'trading-wallet' : 'wallet', gate.access.user, usd, onStep)
        : await runWithdraw(gate.access, usd, onStep)
      if (r === 'filled') setResult({ ok: true, text: tab === 'deposit' ? T('Deposited: your USDC is in your Hyperliquid account.') : T('Withdrawn: your USDC is on Arc.') })
      else if (r === 'refunded') setResult({ ok: false, text: T('Relay refunded it: the USDC went back where it came from.') })
      else if (r === 'pending') setResult({ ok: true, text: T('Still on its way: it usually lands within a minute. Your balance updates by itself.') })
      else setResult({ ok: false, text: T('Relay couldn’t complete it. Anything taken is refunded.') })
      setAmount('')
      onDone()
      refreshCash()
    } catch (e) { setResult({ ok: false, text: errText(e) }) }
    finally { setBusy(false); setStep(null) }
  }

  // A deposit's approval and deposit are on Arc and Relay's fill is on Hyperliquid; a withdrawal's fill is on Arc.
  const txLink = (s: FundingStep, tx: string) => (tab === 'deposit' && s === 'done' ? `${HL_EXPLORER}/tx/${tx}` : `${ARC_EXPLORER}/tx/${tx}`)
  return (
    <div className="modal-back" onClick={busy ? undefined : onClose}>
      <div className="modal-card hl-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('Hyperliquid account')}</b><button className="fxb-x" onClick={onClose} disabled={busy} aria-label={T('Close')}>✕</button></div>
        <div className="fxb-kinds">
          <button className={tab === 'deposit' ? 'active' : ''} disabled={busy} onClick={() => setTab('deposit')}>{T('Deposit')}</button>
          <button className={tab === 'withdraw' ? 'active' : ''} disabled={busy} onClick={() => setTab('withdraw')}>{T('Withdraw')}</button>
        </div>
        {!HL_TRADING ? (
          <div className="fx-empty">{T('Deposits and withdrawals open with trading.')}</div>
        ) : !user ? (
          <div className="fx-empty">
            <button className="link-btn" onClick={openConnectModal}>{T('Connect wallet')}</button> · <button className="link-btn" onClick={openTradingWallet}>{T('Trading wallet')}</button>
          </div>
        ) : (
          <>
            <div className="hl-route">
              <div><span>{T('From')}</span><b>{tab === 'deposit' ? T('USDC on Arc') : T('Your Hyperliquid account')}</b><small>{tab === 'deposit' ? `${T('Balance')} ${money(cash)}` : `${T('Withdrawable')} ${money(account?.withdrawable)}`}</small></div>
              <span className="hl-route-arrow">→</span>
              <div><span>{T('To')}</span><b>{tab === 'deposit' ? T('Your Hyperliquid account') : T('USDC on Arc')}</b><small>{shortAddr(user)}</small></div>
            </div>
            {blocked && <div className="fx-hint-bad">⚠ {regionNote(gate)}</div>}
            <div className="fxb-input">
              <span>{T('Amount')}</span>
              <input inputMode="decimal" value={amount} disabled={busy || blocked} placeholder={`${minUsd}+`} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
              <button className="fxb-last-btn" disabled={busy || blocked} onClick={() => setAmount(String(Math.floor(maxIn * 100) / 100))}>{T('Max')}</button>
              <em>USDC</em>
            </div>
            {tooMuch && <div className="fx-hint-bad">{T('More than you have.')}</div>}
            {usd > 0 && usd < minUsd && <div className="fx-fine">{T('At least ${n}.', { n: minUsd })}</div>}
            <div className="fx-summary">
              <div><span>{T('You receive')}</span><b>{quoting ? T('Quoting…') : quote ? money(quote.outUsd, 4) : '—'}</b></div>
              <div><span>{T('Relay’s fee')}</span><b>{quote ? money(quote.feeUsd, 4) : '—'}</b></div>
              <div><span>{T('Time')}</span><b>{quote ? `≈ ${Math.max(1, quote.seconds)}s` : '—'}</b></div>
              <div><span>{T('ARCDEX fee')}</span><b>{T('None')}</b></div>
            </div>
            {qErr && <div className="fx-hint-bad">⚠ {qErr}</div>}
            {tab === 'withdraw' && gate.access?.kind === 'external' && <div className="fx-fine">{T('Your wallet signs twice: Relay’s authorization (on Ethereum, no gas) and the transfer on Hyperliquid. It switches back to Arc after.')}</div>}
            <button className="btn-primary" disabled={busy || !quote || tooMuch || blocked} onClick={() => void go()}>
              {busy ? T(STEP_LABEL[step ?? 'quote']) : tab === 'deposit' ? T('Deposit {amount}', { amount: money(usd) }) : T('Withdraw {amount}', { amount: money(usd) })}
            </button>
            {txs.length > 0 && (
              <div className="hl-txs">{txs.map(x => <a key={x.tx} href={txLink(x.step, x.tx)} target="_blank" rel="noreferrer">{T(STEP_LABEL[x.step])} ↗</a>)}</div>
            )}
            {result && <div className={`fx-note ${result.ok ? 'ok' : 'bad'}`}>{result.ok ? '✓' : '⚠'} {result.text}</div>}
            <div className="fx-fine">{T('Moved by Relay (relay.link): the quote is checked before you sign it, and the money only goes to your own address.')} <a href={`${HL_EXPLORER}/address/${user}`} target="_blank" rel="noreferrer">{T('Your account on Hyperliquid')} ↗</a></div>
          </>
        )}
      </div>
    </div>
  )
}

/** The account box beside an order form: value, what's free to trade, and the money buttons. */
export function HlAccountBox({ account, gate, onFund }: { account: HlAccountState | null; gate: HlGate; onFund: (t: 'deposit' | 'withdraw') => void }) {
  const signedIn = Boolean(gate.access)
  const builderNote = gate.status && !gate.status.builderReady
  return (
    <div className="spot-panel fxb-account">
      <div className="spot-panel-h"><span>{T('Account')}</span>{account?.mode && <small className="fx-fine">{account.mode === 'unifiedAccount' ? T('Unified') : account.mode === 'portfolioMargin' ? T('Portfolio margin') : T('Standard')}</small>}</div>
      {!signedIn ? (
        <div className="fx-empty"><button className="link-btn" onClick={openConnectModal}>{T('Connect wallet')}</button> · <button className="link-btn" onClick={openTradingWallet}>{T('Trading wallet')}</button></div>
      ) : (
        <>
          <div className="fxb-acct-row"><span>{T('Account value')}</span><b>{account ? money(account.accountValue) : '…'}</b></div>
          <div className="fxb-acct-row"><span>{T('Available to trade')}</span><b>{account ? money(account.available) : '…'}</b></div>
          <div className="fxb-acct-row"><span>{T('Withdrawable')}</span><b>{account ? money(account.withdrawable) : '…'}</b></div>
          {HL_TRADING && (
            <div className="fxb-acct-btns">
              <button className="btn-ghost" onClick={() => onFund('deposit')}>＋ {T('Deposit')}</button>
              <button className="btn-ghost" onClick={() => onFund('withdraw')}>{T('Withdraw')}</button>
            </div>
          )}
          {builderNote ? null : gate.status && <div className="fx-fine hl-fee-note">{T('ARCDEX fee: {pct}% of each futures order.', { pct: (BUILDER.perpF / 1000).toFixed(2) })}</div>}
        </>
      )}
    </div>
  )
}
