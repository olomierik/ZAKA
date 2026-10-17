// /predict — prediction markets on Hyperliquid (its HIP-4 outcome markets), traded from ARCDEX.
//
// Each market is one or more outcomes; each outcome has two sides that trade as their own tokens, between 0 and 1
// USDC. A side pays 1 USDC if it happens and 0 if not, settled by Hyperliquid itself, so its price is the market's
// odds. Orders are signed in the browser and go straight to Hyperliquid (hl/exec.ts): whole contracts, $10 at the
// least. ARCDEX's builder fee applies to sells only (Hyperliquid's rule for these markets), and only once the
// builder can receive it.
//
// The same location rule as futures: buying is off where Hyperliquid's terms don't allow it; selling, cancelling and
// withdrawing always work.

import { useEffect, useMemo, useState } from 'react'
import PriceChart from '../components/PriceChart'
import Sheet from '../components/Sheet'
import { t as T } from '../lib/i18n'
import { useIsMobile } from '../lib/useMobile'
import { openConnectModal } from '../components/ConnectWallet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { fmtUtc, hlIcon, symbolOf, type OutcomeCategory, type OutcomeGroup, type OutcomeMarket } from '../hl/markets'
import { useHlCandles, useHlMids, useHlOutcomes, useHlSocketUp } from '../hl/live'
import { useHlAccount, type HlAccountState, type HlOpenOrder, type HlOutcomeHolding } from '../hl/account'
import { buildOutcomeOrder, cancelOrders, MIN_ORDER_USD, NeedsEnable, outcomeBuilder, placeOrders } from '../hl/exec'
import { BUILDER } from '../hl/access'
import { HL_TRADING } from '../hl/client'
import { EnableTradingModal, HlFundingModal, TradingSoon, errText, money, regionNote, useHlGate, type HlGate } from '../components/HlShared'
import {
  PRACTICE_NOTE, PracticeBar, PracticePanel, PracticeStart, PracticeTicker, PracticeTradePanel, PredictModeSwitch, readPredictMode, savePredictMode,
  type PracticePick, type PredictMode,
} from '../components/PredictPractice'
import { practiceAvailable, startPractice, usePracticeAccount } from '../lib/predictPractice'

const CATS: { id: OutcomeCategory | 'all' | 'mine'; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'mine', label: 'My predictions' }, { id: 'crypto', label: 'Crypto' }, { id: 'stocks', label: 'Stocks' },
  { id: 'indices', label: 'Indices' }, { id: 'commodities', label: 'Commodities' }, { id: 'fx', label: 'FX' }, { id: 'sports', label: 'Sports' },
  { id: 'economics', label: 'Economics' }, { id: 'companies', label: 'Companies' }, { id: 'culture', label: 'Culture' }, { id: 'other', label: 'Other' },
]
const CAT_ICON: Record<OutcomeCategory, string> = {
  crypto: '₿', stocks: '📈', indices: '📊', commodities: '🛢', fx: '💱', sports: '⚽', economics: '🏦', companies: '🏢', culture: '🏆', other: '◇',
}

/** A side's price from the live mids; the other side's complement when only one has a book. */
function sidePx(m: OutcomeMarket, side: 0 | 1, mids: Readonly<Record<string, number>>): number | null {
  const own = mids[m.sides[side].coin]
  if (own > 0) return own
  const other = mids[m.sides[side === 0 ? 1 : 0].coin]
  return other > 0 ? Math.max(0, 1 - other) : null
}
/** A side's price by outcome id, as sidePx reads it. */
function sidePxOf(outcome: number, side: 0 | 1, mids: Readonly<Record<string, number>>): number | null {
  const own = mids[`#${10 * outcome + side}`]
  if (own > 0 && own < 1) return own
  const other = mids[`#${10 * outcome + (side === 0 ? 1 : 0)}`]
  return other > 0 && other < 1 ? 1 - other : null
}
const cents = (p: number | null) => (p == null ? '—' : p < 0.01 ? '<1¢' : p > 0.99 ? '>99¢' : `${Math.round(p * 100)}¢`)
const pctOf = (p: number | null) => (p == null ? '—' : p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : `${Math.round(p * 100)}%`)

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return now
}
function untilText(endsAt: number | null, now: number): string {
  if (endsAt == null) return ''
  const left = endsAt - now
  if (left <= 0) return T('Settling')
  const m = Math.floor(left / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d >= 2) return T('Ends {date}', { date: fmtUtc(endsAt, false) })
  if (h >= 1) return T('Ends in {h}h {m}m', { h, m: m % 60 })
  return T('Ends in {m}m', { m: Math.max(1, m) })
}

