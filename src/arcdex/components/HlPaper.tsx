// Paper trading on /futures (hl/paper.ts): the order form, the account box and the account tabs for the paper
// account, beside the live ones behind a Live | Paper switch (build pack phase 5: "alerts and paper trading first").
//
// Everything here says PAPER. Orders fill against Hyperliquid's live book in this browser; nothing is sent anywhere.

import { useEffect, useMemo, useState } from 'react'
import { N_, t as T } from '../lib/i18n'
import type { HlMarket } from '../hl/markets'
import { HL_TRADING } from '../hl/client'
import { BUILDER } from '../hl/access'
import { DEFAULT_SLIPPAGE } from '../hl/exec'
import { roundPrice, roundSize } from '../hl/wire'
import { fmtNum, fmtPx, pct, sanitize, signedUsd, upDown } from '../hl/format'
import {
  cancelPaper, liqPrice, PAPER, PaperError, paperBook, paperFees, placeLimit, placeMarket, setTpSl,
  type PaperApi, type PaperEvent, type PaperFill, type PaperNotice, type PaperOrder, type PaperPos,
} from '../hl/paper'
import { DEFAULT_LEVERAGE, LeverageModal, errText, money } from './HlShared'
import { AlertsList } from './HlAlerts'
import { activeAlerts, useAlerts } from '../hl/alerts'
import { ShareFuturesButton } from './FuturesShare'

type Note = { ok: boolean; text: string }

/** What a paper order pays: Hyperliquid's base fee plus ARCDEX's builder fee, as a real order through ARCDEX would. */
export const paperFeesNow = () => paperFees(BUILDER.perpF / 100_000)
const paperErr = (e: unknown) => (e instanceof PaperError ? T(e.message) : errText(e))
const symOf = (coin: string, byCoin: Map<string, HlMarket>) => byCoin.get(coin)?.symbol ?? coin.split(':').pop() ?? coin

export const PAPER_NOTE = N_('Paper trading uses virtual USDC against Hyperliquid’s live prices and order book. Fills, fees (ARCDEX’s included), Hyperliquid’s hourly funding and liquidations are worked out in this browser; the market impact of your own orders and partial fills aren’t. Nothing is sent to Hyperliquid.')

// ── which account the page trades ────────────────────────────────────────

export type TradeMode = 'live' | 'paper'
const MODE_KEY = 'arcdex:hl-mode'

/** Live or paper, remembered in this browser. Paper is where a visitor starts while live trading isn't switched on. */
export function useTradeMode(): [TradeMode, (m: TradeMode) => void] {
  const [mode, setMode] = useState<TradeMode>(() => {
    try { const v = localStorage.getItem(MODE_KEY); if (v === 'live' || v === 'paper') return v } catch { /* storage blocked */ }
    return HL_TRADING ? 'live' : 'paper'
  })
  return [mode, m => { setMode(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* storage blocked */ } }]
}

export function ModeSwitch({ mode, onChange }: { mode: TradeMode; onChange: (m: TradeMode) => void }) {
  return (
    <div className="pp-mode" role="tablist" aria-label={T('Trading mode')}>
      <button role="tab" aria-selected={mode === 'live'} className={mode === 'live' ? 'active' : ''} onClick={() => onChange('live')}>
        {T('Live')}{!HL_TRADING && <em>{T('Soon')}</em>}
      </button>
      <button role="tab" aria-selected={mode === 'paper'} className={mode === 'paper' ? 'active paper' : ''} onClick={() => onChange('paper')} title={T('Practise with virtual USDC')}>
        {T('Paper')}
      </button>
    </div>
  )
}

// ── the order form ───────────────────────────────────────────────────────

const avgOf = (fills: PaperFill[]) => {
  const sz = fills.reduce((a, f) => a + f.sz, 0)
  return { sz, px: sz > 0 ? fills.reduce((a, f) => a + f.px * f.sz, 0) / sz : 0 }
}

