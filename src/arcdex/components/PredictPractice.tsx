// Practice predictions on /predict (lib/predictPractice.ts): papertrade.xyz's way of trading, on Hyperliquid's
// prediction markets, with virtual USDC. One tap buys a side at its mid; a position is held until sold or settled by
// Hyperliquid. The account bar, the trade panel, positions, history and the leaderboard, all marked PRACTICE.

import { useEffect, useMemo, useState } from 'react'
import { N_, t as T } from '../lib/i18n'
import { describeOutcome, questionTitle } from '../hl/markets'
import { money } from './HlShared'
import { AgoText } from './Ago'
import {
  PRACTICE, PracticeError, practiceBuy, practiceRename, practiceReset, practiceSell, startPractice, usePracticeBoard,
  type BoardPeriod, type PracticeFill, type PracticeSpec, type PracticeView,
} from '../lib/predictPractice'
import type { PracticeSide } from '../../../api/_practiceProtocol'

export const PRACTICE_NOTE = N_('Practice uses virtual USDC. Every order fills at the market’s live mid on Hyperliquid, with no slippage and no fee, and a position you hold is paid out when Hyperliquid settles the market. Nothing is sent to Hyperliquid, and nothing here is real money.')

const errOf = (e: unknown) => (e instanceof PracticeError ? T(e.message) : T('Something went wrong: {e}', { e: String((e as Error)?.message ?? e) }))
const cents = (p: number | null | undefined) => (p == null ? '—' : p < 0.01 ? '<1¢' : p > 0.99 ? '>99¢' : `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}¢`)
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`
const updown = (n: number) => (n > 0 ? 'fx-up' : n < 0 ? 'fx-down' : '')
const qty = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 })

/** A market's name and its sides' names, from the spec Hyperliquid listed (also once it has settled). */
export function specName(spec: PracticeSpec): { title: string; sides: [string, string] } {
  const m = describeOutcome({ ...spec.o, sideSpecs: spec.o.sideSpecs.length >= 2 ? spec.o.sideSpecs : [{ name: 'Yes' }, { name: 'No' }] }, spec.q)
  const title = spec.q ? `${questionTitle(spec.q)} · ${m.label}` : m.title
  return { title, sides: [m.sides[0].name, m.sides[1].name] }
}

// ── the switch and the account bar ───────────────────────────────────────

export type PredictMode = 'live' | 'practice'
const MODE_KEY = 'arcdex:predict-mode'

export function readPredictMode(liveOn: boolean): PredictMode {
  try { const v = localStorage.getItem(MODE_KEY); if (v === 'live' || v === 'practice') return v } catch { /* storage blocked */ }
  return liveOn ? 'live' : 'practice'
}
export function savePredictMode(m: PredictMode) { try { localStorage.setItem(MODE_KEY, m) } catch { /* storage blocked */ } }

export function PredictModeSwitch({ mode, liveOn, onChange }: { mode: PredictMode; liveOn: boolean; onChange: (m: PredictMode) => void }) {
  return (
    <div className="pp-mode pr-mode" role="tablist" aria-label={T('Trading mode')}>
      <button role="tab" aria-selected={mode === 'practice'} className={mode === 'practice' ? 'active paper' : ''} onClick={() => onChange('practice')} title={T('Practise with virtual USDC')}>
        {T('Practice')}
      </button>
      <button role="tab" aria-selected={mode === 'live'} className={mode === 'live' ? 'active' : ''} onClick={() => onChange('live')}>
        {T('Live')}{!liveOn && <em>{T('Soon')}</em>}
      </button>
    </div>
  )
}

/** Before an account exists: one button, $10,000 of virtual USDC. */
export function PracticeStart({ onStarted }: { onStarted: (v: PracticeView) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="pr-start">
      <div>
        <b>{T('Practise predictions with ${n} of virtual USDC', { n: PRACTICE.startUsd.toLocaleString() })}</b>
        <span>{T('One tap to buy a side at the live price. No wallet, no fees, nothing real at stake. Climb the leaderboard.')}</span>
      </div>
      <button className="btn-primary" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null)
        try { onStarted(await startPractice()) } catch (e) { setErr(errOf(e)) } finally { setBusy(false) }
      }}>{busy ? T('Starting…') : T('Start practising')}</button>
      {err && <div className="fx-hint-bad">⚠ {err}</div>}
    </div>
  )
}

export function PracticeBar({ account, onChange }: { account: PracticeView; onChange: (v: PracticeView) => void }) {
  const [menu, setMenu] = useState<'reset' | 'name' | null>(null)
  const [name, setName] = useState(account.name)
  const [err, setErr] = useState<string | null>(null)
  const posValue = account.positions.reduce((s, p) => s + (p.value ?? p.cost), 0)
  const winRate = account.trades ? Math.round((account.wins / account.trades) * 100) : null
  const run = async (f: () => Promise<PracticeView>) => {
    setErr(null)
    try { onChange(await f()); setMenu(null) } catch (e) { setErr(errOf(e)) }
  }
  return (
    <div className="pr-bar">
      <span className="pp-badge">{T('PRACTICE')}</span>
      <div><span>{T('Balance')}</span><b>{money(account.equity)}</b></div>
      <div><span>{T('Cash')}</span><b>{money(account.cash)}</b></div>
      <div><span>{T('In positions')}</span><b>{money(posValue)}</b></div>
      <div><span>{T('P&L')}</span><b className={updown(account.pnl)}>{signed(account.pnl)}</b></div>
      <div><span>{T('Win rate')}</span><b>{winRate == null ? '—' : `${winRate}%`}</b><small>{T('{n} trades', { n: account.trades })}</small></div>
      <div className="pr-bar-name">
        <button className="link-btn" onClick={() => setMenu(menu === 'name' ? null : 'name')} title={T('Your name on the leaderboard')}>👤 {account.name}</button>
        <button className="link-btn" onClick={() => setMenu(menu === 'reset' ? null : 'reset')}>{T('Reset')}</button>
      </div>
      {menu === 'name' && (
        <div className="pr-pop">
          <input className="field" value={name} maxLength={24} onChange={e => setName(e.target.value)} aria-label={T('Your name on the leaderboard')} />
          <button className="btn-primary" onClick={() => run(() => practiceRename(name))}>{T('Save')}</button>
        </div>
      )}
      {menu === 'reset' && (
        <div className="pr-pop">
          <span>{T('Start over with:')}</span>
          {PRACTICE.resetChoices.map(n => <button key={n} className="btn-ghost" onClick={() => run(() => practiceReset(n))}>{money(n, 0)}</button>)}
        </div>
      )}
      {err && <div className="fx-hint-bad pr-bar-err">⚠ {err}</div>}
    </div>
  )
}

// ── the trade panel ──────────────────────────────────────────────────────

export interface PracticePick { outcome: number; title: string; sides: [string, string]; side: PracticeSide; mode: 'buy' | 'sell' }

export function PracticeTradePanel({ pick, setPick, px, account, onDone, onStart }: {
  pick: PracticePick; setPick: (p: PracticePick) => void; px: [number | null, number | null]
  account: PracticeView | null; onDone: (v: PracticeView, f: PracticeFill) => void; onStart: () => void
}) {
  const { outcome, side, mode } = pick
  const [usd, setUsd] = useState('')
  const [frac, setFrac] = useState(1)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setNote(null) }, [outcome, side, mode])
  const isBuy = mode === 'buy'
  const price = px[side]
  const holding = account?.positions.find(p => p.outcome === outcome && p.side === side) ?? null
  const amount = +usd || 0
  const contracts = price ? amount / price : 0
  const sellN = holding ? holding.contracts * frac : 0
  const sellUsd = price ? sellN * price : 0
  const sellPnl = holding ? sellUsd - holding.cost * frac : 0
  const decided = price != null && (price < PRACTICE.minBuyPx || price > PRACTICE.maxBuyPx)
  const ready = !!account && price != null && (isBuy ? amount >= PRACTICE.minOrderUsd && amount <= account.cash && !decided : !!holding)

  async function submit() {
    setBusy(true); setNote(null)
    try {
      const r = isBuy ? await practiceBuy(outcome, side, amount) : await practiceSell(outcome, side, frac)
      const f = r.fill
      setNote({ ok: true, text: isBuy
        ? T('Bought {n} {side} at {px}', { n: qty(f.contracts), side: pick.sides[side], px: cents(f.px) })
        : T('Sold {n} {side} at {px}: {pnl}', { n: qty(f.contracts), side: pick.sides[side], px: cents(f.px), pnl: signed(f.pnl ?? 0) }) })
      setUsd('')
      onDone(r.account, f)
    } catch (e) { setNote({ ok: false, text: errOf(e) }) } finally { setBusy(false) }
  }

  return (
    <div className="fx-order hl-order pm-trade pr-trade">
      <div className="pp-banner"><b>{T('PRACTICE')}</b><span>{T('Virtual USDC, filled at the live mid')}</span></div>
      <div className="pm-trade-h"><b>{pick.title}</b></div>
      <div className="fxb-kinds">
        <button className={isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'buy' })}>{T('Buy')}</button>
        <button className={!isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'sell' })}>{T('Sell')}{holding ? ` (${qty(holding.contracts)})` : ''}</button>
      </div>
      <div className="pm-sides">
        {([0, 1] as const).map(s => (
          <button key={s} className={`pm-side s${s}${side === s ? ' on' : ''}`} onClick={() => setPick({ ...pick, side: s })}>
            <span>{pick.sides[s]}</span><b>{cents(px[s])}</b>
          </button>
        ))}
      </div>
      {!account ? (
        <button className="fx-go fx-go-primary" onClick={onStart}>{T('Start practising')}</button>
      ) : isBuy ? (
        <>
          <div className="fxb-input"><span>{T('Amount')}</span><input inputMode="decimal" value={usd} placeholder={`${PRACTICE.minOrderUsd}+`} onChange={e => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} /><em>USD</em></div>
          <div className="fxb-ticks">
            {[10, 50, 100, 500].map(v => <button key={v} className={+usd === v ? 'on' : ''} onClick={() => setUsd(String(v))}>${v}</button>)}
            <button onClick={() => setUsd(String(Math.floor(account.cash / 2)))}>½</button>
            <button onClick={() => setUsd(String(Math.floor(account.cash)))}>{T('Max')}</button>
          </div>
          <button className={`fx-go ${side === 0 ? 'long' : 'short'}`} disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? T('Sending…') : T('Buy {side}', { side: pick.sides[side] })}
          </button>
          {decided && <div className="fx-hint-bad">{T('This side is all but decided: practice buys need a price between 1¢ and 99¢.')}</div>}
          {amount > account.cash && <div className="fx-hint-bad">{T('Not enough practice USDC.')}</div>}
        </>
      ) : holding ? (
        <>
          <div className="fxb-ticks pr-fracs">
            {[0.25, 0.5, 1].map(f => <button key={f} className={frac === f ? 'on' : ''} onClick={() => setFrac(f)}>{f === 1 ? T('All') : `${f * 100}%`}</button>)}
          </div>
          <button className="fx-go fx-go-primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? T('Sending…') : T('Sell {side}', { side: pick.sides[side] })}
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
          </>
        ) : (
          <>
            <div><span>{T('Contracts')}</span><b>{sellN ? qty(sellN) : '—'}</b></div>
            <div><span>{T('You receive')}</span><b>{sellN ? money(sellUsd) : '—'}</b></div>
            <div><span>{T('P&L')}</span><b className={updown(sellPnl)}>{sellN ? signed(sellPnl) : '—'}</b></div>
          </>
        )}
        <div><span>{T('Fee')}</span><b>{T('None')}</b></div>
      </div>
      <div className="fx-fine">{T('Each contract pays $1 if its side happens and nothing if not, when Hyperliquid settles the market.')}</div>
    </div>
  )
}

// ── positions, history and the leaderboard ───────────────────────────────

type Tab = 'positions' | 'history' | 'board'

export function PracticePanel({ account, onSell }: { account: PracticeView | null; onSell: (p: PracticePick) => void }) {
  const [tab, setTab] = useState<Tab>(account?.positions.length ? 'positions' : 'board')
  const [period, setPeriod] = useState<BoardPeriod>('24h')
  const { board, error } = usePracticeBoard(period, tab === 'board')
  return (
    <div className="spot-panel pr-panel">
      <div className="hl-acct-tabs pr-tabs">
        <span className="pp-badge">{T('PRACTICE')}</span>
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>{T('Positions')}{account?.positions.length ? ` (${account.positions.length})` : ''}</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>{T('History')}</button>
        <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>🏆 {T('Leaderboard')}</button>
      </div>
      {tab === 'positions' && <Positions account={account} onSell={onSell} />}
      {tab === 'history' && <History account={account} />}
      {tab === 'board' && (
        <>
          <div className="pr-periods">
            {(['24h', '7d', 'all'] as const).map(p => <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>{p === 'all' ? T('All time') : p.toUpperCase()}</button>)}
            {board && <small>{T('{n} practice accounts', { n: board.accounts })}</small>}
          </div>
          {!board ? <div className="fx-empty">{error ? `⚠ ${error}` : T('Loading…')}</div> : <Board board={board} />}
        </>
      )}
    </div>
  )
}

function Positions({ account, onSell }: { account: PracticeView | null; onSell: (p: PracticePick) => void }) {
  if (!account || !account.positions.length) return <div className="fx-empty">{T('No practice positions yet. Pick a side on any market below.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Market')}</th><th>{T('Side')}</th><th>{T('Contracts')}</th><th>{T('Avg price')}</th><th>{T('Now')}</th><th>{T('Value')}</th><th>{T('P&L')}</th><th /></tr></thead>
        <tbody>
          {account.positions.map(p => {
            const n = specName(p.spec)
            const pnl = p.value == null ? null : p.value - p.cost
            return (
              <tr key={`${p.outcome}:${p.side}`}>
                <td><b>{n.title}</b></td>
                <td className={p.side === 0 ? 'fx-up' : 'fx-down'}>{n.sides[p.side]}</td>
                <td>{qty(p.contracts)}</td>
                <td>{cents(p.cost / p.contracts)}</td>
                <td>{cents(p.px)}</td>
                <td>{p.value == null ? '—' : money(p.value)}</td>
                <td className={pnl == null ? '' : updown(pnl)}>{pnl == null ? '—' : signed(pnl)}</td>
                <td><button className="btn-ghost" onClick={() => onSell({ outcome: p.outcome, title: n.title, sides: n.sides, side: p.side, mode: 'sell' })}>{T('Sell')}</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function History({ account }: { account: PracticeView | null }) {
  if (!account || !account.history.length) return <div className="fx-empty">{T('Closed and settled trades show here.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Market')}</th><th>{T('Side')}</th><th>{T('Entry → exit')}</th><th>{T('Cost')}</th><th>{T('P&L')}</th><th>{T('How')}</th><th>{T('Closed')}</th></tr></thead>
        <tbody>
          {account.history.map(t => {
            const n = specName(t.spec)
            return (
              <tr key={t.id}>
                <td><b>{n.title}</b></td>
                <td className={t.side === 0 ? 'fx-up' : 'fx-down'}>{n.sides[t.side]}</td>
                <td>{cents(t.entryPx)} → {cents(t.exitPx)}</td>
                <td>{money(t.cost)}</td>
                <td className={updown(t.pnl)}>{signed(t.pnl)}</td>
                <td>{t.how === 'settled' ? T('Settled') : T('Sold')}</td>
                <td><AgoText ts={t.closedAt} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const MEDAL = ['🥇', '🥈', '🥉']

function Board({ board }: { board: NonNullable<ReturnType<typeof usePracticeBoard>['board']> }) {
  return (
    <div className="pr-board">
      <div>
        <b className="pr-board-h">{T('Top traders')}</b>
        {!board.traders.length ? <div className="fx-empty">{T('Nobody has {n} closed trades in this window yet.', { n: PRACTICE.boardMinTrades })}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>#</th><th>{T('Trader')}</th><th>{T('P&L')}</th><th>{T('Trades')}</th><th>{T('Win rate')}</th><th>{T('Best trade')}</th></tr></thead>
              <tbody>
                {board.traders.slice(0, 20).map((t, i) => (
                  <tr key={`${t.name}-${i}`} className={i < 3 ? `pr-top pr-top${i}` : ''}>
                    <td>{MEDAL[i] ?? i + 1}</td>
                    <td><b>{t.name}</b></td>
                    <td className={updown(t.pnl)}>{signed(t.pnl)}</td>
                    <td>{t.trades}</td>
                    <td>{Math.round((t.wins / t.trades) * 100)}%</td>
                    <td className={updown(t.best)}>{signed(t.best)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <b className="pr-board-h">{T('Best trades')}</b>
        {!board.trades.length ? <div className="fx-empty">{T('No winning trades in this window yet.')}</div> : (
          <div className="fx-table-wrap">
            <table className="fx-table hl-table">
              <thead><tr><th>{T('Trader')}</th><th>{T('Market')}</th><th>{T('Entry → exit')}</th><th>{T('Cost')}</th><th>{T('P&L')}</th><th>{T('Closed')}</th></tr></thead>
              <tbody>
                {board.trades.slice(0, 15).map((t, i) => {
                  const n = specName(t.spec)
                  return (
                    <tr key={`${t.name}-${t.closedAt}-${i}`} className={i < 3 ? `pr-top pr-top${i}` : ''}>
                      <td><b>{t.name}</b></td>
                      <td>{n.title} · <span className={t.side === 0 ? 'fx-up' : 'fx-down'}>{n.sides[t.side]}</span></td>
                      <td>{cents(t.entryPx)} → {cents(t.exitPx)}</td>
                      <td>{money(t.cost)}</td>
                      <td className="fx-up">{signed(t.pnl)} <small>({Math.round((t.pnl / t.cost) * 100)}%)</small></td>
                      <td><AgoText ts={t.closedAt} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/** papertrade's ticker: everyone's latest practice fills, scrolling. */
export function PracticeTicker() {
  const { board } = usePracticeBoard('24h')
  const items = useMemo(() => (board?.recent ?? []).slice(0, 16).map(f => {
    const n = specName(f.spec)
    return { key: `${f.name}-${f.at}-${f.outcome}-${f.buy}`, name: f.name, buy: f.buy, side: n.sides[f.side], title: n.title, usd: f.usd, pnl: f.pnl }
  }), [board])
  if (!items.length) return null
  const row = (pre: string) => items.map(i => (
    <span key={pre + i.key} className="pr-tick" aria-hidden={pre === 'b' || undefined}>
      <b>{i.name}</b> {i.buy ? T('bought') : T('sold')} <span className={i.buy ? 'fx-up' : ''}>{i.side}</span> {money(i.usd)}
      {!i.buy && i.pnl != null && <em className={updown(i.pnl)}> {signed(i.pnl)}</em>}
      <small> · {i.title}</small>
    </span>
  ))
  return (
    <div className="pr-ticker" aria-label={T('Latest practice trades')}>
      <div className="pr-ticker-run">{row('a')}{row('b')}</div>
    </div>
  )
}
