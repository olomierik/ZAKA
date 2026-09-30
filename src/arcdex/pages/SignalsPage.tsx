// Autotrade (/autotrade; /signals still works): the market engine's signal
// bot, for everyone (engine/src/bot).
//
//   My autotrade  a paper account on the engine for this browser: deposit
//                 virtual USDC, pick one or more strategies, Start; it trades
//                 every matching signal, with the bot's exits, 24/7
//   Scanner       every coin being scanned, live, and why it isn't a signal
//                 (rules not met yet, a failed safety check)
//   Signals       the signals, with every check behind them
//   Bot results   the bot's own paper and live results, and the owner's
//                 live switch (a signed message)
//
// A strip at the top shows the scanner working (the `scan` channel, every 2s).
// The numbers are measured results, never a promise.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import type { BotControl, BotPosition, BotStatus, LearnNote, NewPaperAccount, PaperAccountView, PaperAction, SafetyCheck, ScanRow, ScanStats, TradeSignal } from '../../../api/_marketProtocol'
import { getLaunchpadColor } from '../api/radardex'
import { createPaperAccount, engineEnabled, getBotPositions, getBotStats, getBotStatus, getPaperAccount, getPaperTrades, getScan, getSignals, marketStream, paperAction, paperKey, sendBotControl, type BotStats, type BotStatsResponse } from '../api/marketStream'
import { AgoText } from '../components/Ago'
import type { Page } from '../App'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { t as T } from '../lib/i18n'
import { shortAddr, useEmbeddedAddress } from '../lib/identity'

type Tab = 'all' | 'snipe' | 'scalp' | 'secondLeg'
type Strategy = TradeSignal['strategy']
type Book = 'paper' | 'live'
type View = 'mine' | 'scanner' | 'signals' | 'bot'
const EXPLORER = 'https://explorer.arc.io'
const LIVE_RED = '#ef4444'
const VIEW_KEY = 'arcdex:autotrade-view'

const usd = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const price = (n: number) => n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`
const big = (n: number | null) => n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const STRATEGY: Record<TradeSignal['strategy'], string> = { snipe: 'Snipe', scalp: 'Fast scalp', 'second-leg': 'Second leg' }
const STRATEGY_COLOR: Record<TradeSignal['strategy'], string> = { snipe: '#3b82f6', scalp: '#f59e0b', 'second-leg': '#a855f7' }
const STRATEGY_HELP: Record<TradeSignal['strategy'], string> = {
  snipe: 'New coins in their first 10 minutes that pass every safety check and show real buying. Sold in full at the take-profit (+40% to start), aiming for $1–4 a trade.',
  scalp: 'Quick in and out for $1–2: bursts of real buying on any safe coin, and new coins with a risk flag. Sold in full at +15% to start, −10% stop, out within 10 minutes, and at once if the creator sells.',
  'second-leg': 'Coins that ran 10× or more, fell 50–85% and are climbing back on real buying. Sold in full at the take-profit (+35% to start), held up to 6 hours.',
}
/** A bot's name: as the engine checks it (bot/paperAccounts.ts cleanName). */
const BOT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,22}[\p{L}\p{N}.]$/u
const LEARN_KIND: Record<LearnNote['kind'], string> = { tighten: 'Tightened', loosen: 'Loosened', exit: 'New exit', revert: 'Rolled back' }
const LEARN_COLOR: Record<LearnNote['kind'], string> = { tighten: '#a78bfa', loosen: '#38bdf8', exit: '#22c55e', revert: '#f59e0b' }
const SCAN_STATUS: Record<ScanRow['status'], [string, string]> = {
  new: ['New', '#64748b'], watching: ['Watching', '#3b82f6'], checking: ['Checking', '#f59e0b'], rejected: ['Rejected', '#ef4444'], signal: ['Signal', '#22c55e'],
}

export default function SignalsPage({ navigate }: { navigate: (p: Page) => void }) {
  const [stats, setStats] = useState<BotStatsResponse | null>(null)
  const [signals, setSignals] = useState<TradeSignal[]>([])
  const [positions, setPositions] = useState<BotPosition[]>([])
  const [scan, setScan] = useState<{ rows: ScanRow[]; stats: ScanStats } | null>(null)
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [down, setDown] = useState(false)
  const [view, setViewState] = useState<View>(() => { try { return (localStorage.getItem(VIEW_KEY) as View) || 'mine' } catch { return 'mine' } })
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage blocked */ } }

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    // Engines from before these features lack some endpoints: the page shows what it gets.
    const load = () => Promise.all([getBotStats(), getSignals(100), getBotPositions('all', 200), getBotStatus().catch(() => null), getScan(200).catch(() => null)])
      .then(([s, sig, pos, st, sc]) => { if (!alive) return; setStats(s); setSignals(sig); setPositions(pos); setStatus(st); if (sc) setScan(sc); setDown(false) })
      .catch(() => { if (alive) setDown(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    const offSignals = marketStream.subscribe({ channel: 'signals' }, m => {
      if (m.t === 'SIGNAL') setSignals(list => [m.d, ...list.filter(x => x.id !== m.d.id)].slice(0, 100))
      if (m.t === 'BOT_POSITION') setPositions(list => [m.d, ...list.filter(x => x.id !== m.d.id)])
    })
    // The scanner, live: what changed every 2s.
    const offScan = marketStream.subscribe({ channel: 'scan' }, m => {
      if (m.t !== 'SCAN') return
      setScan(prev => {
        const byToken = new Map((prev?.rows ?? []).map(r => [r.token, r]))
        for (const r of m.d.rows) byToken.set(r.token, r)
        return { rows: [...byToken.values()].sort((a, b) => b.at - a.at).slice(0, 400), stats: m.d.stats }
      })
    })
    return () => { alive = false; clearInterval(id); offSignals(); offScan() }
  }, [])

  const mode = status?.mode ?? stats?.mode ?? 'paper'
  const VIEWS: [View, string][] = [['mine', T('My autotrade')], ['scanner', T('Scanner')], ['signals', T('Signals')], ['bot', T('Bot results')]]

  return (
    <div className="token-page content-page">
      <h2 className="page-h" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        ⚡ {T('Autotrade')}
        {engineEnabled && !down && stats && <ModeBadge mode={mode} />}
      </h2>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {T('Autotrade scans every new coin on every Arc launchpad, rejects the unsafe ones and trades the rest with the strategies you choose. Start with virtual USDC: paper trading, no money moves.')}
      </div>

      {!engineEnabled || down ? (
        <Empty>{T("The signal engine isn't reachable right now. Signals and results appear here when it's back.")}</Empty>
      ) : (
        <>
          <ScanStrip stats={scan?.stats ?? null} />
          <div style={{ display: 'flex', gap: 4, marginTop: 14, borderBottom: '1px solid var(--adx-card-border)', overflowX: 'auto' }}>
            {VIEWS.map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} style={{ padding: '9px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${view === k ? 'var(--adx-accent)' : 'transparent'}`, color: view === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 800, fontSize: '0.84rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {l}{k === 'scanner' && scan ? ` · ${scan.stats.watching}` : k === 'signals' && signals.length ? ` · ${signals.length}` : ''}
              </button>
            ))}
          </div>
          {view === 'mine' && <MyAutotrade navigate={navigate} />}
          {view === 'scanner' && <ScannerPanel scan={scan} navigate={navigate} />}
          {view === 'signals' && (
            <Section title={T('Live signals')}>
              {signals.length === 0 ? <Empty>{T('No signals yet. Most launches fail a safety check; a signal appears the moment one passes them all.')}</Empty>
                : signals.map(s => <SignalRow key={s.id} s={s} navigate={navigate} />)}
            </Section>
          )}
          {view === 'bot' && <BotResults stats={stats} positions={positions} status={status} onStatus={setStatus} navigate={navigate} />}
        </>
      )}
      <div style={{ marginTop: 16, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', fontSize: '0.74rem', color: '#fcd34d', lineHeight: 1.45 }}>
        {T('These are measured results, not a promise: no strategy can guarantee a win rate, and most new coins go to zero. Not financial advice.')}
      </div>
    </div>
  )
}

