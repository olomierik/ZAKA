// The Signal engine dashboard (the "Signal engine" tab of /autotrade): the
// engine's live view of every scored coin, its signals with every reason, its
// paper trades and strategy results, its validation runs and the live gate,
// smart-money wallets, and the owner's signed controls (engine/src/quant).
// Every number is measured; nothing here promises a result.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { QuantBookStats, QuantPosition, QuantRadarRow, QuantSignal, QuantStatus, QuantStrategy, QuantValidationRun, QuantWallet } from '../../../api/_quantProtocol'
import { getQuantPositions, getQuantRadar, getQuantSignals, getQuantStatus, getQuantValidations, getQuantWallets, sendQuantControl } from '../api/quant'
import type { Page } from '../App'
import { AgoText } from './Ago'
import { N_, t as T } from '../lib/i18n'
import { shortAddr, useTrader } from '../lib/identity'

type Tab = 'live' | 'signals' | 'trades' | 'strategies' | 'validation' | 'wallets' | 'controls'

const STRATEGY_NAME: Record<QuantStrategy, string> = { early_momentum: N_('Early momentum'), breakout: N_('Breakout'), smart_money: N_('Smart money follow') }
const STRATEGY_COLOR: Record<QuantStrategy, string> = { early_momentum: '#3b82f6', breakout: '#a855f7', smart_money: '#22c55e' }
const BAND: Record<string, [string, string]> = {
  NO_TRADE: [N_('No trade'), '#64748b'], WATCH: [N_('Watch'), '#94a3b8'], WEAK: [N_('Weak'), '#f59e0b'], TRADE_CANDIDATE: [N_('Trade candidate'), '#3b82f6'], HIGH_CONVICTION: [N_('High conviction'), '#22c55e'],
}
const REGIME: Record<string, [string, string]> = {
  BULLISH: [N_('Bullish'), '#22c55e'], NEUTRAL: [N_('Neutral'), '#94a3b8'], BEARISH: [N_('Bearish'), '#ef4444'], HIGH_VOLATILITY: [N_('High volatility'), '#f59e0b'], LIQUIDITY_STRESSED: [N_('Liquidity stressed'), '#ef4444'],
}
const COMPONENTS: [keyof QuantSignal['components'], string][] = [['flow', N_('Flow')], ['momentum', N_('Momentum')], ['volume', N_('Volume')], ['liquidity', N_('Liquidity')], ['smartMoney', N_('Smart money')], ['holders', N_('Holders')], ['safety', N_('Safety')], ['regime', N_('Regime')]]

