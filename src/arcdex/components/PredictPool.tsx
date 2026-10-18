// The prediction pool on /predict (lib/predictPool.ts): papertrade.xyz's pool for Hyperliquid's prediction markets,
// on Arc testnet with test USDC. A buy or sale is a request on-chain, filled by ARCDEX's keeper at Hyperliquid's mid
// a second or two later; a settled market is paid out by the keeper. The account bar (test USDC, the pool balance,
// what the queue owes you, tPOOL and its rewards), the trade panel, positions, requests, history and the pool itself,
// all marked TESTNET.

import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { N_, t as T } from '../lib/i18n'
import { money } from './HlShared'
import { AgoText } from './Ago'
import { openConnectModal } from './ConnectWallet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { CIRCLE_FAUCET } from '../../../engine/src/perps/shared'
import {
  POOL_LIMITS, REJECT_REASON, buyLimit, poolCall, poolDeposit, poolErrorText, poolFaucet, sellLimit, usdOf, usePoolFills, usePoolState,
  type PoolAccount, type PoolFill, type PoolPosition, type PredictPoolDeployment, type PredictPoolStatus,
} from '../lib/predictPool'
import { useTrader } from '../lib/identity'

export const POOL_NOTE = N_('The testnet pool trades with test USDC on Arc testnet: nothing here is real money. Each order is a request on-chain that ARCDEX’s keeper fills at Hyperliquid’s live mid, with no slippage; a settled market is paid out by the keeper. The pool starts empty and fills only from traders’ losses: a win it can’t pay yet waits in a first-in, first-out queue. ARCDEX’s engine signs every price and settlement, so the pool trusts it.')

/** A market's name and its sides' names, as the page knows them (or as this browser saw them when it traded). */
export type PoolNameOf = (outcome: number) => { title: string; sides: [string, string] }
const NAMES_KEY = 'arcdex:pool-names'
function savedNames(): Record<string, { title: string; sides: [string, string] }> {
  try { return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') } catch { return {} }
}
export function rememberName(outcome: number, title: string, sides: [string, string]) {
  try {
    const all = savedNames()
    all[outcome] = { title, sides }
    const keys = Object.keys(all)
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k]
    localStorage.setItem(NAMES_KEY, JSON.stringify(all))
  } catch { /* storage blocked */ }
}
export function withSaved(nameOf: (o: number) => { title: string; sides: [string, string] } | null): PoolNameOf {
  return o => nameOf(o) ?? savedNames()[o] ?? { title: T('Market #{n}', { n: o }), sides: [T('Yes'), T('No')] }
}