/** The scanner working: coins watched, checks a minute, the last check (counting up), today's signals and rejections. */
function ScanStrip({ stats }: { stats: ScanStats | null }) {
  const live = !!stats?.lastEvalAt && Date.now() - stats.lastEvalAt < 120_000
  return (
    <div className="at-strip">
      <span className={`at-dot${live ? ' on' : ''}`} />
      {stats ? (
        <>
          <span><b>{T('Scanning {n} coins', { n: stats.watching.toLocaleString() })}</b></span>
          <span>{T('{n} checks/min', { n: stats.evalsPerMin })}</span>
          {stats.lastEvalAt && <span>{T('last check')} <AgoText ts={stats.lastEvalAt} /></span>}
          <span style={{ color: '#86efac' }}>{T('{n} signals today', { n: stats.signals24h })}</span>
          <span style={{ color: '#fca5a5' }}>{T('{n} rejected today', { n: stats.rejected24h })}</span>
        </>
      ) : <span>{T('Connecting to the scanner…')}</span>}
    </div>
  )
}

function ScannerPanel({ scan, navigate }: { scan: { rows: ScanRow[]; stats: ScanStats } | null; navigate: (p: Page) => void }) {
  const [filter, setFilter] = useState<ScanRow['status'] | 'all'>('all')
  const rows = useMemo(() => (scan?.rows ?? []).filter(r => filter === 'all' || r.status === filter).slice(0, 150), [scan, filter])
  const by = scan?.stats.byStatus
  const chips: [ScanRow['status'] | 'all', string, number | undefined][] = [
    ['all', T('All'), scan?.stats.watching], ['signal', T('Signals'), by?.signal], ['rejected', T('Rejected'), by?.rejected],
    ['checking', T('Checking'), by?.checking], ['watching', T('Watching'), by?.watching], ['new', T('New'), by?.new],
  ]
  return (
    <Section title={T('Every coin being scanned, and why')}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 4px' }}>
        {chips.map(([k, l, n]) => (
          <button key={k} onClick={() => setFilter(k)} className={`at-chip${filter === k ? ' on' : ''}`}>{l}{n !== undefined ? ` ${n}` : ''}</button>
        ))}
      </div>
      {rows.length === 0 ? <Empty>{scan ? T('No coins here right now.') : T('Connecting to the scanner…')}</Empty> : rows.map(r => {
        const [label, color] = SCAN_STATUS[r.status]
        return (
          <div key={r.token} className="at-scan-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              <button className="link-btn" onClick={() => navigate({ name: 'argus', address: r.token, pool: '' })} style={{ textDecoration: 'none', fontWeight: 800 }}>${r.symbol}</button>
              <Pill color={getLaunchpadColor(r.launchpad)}>{r.launchpad}</Pill>
              <Pill color={color}>{T(label)}{r.status === 'signal' && r.strategy ? ` · ${T(STRATEGY[r.strategy])}` : ''}</Pill>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('launched')} <AgoText ts={r.launchedAt} /> · MC {big(r.marketCapUsd)}</span>
              {r.evals > 0 && <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{T('checked')} <AgoText ts={r.at} /></span>}
            </div>
            <div className="at-reasons">
              {r.reasons.slice(0, 3).map((x, i) => <span key={i} className={x.startsWith('✗') ? 'bad' : x.startsWith('…') ? 'wait' : ''}>{x}</span>)}
            </div>
          </div>
        )
      })}
    </Section>
  )
}