/** Where a pick lands: the market, the outcome and its side. */
interface Pick { group: OutcomeGroup; member: OutcomeMarket; side: 0 | 1; mode: 'buy' | 'sell' }

// ── the cards ────────────────────────────────────────────────────────────

function GroupCard({ g, mids, now, held, onPick, onOpen }: {
  g: OutcomeGroup; mids: Readonly<Record<string, number>>; now: number; held: Set<number>
  onPick: (p: Pick) => void; onOpen: (g: OutcomeGroup) => void
}) {
  const single = !g.multi || g.members.length === 1
  const m0 = g.members[0]
  const p0 = sidePx(m0, 0, mids)
  const ranked = useMemo(() => [...g.members].sort((a, b) => (sidePx(b, 0, mids) ?? -1) - (sidePx(a, 0, mids) ?? -1)), [g.members, mids])
  const shown = ranked.slice(0, 3)
  const under = g.underlying
  const underPx = under ? mids[under] : undefined
  const mine = g.members.some(m => held.has(m.outcome))
  return (
    <div className={`pm-card${mine ? ' mine' : ''}`}>
      <div className="pm-card-top">
        <span className="pm-cat">{under ? <img src={hlIcon(under)} alt="" width={14} height={14} loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} /> : CAT_ICON[g.category]} {T(CATS.find(c => c.id === g.category)?.label ?? 'Other')}</span>
        <span className="pm-ends">{untilText(g.endsAt, now)}</span>
      </div>
      <button className="pm-title" onClick={() => onOpen(g)}>{g.title}</button>
      {single ? (
        <>
          <div className="pm-odds">
            <div className="pm-bar"><i style={{ width: `${Math.round((p0 ?? 0) * 100)}%` }} /></div>
            <b>{pctOf(p0)}</b><span>{m0.sides[0].name}</span>
          </div>
          <div className="pm-sides">
            {([0, 1] as const).map(s => (
              <button key={s} className={`pm-side s${s}`} onClick={() => onPick({ group: g, member: m0, side: s, mode: 'buy' })}>
                <span>{m0.sides[s].name}</span><b>{cents(sidePx(m0, s, mids))}</b>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="pm-members">
          {shown.map(m => {
            const p = sidePx(m, 0, mids)
            return (
              <div key={m.outcome} className="pm-member">
                <span className="pm-member-label" title={m.label}>{m.label}</span>
                <b>{pctOf(p)}</b>
                <button className="pm-mini s0" onClick={() => onPick({ group: g, member: m, side: 0, mode: 'buy' })}>{m.sides[0].name} {cents(p)}</button>
                <button className="pm-mini s1" onClick={() => onPick({ group: g, member: m, side: 1, mode: 'buy' })}>{m.sides[1].name} {cents(sidePx(m, 1, mids))}</button>
              </div>
            )
          })}
          {g.members.length > shown.length && <button className="link-btn pm-more" onClick={() => onOpen(g)}>{T('+{n} more outcomes', { n: g.members.length - shown.length })}</button>}
        </div>
      )}
      <div className="pm-card-foot">
        {under && underPx ? <span>{symbolOf(under)} {T('now')} ${underPx.toLocaleString(undefined, { maximumFractionDigits: underPx >= 100 ? 2 : 4 })}</span> : <span />}
        {mine && <span className="pm-held">● {T('You hold this')}</span>}
      </div>
    </div>
  )
}

// ── the trade panel ──────────────────────────────────────────────────────

function TradePanel({ pick, setPick, mids, gate, account, onFund, onEnable, onDone }: {
  pick: Pick; setPick: (p: Pick) => void; mids: Readonly<Record<string, number>>; gate: HlGate; account: HlAccountState | null
  onFund: (t: 'deposit' | 'withdraw') => void; onEnable: () => void; onDone: () => void
}) {
  const { member: m, side, mode } = pick
  const [usd, setUsd] = useState('')
  const [contracts, setContracts] = useState('')
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [limitC, setLimitC] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setNote(null); setLimitC('') }, [m.outcome, side, mode])
  const px = sidePx(m, side, mids)
  const holding = account?.outcomes.find(h => h.outcome === m.outcome && h.side === side) ?? null
  const isBuy = mode === 'buy'
  const refPx = kind === 'limit' && +limitC > 0 ? +limitC / 100 : px ?? 0
  const n = isBuy ? (refPx > 0 ? Math.floor((+usd || 0) / refPx) : 0) : Math.floor(+contracts || 0)
  const value = n * refPx
  const payout = n
  const builder = outcomeBuilder(gate.status, isBuy)
  const fee = builder ? value * (builder.f / 100_000) : 0
  const tooSmall = n > 0 && value < MIN_ORDER_USD
  const overHeld = !isBuy && n > (holding?.size ?? 0)
  const note0 = isBuy ? regionNote(gate) : null
  const spotShort = isBuy && account && account.mode !== 'unifiedAccount' && account.mode !== 'portfolioMargin' && account.spotUsdc.total - account.spotUsdc.hold < value
  const ready = refPx > 0 && n > 0 && !tooSmall && !overHeld && (kind === 'market' || (+limitC > 0 && +limitC < 100))

  async function submit() {
    const a = gate.access
    if (!a) { openConnectModal(); return }
    const s = gate.status
    if (s?.needs.includes('deposit')) { onFund('deposit'); return }
    if (s && s.needs.some(x => x !== 'deposit')) { onEnable(); return }
    setBusy(true); setNote(null)
    try {
      const order = buildOutcomeOrder({ outcome: m.outcome, side, isBuy, contracts: n, px: refPx, kind })
      const [r] = await placeOrders(a, [order], { builder })
      if (r.kind === 'filled') setNote({ ok: true, text: T('{verb} {n} {side} at {px}', { verb: isBuy ? T('Bought') : T('Sold'), n: r.totalSz, side: m.sides[side].name, px: cents(r.avgPx) }) })
      else if (r.kind === 'resting') setNote({ ok: true, text: T('Order placed: it’s on the book.') })
      else setNote({ ok: false, text: r.kind === 'waiting' ? T('Order placed: it waits for its trigger price.') : r.message })
      if (r.kind === 'filled' || r.kind === 'resting') { setUsd(''); setContracts('') }
      onDone()
    } catch (e) {
      if (e instanceof NeedsEnable) { gate.refresh(); onEnable() }
      else setNote({ ok: false, text: errText(e) })
    } finally { setBusy(false) }
  }

  let blocker: JSX.Element | null = null
  if (!HL_TRADING) blocker = <TradingSoon />
  else if (!gate.access) blocker = (
    <div className="hl-blocker">
      <button className="fx-go fx-go-primary" onClick={openConnectModal}>{T('Connect wallet to trade')}</button>
      <button className="link-btn" onClick={openTradingWallet}>{T('or use your trading wallet')}</button>
    </div>
  )
  else if (note0) blocker = <div className="hl-blocker"><div className="fx-hint-bad">{note0}</div></div>
  else if (!gate.status) blocker = <button className="fx-go" disabled>{T('Checking your account…')}</button>
  else if (gate.status.needs.includes('deposit')) blocker = <button className="fx-go fx-go-primary" onClick={() => onFund('deposit')}>{T('Deposit USDC to start')}</button>
  else if (gate.status.needs.length) blocker = <button className="fx-go fx-go-primary" onClick={onEnable}>{T('Enable trading')}</button>

  return (
    <div className="fx-order hl-order pm-trade">
      <div className="pm-trade-h">
        <b>{m.label !== pick.group.title ? m.label : pick.group.title}</b>
        {m.label !== pick.group.title && <small>{pick.group.title}</small>}
      </div>
      <div className="fxb-kinds">
        <button className={isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'buy' })}>{T('Buy')}</button>
        <button className={!isBuy ? 'active' : ''} onClick={() => setPick({ ...pick, mode: 'sell' })}>{T('Sell')}{holding ? ` (${holding.size})` : ''}</button>
      </div>
      <div className="pm-sides">
        {([0, 1] as const).map(s => (
          <button key={s} className={`pm-side s${s}${side === s ? ' on' : ''}`} onClick={() => setPick({ ...pick, side: s })}>
            <span>{m.sides[s].name}</span><b>{cents(sidePx(m, s, mids))}</b>
          </button>
        ))}
      </div>
      <div className="fxb-kinds pm-kinds">
        <button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>{T('Market')}</button>
        <button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>{T('Limit')}</button>
      </div>
      {kind === 'limit' && (
        <div className="fxb-input"><span>{T('Price')}</span><input inputMode="decimal" value={limitC} placeholder={px ? String(Math.round(px * 100)) : ''} onChange={e => setLimitC(e.target.value.replace(/[^0-9.]/g, ''))} /><em>¢</em></div>
      )}
      {isBuy ? (
        <>
          <div className="fxb-input"><span>{T('Amount')}</span><input inputMode="decimal" value={usd} placeholder={`${MIN_ORDER_USD}+`} onChange={e => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} /><em>USD</em></div>
          <div className="fxb-ticks">{[10, 25, 50, 100, 250].map(v => <button key={v} className={+usd === v ? 'on' : ''} onClick={() => setUsd(String(v))}>${v}</button>)}</div>
        </>
      ) : (
        <div className="fxb-input">
          <span>{T('Contracts')}</span>
          <input inputMode="numeric" value={contracts} placeholder={holding ? String(holding.size) : '0'} onChange={e => setContracts(e.target.value.replace(/[^0-9]/g, ''))} />
          <button className="fxb-last-btn" disabled={!holding} onClick={() => holding && setContracts(String(Math.floor(holding.size)))}>{T('Max')}</button>
        </div>
      )}
      {blocker ?? (
        <button className={`fx-go ${isBuy ? (side === 0 ? 'long' : 'short') : 'fx-go-primary'}`} disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? T('Sending…') : isBuy ? T('Buy {side}', { side: m.sides[side].name }) : T('Sell {side}', { side: m.sides[side].name })}
        </button>
      )}
      {tooSmall && <div className="fx-fine">{T('Hyperliquid’s smallest order is ${n}.', { n: MIN_ORDER_USD })}</div>}
      {overHeld && <div className="fx-hint-bad">{T('You hold {n} of these.', { n: holding?.size ?? 0 })}</div>}
      {spotShort && <div className="fx-fine">{T('Predictions are paid from your spot USDC. Make your account unified (Enable trading) or move USDC to spot on Hyperliquid.')}</div>}
      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}
      <div className="fx-summary">
        <div><span>{T('Contracts')}</span><b>{n || '—'}</b></div>
        <div><span>{T('Price')}</span><b>{cents(refPx || null)}</b></div>
        <div><span>{isBuy ? T('Cost') : T('You receive')}</span><b>{n ? money(value) : '—'}</b></div>
        {isBuy && <div><span>{T('Pays if right')}</span><b className="fx-up">{n ? `${money(payout)} (+${money(payout - value)})` : '—'}</b></div>}
        <div><span>{T('Fee')}</span><b>{builder ? `${money(fee, 4)} · ARCDEX ${(builder.f / 1000).toFixed(2)}%` : T('None')}</b></div>
      </div>
      <div className="fx-fine">{T('Each contract pays $1 if its side happens and nothing if not. Hyperliquid settles it by itself.')}</div>
    </div>
  )
}

