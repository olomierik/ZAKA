// /predict → BTC 5m · 15m: Polymarket's BTC Up/Down windows as the engine's autotrader sees them (engine/src/updown).
// Every live window with its price to beat, the engine's BTC estimate, the model's chance of Up against the market's,
// the edge after fees and why it isn't trading; then the autotrader's paper record on Polymarket's live books, and
// what it still needs before real money is offered (each user's own wallet, owner's decision 2026-11-01).
// What it has learned from its record (engine/src/updown/learn.ts): how far it trusts its model against the market,
// the kinds of trade it skips, its learning journal, and why each trade won or lost (the trade log, downloadable).

import { useEffect, useState } from 'react'
import type { UpdownLearnView, UpdownLesson, UpdownStatus, UpdownTrade, UpdownWindowView } from '../../../api/_updownProtocol'
import { engineApiUrl } from '../api/marketStream'
import { t as T } from '../lib/i18n'
import UpdownLiveCard from './UpdownLiveCard'

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
/** A lesson or journal line in the viewer's language (the kind of trade and the part of the window are words too). */
const say = (l: UpdownLesson) => T(l.k, l.v && { ...l.v, ...(l.v.p ? { p: T(l.v.p) } : {}), ...(l.v.b ? { b: T(l.v.b) } : {}) })
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
        <div><span>{T('Model')}</span><div className="ud-bar"><i style={{ width: `${(w.raw ?? w.model ?? 0.5) * 100}%` }} /></div><b>{pct(w.raw ?? w.model)}</b></div>
        {w.raw !== undefined && <div title={T('The market’s chance, moved toward the model as far as it has learned to trust it')}><span>{T('Trades on')}</span><div className="ud-bar"><i style={{ width: `${(w.model ?? 0.5) * 100}%` }} /></div><b>{pct(w.model)}</b></div>}
        <div><span>{T('Market')}</span><div className="ud-bar mkt"><i style={{ width: `${(w.market ?? 0.5) * 100}%` }} /></div><b>{pct(w.market)}</b></div>
      </div>
      <div className="ud-row"><span>{T('Up / Down ask')}</span><b><span className="fx-up">{cents(w.up.ask)}</span> / <span className="fx-down">{cents(w.down.ask)}</span></b></div>
      <div className="ud-row"><span>{T('Best edge after fees')}</span><b className={w.edge ? cls(w.edge.value) : ''}>{w.edge ? `${w.edge.side === 'up' ? T('Up') : T('Down')} ${w.edge.value >= 0 ? '+' : '−'}${Math.abs(w.edge.value * 100).toFixed(1)}¢` : '—'}</b></div>
      <div className={`ud-state ${w.waiting ? '' : 'on'}`}>{!started ? T('Starts soon') : w.waiting ? T(w.waiting) : `● ${T('Watching for an edge')}`}</div>
    </div>
  )
}