export function PaperOrderPanel({ market, px, paper, prefill }: { market: HlMarket; px: number; paper: PaperApi; prefill: { px: number; n: number } | null }) {
  const fees = useMemo(paperFeesNow, [])
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [lev, setLev] = useState(Math.min(DEFAULT_LEVERAGE, market.maxLeverage))
  const [levOpen, setLevOpen] = useState(false)
  const [size, setSize] = useState('')
  const [limitPx, setLimitPx] = useState('')
  const [postOnly, setPostOnly] = useState(false)
  const [reduce, setReduce] = useState(false)
  const [tpsl, setTpsl] = useState(false)
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  const [slip, setSlip] = useState(DEFAULT_SLIPPAGE)
  const [busy, setBusy] = useState<'long' | 'short' | null>(null)
  const [note, setNote] = useState<Note | null>(null)

  useEffect(() => {
    setLev(Math.min(DEFAULT_LEVERAGE, market.maxLeverage))
    setSize(''); setLimitPx(''); setTp(''); setSl(''); setNote(null)
  }, [market.coin, market.maxLeverage])
  // A price picked in the book becomes a limit order's price.
  useEffect(() => { if (prefill) { setKind('limit'); setLimitPx(String(prefill.px)) } }, [prefill])

  // An open position keeps its leverage: an order that adds to it uses that.
  const position = paper.state.positions.find(p => p.coin === market.coin) ?? null
  const shownLev = position ? position.lev : lev
  const value = +size || 0
  const refPx = kind === 'limit' && +limitPx > 0 ? +limitPx : px
  const avbl = paper.summary.available
  const feeRate = kind === 'limit' && postOnly ? fees.maker : fees.taker
  const maxValue = Math.max(0, (avbl / (1 / shownLev + fees.taker)) * 0.98)
  const share = maxValue > 0 ? Math.min(100, Math.round((value / maxValue) * 100)) : 0
  const setShare = (p: number) => { if (maxValue > 0) setSize(String(Math.floor(((maxValue * p) / 100) * 100) / 100)) }
  const coinSz = refPx > 0 ? roundSize(value / refPx, market.szDecimals) : 0
  const liq = (isLong: boolean) => (coinSz > 0 && !reduce ? liqPrice({ szi: isLong ? coinSz : -coinSz, entryPx: refPx, margin: (coinSz * refPx) / shownLev, maxLev: market.maxLeverage }) : null)
  const tpN = +tp, slN = +sl
  const badTpsl = (isLong: boolean) => tpsl && ((tp !== '' && (isLong ? tpN <= refPx : tpN >= refPx)) || (sl !== '' && (isLong ? slN >= refPx : slN <= refPx)))
  const tooSmall = !reduce && value > 0 && value < PAPER.minOrder
  const ready = px > 0 && coinSz > 0 && (reduce || value >= PAPER.minOrder) && (kind === 'market' || +limitPx > 0)

  async function submit(isBuy: boolean) {
    setBusy(isBuy ? 'long' : 'short'); setNote(null)
    try {
      const book = await paperBook(market.coin)
      const base = {
        coin: market.coin, isBuy, sz: coinSz, lev: shownLev, maxLev: market.maxLeverage, reduceOnly: reduce, mid: book.mid || px, book,
        time: Date.now(), fees, tp: tpsl && tp ? roundPrice(tpN, market.szDecimals, true) : null, sl: tpsl && sl ? roundPrice(slN, market.szDecimals, true) : null,
      }
      if (kind === 'market') {
        const r = paper.run(s => placeMarket(s, { ...base, slippage: slip }))
        setNote({ ok: true, text: T('Paper order filled: {sz} {symbol} at {px}', { sz: fmtNum(r.sz, market.szDecimals), symbol: market.symbol, px: fmtPx(r.avg) }) })
      } else {
        const r = paper.run(s => placeLimit(s, { ...base, px: roundPrice(+limitPx, market.szDecimals, true), postOnly }))
        const f = avgOf(r.fills)
        setNote({ ok: true, text: r.resting ? T('Paper order placed: it fills when the price reaches it.') : T('Paper order filled: {sz} {symbol} at {px}', { sz: fmtNum(f.sz, market.szDecimals), symbol: market.symbol, px: fmtPx(f.px) }) })
      }
      setSize('')
    } catch (e) { setNote({ ok: false, text: paperErr(e) }) }
    finally { setBusy(null) }
  }

  return (
    <div className="fx-order hl-order pp-order">
      <div className="pp-banner"><b>{T('PAPER')}</b><span>{T('Virtual USDC, Hyperliquid’s live prices')}</span></div>
      <div className="fxb-mode">
        <span className="fxb-chip" title={T('Paper positions use isolated margin: a loss stops at the position’s margin.')}>{T('Isolated')}</span>
        <button className="fxb-chip fxb-chip-btn" disabled={!!position} title={position ? T('Your open position’s leverage. Close it to change.') : undefined} onClick={() => setLevOpen(true)}>{shownLev}×</button>
      </div>
      <div className="fxb-kinds">
        <button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>{T('Market')}</button>
        <button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>{T('Limit')}</button>
      </div>
      <div className="fxb-avbl"><span>{T('Avbl')}</span><b>{money(avbl)}</b></div>
      {kind === 'limit' ? (
        <div className="fxb-input">
          <span>{T('Price')}</span>
          <input inputMode="decimal" value={limitPx} placeholder={fmtPx(px)} onChange={e => setLimitPx(sanitize(e.target.value))} />
          <button className="fxb-last-btn" onClick={() => px && setLimitPx(String(roundPrice(px, market.szDecimals, true)))}>{T('Mid')}</button>
          <em>USD</em>
        </div>
      ) : (
        <div className="fxb-input fxb-input-ro"><span>{T('Price')}</span><input readOnly value={T('Market price')} /><em>USD</em></div>
      )}
      <div className="fxb-input">
        <span>{T('Size')}</span>
        <input inputMode="decimal" value={size} placeholder={`${PAPER.minOrder}+`} onChange={e => setSize(sanitize(e.target.value))} />
        <em>USD</em>
      </div>
      <div className="fxb-slider">
        <input type="range" min={0} max={100} step={1} value={share} onChange={e => setShare(+e.target.value)} disabled={maxValue <= 0} aria-label={T('Share of what you can trade')} />
        <div className="fxb-ticks">{[0, 25, 50, 75, 100].map(v => <button key={v} className={share >= v ? 'on' : ''} onClick={() => setShare(v)} disabled={maxValue <= 0}>{v}%</button>)}</div>
      </div>
      <div className="hl-checks">
        <label className="fxb-check"><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} /> {T('Reduce only')}</label>
        {kind === 'limit' && <label className="fxb-check"><input type="checkbox" checked={postOnly} onChange={e => setPostOnly(e.target.checked)} /> {T('Post only')}</label>}
        <label className="fxb-check"><input type="checkbox" checked={tpsl} onChange={e => setTpsl(e.target.checked)} /> {T('TP/SL')}</label>
      </div>
      {tpsl && (
        <div className="fx-tpsl">
          <div className="fxb-input"><span>{T('Take-profit')}</span><input inputMode="decimal" value={tp} onChange={e => setTp(sanitize(e.target.value))} /></div>
          <div className="fxb-input"><span>{T('Stop-loss')}</span><input inputMode="decimal" value={sl} onChange={e => setSl(sanitize(e.target.value))} /></div>
          <div className="fx-fine" style={{ gridColumn: '1 / -1' }}>{T('A long takes profit above the entry and stops below it; a short, the other way round.')}</div>
        </div>
      )}
      <div className="fxb-buttons">
        <button className="fx-go long" disabled={!ready || busy !== null || badTpsl(true)} onClick={() => void submit(true)}>{busy === 'long' ? T('Filling…') : T('Buy / Long')}</button>
        <button className="fx-go short" disabled={!ready || busy !== null || badTpsl(false)} onClick={() => void submit(false)}>{busy === 'short' ? T('Filling…') : T('Sell / Short')}</button>
      </div>
      {tooSmall && <div className="fx-fine">{T('Hyperliquid’s smallest order is ${n}.', { n: PAPER.minOrder })}</div>}
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      <div className="fxb-sides">
        <div><span>{T('Liq. price')}</span><b>{liq(true) != null ? `≈ ${fmtPx(liq(true))}` : '—'}</b></div>
        <div><span>{T('Liq. price')}</span><b>{liq(false) != null ? `≈ ${fmtPx(liq(false))}` : '—'}</b></div>
        <div><span>{T('Margin')}</span><b>{value && !reduce ? money(value / shownLev) : '—'}</b></div>
        <div><span>{T('Margin')}</span><b>{value && !reduce ? money(value / shownLev) : '—'}</b></div>
      </div>
      <div className="fx-summary">
        <div><span>{T('Order value')}</span><b>{value ? money(value) : '—'}{coinSz ? <small> · {fmtNum(coinSz, market.szDecimals)} {market.symbol}</small> : null}</b></div>
        <div><span>{T('Fees')}</span><b>{value ? money(value * feeRate, 4) : '—'} <small>{(feeRate * 100).toFixed(3)}%</small></b></div>
        {BUILDER.perpF > 0 && <div><span>{T('incl. ARCDEX fee')}</span><b>{(BUILDER.perpF / 1000).toFixed(3)}%</b></div>}
        {kind === 'market' && <div><span>{T('Max price move')}</span><b>{[0.01, 0.03, 0.05].map(v => <button key={v} className={`hl-slip${slip === v ? ' active' : ''}`} onClick={() => setSlip(v)}>{v * 100}%</button>)}</b></div>}
      </div>
      <div className="fx-fine">{T(PAPER_NOTE)}</div>
      {levOpen && <LeverageModal lev={lev} max={market.maxLeverage} onChange={setLev} onClose={() => setLevOpen(false)} />}
    </div>
  )
}