const usd = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const big = (n: unknown) => typeof n !== 'number' || !Number.isFinite(n) ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const px = (n: unknown) => typeof n !== 'number' || !(n > 0) ? '—' : n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`
const pct = (n: unknown, d = 0) => typeof n !== 'number' || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(d)}%`
const num = (n: unknown, d = 1) => typeof n !== 'number' || !Number.isFinite(n) ? '—' : n.toFixed(d)
const signed = (n: number | null | undefined, d = 1) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`
const scoreColor = (s: number) => s >= 85 ? '#22c55e' : s >= 75 ? '#3b82f6' : s >= 65 ? '#f59e0b' : '#94a3b8'

function Pill({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return <span title={title} style={{ fontSize: '0.64rem', fontWeight: 800, padding: '2px 7px', borderRadius: 999, color, border: `1px solid ${color}55`, background: `${color}18`, whiteSpace: 'nowrap' }}>{children}</span>
}
function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 800 }}>{title}</div>
      {sub && <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>{sub}</div>}
      {children}
    </div>
  )
}
function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: '9px 11px', minWidth: 0 }}>
      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.02rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '18px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5 }}>{children}</div>
}
const th: React.CSSProperties = { textAlign: 'left', fontWeight: 700, color: 'var(--text-muted)', padding: '6px 8px', whiteSpace: 'nowrap', fontSize: '0.68rem', borderBottom: '1px solid var(--adx-card-border)' }
const td: React.CSSProperties = { padding: '6px 8px', whiteSpace: 'nowrap', fontSize: '0.74rem', fontFamily: 'var(--mono)', borderBottom: '1px solid var(--adx-card-border)' }
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: 'auto', margin: '0 -4px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{head.map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function StatsRow({ s, label }: { s: QuantBookStats; label: string }) {
  return (
    <tr>
      <td style={{ ...td, fontFamily: 'inherit', fontWeight: 700 }}>{label}</td>
      <td style={td}>{s.trades}</td>
      <td style={td}>{pct(s.win_rate)}</td>
      <td style={td}>{s.profit_factor === null ? '—' : s.profit_factor >= 99 ? '∞' : s.profit_factor.toFixed(2)}</td>
      <td style={{ ...td, color: s.expectancy_pct >= 0 ? '#22c55e' : '#ef4444' }}>{signed(s.expectancy_pct, 2)}</td>
      <td style={{ ...td, color: s.net_pnl >= 0 ? '#22c55e' : '#ef4444' }}>{usd(s.net_pnl)}</td>
      <td style={td}>{usd(s.average_winner)} / {usd(s.average_loser)}</td>
      <td style={td}>{num(s.max_drawdown_pct)}%</td>
      <td style={td}>{num(s.average_hold_min)}m</td>
      <td style={td}>{s.tp_hit_rates.map(x => pct(x)).join(' / ') || '—'}</td>
      <td style={td}>{pct(s.stop_rate)}</td>
    </tr>
  )
}

export default function SignalEnginePanel({ navigate }: { navigate: (p: Page) => void }) {
  const [tab, setTab] = useState<Tab>('live')
  const [status, setStatus] = useState<QuantStatus | null>(null)
  const [radar, setRadar] = useState<QuantRadarRow[]>([])
  const [signals, setSignals] = useState<QuantSignal[]>([])
  const [positions, setPositions] = useState<QuantPosition[]>([])
  const [down, setDown] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => Promise.all([getQuantStatus(), getQuantRadar(150), getQuantSignals(150), getQuantPositions('paper', 200)])
      .then(([s, r, sg, p]) => { if (!alive) return; setStatus(s); setRadar(r); setSignals(sg); setPositions(p); setDown(false) })
      .catch(() => { if (alive) setDown(true) })
    void load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 4_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (down && !status) return <Empty>{T('The signal engine isn\'t answering right now. It runs inside the market engine; this page fills in when it\'s back.')}</Empty>
  if (!status) return <Empty>{T('Loading…')}</Empty>
  const paper = status.stats.paper.all
  const gateOk = status.liveGate.checks.filter(c => c.ok).length
  const [regName, regColor] = REGIME[status.regime.regime] ?? [status.regime.regime, '#94a3b8']
  const TABS: [Tab, string][] = [['live', T('Live signals')], ['signals', T('Signal history')], ['trades', T('Paper trades')], ['strategies', T('Strategies')], ['validation', T('Validation & live gate')], ['wallets', T('Smart money')], ['controls', T('Controls')]]

  return (
    <div style={{ marginTop: 12 }}>
      <div className="at-step-sub" style={{ lineHeight: 1.5 }}>
        {T('A 100-point score for every coin from its buying and selling, momentum, volume, liquidity, smart-money wallets, holders, safety and the market\'s mood; three strategies on top; paper trading with live data, every trade filled at live speed with its costs. Live trading stays off until walk-forward tests and the paper record pass every check below.')}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <Pill color={status.controls.paperEnabled && status.controls.tradingEnabled ? '#22c55e' : '#94a3b8'}>{T('Paper')} {status.controls.paperEnabled && status.controls.tradingEnabled ? T('on') : T('off')}</Pill>
        <Pill color={status.liveGate.ok ? '#ef4444' : '#94a3b8'} title={status.liveGate.checks.filter(c => !c.ok).map(c => c.detail).join('\n')}>{T('Live')} {status.liveGate.ok ? T('on') : T('off')} · {T('{a} of {b} checks', { a: gateOk, b: status.liveGate.checks.length })}</Pill>
        {status.controls.killSwitch && <Pill color="#ef4444">{T('Kill switch on')}</Pill>}
        <Pill color={regColor} title={status.regime.why}>{T('Market')}: {T(regName)}</Pill>
        <Pill color={status.warm.done ? '#22c55e' : '#f59e0b'} title={status.warm.detail}>{status.warm.done ? T('Warm') : T('Warming up')}</Pill>
        <Pill color="#64748b">{T('Settings v{v}', { v: status.version })}</Pill>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginTop: 10 }}>
        <Stat label={T('Paper equity')} value={usd(status.equity.paper)} />
        <Stat label={T('Paper P&L')} value={usd(paper.net_pnl)} color={paper.net_pnl >= 0 ? '#22c55e' : '#ef4444'} sub={T('{n} trades', { n: paper.trades })} />
        <Stat label={T('Win rate')} value={pct(paper.win_rate)} sub={T('profit factor {pf}', { pf: paper.profit_factor === null ? '—' : paper.profit_factor >= 99 ? '∞' : paper.profit_factor.toFixed(2) })} />
        <Stat label={T('Expectancy')} value={signed(paper.expectancy_pct, 2)} color={paper.expectancy_pct >= 0 ? '#22c55e' : '#ef4444'} sub={T('a trade, after costs')} />
        <Stat label={T('Open')} value={String(status.counts.openPaper)} sub={T('{c} coins scored', { c: status.counts.coins })} />
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 12, borderBottom: '1px solid var(--adx-card-border)', overflowX: 'auto' }}>
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ padding: '8px 12px', background: 'none', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--adx-accent)' : 'transparent'}`, color: tab === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 800, fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>{l}</button>
        ))}
      </div>
      {tab === 'live' && <LiveSignals radar={radar} navigate={navigate} />}
      {tab === 'signals' && <SignalHistory signals={signals} navigate={navigate} />}
      {tab === 'trades' && <PaperTrades positions={positions} navigate={navigate} />}
      {tab === 'strategies' && <Strategies status={status} />}
      {tab === 'validation' && <Validation status={status} />}
      {tab === 'wallets' && <Wallets />}
      {tab === 'controls' && <Controls status={status} onStatus={setStatus} />}
    </div>
  )
}