// ── a market's full view ─────────────────────────────────────────────────

function Rules({ m }: { m: OutcomeMarket }) {
  const f = m.fields
  const rows = Object.entries(f).filter(([k]) => !['class', 'index', 'priceThresholds'].includes(k)).slice(0, 10)
  return (
    <div className="pm-rules">
      <b>{T('How it settles')}</b>
      <span>{T('Resolved by Hyperliquid from its own data, as the market’s terms say:')}</span>
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  )
}

function UnderlyingChart({ coin }: { coin: string }) {
  const source = useHlCandles(coin)
  const up = useHlSocketUp()
  return <PriceChart poolAddress={null} source={source} ticks={[]} live={up} liveTitle={T('Live from Hyperliquid')} symbol={`${symbolOf(coin)}-USD`} height={260} />
}

function MarketDetail({ g, mids, now, onPick, onClose }: { g: OutcomeGroup; mids: Readonly<Record<string, number>>; now: number; onPick: (p: Pick) => void; onClose: () => void }) {
  const ranked = [...g.members].sort((a, b) => (sidePx(b, 0, mids) ?? -1) - (sidePx(a, 0, mids) ?? -1))
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card hl-modal pm-detail" onClick={e => e.stopPropagation()}>
        <div className="hl-modal-h"><b>{g.title}</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <div className="pm-detail-sub">{untilText(g.endsAt, now)}{g.endsAt ? ` · ${fmtUtc(g.endsAt)}` : ''}</div>
        {g.underlying && <UnderlyingChart coin={g.underlying} />}
        <div className="pm-detail-list">
          {ranked.map(m => (
            <div key={m.outcome} className="pm-member">
              <span className="pm-member-label" title={m.label}>{m.label}</span>
              <b>{pctOf(sidePx(m, 0, mids))}</b>
              <button className="pm-mini s0" onClick={() => onPick({ group: g, member: m, side: 0, mode: 'buy' })}>{m.sides[0].name} {cents(sidePx(m, 0, mids))}</button>
              <button className="pm-mini s1" onClick={() => onPick({ group: g, member: m, side: 1, mode: 'buy' })}>{m.sides[1].name} {cents(sidePx(m, 1, mids))}</button>
            </div>
          ))}
        </div>
        <Rules m={g.members[0]} />
      </div>
    </div>
  )
}