// ── the account box ──────────────────────────────────────────────────────

export function PaperAccountBox({ paper, onReset }: { paper: PaperApi; onReset: () => void }) {
  const s = paper.summary
  const pnlPct = paper.state.deposited > 0 ? (s.pnl / paper.state.deposited) * 100 : 0
  return (
    <div className="spot-panel fxb-account pp-account">
      <div className="spot-panel-h"><span>{T('Paper account')}</span><span className="pp-badge">{T('PAPER')}</span></div>
      <div className="fxb-acct-row"><span>{T('Account value')}</span><b>{money(s.value)}</b></div>
      <div className="fxb-acct-row"><span>{T('Available to trade')}</span><b>{money(s.available)}</b></div>
      <div className="fxb-acct-row"><span>{T('Total P&L')}</span><b className={upDown(s.pnl)}>{signedUsd(s.pnl)} <small>{pct(pnlPct)}</small></b></div>
      {paper.catching && <div className="fx-fine">{T('Catching up on the prices you missed…')}</div>}
      <div className="fxb-acct-btns"><button className="btn-ghost" onClick={onReset}>{T('Reset')}</button></div>
    </div>
  )
}

export function PaperResetModal({ onReset, onClose }: { onReset: (amount: number) => void; onClose: () => void }) {
  const [amount, setAmount] = useState(PAPER.start)
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card hl-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('Reset paper account')}</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <p className="fx-fine">{T('Every paper position, order and trade is cleared, and the account starts again with:')}</p>
        <div className="pp-amounts">{[1_000, 10_000, 100_000].map(a => <button key={a} className={amount === a ? 'active' : ''} onClick={() => setAmount(a)}>{money(a, 0)}</button>)}</div>
        <button className="btn-primary" onClick={() => { onReset(amount); onClose() }}>{T('Reset to {amount}', { amount: money(amount, 0) })}</button>
      </div>
    </div>
  )
}