function Learned({ l }: { l: UpdownLearnView }) {
  const trust = (dur: string, band: string) => l.trust.find(x => x.dur === dur && x.band === band)
  return (
    <div className="spot-panel ud-learn">
      <div className="spot-panel-h"><span>{T('What it has learned from its trades')}</span></div>
      <div className="ud-learn-body">
        <div>
          <h4>{T('How far it trusts its model')}</h4>
          <p className="fx-fine">{T('0% trades on the market’s price, 100% on its own model. It moves with every resolved window: toward whichever was closer to the result.')}</p>
          {(['5m', '15m'] as const).map(d => (['mid', 'end'] as const).map(b => { const x = trust(d, b); return x && (
            <div key={d + b} className="ud-trust"><span>{d} · {T(b === 'end' ? 'last minute' : 'mid-window')}</span><div className="ud-bar mkt"><i style={{ width: `${x.weight * 100}%` }} /></div><b>{pct(x.weight)}</b><small>{x.samples ? T('{n} snapshots', { n: String(x.samples) }) : T('not measured yet')}</small></div>
          ) }))}
        </div>
        <div>
          <h4>{T('Kinds of trade, last {n} days', { n: String(l.rule.days) })}</h4>
          <p className="fx-fine">{T('A kind with {n}+ trades that clearly loses {r}% of its stake a trade or more is skipped, and still measured on paper so it can come back.', { n: String(l.rule.minTrades), r: String(Math.round(-l.rule.maxRoi * 100)) })}</p>
          {!l.kinds.length ? <div className="fx-empty">{T('No closed trades yet.')}</div> : (
            <table className="ud-table ud-kinds"><tbody>
              {l.kinds.slice(0, 8).map(k => (
                <tr key={k.id} className={k.skipped ? 'skip' : ''}>
                  <td>{T(k.label)}{k.skipped && <span className="ud-skip">{T('skipped')}</span>}</td>
                  <td>{k.won}/{k.trades}</td>
                  <td className={cls(k.pnl)}>{signed(k.pnl)}</td>
                  <td className={cls(k.roi)}>{k.roi >= 0 ? '+' : '−'}{Math.abs(Math.round(k.roi * 100))}%</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>
      {l.notes.length > 0 && (
        <div className="ud-journal">
          <h4>{T('Learning journal')}</h4>
          {l.notes.slice(0, 8).map((n, i) => <div key={i}><time>{new Date(n.at).toLocaleString()}</time> {say(n)}</div>)}
        </div>
      )}
    </div>
  )
}

/** The trade log as a CSV file, everything the engine kept about each trade. */
function downloadLog(rows: UpdownTrade[]) {
  const cols = ['filledAt', 'slug', 'dur', 'lane', 'side', 'price', 'shares', 'cost', 'fee', 'model', 'raw', 'market', 'edge', 'awayBp', 'secondsLeft', 'hi', 'lo', 'sold', 'proceeds', 'exit', 'result', 'pnl', 'shadow', 'lesson'] as const
  const cell = (t: UpdownTrade, c: typeof cols[number]) => {
    const v = c === 'filledAt' ? new Date(t.filledAt).toISOString() : c === 'lesson' ? (t.lesson ? say(t.lesson) : '') : t[c]
    const x = v === undefined || v === null ? '' : String(v)
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x
  }
  const csv = [cols.join(','), ...rows.map(t => cols.map(c => cell(t, c)).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `arcdex-btc-updown-trades-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5_000)
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
        {st.shadow && st.shadow.trades > 0 && <Stat k={T('Skipped by its lessons (measured)')} v={`${st.shadow.trades} · ${signed(st.shadow.pnl)}`} c={cls(-st.shadow.pnl)} />}
        <Stat k={T('Sold early (scalps / stops)')} v={`${st.exits?.scalp ?? 0} / ${st.exits?.stop ?? 0}`} />
        <Stat k={T('Model vs market (Brier, lower is better)')} v={st.brier.model === null ? '—' : `${st.brier.model.toFixed(3)} / ${st.brier.market!.toFixed(3)}`} c={st.brier.model !== null && st.brier.market !== null ? (st.brier.model <= st.brier.market ? 'fx-up' : 'fx-down') : ''} />
      </div>
      {st.stoppedToday && <div className="ud-warn">⏸ {T('Stopped for today: the day’s loss stop of ${n} was reached.', { n: String(s.rules.dailyLossUsd) })}</div>}

      <div className="ud-grid">
        {live.map(w => <WindowCard key={w.slug} w={w} />)}
        {!live.length && <div className="fx-empty">{T('Finding the live windows…')}</div>}
      </div>
      {next.length > 0 && <div className="ud-next">{T('Next')}: {next.map(w => `${w.dur} ${T('in')} ${clock(w.secondsLeft - (w.end - w.start))}`).join(' · ')}</div>}

      <UpdownLiveCard status={s} />

      {s.learn && <Learned l={s.learn} />}

      <div className="spot-panel">
        <div className="spot-panel-h"><span>{T('The autotrader’s trades')}</span>{trades?.length ? <button className="ud-csv" onClick={() => void fetch(`${engineApiUrl}/v1/updown/trades?limit=500`).then(r => r.json() as Promise<UpdownTrade[]>).then(downloadLog, () => downloadLog(trades))}>{T('Download the trade log (CSV)')}</button> : null}</div>
        {!trades?.length ? <div className="fx-empty">{T('No trades yet: it waits for an edge bigger than the fee and its margin, which can take a while.')}</div> : (
          <div className="ud-table-wrap">
            <table className="ud-table">
              <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Lane')}</th><th>{T('Side')}</th><th>{T('Price')}</th><th>{T('Model')}</th><th>{T('Cost')}</th><th>{T('Result')}</th><th>{T('Lesson')}</th></tr></thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id} className={t.shadow ? 'shadow' : ''} title={t.shadow ? T('Skipped by a lesson: measured on paper, outside the balance') : undefined}>
                    <td>{new Date(t.filledAt).toLocaleTimeString()}</td>
                    <td>{t.dur} · {clock(t.secondsLeft)} {T('left')}</td>
                    <td title={t.lane === 'A' ? T('Lane A: the model beat a stale price mid-window') : T('Lane B: the last minute’s average already decided it')}>{t.lane}</td>
                    <td className={t.side === 'up' ? 'fx-up' : 'fx-down'}>{t.side === 'up' ? T('Up') : T('Down')}</td>
                    <td>{cents(t.price)}</td>
                    <td>{pct(t.model)}</td>
                    <td>{usd(t.cost)}</td>
                    <td className={t.pnl === null ? '' : cls(t.pnl)} title={t.exit ? (t.exit === 'scalp' ? T('Sold at the bid once the market paid the model’s value') : T('Cut once the model said it was worth well under its cost')) : undefined}>
                      {t.result === 'open' ? (t.sold ? `${T('Open')} · ${T('part sold')}` : T('Open')) : signed(t.pnl ?? 0)}
                      {t.exit && t.result !== 'open' && <small> {t.exit === 'scalp' ? T('scalp') : T('stop')}</small>}
                      {t.shadow && <span className="ud-skip">{T('skipped')}</span>}
                    </td>
                    <td className="ud-lesson">{t.lesson ? say(t.lesson) : ''}</td>
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
        {s.rules.overpay && T('Exits: a 15-minute position is sold at the bid once it pays the model’s value, a 5-minute one once it pays {p}¢ more; either is cut once the model says it’s worth {s}¢ under its cost.', { p: String(Math.round(s.rules.overpay['5m'] * 100)), s: String(Math.round(s.rules.stop * 100)) })}{' '}
        {T('Feeds')}: {s.feeds.sources.map(x => `${x.name} ${x.ageMs === null ? '—' : x.ageMs < 3_000 ? '✓' : '✕'}`).join(' · ')} · {T('book')} {s.feeds.bookConnected ? '✓' : '✕'}{s.feeds.bookLagMs !== null ? ` ${s.feeds.bookLagMs} ms` : ''} · {T('order delay')} {s.delayMs} ms{s.feeds.volPct !== null ? ` · ${T('volatility')} ${s.feeds.volPct}%` : ''}.
      </div>
    </div>
  )
}