/** A new bot: its name and strategies (the engine sizes its trades). */
function CreateBot({ busy, loading, error, onCreate }: { busy: boolean; loading: boolean; error: string | null; onCreate: (bot: NewPaperAccount) => void }) {
  const [name, setName] = useState('')
  const [strategies, setStrategies] = useState<Strategy[]>(['scalp'])
  const clean = name.replace(/\s+/g, ' ').trim()
  const valid = BOT_NAME.test(clean)
  const toggle = (s: Strategy) => setStrategies(list => list.includes(s) ? list.filter(x => x !== s) : [...list, s])
  return (
    <div className="at-card at-hero">
      <div className="at-hero-title">{T('Create your Autotrade bot')}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {T('Name it, pick its strategies and fund it with virtual USDC. It sizes every trade itself to lock in $1–4 (fast scalps $1–2), gets out of rugs at once and learns from its losing trades. It keeps trading with this page closed. No wallet or real money needed.')}
      </div>
      <div className="at-label">{T('Bot name')}</div>
      <input className="at-input at-name" value={name} maxLength={24} placeholder={T('e.g. Night Owl')} onChange={e => setName(e.target.value)} aria-label={T('Bot name')} />
      {name && !valid && <div style={{ fontSize: '0.72rem', color: '#fca5a5', marginTop: 4 }}>{T('2–24 letters, digits or spaces.')}</div>}
      <div className="at-label">{T('Strategies')} <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {T('use one, or several at once')}</span></div>
      <StrategyPicker selected={strategies} disabled={busy} onToggle={toggle} />
      <button className="at-big" disabled={busy || loading || !valid || !strategies.length} onClick={() => onCreate({ name: clean, strategies })}>{busy || loading ? T('Loading…') : `🤖 ${T('Create my bot')}`}</button>
      {error && <div className="at-error">⚠ {error}</div>}
    </div>
  )
}

function StrategyPicker({ selected, disabled, onToggle }: { selected: Strategy[]; disabled: boolean; onToggle: (s: Strategy) => void }) {
  return (
    <div className="at-strats">
      {(['scalp', 'snipe', 'second-leg'] as const).map(s => {
        const on = selected.includes(s)
        return (
          <button key={s} className={`at-strat${on ? ' on' : ''}`} style={{ borderColor: on ? STRATEGY_COLOR[s] : undefined }} disabled={disabled} onClick={() => onToggle(s)} aria-pressed={on}>
            <span className="at-strat-head"><span className="at-check" style={{ background: on ? STRATEGY_COLOR[s] : 'transparent', borderColor: STRATEGY_COLOR[s] }}>{on ? '✓' : ''}</span>{T(STRATEGY[s])}</span>
            <span className="at-strat-help">{T(STRATEGY_HELP[s])}</span>
          </button>
        )
      })}
    </div>
  )
}