// ── the account tabs ─────────────────────────────────────────────────────

function PaperTpSlModal({ p, m, paper, mark, onClose, onDone }: { p: PaperPos; m: HlMarket | undefined; paper: PaperApi; mark: number; onClose: () => void; onDone: (n: Note) => void }) {
  const old = paper.state.orders.filter(o => o.coin === p.coin && o.kind !== 'limit')
  const [tp, setTp] = useState(() => String(old.find(o => o.kind === 'tp')?.px ?? ''))
  const [sl, setSl] = useState(() => String(old.find(o => o.kind === 'sl')?.px ?? ''))
  const [err, setErr] = useState<string | null>(null)
  const isLong = p.szi > 0
  const dec = m?.szDecimals ?? 4
  const bad = (tp !== '' && (isLong ? +tp <= mark : +tp >= mark)) || (sl !== '' && (isLong ? +sl >= mark : +sl <= mark))
  function save() {
    try {
      paper.run(s => ({ state: setTpSl(s, p.coin, tp ? roundPrice(+tp, dec, true) : null, sl ? roundPrice(+sl, dec, true) : null, Date.now(), paperFeesNow()) }))
      onDone({ ok: true, text: T('Take-profit and stop-loss saved.') })
    } catch (e) { setErr(paperErr(e)) }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card hl-modal" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{T('TP / SL for {sym} {side}', { sym: m?.symbol ?? p.coin, side: isLong ? T('Long') : T('Short') })} <span className="pp-badge">{T('PAPER')}</span></b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <div className="fx-summary"><div><span>{T('Entry')}</span><b>{fmtPx(p.entryPx)}</b></div><div><span>{T('Mark')}</span><b>{fmtPx(mark)}</b></div></div>
        <div className="fxb-input"><span>{T('Take-profit')}</span><input inputMode="decimal" value={tp} onChange={e => setTp(sanitize(e.target.value))} placeholder={T('None')} /></div>
        <div className="fxb-input"><span>{T('Stop-loss')}</span><input inputMode="decimal" value={sl} onChange={e => setSl(sanitize(e.target.value))} placeholder={T('None')} /></div>
        {bad && <div className="fx-hint-bad">{T('A long takes profit above the entry and stops below it; a short, the other way round.')}</div>}
        {err && <div className="fx-hint-bad">⚠ {err}</div>}
        <button className="btn-primary" disabled={bad} onClick={save}>{T('Save')}</button>
      </div>
    </div>
  )
}