function LiveSignals({ radar, navigate }: { radar: QuantRadarRow[]; navigate: (p: Page) => void }) {
  const [minScore, setMinScore] = useState(0)
  const [strategy, setStrategy] = useState<'' | QuantStrategy>('')
  const [maxAge, setMaxAge] = useState(0)
  const [minLiq, setMinLiq] = useState(0)
  const [safeOnly, setSafeOnly] = useState(false)
  const rows = useMemo(() => radar.filter(r => r.score >= minScore && (!strategy || r.strategy === strategy) && (!maxAge || Number(r.summary.age_min ?? 0) <= maxAge) && Number(r.summary.liquidity ?? 0) >= minLiq && (!safeOnly || r.summary.trade_allowed === true)), [radar, minScore, strategy, maxAge, minLiq, safeOnly])
  const sel: React.CSSProperties = { background: 'var(--adx-card-bg)', color: 'var(--text)', border: '1px solid var(--adx-card-border)', borderRadius: 8, padding: '4px 6px', fontSize: '0.74rem' }
  return (
    <Card title={T('Every coin scored now')} sub={T('Scored on every trade, at most once a second. A strategy column means its conditions are met right now.')}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 8px', fontSize: '0.74rem' }}>
        <label>{T('Score')} ≥ <select style={sel} value={minScore} onChange={e => setMinScore(Number(e.target.value))}>{[0, 50, 65, 75, 85].map(v => <option key={v} value={v}>{v}</option>)}</select></label>
        <label>{T('Strategy')} <select style={sel} value={strategy} onChange={e => setStrategy(e.target.value as '' | QuantStrategy)}><option value="">{T('Any')}</option>{(Object.keys(STRATEGY_NAME) as QuantStrategy[]).map(s => <option key={s} value={s}>{T(STRATEGY_NAME[s])}</option>)}</select></label>
        <label>{T('Age')} ≤ <select style={sel} value={maxAge} onChange={e => setMaxAge(Number(e.target.value))}><option value={0}>{T('Any')}</option>{[10, 30, 120, 1_440].map(v => <option key={v} value={v}>{v >= 60 ? `${v / 60}h` : `${v}m`}</option>)}</select></label>
        <label>{T('Liquidity')} ≥ <select style={sel} value={minLiq} onChange={e => setMinLiq(Number(e.target.value))}>{[0, 5_000, 10_000, 25_000, 50_000].map(v => <option key={v} value={v}>{big(v)}</option>)}</select></label>
        <label><input type="checkbox" checked={safeOnly} onChange={e => setSafeOnly(e.target.checked)} /> {T('Safe to trade only')}</label>
      </div>
      {rows.length === 0 ? <Empty>{T('No coin matches these filters right now.')}</Empty> : (
        <Table head={[T('Token'), T('Price'), T('Market cap'), T('Liquidity'), T('Age'), T('Score'), T('Strategy'), T('Buy pressure'), T('Volume ×'), T('Smart money'), T('Holder health'), T('Exhaustion'), T('Safety'), T('Slippage')]}>
          {rows.map(r => {
            const s = r.summary
            return (
              <tr key={r.token} onClick={() => navigate({ name: 'token', address: r.token, symbol: r.symbol })} style={{ cursor: 'pointer' }}>
                <td style={{ ...td, fontFamily: 'inherit', fontWeight: 800 }}>${r.symbol}</td>
                <td style={td}>{px(s.price)}</td>
                <td style={td}>{big(s.market_cap)}</td>
                <td style={td}>{big(s.liquidity)}</td>
                <td style={td}>{num(s.age_min, 0)}m</td>
                <td style={{ ...td, fontWeight: 800, color: scoreColor(r.score) }}>{r.score.toFixed(1)}</td>
                <td style={td}>{r.strategy ? <Pill color={STRATEGY_COLOR[r.strategy]}>{T(STRATEGY_NAME[r.strategy])}</Pill> : '—'}</td>
                <td style={td}>{pct(s.buy_pressure_1m)}</td>
                <td style={td}>{num(s.volume_acceleration)}×</td>
                <td style={td}>{String(s.smart_money ?? 0)}</td>
                <td style={td}>{num(s.holder_health)}/10</td>
                <td style={{ ...td, color: Number(s.exhaustion) > 65 ? '#ef4444' : undefined }}>{num(s.exhaustion, 0)}</td>
                <td style={{ ...td, color: s.trade_allowed ? '#22c55e' : '#ef4444' }}>{String(s.safety ?? '—')}{s.trade_allowed ? '' : ' ✗'}</td>
                <td style={td}>{num(s.expected_slippage_pct, 2)}%</td>
              </tr>
            )
          })}
        </Table>
      )}
    </Card>
  )
}