const cents = (p: number | null | undefined) => (p == null ? '—' : p < 0.01 ? '<1¢' : p > 0.99 ? '>99¢' : `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}¢`)
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`
const updown = (n: number) => (n > 0 ? 'fx-up' : n < 0 ? 'fx-down' : '')
const qty = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 })
const tokens = (v: bigint) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const nowSec = () => Math.floor(Date.now() / 1000)

type Busy = string | null

// ── before the pool trades ───────────────────────────────────────────────

/** Why the pool can't be traded here yet (engine status), or nothing. */
export function PoolNotReady({ status }: { status: PredictPoolStatus | null }) {
  if (status?.deployment?.pool) return null
  return (
    <div className="pr-start pl-start">
      <div>
        <b>{T('The testnet pool isn’t running yet')}</b>
        <span>{status ? (status.waiting ?? T('Starting…')) : T('Asking the engine…')}</span>
      </div>
    </div>
  )
}

// ── the account bar ──────────────────────────────────────────────────────

export function PoolBar({ dep, view, onChange }: { dep: PredictPoolDeployment; view: PoolAccount | null; onChange: () => void }) {
  const trader = useTrader()
  const pool = usePoolState()?.state ?? null
  const [menu, setMenu] = useState<'deposit' | 'withdraw' | 'stake' | null>(null)
  const [amt, setAmt] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setErr(null)
    try { await f(); setMenu(null); setAmt(''); onChange() } catch (e) { setErr(poolErrorText(e)) } finally { setBusy(null) }
  }
  if (!trader.address) {
    return (
      <div className="pr-start pl-start">
        <div>
          <b>{T('Trade the testnet pool with test USDC')}</b>
          <span>{T('Buy a side at Hyperliquid’s mid against a pool that starts at $0, papertrade-style. Test USDC only, on Arc testnet.')}</span>
        </div>
        <button className="btn-primary" onClick={openTradingWallet}>{T('Trading wallet')}</button>
        <button className="btn-ghost" onClick={openConnectModal}>{T('Connect wallet')}</button>
      </div>
    )
  }
  const inPos = view ? view.positions.reduce((s, p) => s + usdOf(p.cost), 0) : 0
  const faucetReady = !view || !view.lastFaucetAt || nowSec() >= view.lastFaucetAt + 86_400
  const noGas = view != null && view.gas < 10n ** 15n // under 0.001 USDC of gas
  const n = +amt || 0
  const units = BigInt(Math.round(n * 1e6))
  return (
    <div className="pr-bar pl-bar">
      <span className="pp-badge pl-badge">{T('TESTNET')}</span>
      <div><span>{T('Pool balance')}</span><b>{view ? money(usdOf(view.balance)) : '…'}</b><small>{T('Wallet {v}', { v: view ? money(usdOf(view.wallet)) : '…' })}</small></div>
      <div><span>{T('In positions')}</span><b>{money(inPos)}</b></div>
      <div><span>{T('Waiting in the queue')}</span><b className={view?.queued ? 'fx-up' : ''}>{view ? money(usdOf(view.queued)) : '…'}</b></div>
      <div><span>tPOOL</span><b>{view ? tokens(view.token + view.staked) : '…'}</b><small>{view?.staked ? T('{n} staked', { n: tokens(view.staked) }) : T('from your losses')}</small></div>
      <div><span>{T('Rewards')}</span><b>{view ? money(usdOf(view.reward)) : '…'}</b></div>
      <div className="pr-bar-name">
        <button className="link-btn" disabled={!faucetReady || busy !== null} onClick={() => run('faucet', () => poolFaucet(trader.kind, dep))}>
          {busy === 'faucet' ? T('Getting test USDC…') : faucetReady ? `🚰 ${T('Get 1,000 test USDC')}` : T('Faucet used today')}
        </button>
        <button className="link-btn" onClick={() => setMenu(menu === 'deposit' ? null : 'deposit')}>{T('Deposit')}</button>
        <button className="link-btn" onClick={() => setMenu(menu === 'withdraw' ? null : 'withdraw')}>{T('Withdraw')}</button>
        <button className="link-btn" onClick={() => setMenu(menu === 'stake' ? null : 'stake')}>{T('Stake')}</button>
      </div>
      {noGas && <div className="fx-hint-bad pr-bar-err">⛽ {T('This wallet needs testnet USDC for gas.')} <a href={CIRCLE_FAUCET} target="_blank" rel="noreferrer">{T('Circle faucet')}</a></div>}
      {(menu === 'deposit' || menu === 'withdraw') && view && (
        <div className="pr-pop">
          <input className="field" inputMode="decimal" value={amt} placeholder="USD" onChange={e => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
          <button className="btn-ghost" onClick={() => setAmt(String(usdOf(menu === 'deposit' ? view.wallet : view.balance)))}>{T('Max')}</button>
          <button className="btn-primary" disabled={!(n > 0) || busy !== null || (menu === 'deposit' ? units > view.wallet : units > view.balance)} onClick={() => run(menu, () =>
            menu === 'deposit' ? poolDeposit(trader.kind, dep, units, view.allowance) : poolCall(trader.kind, dep, 'withdraw', [units]))}>
            {busy === menu ? T('Sending…') : menu === 'deposit' ? T('Deposit') : T('Withdraw')}
          </button>
        </div>
      )}
      {menu === 'stake' && view && (
        <div className="pr-pop">
          <span>{T('Stake tPOOL for a share of the pool’s fees, paid in test USDC.')}</span>
          <button className="btn-primary" disabled={!view.token || busy !== null} onClick={() => run('stake', () => poolCall(trader.kind, dep, 'stake', [view.token]))}>{T('Stake all')}</button>
          <button className="btn-ghost" disabled={!view.staked || busy !== null} onClick={() => run('unstake', () => poolCall(trader.kind, dep, 'unstake', [view.staked]))}>{T('Unstake')}</button>
          <button className="btn-ghost" disabled={!view.reward || busy !== null} onClick={() => run('claim', () => poolCall(trader.kind, dep, 'claim', []))}>{T('Claim rewards')}</button>
        </div>
      )}
      {pool && (
        <div className="pl-health">
          {T('Pool cash {cash}', { cash: money(usdOf(pool.lpCash) + usdOf(pool.sideBucket)) })} · {T('Queue {n} ({usd})', { n: pool.queueLength, usd: money(usdOf(pool.totalQueued)) })} · {T('Pool P&L {pnl}', { pnl: signed(usdOf(pool.trackedLp)) })}
        </div>
      )}
      {err && <div className="fx-hint-bad pr-bar-err">⚠ {err}</div>}
    </div>
  )
}

// ── the trade panel ──────────────────────────────────────────────────────

export interface PoolPick { outcome: number; title: string; sides: [string, string]; side: 0 | 1; mode: 'buy' | 'sell' }

export function PoolTradePanel({ pick, setPick, px, dep, view, onDone }: {
  pick: PoolPick; setPick: (p: PoolPick) => void; px: [number | null, number | null]
  dep: PredictPoolDeployment; view: PoolAccount | null; onDone: () => void
}) {
  const trader = useTrader()
  const { outcome, side, mode } = pick
  const [usd, setUsd] = useState('')
  const [frac, setFrac] = useState(1)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const fills = usePoolFills(trader.address, sentAt ?? 0)
  useEffect(() => { setNote(null); setSentAt(null) }, [outcome, side, mode])
  // The keeper's answer to the request just sent: its fill or its refund.
  useEffect(() => {
    if (!sentAt || !fills) return
    const f = fills.find(x => x.at >= sentAt - 2_000 && x.outcome === outcome && x.side === side && (x.kind === 'rejected' || x.kind === (mode === 'buy' ? 'buy' : 'sell')))
    if (!f) return
    setSentAt(null)
    setBusy(false)
    onDone()
    if (f.kind === 'rejected') setNote({ ok: false, text: T('Refunded: {why}', { why: REJECT_REASON[f.reason ?? 0] ? T(REJECT_REASON[f.reason ?? 0]) : '—' }) })
    else if (f.kind === 'buy') setNote({ ok: true, text: T('Bought {n} {side} at {px}', { n: qty(usdOf(f.contracts)), side: pick.sides[side], px: cents(usdOf(f.px ?? '0')) }) })
    else setNote({ ok: true, text: T('Sold {n} {side} at {px}: {pnl}', { n: qty(usdOf(f.contracts)), side: pick.sides[side], px: cents(usdOf(f.px ?? '0')), pnl: f.pnl != null ? signed(usdOf(f.pnl)) : '' }) })
  }, [fills, sentAt]) // eslint-disable-line react-hooks/exhaustive-deps
  // No answer in 20 seconds: say so (the request can be cancelled from Requests once its time is up).
  useEffect(() => {
    if (!sentAt) return
    const id = setTimeout(() => { setBusy(false); setSentAt(null); onDone(); setNote({ ok: false, text: T('Not filled yet. It shows under Requests, and can be cancelled for a refund once its time is up.') }) }, 20_000)
    return () => clearTimeout(id)
  }, [sentAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const isBuy = mode === 'buy'
  const price = px[side]
  const holding = view?.positions.find(p => p.outcome === outcome && p.side === side) ?? null
  const free = holding ? holding.contracts - holding.selling : 0n
  const amount = +usd || 0
  const contracts = price ? amount / price : 0
  const sellN = holding ? (frac >= 1 ? free : (free * BigInt(Math.round(frac * 1000))) / 1000n) : 0n
  const sellUsd = price ? usdOf(sellN) * price : 0
  const sellPnl = holding && holding.contracts ? sellUsd - usdOf(holding.cost) * Number(sellN) / Number(holding.contracts) : 0
  const decided = price != null && (price < POOL_LIMITS.minBuyPx || price > POOL_LIMITS.maxBuyPx)
  const balance = view ? usdOf(view.balance) : 0
  const ready = !!view && price != null && (isBuy ? amount >= POOL_LIMITS.minOrderUsd && amount <= balance && !decided : sellN > 0n)

  async function submit() {
    if (price == null) return
    setBusy(true); setNote(null)
    try {
      rememberName(outcome, pick.title, pick.sides)
      const at = Date.now()
      if (isBuy) await poolCall(trader.kind, dep, 'requestBuy', [outcome, side, BigInt(Math.round(amount * 1e6)), buyLimit(price)])
      else await poolCall(trader.kind, dep, 'requestSell', [outcome, side, sellN, sellLimit(price)])
      setUsd('')
      setSentAt(at)
      onDone()
    } catch (e) { setBusy(false); setNote({ ok: false, text: poolErrorText(e) }) }
  }

  return (
    <div className="fx-order hl-order pm-trade pr-trade">
      <div className="pp-banner pl-banner"><b>{T('TESTNET')}</b><span>{T('Test USDC, filled by the keeper at the live mid')}</span></div>
      <div className="pm-trade-h"><b>{pick.title}</b></div>
      <div className="fxb-kinds">
        <button className={isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'buy' })}>{T('Buy')}</button>
        <button className={!isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'sell' })}>{T('Sell')}{holding ? ` (${qty(usdOf(holding.contracts))})` : ''}</button>
      </div>
      <div className="pm-sides">
        {([0, 1] as const).map(s => (
          <button key={s} className={`pm-side s${s}${side === s ? ' on' : ''}`} onClick={() => setPick({ ...pick, side: s })}>
            <span>{pick.sides[s]}</span><b>{cents(px[s])}</b>
          </button>
        ))}
      </div>
      {!trader.address ? (
        <button className="fx-go fx-go-primary" onClick={openTradingWallet}>{T('Trading wallet')}</button>
      ) : isBuy ? (
        <>
          <div className="fxb-input"><span>{T('Amount')}</span><input inputMode="decimal" value={usd} placeholder={`${POOL_LIMITS.minOrderUsd}+`} onChange={e => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} /><em>USD</em></div>
          <div className="fxb-ticks">
            {[10, 50, 100, 250].map(v => <button key={v} className={+usd === v ? 'on' : ''} onClick={() => setUsd(String(v))}>${v}</button>)}
            <button onClick={() => setUsd(String(Math.floor(balance)))}>{T('Max')}</button>
          </div>
          <button className={`fx-go ${side === 0 ? 'long' : 'short'}`} disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? T('Filling…') : T('Buy {side}', { side: pick.sides[side] })}
          </button>
          {decided && <div className="fx-hint-bad">{T('This side is all but decided: the pool takes buys between 1¢ and 99¢.')}</div>}
          {view && amount > balance && <div className="fx-hint-bad">{T('Not enough in your pool balance: deposit test USDC first.')}</div>}
        </>
      ) : holding ? (
        <>
          <div className="fxb-ticks pr-fracs">
            {[0.25, 0.5, 1].map(f => <button key={f} className={frac === f ? 'on' : ''} onClick={() => setFrac(f)}>{f === 1 ? T('All') : `${f * 100}%`}</button>)}
          </div>
          <button className="fx-go fx-go-primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? T('Filling…') : T('Sell {side}', { side: pick.sides[side] })}
          </button>
        </>
      ) : (
        <div className="fx-empty">{T('You don’t hold this side.')}</div>
      )}
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      <div className="fx-summary">
        <div><span>{T('Price')}</span><b>{cents(price)}</b></div>
        {isBuy ? (
          <>
            <div><span>{T('Contracts')}</span><b>{contracts ? qty(contracts) : '—'}</b></div>
            <div><span>{T('Pays if right')}</span><b className="fx-up">{contracts ? `${money(contracts)} (+${money(contracts - amount)})` : '—'}</b></div>
            <div><span>{T('Worst price')}</span><b>{price != null ? cents(Number(buyLimit(price)) / 1e6) : '—'}</b></div>
          </>
        ) : (
          <>
            <div><span>{T('Contracts')}</span><b>{sellN ? qty(usdOf(sellN)) : '—'}</b></div>
            <div><span>{T('You receive')}</span><b>{sellN ? money(sellUsd) : '—'}</b></div>
            <div><span>{T('P&L')}</span><b className={updown(sellPnl)}>{sellN ? signed(sellPnl) : '—'}</b></div>
          </>
        )}
        <div><span>{T('Fee')}</span><b>{T('2% of a win only')}</b></div>
      </div>
      <div className="fx-fine">{T('A win the pool can’t pay yet waits in its queue and is paid in order as other traders’ losses come in. Your own stake always comes back at once.')}</div>
    </div>
  )
}

// ── positions, requests, history and the pool ────────────────────────────

type Tab = 'positions' | 'requests' | 'history' | 'pool'

export function PoolPanel({ dep, view, nameOf, px, onSell, onChange }: {
  dep: PredictPoolDeployment; view: PoolAccount | null; nameOf: PoolNameOf
  px: (outcome: number, side: 0 | 1) => number | null; onSell: (p: PoolPick) => void; onChange: () => void
}) {
  const trader = useTrader()
  const [tab, setTab] = useState<Tab>('positions')
  const [busy, setBusy] = useState<Busy>(null)
  const [err, setErr] = useState<string | null>(null)
  const fills = usePoolFills(trader.address)
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setErr(null)
    try { await f(); onChange() } catch (e) { setErr(poolErrorText(e)) } finally { setBusy(null) }
  }
  const nReq = view?.requests.length ?? 0
  return (
    <div className="spot-panel pr-panel">
      <div className="hl-acct-tabs pr-tabs">
        <span className="pp-badge pl-badge">{T('TESTNET')}</span>
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>{T('Positions')}{view?.positions.length ? ` (${view.positions.length})` : ''}</button>
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>{T('Requests')}{nReq ? ` (${nReq})` : ''}</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>{T('History')}</button>
        <button className={tab === 'pool' ? 'active' : ''} onClick={() => setTab('pool')}>{T('The pool')}</button>
      </div>
      {err && <div className="fx-hint-bad">⚠ {err}</div>}
      {tab === 'positions' && (
        !view || !view.positions.length ? <div className="fx-empty">{T('No pool positions yet. Pick a side on any market below.')}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>{T('Market')}</th><th>{T('Side')}</th><th>{T('Contracts')}</th><th>{T('Avg price')}</th><th>{T('Now')}</th><th>{T('Value')}</th><th>{T('P&L')}</th><th /></tr></thead>
              <tbody>
                {view.positions.map(p => <PositionRow key={`${p.outcome}:${p.side}`} p={p} view={view} nameOf={nameOf} px={px(p.outcome, p.side)} busy={busy}
                  onSell={onSell} onRedeem={() => run(`r${p.outcome}`, () => poolCall(trader.kind, dep, 'redeem', [trader.address as Address, p.outcome, p.side]))} />)}
              </tbody>
            </table>
          </div>
        )
      )}
      {tab === 'requests' && (
        !view || !view.requests.length ? <div className="fx-empty">{T('No requests waiting. The keeper fills each one within a few seconds.')}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>{T('Market')}</th><th>{T('Order')}</th><th>{T('Amount')}</th><th>{T('Limit')}</th><th>{T('Sent')}</th><th /></tr></thead>
              <tbody>
                {view.requests.map(r => {
                  const n = nameOf(r.outcome)
                  const canCancel = nowSec() > r.createdAt + view.requestTimeout
                  return (
                    <tr key={String(r.id)}>
                      <td><b>{n.title}</b></td>
                      <td className={r.side === 0 ? 'fx-up' : 'fx-down'}>{r.buy ? T('Buy') : T('Sell')} {n.sides[r.side]}</td>
                      <td>{r.buy ? money(usdOf(r.amount)) : qty(usdOf(r.amount))}</td>
                      <td>{cents(usdOf(r.limitPx))}</td>
                      <td><AgoText ts={r.createdAt * 1000} /></td>
                      <td><button className="btn-ghost" disabled={!canCancel || busy !== null} title={canCancel ? '' : T('Once its time to fill has passed')} onClick={() => run(`c${r.id}`, () => poolCall(trader.kind, dep, 'cancel', [r.id]))}>{T('Cancel')}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {tab === 'history' && <FillsTable fills={fills} nameOf={nameOf} mine />}
      {tab === 'pool' && <PoolExplainer />}
    </div>
  )
}

function PositionRow({ p, view, nameOf, px, busy, onSell, onRedeem }: {
  p: PoolPosition; view: PoolAccount; nameOf: PoolNameOf; px: number | null; busy: Busy; onSell: (p: PoolPick) => void; onRedeem: () => void
}) {
  const n = nameOf(p.outcome)
  const m = view.markets.get(p.outcome)
  const contracts = usdOf(p.contracts), cost = usdOf(p.cost)
  const settledPx = m && m.state !== 0 ? (p.side === 0 ? Number(m.fraction) / 1e6 : 1 - Number(m.fraction) / 1e6) : null
  const nowPx = settledPx ?? px
  const value = nowPx == null ? null : contracts * nowPx
  const pnl = value == null ? null : value - cost
  const ready = m?.state === 2 || (m?.state === 1 && nowSec() >= m.readyAt)
  return (
    <tr>
      <td><b>{n.title}</b></td>
      <td className={p.side === 0 ? 'fx-up' : 'fx-down'}>{n.sides[p.side]}</td>
      <td>{qty(contracts)}{p.selling ? <small> · {T('{n} selling', { n: qty(usdOf(p.selling)) })}</small> : null}</td>
      <td>{cents(cost / contracts)}</td>
      <td>{cents(nowPx)}{m?.state === 1 && <small> · {T('settling')}</small>}</td>
      <td>{value == null ? '—' : money(value)}</td>
      <td className={pnl == null ? '' : updown(pnl)}>{pnl == null ? '—' : signed(pnl)}</td>
      <td>
        {m && m.state !== 0
          ? <button className="btn-ghost" disabled={!ready || busy !== null} title={ready ? '' : T('Paid out once the settlement’s wait is over')} onClick={onRedeem}>{T('Collect')}</button>
          : <button className="btn-ghost" onClick={() => onSell({ outcome: p.outcome, title: n.title, sides: n.sides, side: p.side, mode: 'sell' })}>{T('Sell')}</button>}
      </td>
    </tr>
  )
}

function FillsTable({ fills, nameOf, mine }: { fills: PoolFill[] | null; nameOf: PoolNameOf; mine?: boolean }) {
  if (!fills) return <div className="fx-empty">{T('Loading…')}</div>
  if (!fills.length) return <div className="fx-empty">{T('Fills, refunds and payouts show here.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr>{!mine && <th>{T('Trader')}</th>}<th>{T('Market')}</th><th>{T('What')}</th><th>{T('Contracts')}</th><th>{T('Price')}</th><th>USD</th><th>{T('P&L')}</th><th>{T('When')}</th></tr></thead>
        <tbody>
          {fills.map(f => {
            const n = nameOf(f.outcome)
            const pnl = f.pnl == null ? null : usdOf(f.pnl)
            const what = f.kind === 'buy' ? T('Bought') : f.kind === 'sell' ? T('Sold') : f.kind === 'settled' ? T('Paid out') : T('Refunded')
            return (
              <tr key={`${f.tx}-${f.requestId}-${f.kind}-${f.trader}-${f.side}`}>
                {!mine && <td>{short(f.trader)}</td>}
                <td><b>{n.title}</b></td>
                <td className={f.side === 0 ? 'fx-up' : 'fx-down'}>{what} {n.sides[f.side]}{f.kind === 'rejected' && f.reason ? <small> · {T(REJECT_REASON[f.reason] ?? '')}</small> : null}</td>
                <td>{f.kind === 'rejected' ? '—' : qty(usdOf(f.contracts))}</td>
                <td>{f.px ? cents(usdOf(f.px)) : '—'}</td>
                <td>{money(usdOf(f.usd))}</td>
                <td className={pnl == null ? '' : updown(pnl)}>{pnl == null ? '—' : signed(pnl)}</td>
                <td><AgoText ts={f.at} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PoolExplainer() {
  const pool = usePoolState()?.state ?? null
  return (
    <div className="pl-explain">
      <div className="fx-summary">
        <div><span>{T('Free cash')}</span><b>{pool ? money(usdOf(pool.lpCash)) : '…'}</b></div>
        <div><span>{T('Set aside for the queue')}</span><b>{pool ? money(usdOf(pool.sideBucket)) : '…'}</b></div>
        <div><span>{T('Owed in the queue')}</span><b>{pool ? `${money(usdOf(pool.totalQueued))} · ${pool.queueLength}` : '…'}</b></div>
        <div><span>{T('Pool P&L (all time)')}</span><b>{pool ? signed(usdOf(pool.trackedLp)) : '…'}</b></div>
        <div><span>{T('tPOOL per $1 lost')}</span><b>{pool ? (Number(pool.mintRate) / 1e18).toFixed(0) : '…'}</b></div>
        <div><span>{T('tPOOL staked')}</span><b>{pool ? tokens(BigInt(pool.totalStaked)) : '…'}</b></div>
      </div>
      {pool && pool.queue.length > 0 && (
        <div className="pl-queue">
          <b>{T('Next in the queue')}</b>
          {pool.queue.map(q => <span key={q.index}>#{q.index} {short(q.user)} {money(usdOf(q.amount))}</span>)}
        </div>
      )}
      <ul className="pl-rules">
        <li>{T('The pool starts at $0. Nobody deposits into it: it fills only from traders’ losses.')}</li>
        <li>{T('When you close, what you paid comes back at once, up to what the position is worth. Only a profit can wait.')}</li>
        <li>{T('A profit the pool can’t pay waits in a first-in, first-out queue; new losses pay the queue first, in order.')}</li>
        <li>{T('Every loss mints tPOOL to the trader: 100 per $1 while the pool is small. Staked tPOOL earns half of the pool’s fees.')}</li>
        <li>{T('Fees: 2% of a win, and 2% of the pool’s gain on a loss, taken only while nothing is queued.')}</li>
        <li>{T('A settlement waits {m} minutes before it pays, so a wrong one can be stopped.', { m: pool ? Math.round(pool.settleDelay / 60) : 10 })}</li>
      </ul>
    </div>
  )
}

/** Everyone's latest pool fills, scrolling. */
export function PoolTicker({ nameOf }: { nameOf: PoolNameOf }) {
  const fills = usePoolFills(null)
  const items = useMemo(() => (fills ?? []).filter(f => f.kind !== 'rejected').slice(0, 16), [fills])
  if (!items.length) return null
  const row = (pre: string) => items.map(f => {
    const n = nameOf(f.outcome)
    const pnl = f.pnl == null ? null : usdOf(f.pnl)
    return (
      <span key={`${pre}${f.tx}-${f.requestId}-${f.kind}-${f.trader}`} className="pr-tick" aria-hidden={pre === 'b' || undefined}>
        <b>{short(f.trader)}</b> {f.kind === 'buy' ? T('bought') : f.kind === 'sell' ? T('sold') : T('was paid')} <span className={f.kind === 'buy' ? 'fx-up' : ''}>{n.sides[f.side]}</span> {money(usdOf(f.usd))}
        {pnl != null && <em className={updown(pnl)}> {signed(pnl)}</em>}
        <small> · {n.title}</small>
      </span>
    )
  })
  return (
    <div className="pr-ticker" aria-label={T('Latest pool trades')}>
      <div className="pr-ticker-run">{row('a')}{row('b')}</div>
    </div>
  )
}