function PaperPositions({ paper, positions, byCoin, mids, onSelect, onNote }: {
  paper: PaperApi; positions: PaperPos[]; byCoin: Map<string, HlMarket>; mids: Readonly<Record<string, number>>; onSelect: (coin: string) => void; onNote: (n: Note) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<PaperPos | null>(null)
  if (!positions.length) return <div className="fx-empty">{T('No open paper positions.')}</div>
  async function close(p: PaperPos) {
    setBusy(p.coin)
    try {
      const book = await paperBook(p.coin)
      const r = paper.run(s => placeMarket(s, {
        coin: p.coin, isBuy: p.szi < 0, sz: Math.abs(p.szi), lev: p.lev, maxLev: p.maxLev, reduceOnly: true, slippage: 0.05,
        mid: book.mid || mids[p.coin] || 0, book, time: Date.now(), fees: paperFeesNow(),
      }))
      const pnl = r.fills.reduce((a, f) => a + f.closedPnl, 0)
      onNote({ ok: true, text: T('Paper position closed: {sym} at {px}, {pnl}', { sym: symOf(p.coin, byCoin), px: fmtPx(r.avg), pnl: signedUsd(pnl) }) })
    } catch (e) { onNote({ ok: false, text: paperErr(e) }) }
    finally { setBusy(null) }
  }
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr>
          <th>{T('Market')}</th><th>{T('Size')}</th><th>{T('Value')}</th><th>{T('Entry')}</th><th>{T('Mark')}</th><th>{T('P&L (ROE)')}</th><th>{T('Liq. price')}</th><th>{T('Margin')}</th><th>{T('Funding')}</th><th>{T('TP / SL')}</th><th />
        </tr></thead>
        <tbody>
          {positions.map(p => {
            const m = byCoin.get(p.coin)
            const mark = mids[p.coin] ?? m?.markPx ?? 0
            const pnl = mark ? Math.max(-p.margin, (mark - p.entryPx) * p.szi) : 0
            const roe = p.margin > 0 ? (pnl / p.margin) * 100 : 0
            const tpO = paper.state.orders.find(o => o.coin === p.coin && o.kind === 'tp')
            const slO = paper.state.orders.find(o => o.coin === p.coin && o.kind === 'sl')
            return (
              <tr key={p.coin}>
                <td><button className="link-btn" onClick={() => onSelect(p.coin)}><b>{symOf(p.coin, byCoin)}</b></button> <span className={p.szi > 0 ? 'fx-up' : 'fx-down'}>{p.szi > 0 ? T('Long') : T('Short')}</span> <small>{p.lev}× {T('Isolated')}</small></td>
                <td>{fmtNum(Math.abs(p.szi), m?.szDecimals ?? 4)}</td>
                <td>{money(Math.abs(p.szi) * (mark || p.entryPx))}</td>
                <td>{fmtPx(p.entryPx)}</td>
                <td>{fmtPx(mark)}</td>
                <td className={upDown(pnl)}>{signedUsd(pnl)}<small> {pct(roe)}</small></td>
                <td className="fx-down">{fmtPx(liqPrice(p))}</td>
                <td>{money(p.margin)}</td>
                <td className={p.funding ? upDown(-p.funding) : ''}>{p.funding ? signedUsd(-p.funding) : '—'}</td>
                <td><button className="link-btn" onClick={() => setEditing(p)}>{tpO ? fmtPx(tpO.px) : '—'} / {slO ? fmtPx(slO.px) : '—'} ✎</button></td>
                <td className="fx-row-acts">
                  <ShareFuturesButton p={{ coin: p.coin, market: symOf(p.coin, byCoin), long: p.szi > 0, leverage: p.lev, roePct: roe, pnlUsd: pnl, entryPx: fmtPx(p.entryPx), markPx: fmtPx(mark), paper: true }} />
                  <button className="btn-ghost" disabled={busy !== null} onClick={() => void close(p)}>{busy === p.coin ? T('Closing…') : T('Close')}</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {editing && (
        <PaperTpSlModal
          p={editing} m={byCoin.get(editing.coin)} paper={paper} mark={mids[editing.coin] ?? byCoin.get(editing.coin)?.markPx ?? editing.entryPx}
          onClose={() => setEditing(null)} onDone={n => { setEditing(null); onNote(n) }}
        />
      )}
    </div>
  )
}

const KIND_LABEL: Record<PaperOrder['kind'], string> = { limit: N_('Limit'), tp: N_('Take profit'), sl: N_('Stop loss') }

function PaperOrders({ paper, orders, byCoin, onNote }: { paper: PaperApi; orders: PaperOrder[]; byCoin: Map<string, HlMarket>; onNote: (n: Note) => void }) {
  if (!orders.length) return <div className="fx-empty">{T('No open paper orders.')}</div>
  const cancel = (list: PaperOrder[]) => {
    paper.run(s => ({ state: cancelPaper(s, list.map(o => o.oid)) }))
    onNote({ ok: true, text: list.length > 1 ? T('Orders cancelled.') : T('Order cancelled.') })
  }
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Type')}</th><th>{T('Side')}</th><th>{T('Price')}</th><th>{T('Size')}</th><th>{T('Trigger')}</th><th><button className="link-btn" onClick={() => cancel(orders)}>{T('Cancel all')}</button></th></tr></thead>
        <tbody>
          {orders.map(o => (
            <tr key={o.oid}>
              <td><small>{new Date(o.at).toLocaleString()}</small></td>
              <td><b>{symOf(o.coin, byCoin)}</b></td>
              <td>{T(KIND_LABEL[o.kind])}{o.kind === 'limit' && o.reduceOnly ? <small> · {T('Reduce only')}</small> : null}</td>
              <td className={o.isBuy ? 'fx-up' : 'fx-down'}>{o.isBuy ? T('Buy') : T('Sell')}</td>
              <td>{o.kind === 'limit' ? fmtPx(o.px) : T('Market')}</td>
              <td>{o.kind === 'limit' ? fmtNum(o.sz, byCoin.get(o.coin)?.szDecimals ?? 4) : T('Whole position')}</td>
              <td>{o.kind === 'limit' ? '—' : fmtPx(o.px)}</td>
              <td><button className="btn-ghost" onClick={() => cancel([o])}>{T('Cancel')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const DIR_LABEL: Record<string, string> = { 'Open Long': N_('Open Long'), 'Open Short': N_('Open Short'), 'Close Long': N_('Close Long'), 'Close Short': N_('Close Short'), Liquidation: N_('Liquidation') }

function PaperFills({ fills, byCoin }: { fills: PaperFill[]; byCoin: Map<string, HlMarket> }) {
  if (!fills.length) return <div className="fx-empty">{T('No paper trades yet.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Direction')}</th><th>{T('Price')}</th><th>{T('Size')}</th><th>{T('Value')}</th><th>{T('Fee')}</th><th>{T('Closed P&L')}</th></tr></thead>
        <tbody>
          {fills.slice(0, 200).map(f => (
            <tr key={f.tid}>
              <td><small>{new Date(f.time).toLocaleString()}</small></td>
              <td><b>{symOf(f.coin, byCoin)}</b></td>
              <td className={f.dir === 'Liquidation' ? 'fx-down' : f.isBuy ? 'fx-up' : 'fx-down'}>{DIR_LABEL[f.dir] ? T(DIR_LABEL[f.dir]) : f.dir}</td>
              <td>{fmtPx(f.px)}</td>
              <td>{fmtNum(f.sz, byCoin.get(f.coin)?.szDecimals ?? 4)}</td>
              <td>{money(f.px * f.sz)}</td>
              <td>{f.fee ? money(f.fee, 4) : '—'}</td>
              <td className={f.closedPnl ? upDown(f.closedPnl) : ''}>{f.closedPnl ? signedUsd(f.closedPnl) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PaperAccount({ paper, onReset }: { paper: PaperApi; onReset: () => void }) {
  const s = paper.summary, st = paper.state
  const pnlPct = st.deposited > 0 ? (s.pnl / st.deposited) * 100 : 0
  return (
    <div className="hl-balances">
      <div className="fx-pool-stats">
        <div><span>{T('Account value')}</span><b>{money(s.value)}</b></div>
        <div><span>{T('Available to trade')}</span><b>{money(s.available)}</b></div>
        <div><span>{T('Margin in positions')}</span><b>{money(s.marginUsed)}</b></div>
        <div><span>{T('Unrealized P&L')}</span><b className={upDown(s.upnl)}>{signedUsd(s.upnl)}</b></div>
        <div><span>{T('Total P&L')}</span><b className={upDown(s.pnl)}>{signedUsd(s.pnl)} <small>{pct(pnlPct)}</small></b></div>
        <div><span>{T('Fees paid')}</span><b>{money(st.feesPaid)}</b></div>
        <div><span>{T('Funding')}</span><b className={st.fundingPaid ? upDown(-st.fundingPaid) : ''}>{st.fundingPaid ? signedUsd(-st.fundingPaid) : '—'}</b></div>
        <div><span>{T('Started with')}</span><b>{money(st.deposited, 0)} <small>· {new Date(st.since).toLocaleDateString()}</small></b></div>
      </div>
      <div className="hl-bal-btns"><button className="btn-ghost" onClick={onReset}>{T('Reset paper account')}</button></div>
      <p className="fx-fine">{T(PAPER_NOTE)}</p>
    </div>
  )
}

type PaperTab = 'positions' | 'orders' | 'fills' | 'account' | 'alerts'

export function PaperAccountTabs({ paper, byCoin, mids, coin, onSelect, onReset }: {
  paper: PaperApi; byCoin: Map<string, HlMarket>; mids: Readonly<Record<string, number>>; coin: string; onSelect: (coin: string) => void; onReset: () => void
}) {
  const [tab, setTab] = useState<PaperTab>('positions')
  const [onlyThis, setOnlyThis] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const st = paper.state
  const positions = st.positions.filter(p => !onlyThis || p.coin === coin)
  const orders = st.orders.filter(o => !onlyThis || o.coin === coin)
  const fills = st.fills.filter(f => !onlyThis || f.coin === coin)
  const waiting = activeAlerts(useAlerts()).length
  return (
    <div className="hl-acct pp-acct">
      <div className="fx-tabs hl-acct-tabs">
        <span className="pp-badge">{T('PAPER')}</span>
        {([
          ['positions', `${T('Positions')}${st.positions.length ? ` (${st.positions.length})` : ''}`],
          ['orders', `${T('Open orders')}${st.orders.length ? ` (${st.orders.length})` : ''}`],
          ['fills', T('Trade history')],
          ['account', T('Account')],
          ['alerts', `${T('Alerts')}${waiting ? ` (${waiting})` : ''}`],
        ] as [PaperTab, string][]).map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        <label className="fxb-check hl-only"><input type="checkbox" checked={onlyThis} onChange={e => setOnlyThis(e.target.checked)} /> {T('This market only')}</label>
      </div>
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      {tab === 'positions' ? <PaperPositions paper={paper} positions={positions} byCoin={byCoin} mids={mids} onSelect={onSelect} onNote={setNote} />
        : tab === 'orders' ? <PaperOrders paper={paper} orders={orders} byCoin={byCoin} onNote={setNote} />
        : tab === 'fills' ? <PaperFills fills={fills} byCoin={byCoin} />
        : tab === 'alerts' ? <AlertsList coin={onlyThis ? coin : null} byCoin={byCoin} mids={mids} onSelect={onSelect} />
        : <PaperAccount paper={paper} onReset={onReset} />}
    </div>
  )
}

// ── what happened, as notices ────────────────────────────────────────────

function spanText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return T('{n} min', { n: min })
  const h = Math.floor(min / 60)
  if (h < 48) return T('{h} h {m} min', { h, m: min % 60 })
  return T('{n} days', { n: Math.floor(h / 24) })
}

function eventNote(e: PaperEvent, byCoin: Map<string, HlMarket>): Note {
  switch (e.kind) {
    case 'filled': {
      const f = avgOf(e.fills)
      const m = byCoin.get(e.order.coin)
      return { ok: true, text: T('Limit order filled: {side} {sz} {sym} at {px}', { side: e.order.isBuy ? T('bought') : T('sold'), sz: fmtNum(f.sz, m?.szDecimals ?? 4), sym: symOf(e.order.coin, byCoin), px: fmtPx(f.px) }) }
    }
    case 'triggered': {
      const pnl = e.fills.reduce((a, f) => a + f.closedPnl, 0)
      const vars = { sym: symOf(e.order.coin, byCoin), px: fmtPx(avgOf(e.fills).px), pnl: signedUsd(pnl) }
      return { ok: pnl >= 0, text: e.order.kind === 'tp' ? T('Take-profit closed {sym} at {px}: {pnl}', vars) : T('Stop-loss closed {sym} at {px}: {pnl}', vars) }
    }
    case 'liquidated':
      return { ok: false, text: T('Position liquidated: {sym} at {px}, {pnl}', { sym: symOf(e.coin, byCoin), px: fmtPx(e.fill.px), pnl: signedUsd(e.fill.closedPnl) }) }
    case 'cancelled':
      return { ok: false, text: e.why === 'no-margin' ? T('Order cancelled: there wasn’t enough paper USDC when {sym} reached its price.', { sym: symOf(e.order.coin, byCoin) }) : T('Order cancelled: no {sym} position was left to reduce.', { sym: symOf(e.order.coin, byCoin) }) }
  }
}

/** A pass's notices: one per fill, trigger and liquidation; what happened while the page was closed comes as one
 * notice that says so (at most four lines, then how many more). */
export function noticeNotes(n: PaperNotice, byCoin: Map<string, HlMarket>): Note[] {
  const out = n.events.map(e => eventNote(e, byCoin))
  if (n.caughtUp && out.length) {
    const lines = out.slice(0, 4).map(x => `• ${x.text}`)
    if (out.length > 4) lines.push(T('and {n} more: see Trade history', { n: out.length - 4 }))
    return [{ ok: out.every(x => x.ok), text: `${T('While you were away ({span}), from Hyperliquid’s candles:', { span: spanText(n.caughtUp.to - n.caughtUp.from) })}\n${lines.join('\n')}` }]
  }
  if (n.gap) out.push({ ok: false, text: T('Prices for the last {span} couldn’t be loaded, so your paper orders weren’t checked then. They’re watched again from now.', { span: spanText(n.gap.to - n.gap.from) }) })
  return out
}

export function PaperToasts({ items, onDismiss }: { items: (Note & { id: number })[]; onDismiss: (id: number) => void }) {
  if (!items.length) return null
  return (
    <div className="pp-toasts" role="status" aria-live="polite">
      {items.map(t => (
        <button key={t.id} className={`pp-toast ${t.ok ? 'ok' : 'bad'}`} onClick={() => onDismiss(t.id)}>
          <span className="pp-badge">{T('PAPER')}</span> {t.text}
        </button>
      ))}
    </div>
  )
}
