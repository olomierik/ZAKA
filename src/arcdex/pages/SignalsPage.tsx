// Signals: what the market engine's signal and paper-trading bot sees
// (engine/src/bot). Paper trading only: simulated positions at live prices,
// no money moves. The numbers are measured results, never a promise.

import { useEffect, useMemo, useState } from 'react'
import type { BotPosition, SafetyCheck, TradeSignal } from '../../../api/_marketProtocol'
import { getLaunchpadColor } from '../api/radardex'
import { engineEnabled, getBotPositions, getBotStats, getSignals, marketStream, type BotStats, type BotStatsResponse } from '../api/marketStream'
import { AgoText } from '../components/Ago'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

type Tab = 'all' | 'snipe' | 'secondLeg'

const usd = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const price = (n: number) => n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`
const big = (n: number | null) => n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const STRATEGY: Record<TradeSignal['strategy'], string> = { snipe: 'Snipe', 'second-leg': 'Second leg' }

export default function SignalsPage({ navigate }: { navigate: (p: Page) => void }) {
  const [stats, setStats] = useState<BotStatsResponse | null>(null)
  const [signals, setSignals] = useState<TradeSignal[]>([])
  const [positions, setPositions] = useState<BotPosition[]>([])
  const [tab, setTab] = useState<Tab>('all')
  const [down, setDown] = useState(false)

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    const load = () => Promise.all([getBotStats(), getSignals(100), getBotPositions('all', 200)])
      .then(([s, sig, pos]) => { if (!alive) return; setStats(s); setSignals(sig); setPositions(pos); setDown(false) })
      .catch(() => { if (alive) setDown(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    const off = marketStream.subscribe({ channel: 'signals' }, m => {
      if (m.t === 'SIGNAL') setSignals(list => [m.d, ...list.filter(x => x.id !== m.d.id)].slice(0, 100))
      if (m.t === 'BOT_POSITION') setPositions(list => [m.d, ...list.filter(x => x.id !== m.d.id)])
    })
    return () => { alive = false; clearInterval(id); off() }
  }, [])

  const shown: BotStats | null = stats ? stats[tab] : null
  const open = useMemo(() => positions.filter(p => p.status === 'open'), [positions])
  const closed = useMemo(() => positions.filter(p => p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)), [positions])

  return (
    <div className="token-page content-page">
      <h2 className="page-h">{T('Signals')}</h2>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {T('New coins that pass every safety check and show real buying, from every Arc launchpad.')}{' '}
        <b style={{ color: 'var(--text)' }}>{T('Paper trading:')}</b>{' '}{T('each signal opens a simulated position at the live price, with real costs. No money moves.')}
      </div>
      <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', fontSize: '0.74rem', color: '#fcd34d', lineHeight: 1.45 }}>
        {T('These are measured results, not a promise: no strategy can guarantee a win rate, and most new coins go to zero. Not financial advice.')}
      </div>

      {!engineEnabled || down ? (
        <Empty>{T("The signal engine isn't reachable right now. Signals and results appear here when it's back.")}</Empty>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, marginTop: 16, borderBottom: '1px solid var(--adx-card-border)' }}>
            {([['all', T('All strategies')], ['snipe', T('Snipe')], ['secondLeg', T('Second leg')]] as [Tab, string][]).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{ padding: '8px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--adx-accent)' : 'transparent'}`, color: tab === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>{l}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 12 }}>
            <Stat label={T('Win rate')} value={shown?.winRate === null || !shown ? '—' : `${(shown.winRate * 100).toFixed(0)}%`} sub={shown ? T('{w} won · {l} lost', { w: shown.wins, l: shown.losses }) : ''} />
            <Stat label={T('Profit factor')} value={!shown || shown.profitFactor === null ? '—' : shown.profitFactor === Infinity ? '∞' : shown.profitFactor.toFixed(2)} sub={T('won ÷ lost; above 1 makes money')} />
            <Stat label={T('Per trade, on average')} value={usd(shown?.expectancyUsd)} color={(shown?.expectancyUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5'} />
            <Stat label={T('Total P&L')} value={usd(shown?.totalPnlUsd)} color={(shown?.totalPnlUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5'} sub={T('{n} closed · {o} open', { n: shown?.closed ?? 0, o: shown?.open ?? 0 })} />
            <Stat label={T('Worst drawdown')} value={usd(shown ? -shown.maxDrawdownUsd : null)} />
            <Stat label={T('Average win / loss')} value={`${usd(shown?.avgWinUsd)} / ${usd(shown?.avgLossUsd)}`} small />
          </div>
          {stats && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>{T('Watching {n} coins launched in the last 48 hours.', { n: stats.watching })}</div>}

          <Section title={T('Live signals')}>
            {signals.length === 0 ? <Empty>{T('No signals yet. Most launches fail a safety check; a signal appears the moment one passes them all.')}</Empty>
              : signals.map(s => <SignalRow key={s.id} s={s} navigate={navigate} />)}
          </Section>

          <Section title={T('Open positions') + ` · ${open.length}`}>
            {open.length === 0 ? <Empty>{T('No open positions.')}</Empty> : open.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
          </Section>

          <Section title={T('Closed positions') + ` · ${closed.length}`}>
            {closed.length === 0 ? <Empty>{T('Nothing closed yet.')}</Empty> : closed.slice(0, 50).map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
          </Section>
        </>
      )}
    </div>
  )
}

function SignalRow({ s, navigate }: { s: TradeSignal; navigate: (p: Page) => void }) {
  const [openDetails, setOpenDetails] = useState(false)
  const passed = s.safety.checks.filter(c => c.hard && c.ok === true).length
  return (
    <div style={{ padding: '12px 4px', borderBottom: '1px solid var(--adx-card-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="link-btn" onClick={() => navigate({ name: 'argus', address: s.token, pool: '' })} style={{ fontSize: '0.95rem', textDecoration: 'none' }}>${s.symbol}</button>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
        <Pill color={getLaunchpadColor(s.launchpad)}>{s.launchpad}</Pill>
        <Pill color={s.strategy === 'snipe' ? '#3b82f6' : '#a855f7'}>{T(STRATEGY[s.strategy])}</Pill>
        {!s.executable && <Pill color="#64748b">{T('Paper only')}</Pill>}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}><AgoText ts={s.at} /></span>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: '0.76rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
        <span>{T('Price')} <b style={{ color: 'var(--text)' }}>{price(s.price)}</b></span>
        <span>{T('MC')} <b style={{ color: 'var(--text)' }}>{big(s.marketCapUsd)}</b></span>
        <span>{T('Liq')} <b style={{ color: 'var(--text)' }}>{big(s.liquidityUsd)}</b></span>
        <span style={{ color: '#86efac' }}>✓ {T('{n} safety checks passed', { n: passed })} · {s.safety.score}/100</span>
        <button className="link-btn" onClick={() => setOpenDetails(v => !v)} style={{ fontSize: '0.74rem' }}>{openDetails ? T('Hide why') : T('Why')}</button>
      </div>
      {openDetails && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>{T('Market')}</div>
            {s.reasons.map(r => <div key={r} style={{ fontSize: '0.74rem', lineHeight: 1.5 }}>• {r}</div>)}
          </div>
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>{T('Safety')}</div>
            {s.safety.checks.map(c => <CheckLine key={c.id} c={c} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function CheckLine({ c }: { c: SafetyCheck }) {
  const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '…'
  const color = c.ok === true ? '#86efac' : c.ok === false ? '#fca5a5' : 'var(--text-muted)'
  return <div style={{ fontSize: '0.74rem', lineHeight: 1.5 }}><span style={{ color, fontWeight: 800 }}>{mark}</span> <b>{c.id}</b> <span style={{ color: 'var(--text-muted)' }}>{c.detail}</span></div>
}

const EXIT: Record<string, string> = { tp1: 'took half the profit', trail: 'trailing stop', stop: 'stop loss', time: 'time stop', safety: 'failed a safety check' }

function PositionRow({ p, navigate }: { p: BotPosition; navigate: (p: Page) => void }) {
  const sold = p.fills.filter(f => f.reason !== 'entry')
  const pnlPct = p.pnlUsd !== null ? (p.pnlUsd / p.sizeUsd) * 100 : null
  return (
    <div className="reward-row" style={{ flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <button className="link-btn" onClick={() => navigate({ name: 'argus', address: p.token, pool: '' })} style={{ textDecoration: 'none' }}>${p.symbol}</button>
        <Pill color={p.strategy === 'snipe' ? '#3b82f6' : '#a855f7'}>{T(STRATEGY[p.strategy])}</Pill>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}><AgoText ts={p.openedAt} /></span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: '0.76rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>{T('in')} {price(p.marketEntry)} · {usd(p.sizeUsd, 0)}</span>
        {sold.length > 0 && <span>{T('sold')} {sold.map(f => price(f.price)).join(', ')}</span>}
        {p.status === 'closed'
          ? <b style={{ color: (p.pnlUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(p.pnlUsd)} ({pnlPct! >= 0 ? '+' : ''}{pnlPct!.toFixed(0)}%) · {T(EXIT[p.exitReason ?? ''] ?? p.exitReason ?? '')}</b>
          : <span style={{ color: 'var(--text)' }}>{p.tp1Done ? T('half taken, trailing') : T('open')}</span>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 800, marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, sub, color, small }: { label: string; value: string; sub?: string; color?: string; small?: boolean }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: small ? '0.9rem' : '1.15rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: '0.64rem', fontWeight: 800, padding: '2px 7px', borderRadius: 999, color, border: `1px solid ${color}55`, background: `${color}18`, whiteSpace: 'nowrap' }}>{children}</span>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '22px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5 }}>{children}</div>
}