function SignalHistory({ signals, navigate }: { signals: QuantSignal[]; navigate: (p: Page) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [decision, setDecision] = useState<'' | 'traded' | 'rejected'>('')
  const rows = signals.filter(s => !decision || s.decision === decision)
  return (
    <Card title={T('Signals')} sub={T('A signal is a strategy\'s conditions met. Each one says why it triggered, and why it was traded or not.')}>
      <div style={{ display: 'flex', gap: 6, margin: '4px 0 8px' }}>
        {([['', T('All')], ['traded', T('Traded')], ['rejected', T('Not traded')]] as const).map(([k, l]) => <button key={k} className={`at-chip${decision === k ? ' on' : ''}`} onClick={() => setDecision(k)}>{l}</button>)}
      </div>
      {rows.length === 0 ? <Empty>{T('No signals yet. Most coins never meet a strategy\'s conditions; a signal shows here the moment one does.')}</Empty> : rows.map(s => {
        const [bandName, bandColor] = BAND[s.band] ?? [s.band, '#94a3b8']
        const q = s.trade_quality
        return (
          <div key={s.id} style={{ borderBottom: '1px solid var(--adx-card-border)', padding: '8px 0' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <Pill color={s.decision === 'traded' ? '#22c55e' : '#94a3b8'}>{s.decision === 'traded' ? T('Traded') : T('Not traded')}</Pill>
              <b style={{ fontSize: '0.84rem' }}>${s.symbol}</b>
              <Pill color={STRATEGY_COLOR[s.strategy]}>{T(STRATEGY_NAME[s.strategy])}</Pill>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: scoreColor(s.signal_score) }}>{s.signal_score.toFixed(1)}</span>
              <Pill color={bandColor}>{T(bandName)}</Pill>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('confidence {c}', { c: pct(s.confidence) })} · <AgoText ts={s.at} /></span>
            </div>
            <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
              {COMPONENTS.map(([k, l]) => (
                <div key={k} title={`${T(l)} ${s.components[k]}`} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--adx-card-border)', overflow: 'hidden' }}><div style={{ width: `${Math.min(100, (s.components[k] / maxOf(k)) * 100)}%`, height: '100%', background: 'var(--adx-accent)' }} /></div>
                  <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{T(l)} {s.components[k]}</div>
                </div>
              ))}
            </div>
            {s.decision === 'rejected' && <div style={{ fontSize: '0.72rem', color: '#f59e0b', marginTop: 4 }}>✗ {s.why_trade_rejected[0]}</div>}
            {open === s.id && (
              <div style={{ fontSize: '0.72rem', lineHeight: 1.6, marginTop: 6, color: 'var(--text-muted)' }}>
                <div><b>{T('Why it triggered')}</b>: {s.why_signal_triggered.join(' · ')}</div>
                {s.why_trade_allowed.length > 0 && <div style={{ color: '#22c55e' }}><b>{T('Why it may trade')}</b>: {s.why_trade_allowed.join(' · ')}</div>}
                {s.why_trade_rejected.length > 0 && <div style={{ color: '#f59e0b' }}><b>{T('Why not')}</b>: {s.why_trade_rejected.join(' · ')}</div>}
                {s.risk_flags.length > 0 && <div><b>{T('Risk flags')}</b>: {s.risk_flags.join(', ')}</div>}
                {s.recommended_stop && <div><b>{T('Plan')}</b>: {T('entry {e}, stop {s} (−{p}%), targets {t}', { e: px(s.recommended_entry?.price), s: px(s.recommended_stop.price), p: s.recommended_stop.pct, t: s.recommended_targets.map(x => `+${x.gainPct}% (${x.sellPct}%)`).join(', ') })}{s.position_size > 0 ? ` · ${T('size {u}', { u: usd(s.position_size) })}` : ''}</div>}
                {q && <div><b>{T('Expected value')}</b>: {q.why} · {T('win chance {p}', { p: pct(q.p_win) })}</div>}
                <button className="link-btn" onClick={() => navigate({ name: 'token', address: s.token, symbol: s.symbol })}>{T('Open the coin')} →</button>
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}
const MAX: Record<string, number> = { flow: 20, momentum: 15, volume: 15, liquidity: 15, smartMoney: 10, holders: 10, safety: 10, regime: 5 }
const maxOf = (k: string) => MAX[k] ?? 10

function PaperTrades({ positions, navigate }: { positions: QuantPosition[]; navigate: (p: Page) => void }) {
  return (
    <Card title={T('Paper trades')} sub={T('Virtual USDC, live prices: each buy fills at the first price 2.5 seconds after the signal and each sale 2 seconds after its trigger, paying the pool\'s price impact, fees, taxes and gas.')}>
      {positions.length === 0 ? <Empty>{T('No paper trades yet.')}</Empty> : (
        <Table head={[T('Coin'), T('Strategy'), T('Opened'), T('Status'), T('Size'), T('Entry'), T('P&L'), T('Targets'), T('Exit')]}>
          {positions.map(p => (
            <tr key={p.id} onClick={() => navigate({ name: 'token', address: p.token, symbol: p.symbol })} style={{ cursor: 'pointer' }}>
              <td style={{ ...td, fontFamily: 'inherit', fontWeight: 800 }}>${p.symbol}</td>
              <td style={td}><Pill color={STRATEGY_COLOR[p.strategy]}>{T(STRATEGY_NAME[p.strategy])}</Pill></td>
              <td style={td}><AgoText ts={p.openedAt} /></td>
              <td style={td}>{p.status === 'open' ? T('Open') : p.status === 'pending' ? T('Filling') : p.status === 'failed' ? T('Not bought') : T('Closed')}</td>
              <td style={td}>{usd(p.costUsd || p.plannedUsd)}</td>
              <td style={td}>{px(p.entryPrice)}</td>
              <td style={{ ...td, color: (p.pnlUsd ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>{p.pnlUsd === null ? '—' : `${usd(p.pnlUsd)} (${signed(p.returnPct)})`}</td>
              <td style={td}>{p.tpHit}</td>
              <td style={{ ...td, fontFamily: 'inherit', color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.exitReason ?? ''}>{p.exitReason ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function Strategies({ status }: { status: QuantStatus }) {
  const head = [T('Strategy'), T('Trades'), T('Won'), T('Profit factor'), T('Expectancy'), T('Net'), T('Avg win / loss'), T('Max DD'), T('Hold'), T('Targets hit'), T('Stops')]
  const rows = (book: 'paper' | 'live') => [...(Object.keys(STRATEGY_NAME) as QuantStrategy[]).map(s => [s, T(STRATEGY_NAME[s])] as const), ['all', T('All')] as const]
    .map(([k, l]) => status.stats[book][k] ? <StatsRow key={k} s={status.stats[book][k]} label={l} /> : null)
  return (
    <>
      <Card title={T('Paper results by strategy')} sub={T('Closed paper trades, after every cost. Each strategy can be switched off or tuned on its own (Controls).')}>
        <Table head={head}>{rows('paper')}</Table>
      </Card>
      {(status.stats.live.all?.trades ?? 0) > 0 && <Card title={T('Live results by strategy')}><Table head={head}>{rows('live')}</Table></Card>}
    </>
  )
}

function Validation({ status }: { status: QuantStatus }) {
  const [runs, setRuns] = useState<QuantValidationRun[]>([])
  useEffect(() => { void getQuantValidations().then(r => setRuns(r.runs)).catch(() => {}) }, [status.validation.last?.id])
  return (
    <>
      <Card title={T('Live gate')} sub={T('Live orders need every one of these. Until then the engine trades paper only.')}>
        {status.liveGate.checks.map(c => (
          <div key={c.id} style={{ fontSize: '0.76rem', margin: '3px 0', color: c.ok ? '#22c55e' : 'var(--text-muted)' }}>{c.ok ? '✓' : '✗'} {c.detail}</div>
        ))}
      </Card>
      <Card title={T('Walk-forward validation')} sub={T('Settings are chosen on a training window, checked on the next one, and judged on a window no choice has seen. The out-of-sample results are what the live gate reads.')}>
        {status.validation.running && <div className="at-note">{T('A validation run is going now (a few minutes).')}</div>}
        {status.validation.next && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('Next run')}: {new Date(status.validation.next).toLocaleString()}</div>}
        {runs.length === 0 ? <Empty>{T('No validation run yet. The first one starts 15 minutes after the engine does.')}</Empty> : runs.map(r => (
          <div key={r.id} style={{ borderBottom: '1px solid var(--adx-card-border)', padding: '6px 0', fontSize: '0.74rem' }}>
            <div><Pill color={r.ok ? '#22c55e' : '#ef4444'}>{r.ok ? T('Done') : T('Failed')}</Pill> <AgoText ts={r.at} /> · {r.summary}</div>
            {r.folds?.map(f => <div key={f.fold} style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{T('Fold {n}', { n: f.fold })}: {f.chosen} · {T('{t} trades, {e} a trade', { t: f.test.trades, e: signed(f.test.expectancy_pct, 2) })}</div>)}
          </div>
        ))}
      </Card>
    </>
  )
}

function Wallets() {
  const [data, setData] = useState<{ summary: Record<string, number>; top: QuantWallet[] } | null>(null)
  useEffect(() => { void getQuantWallets().then(setData).catch(() => {}) }, [])
  if (!data) return <Empty>{T('Loading…')}</Empty>
  return (
    <Card title={T('Smart money')} sub={T('Wallets judged by their closed trades across coins: winning often and by more than they lose, over several coins, and not bots that buy everything. Size alone never makes a wallet smart.')}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {Object.entries(data.summary).filter(([k]) => k !== 'wallets').map(([k, v]) => <Pill key={k} color={k === 'SMART_MONEY' ? '#22c55e' : k === 'HIGH_RISK' ? '#ef4444' : '#64748b'}>{k.replace('_', ' ').toLowerCase()} {v}</Pill>)}
      </div>
      {data.top.length === 0 ? <Empty>{T('No wallet has a record good enough yet.')}</Empty> : (
        <Table head={[T('Wallet'), T('Quality'), T('Trades'), T('Won'), T('Profit factor'), T('Median'), T('Realized'), T('Coins')]}>
          {data.top.map(w => (
            <tr key={w.wallet}>
              <td style={td}><a href={`https://explorer.arc.io/address/${w.wallet}`} target="_blank" rel="noreferrer">{shortAddr(w.wallet)}</a></td>
              <td style={td}>{w.quality.toFixed(2)}</td>
              <td style={td}>{w.trade_count}</td>
              <td style={td}>{pct(w.win_rate)}</td>
              <td style={td}>{w.profit_factor === null ? '∞' : w.profit_factor.toFixed(2)}</td>
              <td style={td}>{pct(w.median_return, 1)}</td>
              <td style={td}>{usd(w.realized_profit - w.realized_loss, 0)}</td>
              <td style={td}>{w.tokens_traded}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function Controls({ status, onStatus }: { status: QuantStatus; onStatus: (s: QuantStatus) => void }) {
  const trader = useTrader()
  const [patch, setPatch] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const send = useCallback(async (c: Parameters<typeof sendQuantControl>[0]) => {
    setBusy(true); setMsg(null)
    try { onStatus(await sendQuantControl(c, trader.signMessage)); setMsg(T('Done.')) }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [trader.signMessage, onStatus])
  const valid = (() => { if (!patch.trim()) return false; try { JSON.parse(patch); return true } catch { return false } })()
  return (
    <>
      <Card title={T('Owner controls')} sub={T('Only the engine owner\'s wallet can use these: each is a message it signs, checked by the engine. Anyone else is refused.')}>
        {!trader.address && <div className="at-note">{T('Connect the owner\'s wallet to sign.')}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <button className="at-wbtn primary" disabled={busy || !trader.address} onClick={() => void send({ action: 'kill', on: !status.controls.killSwitch })} style={{ background: status.controls.killSwitch ? undefined : '#ef4444' }}>
            {status.controls.killSwitch ? T('Turn the kill switch off') : T('Kill switch: stop and sell everything')}
          </button>
          <button className="at-wbtn" disabled={busy || !trader.address || status.validation.running} onClick={() => void send({ action: 'validate' })}>{T('Run validation now')}</button>
        </div>
        <div style={{ marginTop: 12, fontSize: '0.76rem', fontWeight: 700 }}>{T('Change settings')}</div>
        <div className="at-step-sub" style={{ margin: '2px 0 6px' }}>{T('A JSON patch over the settings below, e.g. {"gates":{"minSignalScore":70}}. Invalid settings are refused; every change is kept as a new version.')}</div>
        <textarea value={patch} onChange={e => setPatch(e.target.value)} rows={3} spellCheck={false} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: '0.74rem', background: 'var(--adx-card-bg)', color: 'var(--text)', border: `1px solid ${patch && !valid ? '#ef4444' : 'var(--adx-card-border)'}`, borderRadius: 8, padding: 8 }} placeholder='{"risk":{"maxConcurrent":3}}' />
        <input value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder={T('Why (kept with the version)')} style={{ width: '100%', marginTop: 6, background: 'var(--adx-card-bg)', color: 'var(--text)', border: '1px solid var(--adx-card-border)', borderRadius: 8, padding: 8, fontSize: '0.76rem' }} />
        <button className="at-wbtn primary" style={{ marginTop: 6 }} disabled={busy || !trader.address || !valid || !note.trim()} onClick={() => void send({ action: 'settings', patch: JSON.stringify(JSON.parse(patch)), note: note.trim() })}>{T('Sign and apply')}</button>
        {msg && <div style={{ fontSize: '0.74rem', marginTop: 6, color: msg === T('Done.') ? '#22c55e' : '#ef4444' }}>{msg}</div>}
      </Card>
      <Card title={T('Current settings')} sub={T('Every weight, threshold, exit and limit the engine uses (version {v}).', { v: status.version })}>
        <pre style={{ fontSize: '0.68rem', maxHeight: 360, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(status.config, null, 2)}</pre>
      </Card>
    </>
  )
}