/** This browser's bot: named, its strategies and virtual USDC; it sizes its own trades, gets out of rugs and learns from its losses. */
function MyAutotrade({ navigate }: { navigate: (p: Page) => void }) {
  const [key, setKey] = useState<string | null>(() => paperKey())
  const [acct, setAcct] = useState<PaperAccountView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('1000')
  const [resetting, setResetting] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [logTab, setLogTab] = useState<'activity' | 'skipped'>('activity')

  useEffect(() => {
    if (!key) return
    let alive = true
    const load = () => getPaperAccount(key).then(a => { if (alive) { setAcct(a); setError(null) } }).catch((e: Error) => { if (!alive) return; if (!paperKey()) { setKey(null); setAcct(null) } else setError(e.message) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 5_000)
    return () => { alive = false; clearInterval(id) }
  }, [key])

  const act = async (a: PaperAction) => {
    if (!key) return
    setBusy(true); setError(null)
    try { setAcct(await paperAction(key, a)) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const create = async (bot: NewPaperAccount) => {
    setBusy(true); setError(null)
    try { const a = await createPaperAccount(bot); setAcct(a); setKey(paperKey()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (!key || !acct) return <CreateBot busy={busy} loading={!!key && !acct} error={error} onCreate={b => void create(b)} />

  const pnl = acct.equity - acct.deposited
  const open = acct.positions.filter(p => p.status === 'open')
  const toggle = (s: Strategy) => {
    const next = acct.strategies.includes(s) ? acct.strategies.filter(x => x !== s) : [...acct.strategies, s]
    if (next.length) void act({ action: 'strategies', strategies: next })
    else setError(T('Keep at least one strategy.'))
  }
  // Older engines don't send these yet: the page shows what it gets.
  const tuning = acct.tuning as PaperAccountView['tuning'] | undefined
  const prot = acct.protections as PaperAccountView['protections'] | undefined
  const paused = prot?.pausedUntil ?? null
  const cleanRename = renaming?.replace(/\s+/g, ' ').trim() ?? ''

  return (
    <>
      <div className="at-card" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`at-run${acct.running ? ' on' : ''}`}>{acct.running ? `● ${T('Running')}` : T('Stopped')}</span>
          {renaming === null ? (
            <>
              <b className="at-bot-name">🤖 {acct.name ?? T('My bot')}</b>
              <button className="link-btn" style={{ fontSize: '0.72rem' }} onClick={() => setRenaming(acct.name ?? '')} aria-label={T('Rename')}>✎ {T('Rename')}</button>
            </>
          ) : (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input className="at-input at-name" value={renaming} maxLength={24} autoFocus onChange={e => setRenaming(e.target.value)} aria-label={T('Bot name')} />
              <button className="btn-ghost" disabled={busy || !BOT_NAME.test(cleanRename)} onClick={() => { void act({ action: 'rename', name: cleanRename }); setRenaming(null) }}>{T('Save')}</button>
              <button className="link-btn" onClick={() => setRenaming(null)}>{T('Cancel')}</button>
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('Paper account')} {acct.id} · {T('virtual USDC')}</span>
          {acct.running && acct.startedAt && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>· {T('started')} <AgoText ts={acct.startedAt} /></span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginTop: 10 }}>
          <Stat label={T('Account value')} value={usd(acct.equity)} />
          <Stat label={T('Cash')} value={usd(acct.cash)} sub={T('{v} in open trades', { v: usd(acct.openValue) })} />
          <Stat label={T('Profit / loss')} value={usd(pnl)} color={pnl >= 0 ? 'var(--green)' : '#fca5a5'} sub={T('on {d} deposited', { d: usd(acct.deposited, 0) })} />
          <Stat label={T('Win rate')} value={acct.stats.winRate === null ? '—' : `${(acct.stats.winRate * 100).toFixed(0)}%`} sub={T('{w} won · {l} lost', { w: acct.stats.wins, l: acct.stats.losses })} />
        </div>
        {paused && <div className="at-note warn">⏸ {T('Paused after {n} losses in a row: no new trades until {t} while it learns from them.', { n: prot!.pauseAfterLosses, t: new Date(paused).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</div>}

        <div className="at-label">{T('Deposit virtual USDC')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {[100, 1_000, 10_000].map(v => <button key={v} className="at-chip" disabled={busy} onClick={() => void act({ action: 'deposit', amount: v })}>+{usd(v, 0)}</button>)}
          <input className="at-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
          <button className="btn-ghost" disabled={busy || !Number(amount)} onClick={() => void act({ action: 'deposit', amount: Number(amount) })}>{T('Deposit')}</button>
        </div>

        <div className="at-label">{T('Strategies')} <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {T('use one, or several at once')}</span></div>
        <StrategyPicker selected={acct.strategies} disabled={busy} onToggle={toggle} />

        <div className="at-label">{T('Trade size: automatic')}</div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {T('You don\'t set an amount: each trade is the smallest that locks in its profit target after fees and price impact, and is sold in full there. A pool too thin to pay it is skipped.')}
        </div>
        {tuning && acct.strategies.map(s => <TuningLine key={s} s={s} t={tuning[s]} range={acct.targets?.[s] ?? null} />)}

        <button className={`at-big${acct.running ? ' stop' : ''}`} disabled={busy} onClick={() => void act({ action: acct.running ? 'stop' : 'start' })}>
          {acct.running ? `■ ${T('Stop trading')}` : `▶ ${T('Start trading')}`}
        </button>
        {!acct.running && acct.cash < 5 && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>{T('Deposit virtual USDC first.')}</div>}
        {error && <div className="at-error">⚠ {error}</div>}
      </div>

      <Section title={T('What {name} learned', { name: acct.name ?? T('your bot') })}>
        {!acct.learnLog?.length ? <Empty>{T('Nothing yet. After a few closed trades it reads the losing ones and adjusts its filters and take-profit; every change is shown here with the reason, and a change that does worse is rolled back.')}</Empty>
          : acct.learnLog.map((n, i) => (
            <div key={`${n.at}:${i}`} className="at-learn">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill color={STRATEGY_COLOR[n.strategy]}>{T(STRATEGY[n.strategy])} · v{n.version}</Pill>
                <Pill color={LEARN_COLOR[n.kind]}>{T(LEARN_KIND[n.kind])}</Pill>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}><AgoText ts={n.at} /></span>
              </div>
              <div style={{ fontSize: '0.76rem', lineHeight: 1.45, marginTop: 3 }}>{n.text}</div>
            </div>
          ))}
      </Section>

      {prot && (
        <Section title={T('Protection')}>
          <ul className="at-protect">
            <li>🛡 {T('Rug guard: out at once when liquidity is pulled, an early insider or a whale dumps, the price crashes on heavy selling, or the creator sells.')}</li>
            <li>⏸ {T('Pauses new trades for 30 minutes after {n} losses in a row (now {s} in a row).', { n: prot.pauseAfterLosses, s: prot.lossStreak })}</li>
            <li>📉 {T('Daily loss limit {l}: no new trades after it until tomorrow (UTC). Today: {t}.', { l: usd(prot.dailyLossLimitUsd, 0), t: usd(prot.todayPnlUsd) })}</li>
            <li>🛑 {T('Stops if the account falls {p}% below what was deposited.', { p: prot.stopBelowPct })}</li>
          </ul>
        </Section>
      )}

      <Section title={T('Open trades') + ` · ${open.length}`}>
        {open.length === 0 ? <Empty>{acct.running ? T('Waiting for the next signal. The scanner above shows what it is checking.') : T('No open trades.')}</Empty> : open.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
      </Section>
      <TradeLog paperKey={key} name={acct.name ?? 'bot'} total={acct.tradesLogged ?? acct.stats.closed} fallback={acct.positions.filter(p => p.status === 'closed')} navigate={navigate} />
      {acct.events && (
        <Section title={T('Activity')}>
          <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
            <button className={`at-chip${logTab === 'activity' ? ' on' : ''}`} onClick={() => setLogTab('activity')}>{T('What it did')}</button>
            <button className={`at-chip${logTab === 'skipped' ? ' on' : ''}`} onClick={() => setLogTab('skipped')}>{T('Signals it passed over')} {acct.skips?.length ? acct.skips.length : ''}</button>
          </div>
          {(logTab === 'activity' ? acct.events : acct.skips ?? []).length === 0 ? <Empty>{T('Nothing yet.')}</Empty>
            : (logTab === 'activity' ? acct.events : acct.skips ?? []).map((e, i) => (
              <div key={`${e.at}:${i}`} className={`at-event ${e.kind}`}>
                <span className="at-event-at"><AgoText ts={e.at} /></span>
                {e.symbol && e.token ? <button className="link-btn" onClick={() => navigate({ name: 'argus', address: e.token!, pool: '' })} style={{ textDecoration: 'none', fontWeight: 800 }}>${e.symbol}</button> : null}
                <span>{e.text}</span>
              </div>
            ))}
        </Section>
      )}
      <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {resetting ? (
          <>{T('Start over with an empty account? Its trade log is kept.')}{' '}
            <button className="link-btn" onClick={() => { void act({ action: 'reset' }); setResetting(false) }}>{T('Yes, reset it')}</button>{' · '}
            <button className="link-btn" onClick={() => setResetting(false)}>{T('Cancel')}</button></>
        ) : <button className="link-btn" onClick={() => setResetting(true)}>{T('Reset my paper account')}</button>}
      </div>
    </>
  )
}

const pctMove = (m: number) => `${m >= 1 ? '+' : '−'}${Math.abs(Math.round((m - 1) * 100))}%`

/** One strategy's settings: its size now, exits, target, what it learned to filter, and its record. */
function TuningLine({ s, t, range }: { s: Strategy; t: PaperAccountView['tuning'][Strategy]; range: [number, number] | null }) {
  const f = t.filters
  const learned = [
    f.minLiquidityUsd > 1_000 && T('liquidity ≥ {v}', { v: big(f.minLiquidityUsd) }),
    f.minBuyers > 0 && T('≥ {v} buyers', { v: f.minBuyers }),
    f.minBuySellRatio > 0 && T('buys ≥ {v}× sells', { v: f.minBuySellRatio }),
    f.maxRunUp < 100 && T('not up more than {v}', { v: pctMove(f.maxRunUp) }),
    f.minScore > 0 && T('safety score ≥ {v}', { v: f.minScore }),
    f.maxTopBuyerPct < 100 && T('largest buyer ≤ {v}%', { v: Math.round(f.maxTopBuyerPct) }),
    f.avoidFlags.length > 0 && T('skips {v}', { v: f.avoidFlags.map(x => `“${x}”`).join(', ') }),
  ].filter(Boolean)
  return (
    <div className="at-tune">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])} · v{t.version}</Pill>
        <b style={{ fontFamily: 'var(--mono)' }}>{t.sizeUsd === null ? '—' : T('about {v} a trade', { v: usd(t.sizeUsd) })}</b>
        {t.closed > 0 && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('{n} trades, {w} won', { n: t.closed, w: t.winRate === null ? '—' : `${Math.round(t.winRate * 100)}%` })}</span>}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
        {T('Sells all at {tp} to make {target}{range} · stop {sl} · out after {m} min unless moving, {x} min at most', {
          tp: pctMove(t.takeProfit), target: usd(t.targetUsd), range: range ? ` (${T('aims {a}–{b}', { a: `$${range[0]}`, b: `$${range[1]}` })})` : '',
          sl: pctMove(t.stopLoss), m: t.timeStopMin, x: t.maxHoldMin,
        })}
      </div>
      {learned.length > 0 && <div style={{ fontSize: '0.72rem', color: '#c4b5fd', marginTop: 2 }}>{T('Learned:')} {learned.join(' · ')}</div>}
    </div>
  )
}

/** Every closed trade the bot has made (the engine keeps them all), newest first, with a CSV download. */
function TradeLog({ paperKey: key, name, total, fallback, navigate }: { paperKey: string; name: string; total: number; fallback: BotPosition[]; navigate: (p: Page) => void }) {
  const [trades, setTrades] = useState<BotPosition[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getPaperTrades(key, 50).then(r => { if (alive) { setTrades(r.trades); setMore(r.trades.length < r.total); setError(null) } })
      .catch(() => { if (alive) { setTrades(null); setMore(false) } }) // an engine without the log: the account's own list below
    return () => { alive = false }
  }, [key, total])

  const loadMore = async () => {
    if (!trades?.length) return
    setBusy(true)
    try {
      const r = await getPaperTrades(key, 100, trades[trades.length - 1].closedAt ?? undefined)
      const next = [...trades, ...r.trades.filter(t => !trades.some(x => x.id === t.id))]
      setTrades(next); setMore(r.trades.length > 0 && next.length < r.total)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const download = async () => {
    setBusy(true); setError(null)
    try {
      const all: BotPosition[] = []
      let before: number | undefined
      for (let page = 0; page < 40; page++) {
        const r = await getPaperTrades(key, 500, before)
        all.push(...r.trades)
        if (r.trades.length < 500) break
        before = r.trades[r.trades.length - 1].closedAt ?? undefined
      }
      const blob = new Blob([tradesCsv(all)], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}-trades.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const list = trades ?? fallback
  return (
    <Section title={T('Trade log') + ` · ${total}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 6px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        <span>{T('Every trade it closes is kept, with the coin\'s numbers at entry and why it closed: what it learns from.')}</span>
        {trades && trades.length > 0 && <button className="btn-ghost" disabled={busy} onClick={() => void download()}>⤓ {T('Download CSV')}</button>}
      </div>
      {list.length === 0 ? <Empty>{T('Nothing closed yet.')}</Empty> : list.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
      {more && <button className="btn-ghost" style={{ marginTop: 8 }} disabled={busy} onClick={() => void loadMore()}>{busy ? T('Loading…') : T('Load more')}</button>}
      {error && <div className="at-error">⚠ {error}</div>}
    </Section>
  )
}

/** The trade log as CSV (one row a trade, the entry numbers included). */
function tradesCsv(list: BotPosition[]): string {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const head = ['closed_at', 'opened_at', 'symbol', 'token', 'strategy', 'size_usd', 'entry_price', 'exit_reason', 'pnl_usd', 'pnl_pct', 'held_s', 'target_usd', 'tuning_version', 'liquidity_usd', 'buyers', 'buy_sell_ratio', 'run_up', 'safety_score', 'flags', 'note']
  const rows = list.map(p => [
    p.closedAt ? new Date(p.closedAt).toISOString() : '', new Date(p.openedAt).toISOString(), p.symbol, p.token, p.strategy, p.sizeUsd.toFixed(2), p.marketEntry,
    p.exitReason, p.pnlUsd?.toFixed(4), p.pnlUsd !== null ? ((p.pnlUsd / p.sizeUsd) * 100).toFixed(2) : '', p.closedAt ? Math.round((p.closedAt - p.openedAt) / 1000) : '',
    p.targetUsd, p.tuningVersion, p.features?.liquidityUsd, p.features?.buyers, p.features?.buySellRatio, p.features?.runUp, p.features?.score, p.features?.flags.join(' '), p.note,
  ].map(cell).join(','))
  return [head.join(','), ...rows].join('\n')
}

/** The bot's own results (paper and live), its positions, and the owner's panel. */
function BotResults({ stats, positions, status, onStatus, navigate }: { stats: BotStatsResponse | null; positions: BotPosition[]; status: BotStatus | null; onStatus: (s: BotStatus) => void; navigate: (p: Page) => void }) {
  const [tab, setTab] = useState<Tab>('all')
  const [book, setBook] = useState<Book>('paper')
  const set = book === 'live' ? stats?.live : stats
  const shown: BotStats | null = set ? set[tab] ?? null : null
  const mine = useMemo(() => positions.filter(p => (p.mode === 'live') === (book === 'live')), [positions, book])
  const open = useMemo(() => mine.filter(p => p.status === 'open'), [mine])
  const closed = useMemo(() => mine.filter(p => p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)), [mine])
  return (
    <>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
        <b style={{ color: 'var(--text)' }}>{T('Paper trading:')}</b>{' '}{T('each signal opens a simulated position at the live price, with real costs. No money moves.')}{' '}
        <b style={{ color: LIVE_RED }}>{T('Live mode:')}</b>{' '}{T('the bot wallet also buys and sells each signal with real USDC, within hard limits.')}
      </div>
      {status && <BotPanel status={status} onStatus={onStatus} navigate={navigate} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 800 }}>{T('Results')}</span>
        <Segmented value={book} onChange={v => setBook(v as Book)} options={[['paper', T('Paper')], ['live', T('Live')]]} />
        {book === 'live' && !stats?.live && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('No live trades yet.')}</span>}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 8, borderBottom: '1px solid var(--adx-card-border)', overflowX: 'auto' }}>
        {([['all', T('All strategies')], ['snipe', T('Snipe')], ['scalp', T('Fast scalp')], ['secondLeg', T('Second leg')]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '8px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--adx-accent)' : 'transparent'}`, color: tab === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>{l}</button>
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
      <Section title={(book === 'live' ? T('Open live positions') : T('Open positions')) + ` · ${open.length}`}>
        {open.length === 0 ? <Empty>{T('No open positions.')}</Empty> : open.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
      </Section>
      <Section title={(book === 'live' ? T('Closed live positions') : T('Closed positions')) + ` · ${closed.length}`}>
        {closed.length === 0 ? <Empty>{T('Nothing closed yet.')}</Empty> : closed.slice(0, 50).map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
      </Section>
    </>
  )
}

function SignalRow({ s, navigate }: { s: TradeSignal; navigate: (p: Page) => void }) {
  const [openDetails, setOpenDetails] = useState(false)
  const passed = s.safety.checks.filter(c => c.hard && c.ok === true).length
  const risks = s.safety.checks.filter(c => c.risk && c.ok !== true)
  return (
    <div style={{ padding: '12px 4px', borderBottom: '1px solid var(--adx-card-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="link-btn" onClick={() => navigate({ name: 'argus', address: s.token, pool: '' })} style={{ fontSize: '0.95rem', textDecoration: 'none' }}>${s.symbol}</button>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
        <Pill color={getLaunchpadColor(s.launchpad)}>{s.launchpad}</Pill>
        <Pill color={STRATEGY_COLOR[s.strategy] ?? '#64748b'}>{T(STRATEGY[s.strategy] ?? s.strategy)}</Pill>
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
      {risks.length > 0 && (
        <div style={{ marginTop: 4, fontSize: '0.74rem', color: '#fcd34d', lineHeight: 1.45 }}>⚠ {T('Risky:')} {risks.map(c => c.detail).join(' · ')}</div>
      )}
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
  // A risk check that didn't pass is a warning (the coin is traded small), not a failure.
  const mark = c.ok === true ? '✓' : c.risk ? '⚠' : c.ok === false ? '✗' : '…'
  const color = c.ok === true ? '#86efac' : c.risk ? '#fcd34d' : c.ok === false ? '#fca5a5' : 'var(--text-muted)'
  return <div style={{ fontSize: '0.74rem', lineHeight: 1.5 }}><span style={{ color, fontWeight: 800 }}>{mark}</span> <b>{c.id}</b> <span style={{ color: 'var(--text-muted)' }}>{c.detail}</span></div>
}

const EXIT: Record<string, string> = { tp1: 'took profit', trail: 'trailing stop', stop: 'stop loss', time: 'time stop', safety: 'failed a safety check', creator: 'the creator sold', rug: 'rug guard', manual: 'sold by the owner' }

function PositionRow({ p, navigate }: { p: BotPosition; navigate: (p: Page) => void }) {
  const sold = p.fills.filter(f => f.reason !== 'entry')
  const pnlPct = p.pnlUsd !== null ? (p.pnlUsd / p.sizeUsd) * 100 : null
  return (
    <div className="reward-row" style={{ flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <button className="link-btn" onClick={() => navigate({ name: 'argus', address: p.token, pool: '' })} style={{ textDecoration: 'none' }}>${p.symbol}</button>
        <Pill color={STRATEGY_COLOR[p.strategy] ?? '#64748b'}>{T(STRATEGY[p.strategy] ?? p.strategy)}</Pill>
        {p.mode === 'live' && <Pill color={LIVE_RED}>{T('LIVE')}</Pill>}
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}><AgoText ts={p.openedAt} /></span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: '0.76rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>{T('in')} {price(p.marketEntry)} · {usd(p.sizeUsd, p.sizeUsd < 100 ? 2 : 0)}</span>
        {sold.length > 0 && <span>{T('sold')} {sold.map(f => price(f.price)).join(', ')}</span>}
        {p.status === 'closed'
          ? <b style={{ color: (p.pnlUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(p.pnlUsd)} ({pnlPct! >= 0 ? '+' : ''}{pnlPct!.toFixed(0)}%) · {T(EXIT[p.exitReason ?? ''] ?? p.exitReason ?? '')}</b>
          : <span style={{ color: 'var(--text)' }}>{p.tp1Done ? T('profit taken, trailing') : T('open')}</span>}
      </div>
      {p.status === 'closed' && p.note && <div style={{ width: '100%', fontSize: '0.72rem', color: p.exitReason === 'rug' ? '#fcd34d' : 'var(--text-muted)' }}>{p.exitReason === 'rug' ? '🛡 ' : ''}{p.note}</div>}
      {p.stuck && p.status === 'open' && <div style={{ width: '100%', fontSize: '0.72rem', color: '#fca5a5' }}>⚠ {T('Sale failing, retrying:')} {p.stuck}</div>}
      {p.txs && p.txs.length > 0 && (
        <div style={{ width: '100%', display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: '0.7rem' }}>
          {p.txs.map(tx => (
            <a key={tx.hash} href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>
              {T(TX_KIND[tx.kind] ?? tx.kind)}{tx.usd !== undefined ? ` ${usd(tx.usd)}` : ''} ↗
            </a>
          ))}
          {p.gasUsd !== undefined && <span style={{ color: 'var(--text-muted)' }}>{T('gas')} {usd(p.gasUsd, 3)}</span>}
        </div>
      )}
    </div>
  )
}

const TX_KIND: Record<string, string> = { buy: 'buy', sell: 'sell', approve: 'approval' }

function ModeBadge({ mode }: { mode: BotStatus['mode'] }) {
  const live = mode === 'live'
  return (
    <span style={{ fontSize: '0.66rem', fontWeight: 900, letterSpacing: 0.6, padding: '3px 9px', borderRadius: 999, color: live ? '#fff' : 'var(--text-muted)', background: live ? LIVE_RED : 'transparent', border: `1px solid ${live ? LIVE_RED : 'var(--adx-card-border)'}` }}>
      {live ? `● ${T('LIVE')}` : mode === 'off' ? T('OFF') : T('PAPER')}
    </span>
  )
}

function Segmented({ value, onChange, options, disabled }: { value: string; onChange: (v: string) => void; options: [string, string][]; disabled?: boolean }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--adx-card-border)', borderRadius: 999, padding: 2, opacity: disabled ? 0.6 : 1 }}>
      {options.map(([v, l]) => (
        <button key={v} disabled={disabled} onClick={() => onChange(v)} style={{ padding: '4px 12px', borderRadius: 999, border: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: '0.74rem', fontWeight: 800, background: value === v ? (v === 'live' ? LIVE_RED : 'var(--adx-accent)') : 'transparent', color: value === v ? '#fff' : 'var(--text-muted)' }}>{l}</button>
      ))}
    </div>
  )
}

/** The owner's wallet, if this browser has it (the trading wallet or a connected one), and a way to sign with it. */
function useOwnerSigner(owner: string | null) {
  const embedded = useEmbeddedAddress()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const o = owner?.toLowerCase()
  const which = !o ? null : embedded?.toLowerCase() === o ? 'embedded' : address?.toLowerCase() === o ? 'connected' : null
  const sign = useCallback(async (message: string) => {
    if (which === 'embedded') return getEmbeddedWalletClient().signMessage({ message })
    return signMessageAsync({ message })
  }, [which, signMessageAsync])
  return which ? sign : null
}

function BotPanel({ status, onStatus }: { status: BotStatus; onStatus: (s: BotStatus) => void; navigate: (p: Page) => void }) {
  const sign = useOwnerSigner(status.owner)
  const [confirm, setConfirm] = useState<BotControl | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const l = status.live

  const run = async (c: BotControl) => {
    if (!sign) return
    setBusy(true); setError(null)
    try { onStatus(await sendBotControl(c, sign)); setConfirm(null) }
    catch (e) { setError((e as Error).message?.split('\n')[0] ?? String(e)) }
    finally { setBusy(false) }
  }
  const choose = (m: string) => {
    if (m === status.mode) return
    if (m === 'live') setConfirm({ action: 'mode', mode: 'live' })
    else void run({ action: 'mode', mode: 'paper' })
  }

  return (
    <div style={{ marginTop: 16, background: 'var(--adx-card-bg)', border: `1px solid ${status.mode === 'live' ? LIVE_RED + '66' : 'var(--adx-card-border)'}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 800 }}>{T('Trading mode')}</span>
        <Segmented value={status.mode} onChange={choose} disabled={!sign || busy || status.mode === 'off'} options={[['paper', T('Paper')], ['live', T('Live')]]} />
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {status.mode === 'live' ? T('Signals are traded with real money from the bot wallet.') : status.mode === 'off' ? T('The bot is off on this engine.') : T('Signals open simulated positions. No money moves.')}
        </span>
      </div>
      {!sign && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{status.owner ? T("Only the owner's wallet can switch modes.") : T('No owner wallet is set on the engine, so the mode can\'t be switched here.')}</div>}

      {confirm?.action === 'mode' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', fontSize: '0.76rem', lineHeight: 1.5 }}>
          <b>{T('Switch to live trading?')}</b>{' '}
          {T('From now on the bot buys and sells every signal it can reach with the bot wallet\'s USDC. Trades can lose money, and most new coins go to zero.')}
          {l.limits && <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{limitsText(l.limits)}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>{T('Cancel')}</button>
            <button disabled={busy} onClick={() => void run(confirm)} style={{ background: LIVE_RED, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontWeight: 800, cursor: 'pointer' }}>{busy ? T('Waiting for your signature…') : T('Sign and go live')}</button>
          </div>
        </div>
      )}
      {error && <div style={{ marginTop: 8, fontSize: '0.74rem', color: '#fca5a5' }}>⚠ {error}</div>}

      {l.available ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
            <Stat label={T('Bot wallet')} value={l.wallet ? shortAddr(l.wallet) : '—'} small sub={l.wallet ? undefined : ''} href={l.wallet ? `${EXPLORER}/address/${l.wallet}` : undefined} />
            <Stat label={T('Balance')} value={usd(l.balanceUsd)} small sub={T('USDC on Arc')} />
            <Stat label={T('Live P&L today')} value={usd(l.todayPnlUsd)} small color={l.todayPnlUsd >= 0 ? 'var(--green)' : '#fca5a5'} />
            <Stat label={T('Live positions open')} value={String(l.open)} small />
          </div>
          {l.limits && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>{limitsText(l.limits)}</div>}
          {sign && l.open > 0 && (
            confirm?.action === 'close-live'
              ? <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.76rem' }}>
                  {T('Sell all {n} live positions now, at any price the pools give?', { n: l.open })}
                  <button className="btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>{T('Cancel')}</button>
                  <button disabled={busy} onClick={() => void run({ action: 'close-live' })} style={{ background: LIVE_RED, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontWeight: 800, cursor: 'pointer' }}>{busy ? T('Waiting for your signature…') : T('Sign and sell all')}</button>
                </div>
              : <button onClick={() => setConfirm({ action: 'close-live' })} style={{ marginTop: 8, background: 'transparent', color: LIVE_RED, border: `1px solid ${LIVE_RED}88`, borderRadius: 8, padding: '5px 12px', fontWeight: 800, fontSize: '0.74rem', cursor: 'pointer' }}>{T('Sell all live positions')}</button>
          )}
          {l.events.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', marginBottom: 2 }}>{T('Live activity')}</div>
              {l.events.slice(0, 8).map((e, i) => (
                <div key={i} style={{ fontSize: '0.72rem', lineHeight: 1.6, color: e.kind === 'error' ? '#fca5a5' : e.kind === 'skip' ? 'var(--text-muted)' : 'var(--text)' }}>
                  <span style={{ color: 'var(--text-muted)' }}><AgoText ts={e.at} /></span> · {e.text}
                  {e.hash && <> · <a href={`${EXPLORER}/tx/${e.hash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>tx ↗</a></>}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          {sign ? T('Live trading needs a bot wallet on the engine: set BOT_PRIVATE_KEY (a new wallet that holds only what the bot may trade) in Railway, then fund it with USDC on Arc.') : T('Live trading is not set up on this engine.')}
        </div>
      )}
    </div>
  )
}

function limitsText(x: NonNullable<BotStatus['live']['limits']>): string {
  return T('Limits: up to ${a} a trade · {o} open at once ({s} scalps) · stops for the day after a ${d} loss · keeps ${r} for gas · buys at most {b}% under the quote', { a: x.maxTradeUsd, o: x.maxOpen, s: x.maxOpenScalp, d: x.dailyLossUsd, r: x.reserveUsd, b: x.slippageBps / 100 })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 800, marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, sub, color, small, href }: { label: string; value: string; sub?: string; color?: string; small?: boolean; href?: string }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: small ? '0.9rem' : '1.15rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {href ? <a href={href} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{value} ↗</a> : value}
      </div>
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
