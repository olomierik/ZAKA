// /autotrade — ARCDEX Algo: a 24/7 agent trading BTC, ETH and SOL futures, shown as it works.
// Every candle's decision (regime, direction, setup quality, calibrated confidence, the gates it
// passed or failed), every trade, the risk limits, the calibration and the nightly reviews, read
// from the engine (engine/src/algo). Test USDC on Arc testnet, or paper: nothing here is real
// money, and nothing promises a result.
//
// Owners of the old Autotrade bots still get their button to manage and withdraw.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AlgoCalibration, AlgoDecisionRow, AlgoMarket, AlgoReview, AlgoStatus, AlgoTrade } from '../../../api/_algoProtocol'
import { ALGO_MARKETS } from '../../../api/_algoProtocol'
import { getAlgoDecisions, getAlgoReviews, getAlgoStatus, getAlgoTrades, sendAlgoControl } from '../api/algo'
import { botMe, botSession, engineEnabled } from '../api/marketStream'
import type { Page } from '../App'
import { AgoText } from '../components/Ago'
import { N_, t as T } from '../lib/i18n'
import { shortAddr, useTrader } from '../lib/identity'
import { ARC_TESTNET } from '../../../engine/src/perps/shared'

const REGIME: Record<string, [string, string]> = {
  trending: [N_('Trending'), '#2a6df4'], mean_reverting: [N_('Ranging'), '#94a3b8'], high_vol: [N_('High volatility'), '#f59e0b'], crisis: [N_('Crisis'), '#f6465d'],
}
const DIR: Record<string, [string, string]> = { long: [N_('Long'), '#0ecb81'], short: [N_('Short'), '#f6465d'], neutral: [N_('Stand aside'), '#848e9c'] }
const RISK: Record<string, [string, string]> = { safe: [N_('Safe'), '#0ecb81'], near_limit: [N_('Near a limit'), '#f59e0b'], reduce: [N_('Reduce'), '#f6465d'] }
const ACTION: Record<string, string> = { open: N_('Opened a trade'), close: N_('Closed by the risk code'), hold: N_('Holding'), escalate: N_('Escalated'), none: N_('No trade') }
const CHECK: Record<string, string> = {
  direction: N_('Direction'), regime: N_('Regime'), toxic: N_('Clean flow'), quality: N_('Setup quality'), calibrated: N_('Calibrated'),
  confidence: N_('Confidence'), risk_state: N_('Risk state'), volatility: N_('Volatility'), target: N_('Target vs costs'), edge: N_('Edge after costs'), size: N_('Size'), risk: N_('Risk limits'),
}

