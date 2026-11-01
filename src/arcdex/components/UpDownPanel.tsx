// /predict → BTC 5m · 15m: Polymarket's BTC Up/Down windows as the engine's autotrader sees them (engine/src/updown).
// Every live window with its price to beat, the engine's BTC estimate, the model's chance of Up against the market's,
// the edge after fees and why it isn't trading; then the autotrader's paper record on Polymarket's live books, and
// what it still needs before real money is offered (each user's own wallet, owner's decision 2026-11-01).

import { useEffect, useState } from 'react'
import type { UpdownStatus, UpdownTrade, UpdownWindowView } from '../../../api/_updownProtocol'
import { engineApiUrl } from '../api/marketStream'
import { t as T } from '../lib/i18n'

export const updownAvailable = Boolean(engineApiUrl)

function usePoll<V>(path: string, everyMs: number): { v: V | null; err: boolean } {
  const [v, setV] = useState<V | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!engineApiUrl) return
    let alive = true
    const load = () => void fetch(`${engineApiUrl}${path}`, { signal: AbortSignal.timeout(8_000) })
      .then(r => (r.ok ? r.json() as Promise<V> : Promise.reject(new Error(String(r.status)))))
      .then(x => { if (alive) { setV(x); setErr(false) } }, () => { if (alive) setErr(true) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, everyMs)
    return () => { alive = false; clearInterval(id) }
  }, [path, everyMs])
  return { v, err }
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(0)}%`)
const cents = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}¢`)
const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const cls = (n: number) => (n > 0 ? 'fx-up' : n < 0 ? 'fx-down' : '')
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const btc = (n: number | null) => (n === null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`)

function WindowCard({ w }: { w: UpdownWindowView }) {
  const started = w.secondsLeft <= (w.end - w.start)
  const ahead = w.open !== null && w.btc !== null ? w.btc - w.open : null
  return (
    <div className={`ud-win ${w.waiting ? '' : 'live'}`}>
      <div className="ud-win-h">
        <span className="ud-dur">{w.dur}</span>
        <b>{clock(w.secondsLeft)}</b>
        <a href={w.url} target="_blank" rel="noopener noreferrer" className="ud-link">{T('On Polymarket')} ↗</a>
      </div>
      <div className="ud-row"><span>{T('Price to beat')}</span><b>{btc(w.open)}</b></div>
      <div className="ud-row"><span>{T('BTC now (engine)')}</span><b className={ahead === null ? '' : cls(ahead)}>{btc(w.btc)}{ahead !== null && <small> {ahead >= 0 ? '+' : '−'}${Math.abs(ahead).toFixed(2)}</small>}</b></div>
      <div className="ud-bars">
        <div><span>{T('Model')}</span><div className="ud-bar"><i style={{ width: `${(w.model ?? 0.5) * 100}%` }} /></div><b>{pct(w.model)}</b></div>
        <div><span>{T('Market')}</span><div className="ud-bar mkt"><i style={{ width: `${(w.market ?? 0.5) * 100}%` }} /></div><b>{pct(w.market)}</b></div>
      </div>
      <div className="ud-row"><span>{T('Up / Down ask')}</span><b><span className="fx-up">{cents(w.up.ask)}</span> / <span className="fx-down">{cents(w.down.ask)}</span></b></div>
      <div className="ud-row"><span>{T('Best edge after fees')}</span><b className={w.edge ? cls(w.edge.value) : ''}>{w.edge ? `${w.edge.side === 'up' ? T('Up') : T('Down')} ${w.edge.value >= 0 ? '+' : '−'}${Math.abs(w.edge.value * 100).toFixed(1)}¢` : '—'}</b></div>
      <div className={`ud-state ${w.waiting ? '' : 'on'}`}>{!started ? T('Starts soon') : w.waiting ? T(w.waiting) : `● ${T('Watching for an edge')}`}</div>
    </div>
  )
}

function Stat({ k, v, c }: { k: string; v: string; c?: string }) { return <div><span>{k}</span><b className={c}>{v}</b></div> }

export default function UpDownPanel() {
  const { v: s, err } = usePoll<UpdownStatus>('/v1/updown/status', 1_000)
  const { v: trades } = usePoll<UpdownTrade[]>('/v1/updown/trades?limit=60', 5_000)
  if (!engineApiUrl) return <div className="fx-empty">{T('The autotrader runs on ARCDEX’s engine, which this site isn’t connected to.')}</div>
  if (!s) return <div className="fx-empty">{err ? T('The autotrader isn’t answering right now.') : T('Loading the autotrader…')}</div>
  const st = s.stats, rd = s.readiness
  const live = s.windows.filter(w => w.secondsLeft <= w.end - w.start)
  const next = s.windows.filter(w => w.secondsLeft > w.end - w.start)
  const settled = st.won + st.lost
  return (
    <div className="ud">
      <div className="ud-hero spot-panel">
        <div>
          <div className="ud-title">{T('BTC Up/Down autotrader')} <span className="ud-paper">{T('PAPER')}</span></div>
          <p className="ud-sub">{T('Every 5- and 15-minute Bitcoin market on Polymarket, priced by ARCDEX’s model from live exchange prices and Polymarket’s own rules. It buys only when its chance beats the price plus Polymarket’s fee by a safety margin, and for now it trades virtual dollars against Polymarket’s live order books, with the real delay and the real fee.')}</p>
        </div>
        <div className="ud-ready">
          <b>{rd.ready ? T('Ready for real money') : T('Real money: not yet')}</b>
          <div>{rd.days >= 14 ? '✓' : '○'} {T('{n} of {m} days on paper', { n: String(rd.days), m: '14' })}</div>
          <div>{rd.windows >= 300 ? '✓' : '○'} {T('{n} of {m} windows traded', { n: String(rd.windows), m: '300' })}</div>
          <div>{rd.weeksPositive >= 2 ? '✓' : '○'} {T('{n} of 2 weeks positive after fees', { n: String(rd.weeksPositive) })}</div>
          <div>{rd.modelBeatsMarket ? '✓' : '○'} {rd.modelBeatsMarket === null ? T('Model not scored yet') : rd.modelBeatsMarket ? T('Model scores at least as well as the market') : T('The market’s price scores better than the model')}</div>
          <small>{T('Then you can turn it on with your own wallet. ARCDEX never holds your money.')}</small>
        </div>
      </div>

      <div className="ud-stats spot-panel">
        <Stat k={T('Paper balance')} v={usd(st.bankroll)} />
        <Stat k={T('P&L after fees')} v={signed(st.pnl)} c={cls(st.pnl)} />
        <Stat k={T('Today')} v={signed(st.todayPnl)} c={cls(st.todayPnl)} />
        <Stat k={T('Trades')} v={`${st.trades}${st.open ? ` · ${st.open} ${T('open')}` : ''}`} />
        <Stat k={T('Won')} v={settled ? `${st.won}/${settled} (${Math.round((st.won / settled) * 100)}%)` : '—'} />
        <Stat k={T('Staked')} v={usd(st.staked)} />
        <Stat k={T('Fees')} v={usd(st.fees)} />
        <Stat k={T('Missed (gone after the delay)')} v={String(st.missed)} />
        <Stat k={T('Model vs market (Brier, lower is better)')} v={st.brier.model === null ? '—' : `${st.brier.model.toFixed(3)} / ${st.brier.market!.toFixed(3)}`} c={st.brier.model !== null && st.brier.market !== null ? (st.brier.model <= st.brier.market ? 'fx-up' : 'fx-down') : ''} />
      </div>
      {st.stoppedToday && <div className="ud-warn">⏸ {T('Stopped for today: the day’s loss stop of ${n} was reached.', { n: String(s.rules.dailyLossUsd) })}</div>}

      <div className="ud-grid">
        {live.map(w => <WindowCard key={w.slug} w={w} />)}
        {!live.length && <div className="fx-empty">{T('Finding the live windows…')}</div>}
      </div>
      {next.length > 0 && <div className="ud-next">{T('Next')}: {next.map(w => `${w.dur} ${T('in')} ${clock(w.secondsLeft - (w.end - w.start))}`).join(' · ')}</div>}

      <div className="spot-panel">
        <div className="spot-panel-h"><span>{T('The autotrader’s trades')}</span></div>
        {!trades?.length ? <div className="fx-empty">{T('No trades yet: it waits for an edge bigger than the fee and its margin, which can take a while.')}</div> : (
          <div className="ud-table-wrap">
            <table className="ud-table">
              <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Lane')}</th><th>{T('Side')}</th><th>{T('Price')}</th><th>{T('Model')}</th><th>{T('Cost')}</th><th>{T('Result')}</th></tr></thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id}>
                    <td>{new Date(t.filledAt).toLocaleTimeString()}</td>
                    <td>{t.dur} · {clock(t.secondsLeft)} {T('left')}</td>
                    <td title={t.lane === 'A' ? T('Lane A: the model beat a stale price mid-window') : T('Lane B: the last minute’s average already decided it')}>{t.lane}</td>
                    <td className={t.side === 'up' ? 'fx-up' : 'fx-down'}>{t.side === 'up' ? T('Up') : T('Down')}</td>
                    <td>{cents(t.price)}</td>
                    <td>{pct(t.model)}</td>
                    <td>{usd(t.cost)}</td>
                    <td className={t.pnl === null ? '' : cls(t.pnl)}>{t.result === 'open' ? T('Open') : signed(t.pnl ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="hl-foot fx-fine">
        {T('No strategy can make every trade win: this one loses some by design and is judged on profit after fees over hundreds of windows.')}{' '}
        {T('Rules: at most ${o} an order and ${w} a window, a ${d} daily loss stop, and no order on a stale price or a quiet book.', { o: String(s.rules.orderUsd), w: String(s.rules.windowUsd), d: String(s.rules.dailyLossUsd) })}{' '}
        {T('Feeds')}: {s.feeds.sources.map(x => `${x.name} ${x.ageMs === null ? '—' : x.ageMs < 3_000 ? '✓' : '✕'}`).join(' · ')} · {T('book')} {s.feeds.bookConnected ? '✓' : '✕'}{s.feeds.bookLagMs !== null ? ` ${s.feeds.bookLagMs} ms` : ''} · {T('order delay')} {s.delayMs} ms{s.feeds.volPct !== null ? ` · ${T('volatility')} ${s.feeds.volPct}%` : ''}.
      </div>
    </div>
  )
}