// ── your predictions ─────────────────────────────────────────────────────

function Holdings({ holdings, orders, byOutcome, mids, gate, onSell, onDone }: {
  holdings: HlOutcomeHolding[]; orders: HlOpenOrder[]; byOutcome: Map<number, { group: OutcomeGroup; member: OutcomeMarket }>; mids: Readonly<Record<string, number>>
  gate: HlGate; onSell: (p: Pick) => void; onDone: () => void
}) {
  if (!holdings.length && !orders.length) return <div className="fx-empty">{T('No predictions yet. Pick a side on any market below.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table hl-table">
        <thead><tr><th>{T('Market')}</th><th>{T('Side')}</th><th>{T('Contracts')}</th><th>{T('Avg price')}</th><th>{T('Now')}</th><th>{T('Value')}</th><th>{T('P&L')}</th><th /></tr></thead>
        <tbody>
          {holdings.map(h => {
            const hit = byOutcome.get(h.outcome)
            const px = hit ? sidePx(hit.member, h.side, mids) : mids[h.coin] ?? null
            const value = px != null ? px * h.size : null
            const pnl = value != null ? value - h.entryNtl : null
            return (
              <tr key={h.coin}>
                <td>{hit ? <b>{hit.member.label !== hit.group.title ? `${hit.group.title} · ${hit.member.label}` : hit.group.title}</b> : <span>{T('Settled or closed market')} #{h.outcome}</span>}</td>
                <td className={h.side === 0 ? 'fx-up' : 'fx-down'}>{hit ? hit.member.sides[h.side].name : h.side === 0 ? 'Yes' : 'No'}</td>
                <td>{h.size}</td>
                <td>{h.size ? cents(h.entryNtl / h.size) : '—'}</td>
                <td>{cents(px)}</td>
                <td>{value == null ? '—' : money(value)}</td>
                <td className={pnl == null ? '' : pnl >= 0 ? 'fx-up' : 'fx-down'}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}`}</td>
                <td>{HL_TRADING && hit && gate.access ? <button className="btn-ghost" onClick={() => onSell({ group: hit.group, member: hit.member, side: h.side, mode: 'sell' })}>{T('Sell')}</button> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <OutcomeOrders orders={orders} byOutcome={byOutcome} gate={gate} onDone={onDone} />
    </div>
  )
}

/** Open orders on prediction markets, with Cancel. */
function OutcomeOrders({ orders, byOutcome, gate, onDone }: { orders: HlOpenOrder[]; byOutcome: Map<number, { group: OutcomeGroup; member: OutcomeMarket }>; gate: HlGate; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  if (!orders.length) return null
  return (
    <div className="pm-orders">
      <b>{T('Open orders')}</b>
      {orders.map(o => {
        const enc = Number(o.coin.slice(1))
        const hit = byOutcome.get(Math.floor(enc / 10))
        const sideName = hit ? hit.member.sides[(enc % 10) as 0 | 1].name : enc % 10 === 0 ? 'Yes' : 'No'
        return (
        <div key={o.oid} className="pm-order-row">
          <span>{hit ? (hit.member.label !== hit.group.title ? `${hit.group.title} · ${hit.member.label}` : hit.group.title) : `#${Math.floor(enc / 10)}`} · {sideName}</span>
          <span className={o.side === 'B' ? 'fx-up' : 'fx-down'}>{o.side === 'B' ? T('Buy') : T('Sell')} {o.sz} @ {cents(o.limitPx)}</span>
          {HL_TRADING && <button className="btn-ghost" disabled={busy !== null || !gate.access} onClick={async () => {
            if (!gate.access) return
            setBusy(o.oid)
            try { await cancelOrders(gate.access, [{ asset: 100_000_000 + Number(o.coin.slice(1)), oid: o.oid }]) } catch { /* the list refreshes either way */ }
            setBusy(null); onDone()
          }}>{busy === o.oid ? '…' : T('Cancel')}</button>}
        </div>
        )
      })}
    </div>
  )
}

// ── the page ─────────────────────────────────────────────────────────────

type Sort = 'ending' | 'newest' | 'outcomes'

export default function PredictPage({ navigate }: { navigate: (p: Page) => void }) {
  const mobile = useIsMobile()
  const { groups, error } = useHlOutcomes()
  const mids = useHlMids()
  const now = useNow(15_000)
  const gate = useHlGate()
  const acct = useHlAccount(gate.access?.user ?? null)
  const [cat, setCat] = useState<(typeof CATS)[number]['id']>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('ending')
  const [pick, setPick] = useState<Pick | null>(null)
  const [detail, setDetail] = useState<OutcomeGroup | null>(null)
  const [funding, setFunding] = useState<'deposit' | 'withdraw' | null>(null)
  const [enabling, setEnabling] = useState(false)
  // Practice (virtual USDC on the engine, lib/predictPractice.ts) or live (Hyperliquid itself), remembered here.
  const [mode, setModeState] = useState<PredictMode>(() => (practiceAvailable ? readPredictMode(HL_TRADING) : 'live'))
  const setMode = (m: PredictMode) => { setModeState(m); savePredictMode(m); setPick(null); setPPick(null) }
  const practice = usePracticeAccount()
  const [pPick, setPPick] = useState<PracticePick | null>(null)
  const isPractice = mode === 'practice'

  useEffect(() => { const base = document.title; document.title = `${T('Predictions')} | ARCDEX`; return () => { document.title = base } }, [])

  const byOutcome = useMemo(() => {
    const m = new Map<number, { group: OutcomeGroup; member: OutcomeMarket }>()
    for (const g of groups ?? []) for (const member of g.members) m.set(member.outcome, { group: g, member })
    return m
  }, [groups])
  const holdings = acct.state?.outcomes ?? []
  const outcomeOrders = (acct.state?.orders ?? []).filter(o => o.coin.startsWith('#'))
  const practicePos = practice.account?.positions
  const held = useMemo(() => new Set(isPractice ? (practicePos ?? []).map(p => p.outcome) : holdings.map(h => h.outcome)), [isPractice, practicePos, holdings])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: groups?.length ?? 0, mine: 0 }
    for (const g of groups ?? []) {
      c[g.category] = (c[g.category] ?? 0) + 1
      if (g.members.some(m => held.has(m.outcome))) c.mine++
    }
    return c
  }, [groups, held])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = (groups ?? []).filter(g =>
      (cat === 'all' || (cat === 'mine' ? g.members.some(m => held.has(m.outcome)) : g.category === cat))
      && (g.endsAt == null || g.endsAt > now - 3_600_000)
      && (!needle || g.title.toLowerCase().includes(needle) || g.members.some(m => m.label.toLowerCase().includes(needle))))
    return out.sort((a, b) =>
      sort === 'ending' ? (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity)
        : sort === 'newest' ? Math.abs(b.id) - Math.abs(a.id)
          : b.members.length - a.members.length)
  }, [groups, cat, q, sort, held, now])

  const openPick = (p: Pick) => {
    setDetail(null)
    if (isPractice) setPPick({ outcome: p.member.outcome, title: p.member.label !== p.group.title ? `${p.group.title} · ${p.member.label}` : p.group.title, sides: [p.member.sides[0].name, p.member.sides[1].name], side: p.side, mode: p.mode })
    else setPick(p)
  }
  // Positions, history and the leaderboard: above the markets on desktop, under them on phones.
  const practicePanel = <PracticePanel key={practice.account ? 'acct' : 'none'} account={practice.account} onSell={p => setPPick(p)} />
  const pPanel = pPick ? (
    <PracticeTradePanel
      pick={pPick} setPick={setPPick} account={practice.account}
      px={[sidePxOf(pPick.outcome, 0, mids), sidePxOf(pPick.outcome, 1, mids)]}
      onStart={() => { void startPractice().then(practice.set, () => practice.refresh()) }}
      onDone={v => practice.set(v)}
    />
  ) : null
  const panel = pick ? (
    <TradePanel
      pick={pick} setPick={setPick} mids={mids} gate={gate} account={acct.state}
      onFund={t => { setPick(null); setFunding(t) }} onEnable={() => { setPick(null); setEnabling(true) }} onDone={() => acct.refresh()}
    />
  ) : null

  return (
    <div className="pm-page fxb">
      <div className="pm-head">
        <div>
          <h1 className="page-h">{T('Predictions')}</h1>
          <p className="pm-sub">{T('Trade on what happens next: crypto prices, stocks, sports and the economy. Each side pays $1 if it’s right, settled by Hyperliquid.')}</p>
        </div>
        {practiceAvailable && <PredictModeSwitch mode={mode} liveOn={HL_TRADING} onChange={setMode} />}
        {!isPractice && <div className="pm-acct">
          {gate.access ? (
            <>
              <div><span>{T('Account value')}</span><b>{acct.state ? money(acct.state.accountValue) : '…'}</b></div>
              {HL_TRADING && <button className="btn-primary" onClick={() => setFunding('deposit')}>＋ {T('Deposit')}</button>}
              {HL_TRADING && <button className="btn-ghost" onClick={() => setFunding('withdraw')}>{T('Withdraw')}</button>}
            </>
          ) : (
            <>
              <button className="btn-primary" onClick={openConnectModal}>{T('Connect wallet')}</button>
              <button className="link-btn" onClick={openTradingWallet}>{T('Trading wallet')}</button>
            </>
          )}
        </div>}
      </div>

      {isPractice && (
        <>
          {practice.account ? <PracticeBar account={practice.account} onChange={practice.set} /> : <PracticeStart onStarted={practice.set} />}
          <PracticeTicker />
          {!mobile && practicePanel}
        </>
      )}

      {!isPractice && gate.access && (holdings.length > 0 || outcomeOrders.length > 0 || cat === 'mine') && (
        <div className="spot-panel pm-holdings">
          <div className="spot-panel-h"><span>{T('Your predictions')}</span></div>
          <Holdings holdings={holdings} orders={outcomeOrders} byOutcome={byOutcome} mids={mids} gate={gate} onSell={openPick} onDone={() => acct.refresh()} />
        </div>
      )}

      <div className="pm-tools">
        <div className="pm-cats">
          {CATS.filter(c => c.id === 'all' || (counts[c.id] ?? 0) > 0).map(c => (
            <button key={c.id} className={cat === c.id ? 'active' : ''} onClick={() => setCat(c.id)}>
              {c.id !== 'all' && c.id !== 'mine' ? `${CAT_ICON[c.id as OutcomeCategory]} ` : ''}{T(c.label)}<small>{counts[c.id] ?? 0}</small>
            </button>
          ))}
        </div>
        <div className="pm-filters">
          <input className="field" placeholder={T('Search markets')} value={q} onChange={e => setQ(e.target.value)} />
          <select className="field" value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label={T('Sort')}>
            <option value="ending">{T('Ending soon')}</option>
            <option value="newest">{T('Newest')}</option>
            <option value="outcomes">{T('Most outcomes')}</option>
          </select>
        </div>
      </div>

      {!groups ? (
        <div className="fx-empty">{error ? `⚠ ${T('Hyperliquid didn’t answer: {e}', { e: error })}` : T('Loading markets…')}</div>
      ) : list.length === 0 ? (
        <div className="fx-empty">{T('No market matches.')}</div>
      ) : (
        <div className="pm-grid">
          {list.slice(0, 120).map(g => <GroupCard key={g.id} g={g} mids={mids} now={now} held={held} onPick={openPick} onOpen={setDetail} />)}
        </div>
      )}

      {isPractice && mobile && practicePanel}

      <div className="hl-foot fx-fine">
        {isPractice && <>{T(PRACTICE_NOTE)}{' '}</>}
        {T('Markets, prices and settlement are Hyperliquid’s: orders are signed in your browser and go straight to it. ARCDEX never holds your money.')}{' '}
        {BUILDER.outcomeF > 0 && T('ARCDEX’s fee applies only when you sell, as a Hyperliquid builder fee you approve once.')}{' '}
        <button className="link-btn" onClick={() => navigate({ name: 'perps' })}>{T('Trade futures')}</button>
      </div>

      {detail && <MarketDetail g={detail} mids={mids} now={now} onPick={openPick} onClose={() => setDetail(null)} />}
      {pick && (mobile ? (
        <Sheet open onClose={() => setPick(null)} title={T('Trade')}><div className="fxb">{panel}</div></Sheet>
      ) : (
        <div className="modal-back" onClick={() => setPick(null)}>
          <div className="modal-card hl-modal pm-trade-modal fxb" onClick={e => e.stopPropagation()}>
            <div className="hl-modal-h"><b>{T('Trade')}</b><button className="fxb-x" onClick={() => setPick(null)} aria-label={T('Close')}>✕</button></div>
            {panel}
          </div>
        </div>
      ))}
      {pPick && (mobile ? (
        <Sheet open onClose={() => setPPick(null)} title={T('Practice')}><div className="fxb">{pPanel}</div></Sheet>
      ) : (
        <div className="modal-back" onClick={() => setPPick(null)}>
          <div className="modal-card hl-modal pm-trade-modal fxb" onClick={e => e.stopPropagation()}>
            <div className="hl-modal-h"><b>{T('Practice')}</b><button className="fxb-x" onClick={() => setPPick(null)} aria-label={T('Close')}>✕</button></div>
            {pPanel}
          </div>
        </div>
      ))}
      {funding && <HlFundingModal gate={gate} account={acct.state} initial={funding} onClose={() => setFunding(null)} onDone={() => { acct.refresh(); gate.refresh() }} />}
      {enabling && <EnableTradingModal gate={gate} onClose={() => setEnabling(false)} onDone={() => { setEnabling(false); acct.refresh() }} />}
    </div>
  )
}