const usd = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const price = (n: number | null | undefined) => n === null || n === undefined || !(n > 0) ? '—' : n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n >= 10 ? n.toFixed(2) : n.toFixed(4)
const signed = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`
const pnlColor = (n: number | null | undefined) => (n ?? 0) > 0 ? '#0ecb81' : (n ?? 0) < 0 ? '#f6465d' : 'var(--text-muted)'
const txUrl = (tx: string) => `${ARC_TESTNET.blockExplorers.default.url}/tx/${tx}`

function Pill({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return <span className="algo-pill" title={title} style={{ color, borderColor: `${color}55`, background: `${color}18` }}>{children}</span>
}

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="algo-card">
      <div className="algo-card-head"><div><div className="algo-card-title">{title}</div>{sub && <div className="algo-card-sub">{sub}</div>}</div>{right}</div>
      {children}
    </section>
  )
}

function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="algo-stat">
      <div className="algo-stat-label">{label}</div>
      <div className="algo-stat-value" style={{ color }}>{value}</div>
      {sub && <div className="algo-stat-sub">{sub}</div>}
    </div>
  )
}

/** Confidence against the gate: the bar, and a line where the gate is. */
function ConfidenceBar({ value, gate }: { value: number; gate: number }) {
  const ok = value > gate
  return (
    <div className="algo-conf" title={T('Calibrated probability the trade reaches its target before its stop')}>
      <div className="algo-conf-track">
        <span style={{ width: `${Math.min(100, value * 100)}%`, background: ok ? '#0ecb81' : '#2a6df4' }} />
        <i style={{ left: `${gate * 100}%` }} />
      </div>
      <b style={{ color: ok ? '#0ecb81' : undefined }}>{(value * 100).toFixed(1)}%</b>
    </div>
  )
}

function Quality({ q }: { q: number }) {
  return <span className="algo-quality" title={T('Setup quality {q} of 3', { q })}>{[0, 1, 2].map(i => <i key={i} className={i < q ? 'on' : ''} />)}</span>
}

function MarketCard({ m, view, gate, expanded, onToggle }: { m: AlgoMarket; view: AlgoStatus['markets'][AlgoMarket]; gate: number; expanded: boolean; onToggle: () => void }) {
  const d = view?.last
  const reg = d ? REGIME[d.decision.regime] : null
  const dir = d ? DIR[d.decision.direction] : null
  const risk = d ? RISK[d.decision.risk_state] : null
  return (
    <div className="algo-market">
      <div className="algo-market-head">
        <b>{m}<span>/USDC</span></b>
        <span className="algo-market-px">{price(view?.price)}</span>
      </div>
      {!d ? <div className="algo-muted">{T('Waiting for the first candle…')}</div> : (
        <>
          <div className="algo-market-pills">
            {reg && <Pill color={reg[1]}>{T(reg[0])}</Pill>}
            {dir && <Pill color={dir[1]}>{T(dir[0])}</Pill>}
            {d.decision.toxic_flow && <Pill color="#f6465d">{T('Toxic flow')}</Pill>}
            {risk && <Pill color={risk[1]}>{T(risk[0])}</Pill>}
          </div>
          <div className="algo-row"><span>{T('Setup quality')}</span><Quality q={d.decision.setup_quality} /></div>
          <div className="algo-row"><span>{T('Confidence')}</span><ConfidenceBar value={d.decision.confidence} gate={gate} /></div>
          <div className={`algo-verdict ${d.gate.passed ? 'go' : ''}`}>{d.gate.passed ? '✓ ' : ''}{T(ACTION[d.action] ?? d.action)} · <AgoText ts={d.at} /></div>
          <ul className="algo-why">{d.why.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}</ul>
          <button className="algo-link" onClick={onToggle}>{expanded ? T('Hide the checks') : T('Show the checks')}</button>
          {expanded && (
            <>
              <ul className="algo-checks">
                {d.gate.checks.map(c => <li key={c.id} className={c.ok ? 'ok' : 'bad'}><span>{c.ok ? '✓' : '✗'} {T(CHECK[c.id] ?? c.id)}</span><em>{c.detail}</em></li>)}
              </ul>
              <div className="algo-snap" title={T('The snapshot the reflex read')}>{d.snapshot}</div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function EquityCurve({ trades, start }: { trades: AlgoTrade[]; start: number }) {
  const pts = useMemo(() => {
    const closed = trades.filter(t => t.status === 'closed' && t.closedAt).sort((a, b) => a.closedAt! - b.closedAt!)
    let eq = start
    return [start, ...closed.map(t => (eq += t.pnlUsd ?? 0))]
  }, [trades, start])
  if (pts.length < 2) return <div className="algo-muted algo-empty">{T('No closed trades yet.')}</div>
  const W = 600, H = 120
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * W},${H - 6 - ((v - lo) / span) * (H - 12)}`).join(' ')
  const up = pts[pts.length - 1] >= start
  return (
    <svg className="algo-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={T('Equity after each closed trade')}>
      <line x1="0" x2={W} y1={H - 6 - ((start - lo) / span) * (H - 12)} y2={H - 6 - ((start - lo) / span) * (H - 12)} stroke="var(--adx-card-border)" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke={up ? '#0ecb81' : '#f6465d'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Reliability({ c }: { c: AlgoCalibration }) {
  const S = 160
  if (!c.bins.length) return <div className="algo-muted algo-empty">{T('Not enough labeled decisions in the last day yet.')}</div>
  const maxN = Math.max(...c.bins.map(b => b.n))
  return (
    <svg className="algo-rel" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={T('Predicted against observed')}>
      <rect x="0" y="0" width={S} height={S} fill="none" stroke="var(--adx-card-border)" />
      <line x1="0" y1={S} x2={S} y2="0" stroke="var(--text-muted)" strokeDasharray="3 3" opacity="0.6" />
      {c.bins.map(b => <circle key={b.lo} cx={b.predicted * S} cy={S - b.observed * S} r={2.5 + 4 * Math.sqrt(b.n / maxN)} fill="#2a6df4" opacity="0.85"><title>{`${(b.predicted * 100).toFixed(0)}% → ${(b.observed * 100).toFixed(0)}% (${b.n})`}</title></circle>)}
    </svg>
  )
}

function ReviewCard({ r }: { r: AlgoReview }) {
  return (
    <div className="algo-review">
      <div className="algo-review-head"><b>{r.day}</b><span className="algo-muted">{r.by === 'rules' ? T('Code only') : r.by}</span></div>
      <p>{r.summary}</p>
      {r.lessons.length > 0 && <ul className="algo-why">{r.lessons.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {r.proposals.map(p => (
        <div key={p.param} className="algo-proposal">
          <Pill color={p.status === 'shipped' ? '#0ecb81' : '#848e9c'}>{p.status === 'shipped' ? T('Shipped') : T('Rejected')}</Pill>
          <code>{p.param}: {p.from} → {p.to}</code>
          <span className="algo-muted">{p.why} — {p.test.detail}</span>
        </div>
      ))}
    </div>
  )
}

function OwnerControls({ status, onStatus }: { status: AlgoStatus; onStatus: (s: AlgoStatus) => void }) {
  const trader = useTrader()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const send = useCallback(async (c: Parameters<typeof sendAlgoControl>[0]) => {
    setBusy(true); setMsg(null)
    try { onStatus(await sendAlgoControl(c, trader.signMessage)); setMsg(T('Done.')) }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [trader.signMessage, onStatus])
  const killed = status.risk.killSwitch.tripped
  return (
    <Card title={T('Owner controls')} sub={T("Only the engine owner's wallet can use these: each is a message it signs, checked by the engine. Anyone else is refused.")}>
      {!trader.address ? <div className="algo-muted">{T("Connect the owner's wallet to sign.")}</div> : (
        <div className="algo-controls">
          <input className="at-input" style={{ width: '100%', maxWidth: 360 }} placeholder={T('Why (kept with the change)')} value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
          <div className="algo-btns">
            {!killed
              ? <button className="algo-btn danger" disabled={busy || !note.trim()} onClick={() => send({ action: 'kill', on: true, note: note.trim() })}>{T('Trip the kill switch')}</button>
              : <button className="algo-btn" disabled={busy || !note.trim()} onClick={() => send({ action: 'kill', on: false, note: note.trim() })}>{T('Re-arm the agent')}</button>}
            <button className="algo-btn" disabled={busy} onClick={() => send({ action: 'mode', mode: status.mode === 'paper' ? 'testnet' : 'paper' })}>{status.mode === 'paper' ? T('Trade on Arc testnet') : T('Back to paper')}</button>
          </div>
          {msg && <div className="algo-muted">{msg}</div>}
          <div className="algo-muted">{T('Signed as {a}', { a: shortAddr(trader.address) })}</div>
        </div>
      )}
    </Card>
  )
}

export default function AlgoPage({ navigate }: { navigate: (p: Page) => void }) {
  const [status, setStatus] = useState<AlgoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<AlgoDecisionRow[]>([])
  const [trades, setTrades] = useState<AlgoTrade[]>([])
  const [reviews, setReviews] = useState<AlgoReview[]>([])
  const [open, setOpen] = useState<Partial<Record<AlgoMarket, boolean>>>({})
  const [bots, setBots] = useState<number | null>(null)

  useEffect(() => {
    if (!engineEnabled) { setError(T('The engine is not connected on this site.')); return }
    let alive = true
    const load = (fn: () => Promise<void>) => fn().catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    const s = () => load(async () => { const x = await getAlgoStatus(); if (alive) { setStatus(x); setError(null) } })
    const d = () => load(async () => { const x = await getAlgoDecisions(45); if (alive) setDecisions(x) })
    const t = () => load(async () => { const x = await getAlgoTrades(200); if (alive) setTrades(x) })
    const r = () => load(async () => { const x = await getAlgoReviews(7); if (alive) setReviews(x) })
    s(); d(); t(); r()
    const ids = [setInterval(() => { if (!document.hidden) s() }, 5_000), setInterval(() => { if (!document.hidden) d() }, 10_000), setInterval(() => { if (!document.hidden) t() }, 15_000), setInterval(() => { if (!document.hidden) r() }, 120_000)]
    return () => { alive = false; ids.forEach(clearInterval) }
  }, [])

  useEffect(() => {
    if (!engineEnabled || !botSession()) return
    let alive = true
    void botMe().then(m => { if (alive) setBots(m.bots.length) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const openTrades = trades.filter(t => t.status === 'open' || t.status === 'pending')
  const closed = trades.filter(t => t.status === 'closed' || t.status === 'failed')
  const st = status?.stats
  const risk = status?.risk

  return (
    <div className="content-page algo-page">
      <header className="algo-hero">
        <div>
          <h2 className="page-h">⚡ {T('ARCDEX Algo')}</h2>
          <p className="algo-lead">{T('A 24/7 agent trading BTC, ETH and SOL futures. Every decision, every trade and every risk limit, live.')}</p>
        </div>
        {status && (
          <div className="algo-badges">
            <span className={`at-run ${status.running && !status.risk.killSwitch.tripped ? 'on' : ''}`}>{status.risk.killSwitch.tripped ? T('Stopped by the kill switch') : status.running ? T('Running') : T('Starting')}</span>
            <Pill color={status.mode === 'testnet' ? '#2a6df4' : '#848e9c'}>{status.mode === 'testnet' ? T('Arc testnet') : T('Paper')}</Pill>
            <Pill color="#f59e0b">{T('Test USDC · no real money')}</Pill>
          </div>
        )}
      </header>

      {error && !status && <div className="algo-banner bad">{T('The agent is not reachable right now.')} <span className="algo-muted">{error}</span></div>}
      {status?.waiting && <div className="algo-banner">{status.waiting}</div>}
      {status?.risk.killSwitch.tripped && <div className="algo-banner bad">{T('Kill switch tripped')}: {status.risk.killSwitch.reason}</div>}

      {status && st && risk && (
        <>
          <div className="algo-stats">
            <Stat label={T('Equity')} value={usd(risk.equityUsd)} sub={T('started with {v}', { v: usd(risk.startUsd, 0) })} />
            <Stat label={T('P&L')} value={usd(st.pnlUsd)} color={pnlColor(st.pnlUsd)} sub={signed(st.pnlPct)} />
            <Stat label={T('Trades')} value={String(st.trades)} sub={st.winRate === null ? T('none closed yet') : T('{p}% won', { p: (st.winRate * 100).toFixed(0) })} />
            <Stat label={T('Drawdown')} value={`${risk.drawdownPct.toFixed(2)}%`} color={risk.drawdownPct >= risk.limits.maxDrawdownPct * 0.5 ? '#f59e0b' : undefined} sub={T('limit {v}%', { v: risk.limits.maxDrawdownPct })} />
            <Stat label={T('Today')} value={signed(risk.dayPnlPct)} color={pnlColor(risk.dayPnlPct)} sub={T('limit −{v}%', { v: risk.limits.maxDailyLossPct })} />
            <Stat label={T('Calibration')} value={status.calibration.skill === null ? '—' : status.calibration.skill.toFixed(3)} sub={T('Brier {b} on the last day', { b: status.calibration.brier === null ? '—' : status.calibration.brier.toFixed(3) })} />
          </div>

          <div className="algo-markets">
            {ALGO_MARKETS.map(m => <MarketCard key={m} m={m} view={status.markets[m]} gate={status.gates.minConfidence} expanded={!!open[m]} onToggle={() => setOpen(o => ({ ...o, [m]: !o[m] }))} />)}
          </div>

          <div className="algo-grid">
            <Card title={T('Equity')} sub={T('After each closed trade.')}><EquityCurve trades={trades} start={risk.startUsd} /></Card>
            <Card title={T('How it trades')}>
              <ul className="algo-how">
                <li><b>{T('Reflex')}</b> — {T('every one-minute candle, one typed decision per market: regime, direction, toxic flow, setup quality 0–3 and a calibrated confidence.')}</li>
                <li><b>{T('Gates')}</b> — {T('it trades only when quality is at least {q}, confidence is above {c}% and the risk state is safe, with a positive expectation after fees.', { q: status.gates.minSetupQuality, c: (status.gates.minConfidence * 100).toFixed(0) })}</li>
                <li><b>{T('Size')}</b> — {T('a quarter of the Kelly fraction, never more than {r}% of equity at risk, at most {l}× leverage.', { r: risk.limits.maxRiskPerTradePct, l: risk.limits.maxLeverage })}</li>
                <li><b>{T('Brain')}</b> — {status.brain.enabled ? T('Claude re-reads a position when the reflex loses confidence, and reviews every day. It can only hold or close.') : T('not connected: the code closes a position when the reflex loses confidence.')}</li>
                <li><b>{T('Limits')}</b> — {T('a {d}% drawdown trips the kill switch and closes everything; a {l}% daily loss stops new trades until tomorrow.', { d: risk.limits.maxDrawdownPct, l: risk.limits.maxDailyLossPct })}</li>
              </ul>
            </Card>
          </div>

          <Card title={T('Open positions')} right={<span className="algo-muted">{openTrades.length}</span>}>
            {openTrades.length === 0 ? <div className="algo-muted algo-empty">{T('No open positions.')}</div> : <TradeTable trades={openTrades} />}
          </Card>

          <Card title={T('Decisions')} sub={T('Every candle, every market. Most say no: that is the point.')}>
            <div className="algo-table-wrap">
              <table className="algo-table">
                <thead><tr><th>{T('Time')}</th><th>{T('Market')}</th><th>{T('Regime')}</th><th>{T('Direction')}</th><th>{T('Quality')}</th><th>{T('Confidence')}</th><th>{T('Result')}</th></tr></thead>
                <tbody>
                  {decisions.map(d => (
                    <tr key={d.id} className={d.gate.passed ? 'go' : ''}>
                      <td><AgoText ts={d.at} /></td>
                      <td>{d.market}</td>
                      <td style={{ color: REGIME[d.decision.regime]?.[1] }}>{T(REGIME[d.decision.regime]?.[0] ?? d.decision.regime)}</td>
                      <td style={{ color: DIR[d.decision.direction]?.[1] }}>{T(DIR[d.decision.direction]?.[0] ?? d.decision.direction)}</td>
                      <td><Quality q={d.decision.setup_quality} /></td>
                      <td>{d.decision.direction === 'neutral' ? '—' : `${(d.decision.confidence * 100).toFixed(1)}%`}</td>
                      <td title={d.gate.checks.filter(c => !c.ok).map(c => c.detail).join(' · ')}>{d.gate.passed ? T(ACTION[d.action]) : d.decision.direction === 'neutral' ? T('No trade') : T('Held back: {why}', { why: T(CHECK[d.gate.checks.find(c => !c.ok)?.id ?? ''] ?? '') })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={T('Trades')} right={<span className="algo-muted">{closed.length}</span>}>
            {closed.length === 0 ? <div className="algo-muted algo-empty">{T('No trades yet. It trades only when a setup clears every gate.')}</div> : <TradeTable trades={closed.slice(0, 50)} />}
          </Card>

          <div className="algo-grid">
            <Card title={T('Calibration')} sub={T('When it says 80%, does it happen 80% of the time? Fit on older decisions, scored on the last day it never saw.')}>
              <div className="algo-cal">
                <Reliability c={status.calibration} />
                <dl>
                  <dt>{T('Brier score')}</dt><dd>{status.calibration.brier ?? '—'}</dd>
                  <dt>{T('Base rate only')}</dt><dd>{status.calibration.brierBaseRate ?? '—'}</dd>
                  <dt>{T('Skill')}</dt><dd>{status.calibration.skill ?? '—'}</dd>
                  <dt>{T('Calibration error')}</dt><dd>{status.calibration.ece ?? '—'}</dd>
                  <dt>{T('Labeled decisions')}</dt><dd>{status.calibration.n} / {status.calibration.nTest}</dd>
                </dl>
              </div>
            </Card>
            <Card title={T('Replay')} sub={T('The same agent run over the stored candles when it started, to calibrate it. A measurement, not a promise.')}>
              {!status.replay ? <div className="algo-muted algo-empty">{T('Not enough stored candles yet.')}</div> : (
                <dl className="algo-dl">
                  <dt>{T('Trades')}</dt><dd>{status.replay.stats.trades}</dd>
                  <dt>{T('Won')}</dt><dd>{status.replay.stats.winRate === null ? '—' : `${(status.replay.stats.winRate * 100).toFixed(0)}%`}</dd>
                  <dt>{T('P&L')}</dt><dd style={{ color: pnlColor(status.replay.stats.pnlUsd) }}>{usd(status.replay.stats.pnlUsd)}</dd>
                  <dt>{T('Fees')}</dt><dd>{usd(status.replay.stats.feesUsd)}</dd>
                  <dt>{T('Max drawdown')}</dt><dd>{status.replay.stats.maxDrawdownPct}%</dd>
                  <dt>{T('Decisions')}</dt><dd>{status.replay.decisions.toLocaleString()}</dd>
                </dl>
              )}
            </Card>
          </div>

          <Card title={T('Nightly reviews')} sub={T('Each day: the fills and misses, the calibration, and changes it proposes. A change ships only if a replay shows it does better; gates and limits never change by themselves.')}>
            {reviews.length === 0 ? <div className="algo-muted algo-empty">{T('The first review runs after its first full day.')}</div> : reviews.map(r => <ReviewCard key={r.id} r={r} />)}
          </Card>

          {status.wallet && (
            <Card title={T('Agent wallet on Arc testnet')}>
              <div className="algo-muted"><code>{status.wallet.address}</code> · {T('{u} tUSDC, {g} USDC for gas', { u: status.wallet.usdc?.toFixed(2) ?? '—', g: status.wallet.gasUsdc?.toFixed(3) ?? '—' })}</div>
            </Card>
          )}

          <OwnerControls status={status} onStatus={setStatus} />
        </>
      )}

      {bots !== null && bots > 0 && (
        <div className="soon-owner" style={{ marginTop: 14 }}>
          <span>{T('You have {n} Autotrade bot(s). They open no new trades; you can manage them and withdraw your USDC at any time.', { n: bots })}</span>
          <button className="btn-primary" onClick={() => navigate({ name: 'signals', view: 'manage' })}>{T('Manage and withdraw')} →</button>
        </div>
      )}
      <p className="algo-foot">{T('Futures carry risk. ARCDEX Algo trades test USDC; its results are measured, not promised, and past results say little about the future.')}</p>
    </div>
  )
}

function TradeTable({ trades }: { trades: AlgoTrade[] }) {
  return (
    <div className="algo-table-wrap">
      <table className="algo-table">
        <thead><tr><th>{T('Opened')}</th><th>{T('Market')}</th><th>{T('Side')}</th><th>{T('Entry')}</th><th>{T('Exit')}</th><th>{T('Size')}</th><th>{T('Confidence')}</th><th>{T('P&L')}</th><th>{T('Why it closed')}</th></tr></thead>
        <tbody>
          {trades.map(t => (
            <tr key={t.id}>
              <td><AgoText ts={t.openedAt} /></td>
              <td>{t.market}</td>
              <td style={{ color: DIR[t.side][1] }}>{T(DIR[t.side][0])} {t.leverage}×</td>
              <td>{price(t.entry)}{t.txOpen && <a className="algo-tx" href={txUrl(t.txOpen)} target="_blank" rel="noreferrer">↗</a>}</td>
              <td>{t.status === 'pending' ? T('Filling…') : price(t.exit)}{t.txClose && <a className="algo-tx" href={txUrl(t.txClose)} target="_blank" rel="noreferrer">↗</a>}</td>
              <td>{usd(t.sizeUsd, 0)}</td>
              <td>{(t.confidence * 100).toFixed(1)}%</td>
              <td style={{ color: pnlColor(t.pnlUsd) }}>{t.pnlUsd === null ? (t.status === 'failed' ? '—' : T('open')) : `${usd(t.pnlUsd)} (${signed(t.pnlPct)})`}</td>
              <td className="algo-reason">{t.status === 'failed' ? `✗ ${t.reason ?? ''}` : t.reason ?? `TP ${price(t.tp)} · SL ${price(t.sl)}`}{t.escalations.length > 0 && <span className="algo-muted"> · {t.escalations[t.escalations.length - 1].by}: {t.escalations[t.escalations.length - 1].why}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
