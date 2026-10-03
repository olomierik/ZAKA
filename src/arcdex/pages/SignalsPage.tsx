// Autotrade (/autotrade; /signals still works): the market engine's signal
// bot, for everyone (engine/src/bot).
//
//   My bots       sign up with an email and a 4-character passcode, then
//                 create bots (each name unique on ARCSENSE), deposit virtual
//                 USDC, pick strategies, Start: they trade on the engine 24/7
//                 with every device off. Once a bot's paper record is good
//                 enough, its owner switches the same bot to LIVE: its own
//                 wallet trades real USDC (15% of each winning trade's profit
//                 goes to the platform)
//   Marketplace   every bot, its P&L and open positions (/bots, /bots/<name>)
//   Scanner       every coin being scanned, live, and why it isn't a signal
//                 (rules not met yet, a failed safety check), and the most
//                 common reasons right now
//   Signals       the signals, with every check behind them, each graded
//                 Prime, Core or Standard, and each grade's record at live
//                 speed (engine/src/signals/grades.ts)
//   Signal engine the 100-point signal engine (engine/src/quant): every coin
//                 scored live, its signals and why, paper trades, strategy
//                 results, walk-forward validation and the live gate,
//                 smart money, and the owner's signed controls
//   Bot results   the bot's own paper and live results, and the owner's
//                 live switch (a signed message)
//
// Tiers (engine/src/bot/tiers.ts, lib/tiers.ts): what each tier gets, the
// account's own tier from the wallets it links, and "free for now" until the
// engine enforces them.
//
// A strip at the top shows the scanner working (the `scan` channel, every 2s).
// The numbers are measured results, never a promise.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import type { AccessView, BotControl, BotFilters, BotPosition, BotStatus, BotStrategy, DollarPlanView, GradeRecordView, LearnNote, StrategyTuning, MarketBot, MarketBotDetail, MeResponse, NewPaperAccount, PaperAccountView, PaperAction, RejectionStats, SafetyCheck, ScanRow, ScanStats, SignalGrade, SignalOutcomes, SignalRule, StrategyBoardEntry, StrategyBoardResponse, TeamView, TierId, TiersResponse, TradeSignal } from '../../../api/_marketProtocol'
import { getLaunchpadColor } from '../api/radardex'
import { botAction, botChangePasscode, botCreate, botForgot, botLogin, botMe, botSession, botSignOut, botSignOutAll, botSignup, botTrades, botVerify, botVerifySend, botFunders, botWithdraw, botWithdrawCode, botWithdrawPasscode, engineEnabled, getTiers, sendTierGrant, getBotPositions, getBotStats, getBotStatus, getMarket, getMarketBot, getRejections, getScan, getSignals, getStrategyBoard, marketStream, paperKey, sendBotControl, type BotStats, type BotStatsResponse, type LiveSpeedRow } from '../api/marketStream'
import { AgoText } from '../components/Ago'
import { openConnectModal } from '../components/ConnectWallet'
import { PasscodeField, useWithdrawGuard } from '../components/WithdrawGuard'
import { notifyBalances } from '../lib/balances'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { txErrorText } from '../lib/tx'
import { useCash, useSendUsdc } from '../lib/usdc'
import { cardFromAccount, cardFromMarket, ShareBotButton } from '../components/BotShare'
import SignalEnginePanel from '../components/SignalEngine'
import { profitNotifyOn, setProfitNotify } from '../components/ProfitAlerts'
import { ARCD_TIERS, GRADE_COLOR, GRADE_NAME, GRADE_TIER, STRATEGY_TIER, tierName } from '../lib/tiers'
import type { Page } from '../App'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { N_, t as T } from '../lib/i18n'
import { shortAddr, useEmbeddedAddress, useTrader } from '../lib/identity'

type Tab = 'all' | 'snipe' | 'scalp' | 'secondLeg'
type Strategy = BotStrategy
type Book = 'paper' | 'live'
type View = 'mine' | 'market' | 'scanner' | 'signals' | 'engine' | 'bot'
const EXPLORER = 'https://explorer.arc.io'
const LIVE_RED = '#ef4444'
const VIEW_KEY = 'arcdex:autotrade-view'

const usd = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const price = (n: number) => n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`
const big = (n: number | null) => n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const STRATEGY: Record<BotStrategy, string> = { snipe: 'Snipe', scalp: 'Fast scalp', 'second-leg': 'Dip rebound', precision: 'Precision' }
const STRATEGY_COLOR: Record<BotStrategy, string> = { snipe: '#3b82f6', scalp: '#f59e0b', 'second-leg': '#a855f7', precision: '#facc15' }
/** The three strategies bots trade (2026-10-01; dip rebounds are measured on paper by the engine only). */
const ALL_STRATEGIES: BotStrategy[] = ['precision', 'snipe', 'scalp']
const STRATEGY_HELP: Record<BotStrategy, string> = {
  precision: 'Prime signals only: an early crowd (10+ buyers in a coin\'s first minute, none over 20% of the buying) or a crowd momentum burst. All of it sold at +10%, −10% stop, 10 minutes at most, out at once if the creator sells.',
  snipe: 'New coins in their first 10 minutes that pass every safety check and show real buying. Half sold at +10%, then the stop moves to break-even and the rest trails 25% under its peak; −10% stop, an hour at most.',
  scalp: 'Quick in and out: bursts of real buying on any safe coin, and new coins with a risk flag. Half sold at +10%, then the stop moves to break-even and the rest trails 25% under its peak; −10% stop, an hour at most, and out at once if the creator sells.',
  'second-leg': 'Coins that ran 2× or more, pulled back 25–70% and are being bought again. Half sold at the take-profit (+35% to start), then the stop moves to break-even and the rest trails; held up to 6 hours.',
}
/** A bot's name: as the engine checks it (bot/paperAccounts.ts cleanName). */
const BOT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,22}[\p{L}\p{N}.]$/u
const LEARN_KIND: Record<LearnNote['kind'], string> = { tighten: 'Tightened', loosen: 'Loosened', exit: 'New exit', revert: 'Rolled back', team: 'From the team' }
const LEARN_COLOR: Record<LearnNote['kind'], string> = { tighten: '#a78bfa', loosen: '#38bdf8', exit: '#22c55e', revert: '#f59e0b', team: '#2dd4bf' }
const SCAN_STATUS: Record<ScanRow['status'], [string, string]> = {
  new: ['New', '#64748b'], watching: ['Watching', '#3b82f6'], checking: ['Checking', '#f59e0b'], rejected: ['Rejected', '#ef4444'], signal: ['Signal', '#22c55e'],
}

export default function SignalsPage({ navigate, view: pageView, bot, manage = false }: { navigate: (p: Page) => void; view?: 'market'; bot?: string; manage?: boolean }) {
  const [stats, setStats] = useState<BotStatsResponse | null>(null)
  const [signals, setSignals] = useState<TradeSignal[]>([])
  const [positions, setPositions] = useState<BotPosition[]>([])
  const [scan, setScan] = useState<{ rows: ScanRow[]; stats: ScanStats } | null>(null)
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [down, setDown] = useState(false)
  const [view, setViewState] = useState<View>(() => { if (manage) return 'mine'; if (pageView === 'market') return 'market'; try { return (localStorage.getItem(VIEW_KEY) as View) || 'mine' } catch { return 'mine' } })
  const setView = (v: View) => {
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage blocked */ }
    // The marketplace has its own address (/bots); leaving it goes back to /autotrade.
    if (v === 'market') navigate({ name: 'signals', view: 'market' })
    else if (pageView === 'market') navigate({ name: 'signals' })
  }
  useEffect(() => { if (pageView === 'market') setViewState('market') }, [pageView, bot])

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
  const VIEWS: [View, string][] = [['mine', T('My bots')], ['market', T('Marketplace')], ['scanner', T('Scanner')], ['signals', T('Signals')], ['engine', T('Signal engine')], ['bot', T('Bot results')]]

  return (
    <div className="token-page content-page">
      <h2 className="page-h" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        ⚡ {manage ? T('Your Autotrade bots') : T('Autotrade')}
      </h2>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {manage ? T('Autotrade is coming soon. Your bots open no new trades; manage them and withdraw your USDC here.') : T('Autotrade scans every new coin on every Arc launchpad, rejects the unsafe ones and trades the rest with the strategies you choose. Start with virtual USDC: paper trading, no money moves.')}
      </div>

      {!engineEnabled || down ? (
        <Empty>{T("The signal engine isn't reachable right now. Signals and results appear here when it's back.")}</Empty>
      ) : (
        <>
          {!manage && <ScanStrip stats={scan?.stats ?? null} />}
          {stats?.routing?.autotradePaused && (
            <div className="at-promo">
              <span className="at-promo-badge">⏸ {T('Autotrade is paused')}</span>
              <span>{T("Bots don't open new trades for now. Trades already open are still closed as usual, and you can withdraw your USDC at any time.")}</span>
            </div>
          )}
          {!manage && <div style={{ display: 'flex', gap: 4, marginTop: 14, borderBottom: '1px solid var(--adx-card-border)', overflowX: 'auto' }}>
            {VIEWS.map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} style={{ padding: '9px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${view === k ? 'var(--adx-accent)' : 'transparent'}`, color: view === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 800, fontSize: '0.84rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {l}{k === 'scanner' && scan ? ` · ${scan.stats.watching}` : k === 'signals' && signals.length ? ` · ${signals.length}` : ''}
              </button>
            ))}
          </div>}
          {view === 'mine' && <MyBots navigate={navigate} liveSpeed={stats?.routing?.liveSignals === 'all' ? undefined : stats?.liveSpeed} />}
          {view === 'market' && <Marketplace navigate={navigate} slug={bot ?? null} />}
          {view === 'scanner' && stats?.routing?.launchpadOnly && stats.routing.launchpadOnly !== 'off' && (
            <div className="at-note" style={{ marginTop: 12 }}>🛡 {T(stats.routing.launchpadOnly === 'strict'
              ? 'Launchpad coins only: a coin can become a signal only if a known Arc launchpad launched it (Argus, ARCSENSE, Mercuri, SolonPad, Peach, Faze, Aka.fun, o1, Minara, Long.supply) and it runs that launchpad\'s standard code. Coins from anywhere else are listed, never traded.'
              : 'Launchpad coins only: a coin can become a signal only if a known Arc launchpad launched it (Argus, ARCSENSE, Mercuri, SolonPad, Peach, Faze, Aka.fun, o1, Minara, Long.supply). Coins from anywhere else are listed, never traded.')}</div>
          )}
          {view === 'scanner' && <><RejectionsCard /><ScannerPanel scan={scan} navigate={navigate} /></>}
          {view === 'engine' && <SignalEnginePanel navigate={navigate} />}
          {view === 'signals' && <StrategyBoardCard />}
          {view === 'signals' && <GradesCard grades={stats?.grades} />}
          {view === 'signals' && stats?.liveSpeed && <LiveSpeedCard rows={stats.liveSpeed} all={stats.routing?.liveSignals === 'all'} />}
          {view === 'signals' && (
            <Section title={T('Live signals')}>
              <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>{T('Every signal is graded Prime, Core or Standard when it fires. A trade takes 20% of a bot\'s capital on a Prime signal, 15% on Core, 10% on Standard. When many bots take the same signal, they share it: together they never buy enough to move the price against themselves.')}</div>
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
function CreateBot({ busy, loading, error, onCreate, onCancel, team, access }: { busy: boolean; loading: boolean; error: string | null; onCreate: (bot: NewPaperAccount) => void; onCancel?: () => void; team?: TeamView; access?: AccessView | null }) {
  const [name, setName] = useState('')
  // Both by default (2026-09-30): the team's clean-coin snipes won 6 of 6, and a scalp-only bot never saw them.
  const [strategies, setStrategies] = useState<Strategy[]>(['snipe', 'scalp'])
  const clean = name.replace(/\s+/g, ' ').trim()
  const valid = BOT_NAME.test(clean)
  const toggle = (s: Strategy) => setStrategies(list => list.includes(s) ? list.filter(x => x !== s) : [...list, s])
  return (
    <div className="at-card at-hero">
      <div className="at-hero-title">{T('Create your Autotrade bot')}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {T('Name it and pick its strategies: it starts trading at once with $1,000 of virtual USDC and the team\'s best settings. Each trade is a share of what the bot is worth: 20% on a Prime signal, 15% on Core, 10% on Standard, at least $1, so even a $10 bot trades. It gets out of rugs at once and learns from its own trades and every other bot\'s. It keeps trading with this page closed. No wallet or real money needed.')}
      </div>
      <div className="at-label">{T('Bot name')}</div>
      <input className="at-input at-name" value={name} maxLength={24} placeholder={T('e.g. Night Owl')} onChange={e => setName(e.target.value)} aria-label={T('Bot name')} />
      {name && !valid && <div style={{ fontSize: '0.72rem', color: '#fca5a5', marginTop: 4 }}>{T('2–24 letters, digits or spaces.')}</div>}
      <div className="at-label">{T('Strategies')} <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {T('use one, or several at once')}</span></div>
      <StrategyPicker selected={strategies} disabled={busy} onToggle={toggle} team={team} access={access} />
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('Its name is its unique id on ARCSENSE: the marketplace shows it at /bots/<name>.')}</div>
      <button className="at-big" disabled={busy || loading || !valid || !strategies.length} onClick={() => onCreate({ name: clean, strategies })}>{busy || loading ? T('Loading…') : `🤖 ${T('Create my bot')}`}</button>
      {onCancel && <button className="link-btn" onClick={onCancel}>{T('Cancel')}</button>}
      {error && <div className="at-error">⚠ {error}</div>}
    </div>
  )
}

/** The strategies to pick from, each with the team's record on it this week when the engine sends it, and the tier a tiered one is for. */
function StrategyPicker({ selected, disabled, onToggle, team, access }: { selected: Strategy[]; disabled: boolean; onToggle: (s: Strategy) => void; team?: TeamView; access?: AccessView | null }) {
  return (
    <div className="at-strats">
      {ALL_STRATEGIES.map(s => {
        const on = selected.includes(s)
        const rec = team?.byStrategy[s]
        const tier = STRATEGY_TIER[s]
        const locked = !!access?.enforced && !access.strategies.includes(s)
        return (
          <button key={s} className={`at-strat${on ? ' on' : ''}${locked ? ' locked' : ''}`} style={{ borderColor: on ? STRATEGY_COLOR[s] : undefined }} disabled={disabled || (locked && !on)} onClick={() => onToggle(s)} aria-pressed={on}>
            <span className="at-strat-head">
              <span className="at-check" style={{ background: on ? STRATEGY_COLOR[s] : 'transparent', borderColor: STRATEGY_COLOR[s] }}>{on ? '✓' : ''}</span>{T(STRATEGY[s])}
              {tier && <span className="at-tier-tag">{locked ? '🔒 ' : ''}{T(tierName(tier))}{access?.enforced ? '' : ` · ${T('free for now')}`}</span>}
            </span>
            <span className="at-strat-help">{T(STRATEGY_HELP[s])}</span>
            <span className="at-strat-team">{rec ? T('Team, 7 days: {n} trades, {w} won, {p}', { n: rec.trades, w: rec.winRate === null ? '—' : `${Math.round(rec.winRate * 100)}%`, p: usd(rec.pnlUsd) }) : T('Team, 7 days: no trades yet')}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The signed-in owner's bots, on any device: sign in first, then one dashboard per bot. */
/** The engine's tier table and each grade's record (GET /v1/tiers), shared by every part of the page; the page's own copy until it answers. */
let tiersCache: TiersResponse | null = null
function useTiers(): TiersResponse | null {
  const [t, setT] = useState<TiersResponse | null>(tiersCache)
  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    const load = () => getTiers().then(r => { tiersCache = r; if (alive) setT(r) }).catch(() => { /* an older engine: the page's copy */ })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return t
}

/** A signal's grade, and the lowest tier that gets it. */
function GradeBadge({ g, title, tiers }: { g: SignalGrade; title?: string; tiers?: TiersResponse | null }) {
  return <span className={`at-grade ${g}`} title={title} style={{ borderColor: GRADE_COLOR[g] + '88', color: GRADE_COLOR[g] }}>{g === 'prime' ? '◆ ' : ''}{T(GRADE_NAME[g])}{g !== 'standard' ? ` · ${T(tierName(GRADE_TIER[g], tiers?.tiers))}` : ''}</span>
}

/** The strategy board (GET /v1/bot/board), shared by every part of the page and read every 20 seconds; null on an older engine. */
let boardCache: StrategyBoardResponse | null = null
function useBoard(): StrategyBoardResponse | null {
  const [b, setB] = useState<StrategyBoardResponse | null>(boardCache)
  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    const load = () => getStrategyBoard().then(r => { boardCache = r; if (alive) setB(r) }).catch(() => { /* an older engine: no board */ })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return b
}

const BOARD_STATUS: Record<StrategyBoardEntry['status'], { label: string; color: string }> = {
  live: { label: 'LIVE', color: '#22c55e' },
  trial: { label: 'TRIAL', color: '#f59e0b' },
  paused: { label: 'PAUSED', color: '#94a3b8' },
}

/** The kinds of signal live bots trade on the dollar plan. */
const DOLLAR_KIND: Record<string, string> = {
  'snipe/snipe': N_('Snipes'),
  'snipe/scalp': N_('Fast scalps: snipes on risky coins'),
  'volume/scalp': N_('Fast scalps: volume spikes'),
  'momentum/scalp': N_('Fast scalps: momentum bursts'),
  'second-leg/second-leg': N_('Comebacks: dip rebounds'),
}

/**
 * The $2 plan (engine/src/bot/dollarPlan.ts): live bots take every snipe at $2, on coins with 80 buyers or fewer, and
 * sell all of it at about +10% within 3 minutes (quick take-profits, since 2026-10-01). Each kind's record: its signals
 * replayed on the coins' real trades at live speed, and live bots' own trades. A kind on probation, or not yet proven
 * (momentum bursts, comebacks), is sat out.
 */
function DollarPlanCard({ plan }: { plan: DollarPlanView }) {
  const money = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(2)}`
  return (
    <Section title={T('Live plan: {p}% of the wallet a trade, quick take-profits', { p: plan.walletSharePct ?? 20 })}>
      <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>{T('Live bots take every snipe on a coin with {b} buyers or fewer in and no wallet over {t}% of the buying. Each trade is {p}% of what the bot\'s wallet is worth (at least {min}, at most {max}), so it grows with the capital: all of it sold at +{g}% after costs (about +10% on the price), out at −7%, when the creator sells, or after {m} minutes. Losses never stop a live bot: no daily loss limit, no pause, no switch back to paper. Momentum bursts and comebacks are replayed and measured first, and traded once their replays make money. Each bot learns its own entry filters from its losing trades and the team\'s, but no lesson may turn away more than half of a kind\'s signals. Most trades are small wins; a rug, which no stop catches at live speed, can cost most of its trade.', { p: plan.walletSharePct ?? 20, min: usd(plan.minTradeUsd ?? 2, 0), max: usd(plan.maxTradeUsd ?? 50, 0), b: plan.maxBuyers ?? 80, t: plan.maxTopBuyerPct ?? 15, g: plan.netGainPct ?? 7.5, m: plan.exits[0]?.maxHoldMin ?? 3 })}</div>
      {/* Volume spikes (engine/src/signals/rules.ts RULES.volume): 30+ holders, $6,000+ market cap, $5,000+ liquidity. */}
      {plan.exits.some(e => e.rule === 'volume') && <div className="at-step-sub" style={{ margin: '0 0 8px' }}>{T('Volume spikes too: a coin 10+ minutes old whose last minute traded 3× its usual, mostly buying, with {h}+ holders, a market cap over {mc} and liquidity over {liq}. Sold at +25%, out at −10% or after 20 minutes.', { h: 30, mc: '$6,000', liq: '$5,000' })}</div>}
      {plan.exits.map(e => (
        <div key={`${e.strategy}/${e.rule ?? ''}`} style={{ fontSize: '0.74rem', margin: '2px 0', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill color={STRATEGY_COLOR[e.strategy]}>{T(e.rule ? DOLLAR_KIND[`${e.rule}/${e.strategy}`] ?? STRATEGY[e.strategy] : STRATEGY[e.strategy])}</Pill>
          <span style={{ color: 'var(--text-muted)' }}>{e.rule === 'volume'
            ? T('All of it at +{p}% on the price (+{g}% after costs); out at {sl}, when the creator sells, or after {m} minutes', { p: 25, g: e.netGainPct ?? 22.5, sl: pctMove(e.stopLoss), m: e.maxHoldMin })
            : T('All of it at +{g}% after costs; out at {sl}, when the creator sells, or after {m} minutes', { g: plan.netGainPct ?? 7.5, sl: pctMove(e.stopLoss), m: e.maxHoldMin })}</span>
        </div>
      ))}
      {plan.kinds.map(k => (
        <div key={`${k.rule}/${k.strategy}`} className="at-grade-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill color={STRATEGY_COLOR[k.strategy]}>{T(DOLLAR_KIND[`${k.rule}/${k.strategy}`] ?? STRATEGY[k.strategy])}</Pill>
            <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.04em', color: k.probation ? '#94a3b8' : '#22c55e', border: `1px solid ${k.probation ? '#94a3b8' : '#22c55e'}`, borderRadius: 6, padding: '1px 6px' }}>{k.probation ? T('SAT OUT') : T('LIVE')}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.74rem' }}>
              {k.replays.trades ? T('{n} replays · {h} took profit · {w} won · {p}', { n: k.replays.trades, h: k.replays.hits, w: k.replays.wins, p: money(k.replays.pnlUsd) }) : T('no replays yet')}
            </span>
          </div>
          {k.live.trades > 0 && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{T('Live bots: {n} trades, {h} took profit, {w} won, {p}', { n: k.live.trades, h: k.live.hits, w: k.live.wins, p: money(k.live.pnlUsd) })}</div>}
          {k.probation && <div className="at-note warn" style={{ marginTop: 4 }}>{T(k.probation)}</div>}
        </div>
      ))}
      {plan.patterns && <LossPatterns patterns={plan.patterns} />}
      {plan.watch && <ComebackWatch watch={plan.watch} />}
    </Section>
  )
}

/** The kinds of coin that keep losing on the plan (engine/src/bot/patterns.ts): live bots sit them out, paper keeps measuring them. */
function LossPatterns({ patterns }: { patterns: NonNullable<DollarPlanView['patterns']> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="at-label">{T('Why trades lose: kinds of coin live bots sit out')}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 6px', lineHeight: 1.5 }}>{T('Found every minute in the last 7 days of replays and live trades. A kind of coin that loses money, 3%+ a trade and 8+ points worse than the rest, is sat out by live bots until it stops losing; paper bots and the replays keep trading it, so it is lifted by itself.')}</div>
      {patterns.length === 0 ? <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{T('No losing kind of coin in the last 7 days.')}</div> : patterns.map(p => (
        <div key={p.id} className="at-grade-row">
          <div style={{ fontSize: '0.76rem', fontWeight: 700 }}>{p.label}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{T('{n} trades · {w} won · {a}% a trade · {p} · other coins {r}%', { n: p.trades, w: p.wins, a: p.avgPct, p: `${p.pnlUsd < 0 ? '−' : ''}$${Math.abs(p.pnlUsd).toFixed(2)}`, r: `${p.restAvgPct > 0 ? '+' : ''}${p.restAvgPct}` })}</div>
        </div>
      ))}
    </div>
  )
}

/** Coins watched for a comeback after a live trade lost on them or live bots sat them out (the last 6 hours). */
function ComebackWatch({ watch }: { watch: NonNullable<DollarPlanView['watch']> }) {
  if (!watch.length) return null
  const move = (a: number | null, b: number | null) => (a && b ? `${b >= a ? '+' : '−'}${Math.abs(Math.round((b / a - 1) * 100))}%` : '—')
  return (
    <div style={{ marginTop: 12 }}>
      <div className="at-label">{T('Comeback watch')}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 6px', lineHeight: 1.5 }}>{T('Coins a live trade lost on, or that live bots sat out, stay on the scanner for 48 hours. A comeback is the dip-rebound rule firing on one: it ran, pulled back and is being bought again. Comebacks are measured first and traded live only once their replays prove them.')}</div>
      {watch.map(w => (
        <div key={w.token} className="at-grade-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: '0.78rem' }}>${w.symbol}</b>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}><AgoText ts={w.since} /></span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem' }}>{T('since then {m}', { m: move(w.priceThen, w.priceNow) })}</span>
            {w.comeback && <span style={{ fontSize: '0.7rem', fontWeight: 800, color: '#22c55e', border: '1px solid #22c55e', borderRadius: 6, padding: '1px 6px' }}>{T('COMEBACK')}</span>}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{w.why}</div>
          <div style={{ fontSize: '0.72rem', marginTop: 2 }}>{w.status}</div>
        </div>
      ))}
    </div>
  )
}

/** Which of the three strategies live bots trade now, with whose settings: the paper book doing best on each (engine/src/bot/strategyBoard.ts). */
function StrategyBoardCard() {
  const board = useBoard()
  if (board?.routing === 'dollar' && board.dollar) return <DollarPlanCard plan={board.dollar} />
  if (!board?.strategies.length) return null
  const pct = (x: number) => `${x > 0 ? '+' : ''}${x}%`
  return (
    <Section title={T('Strategy board: what live bots trade now')}>
      <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>{T('Paper bots trade every signal at live speed and learn from their losses. For each strategy, live bots use the settings of the paper book doing best on it (its last 20 trades) and switch by themselves: live while it is in profit, paused when it isn\'t, on trial at $2 until it has 8 trades.')}</div>
      {board.strategies.map(e => (
        <div key={e.strategy} className="at-grade-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill color={STRATEGY_COLOR[e.strategy]}>{T(STRATEGY[e.strategy])}</Pill>
            <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.04em', color: BOARD_STATUS[e.status].color, border: `1px solid ${BOARD_STATUS[e.status].color}`, borderRadius: 6, padding: '1px 6px' }}>{T(BOARD_STATUS[e.status].label)}</span>
            {e.source && <span style={{ fontFamily: 'var(--mono)', fontSize: '0.74rem' }}>{T('Settings from {n}: {t} trades, {w} won, {a} a trade', { n: e.source.kind === 'house' ? T(e.source.name) : e.source.name, t: e.source.trades, w: e.source.wins, a: pct(e.source.avgPct) })}</span>}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{T('Sells {s}% at {tp} · stop {sl} · {m} min at most', { s: e.exits.sellPct, tp: pctMove(e.exits.takeProfit), sl: pctMove(e.exits.stopLoss), m: e.exits.maxHoldMin ?? '—' })}</div>
          {e.live && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{T('Live bots, last 24h: {t} trades, {w} won, {a} a trade', { t: e.live.trades, w: e.live.wins, a: pct(e.live.avgPct) })}</div>}
          <div style={{ fontSize: '0.72rem', marginTop: 2, color: e.status === 'paused' ? 'var(--text-muted)' : '#86efac' }}>{T(e.why)}</div>
        </div>
      ))}
    </Section>
  )
}

/** Each grade's signals replayed at live speed with the exits that grade trades with: what each tier's signals did. */
function GradesCard({ grades: fromStats }: { grades?: GradeRecordView[] }) {
  const tiers = useTiers()
  const grades = tiers?.grades?.length ? tiers.grades : fromStats ?? []
  const [open, setOpen] = useState<SignalGrade | null>(null)
  if (!grades.length) return null
  return (
    <Section title={T('Signal grades, measured at live speed')}>
      <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>{T('Every signal is replayed on the coin\'s real trades as a live bot gets it (bought 2.5s late, sold 2s late), with the exits its grade trades with. A grade whose record fails is under review: its signals go out one grade lower until it recovers.')}</div>
      {grades.map(g => (
        <div key={g.grade} className="at-grade-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <GradeBadge g={g.grade} tiers={tiers} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
              {g.trades ? T('{n} replays · {w} won · {a} a trade', { n: g.trades, w: g.winRate === null ? '—' : `${Math.round(g.winRate * 100)}%`, a: g.avgPct === null ? '—' : `${g.avgPct > 0 ? '+' : ''}${g.avgPct}%` }) : T('no replays yet')}
            </span>
            <button className="link-btn" style={{ marginLeft: 'auto', fontSize: '0.72rem' }} onClick={() => setOpen(o => (o === g.grade ? null : g.grade))}>{open === g.grade ? T('Hide') : T('What it takes')}</button>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{T('Traded with {e}', { e: T(g.exits) })}</div>
          {g.live !== undefined && <div style={{ fontSize: '0.72rem', marginTop: 2, color: g.live ? '#86efac' : 'var(--text-muted)' }}>{g.live ? `✓ ${T('Live bots trade it now')}` : T('Live bots: not yet (it needs 10+ replays, 60% won and a profit at live speed)')}</div>}
          {g.review && <div className="at-note warn" style={{ marginTop: 4 }}>⚠ {T(g.review)}</div>}
          {open === g.grade && <ul className="at-grade-rules">{g.rules.map(r => <li key={r}>{T(r)}</li>)}</ul>}
        </div>
      ))}
      {!(tiers?.enforced) && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>{T('Free for now: every grade goes to every bot.')}</div>}
    </Section>
  )
}

/** The trades a bot closed, by the signal's grade: what each tier's signals did for this bot. */
function GradeStats({ acct }: { acct: PaperAccountView }) {
  const by = acct.byGrade ?? {}
  const rows = (['prime', 'core', 'standard'] as const).filter(g => by[g]?.trades)
  if (!rows.length) return null
  return (
    <Section title={T('By signal grade')}>
      {rows.map(g => {
        const r = by[g]!
        return (
          <div key={g} className="reward-row">
            <GradeBadge g={g} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{T('{n} trades, {w} won', { n: r.trades, w: `${Math.round((r.wins / r.trades) * 100)}%` })}</span>
            <b style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', color: r.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(r.pnlUsd)}</b>
          </div>
        )
      })}
    </Section>
  )
}

/** A system notification for every profit its bots take (a toast shows either way while ARCSENSE is open). */
function ProfitNotifySwitch() {
  const [on, setOn] = useState(() => profitNotifyOn())
  const [denied, setDenied] = useState(false)
  const supported = typeof Notification !== 'undefined'
  if (!supported) return null
  return (
    <div className="at-notify">
      <label>
        <input type="checkbox" checked={on} onChange={e => { const want = e.target.checked; void setProfitNotify(want).then(ok => { setOn(ok); setDenied(want && !ok) }) }} />
        🔔 {T('Notify me of every profit')}
      </label>
      <span>{denied ? T('Your browser blocked notifications for this site: allow them in its settings.') : T('A notification each time a trade closes in profit, even with this tab in the background.')}</span>
    </div>
  )
}

function MyBots({ navigate, liveSpeed }: { navigate: (p: Page) => void; liveSpeed?: LiveSpeedRow[] }) {
  const [session, setSession] = useState<string | null>(() => botSession())
  const [me, setMe] = useState<MeResponse | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const on = () => setSession(botSession())
    window.addEventListener('arcdex:bot-session', on)
    return () => window.removeEventListener('arcdex:bot-session', on)
  }, [])
  const reload = useCallback(() => botMe().then(m => { setMe(m); setError(null) }).catch((e: Error) => setError(e.message)), [])
  useEffect(() => {
    if (!session) { setMe(null); return }
    let alive = true
    const load = () => botMe().then(m => { if (alive) { setMe(m); setError(null) } }).catch((e: Error) => { if (alive) setError(e.message) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 5_000)
    return () => { alive = false; clearInterval(id) }
  }, [session])

  if (!session) return <AuthPanel />
  if (!me) return error ? <div className="at-card" style={{ marginTop: 14 }}><div className="at-error">⚠ {error}</div><button className="link-btn" onClick={() => botSignOut()}>{T('Sign out')}</button></div> : <Empty>{T('Loading…')}</Empty>

  const bots = me.bots
  const acct = bots.find(b => b.slug === sel) ?? bots[0] ?? null
  const act = async (a: PaperAction) => {
    if (!acct?.slug) return
    setBusy(true); setError(null)
    try {
      const v = await botAction(acct.slug, a)
      setMe(m => m && { ...m, bots: m.bots.map(b => (b.slug === acct.slug ? v : b)) })
      if (a.action === 'rename') setSel(v.slug ?? null)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const create = async (bot: NewPaperAccount) => {
    setBusy(true); setError(null)
    try { const v = await botCreate(bot); await reload(); setSel(v.slug ?? null); setCreating(false) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <>
      <AccountBar me={me} onChanged={() => void reload()} />
      {bots.length > 0 && (
        <div className="at-botbar">
          {bots.map(b => (
            <button key={b.slug} className={`at-chip${b.slug === acct?.slug && !creating ? ' on' : ''}`} onClick={() => { setSel(b.slug ?? null); setCreating(false) }}>
              <span className={`at-dot${b.running ? ' on' : ''}${b.mode === 'live' ? ' live' : ''}`} />{b.name}{b.mode === 'live' ? <span className="at-chip-live">{T('LIVE')}</span> : null}
            </button>
          ))}
          {bots.length < me.maxBots && <button className={`at-chip${creating ? ' on' : ''}`} onClick={() => setCreating(true)}>+ {T('New bot')}</button>}
        </div>
      )}
      {creating || !acct
        ? <CreateBot busy={busy} loading={false} error={error} onCreate={b => void create(b)} onCancel={bots.length ? () => setCreating(false) : undefined} team={me.team} access={me.access} />
        : <BotDashboard key={acct.slug} acct={acct} act={act} busy={busy} error={error} setError={setError} me={me} onMe={() => void reload()} navigate={navigate} liveSpeed={liveSpeed} />}
    </>
  )
}

/** Sign in, sign up (email + 4 letters or digits), or get a new passcode by email. */
function AuthPanel() {
  const [tab, setTab] = useState<'up' | 'in' | 'forgot'>('up')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const passOk = /^[A-Za-z0-9]{4}$/.test(pass)
  const emailOk = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())
  const submit = async () => {
    setBusy(true); setError(null); setInfo(null)
    try {
      if (tab === 'forgot') { await botForgot(email.trim()); setInfo(T('If that email has an account, a new passcode is on its way. Sign in with it, then change it if you like.')); setTab('in'); setPass('') }
      else if (tab === 'up') await botSignup(email.trim(), pass)
      else await botLogin(email.trim(), pass)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="at-card at-hero">
      <div className="at-hero-title">{T('Your Autotrade bots, on any device')}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {T('Sign up with your email and a 4-character passcode. Your bots run on ARCSENSE around the clock, with your phone and computer off; sign in from anywhere to see every trade.')}
      </div>
      {paperKey() && <div className="at-note warn">🤖 {T('This browser already has a bot: it joins your account when you sign up or sign in.')}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        {([['up', T('Sign up')], ['in', T('Sign in')]] as const).map(([k, l]) => <button key={k} className={`at-chip${tab === k ? ' on' : ''}`} onClick={() => { setTab(k); setError(null) }}>{l}</button>)}
      </div>
      <input className="at-input at-name" type="email" autoComplete="email" value={email} placeholder={T('Email')} onChange={e => setEmail(e.target.value)} aria-label={T('Email')} />
      {tab !== 'forgot' && (
        <>
          <input className="at-input at-pass" type="password" autoComplete={tab === 'up' ? 'new-password' : 'current-password'} maxLength={4} value={pass} placeholder="••••" onChange={e => setPass(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} aria-label={T('Passcode')} onKeyDown={e => { if (e.key === 'Enter' && emailOk && passOk) void submit() }} />
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('4 letters or digits; upper and lower case count.')}</div>
        </>
      )}
      <button className="at-big" disabled={busy || !emailOk || (tab !== 'forgot' && !passOk)} onClick={() => void submit()}>
        {busy ? T('Loading…') : tab === 'up' ? T('Create my account') : tab === 'in' ? T('Sign in') : T('Email me a new passcode')}
      </button>
      {tab === 'in' && <button className="link-btn" onClick={() => { setTab('forgot'); setError(null) }}>{T('Forgot your passcode?')}</button>}
      {tab === 'forgot' && <button className="link-btn" onClick={() => setTab('in')}>{T('Back to sign in')}</button>}
      {info && <div className="at-note">✉️ {info}</div>}
      {error && <div className="at-error">⚠ {error}</div>}
    </div>
  )
}

/** Confirms the owner's email with a 6-digit code (needed for live trading and withdrawals). */
function VerifyEmail({ onDone }: { onDone: () => void }) {
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (f: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(null)
    try { await f(); after?.() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  // Sign-up already emailed a code, so the box to enter it is always there.
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      <input className="at-input" inputMode="numeric" maxLength={6} value={code} placeholder="123456" onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label={T('Code')} />
      <button className="btn-ghost" disabled={busy || code.length !== 6} onClick={() => void run(() => botVerify(code), onDone)}>{T('Confirm')}</button>
      <button className="link-btn" disabled={busy} onClick={() => void run(botVerifySend, () => setSent(true))}>{sent ? T('Send the code again') : T('Email me a code')}</button>
      {error && <span className="at-error" style={{ marginTop: 0 }}>⚠ {error}</span>}
    </div>
  )
}

/** Who's signed in: email (verified or not), change passcode, sign out. */
function AccountBar({ me, onChanged }: { me: MeResponse; onChanged: () => void }) {
  const [open, setOpen] = useState<'verify' | 'passcode' | null>(null)
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const change = async () => {
    setBusy(true); setMsg(null)
    try { await botChangePasscode(cur, next); setMsg(T('Passcode changed. Other devices were signed out.')); setOpen(null); setCur(''); setNext('') } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="at-account">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>👤 <b>{me.user.email}</b></span>
        {me.user.verified ? <Pill color="#22c55e">✓ {T('verified')}</Pill>
          : me.email ? <button className="link-btn" onClick={() => setOpen(open === 'verify' ? null : 'verify')}>{T('Verify email')}</button> : null}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="link-btn" onClick={() => setOpen(open === 'passcode' ? null : 'passcode')}>{T('Change passcode')}</button>
          <button className="link-btn" onClick={() => botSignOut()}>{T('Sign out')}</button>
          <button className="link-btn" onClick={() => void botSignOutAll().catch(() => botSignOut())}>{T('Sign out everywhere')}</button>
        </span>
      </div>
      {open === 'verify' && <VerifyEmail onDone={() => { setOpen(null); onChanged() }} />}
      {open === 'passcode' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <input className="at-input at-pass" type="password" maxLength={4} value={cur} placeholder={T('Current')} onChange={e => setCur(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} aria-label={T('Current passcode')} />
          <input className="at-input at-pass" type="password" maxLength={4} value={next} placeholder={T('New')} onChange={e => setNext(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} aria-label={T('New passcode')} />
          <button className="btn-ghost" disabled={busy || cur.length !== 4 || next.length !== 4} onClick={() => void change()}>{T('Save')}</button>
        </div>
      )}
      {msg && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>{msg}</div>}
    </div>
  )
}

type BotTab = 'overview' | 'trades' | 'strategy' | 'learning' | 'activity' | 'settings'
type WalletPanel = 'fund-paper' | 'fund-live' | 'withdraw' | null

/**
 * One of the owner's bots (redesigned 2026-09-30, owner: "PAPER to LIVE on
 * one toggle button, fund the live and paper wallets, a more professional
 * bot interface that's easy to navigate"). The header holds the bot, its one
 * Paper/Live switch and Start/Stop; under it, its two wallets side by side
 * (paper: virtual USDC; live: its own wallet on Arc), each with Fund; then
 * the book in use in four numbers; then tabs for everything else.
 */
function BotDashboard({ acct, act, busy, error, setError, me, onMe, navigate, liveSpeed }: { acct: PaperAccountView; act: (a: PaperAction) => Promise<void>; busy: boolean; error: string | null; setError: (e: string | null) => void; me: MeResponse; onMe: () => void; navigate: (p: Page) => void; liveSpeed?: LiveSpeedRow[] }) {
  const [tab, setTab] = useState<BotTab>('overview')
  const [panel, setPanel] = useState<WalletPanel>(null)
  const [goLive, setGoLive] = useState(false)
  const [toPaper, setToPaper] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const isLive = acct.mode === 'live'
  const board = useBoard()
  const live = acct.live ?? null
  const avail = acct.liveAvailable ?? me.liveAvailable
  const cleanRename = renaming?.replace(/\s+/g, ' ').trim() ?? ''
  const prot = acct.protections as PaperAccountView['protections'] | undefined
  const paused = prot?.pausedUntil ?? null
  const open = acct.positions.filter(p => p.status === 'open').sort((a, b) => Number(b.mode === 'live') - Number(a.mode === 'live') || b.openedAt - a.openedAt)
  const recent = acct.positions.filter(p => p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 5)

  // The switch: to live opens the checklist (and asks to confirm); back to paper asks once.
  const flip = () => {
    setError(null)
    if (isLive) { setToPaper(t => !t); setGoLive(false) } else { setGoLive(g => !g); setToPaper(false) }
  }
  const openPanel = (p: WalletPanel) => setPanel(cur => (cur === p ? null : p))

  const paperPnl = acct.equity - acct.deposited
  const stats: [string, string, string | undefined, string | undefined][] = isLive && live
    ? [
        [T('Live wallet'), usd(live.balanceUsd), T('real USDC on Arc'), undefined],
        [T('Live P&L'), usd(live.pnlUsd), T('after gas and fees'), live.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5'],
        [T('Win rate'), live.winRate === null ? '—' : `${Math.round(live.winRate * 100)}%`, T('{n} live trades', { n: live.closed }), undefined],
        [T('Open trades'), String(live.open), T('fees paid {v}', { v: usd(live.feesPaidUsd) }), undefined],
      ]
    : [
        [T('Account value'), usd(acct.equity), T('{v} in open trades', { v: usd(acct.openValue) }), undefined],
        [T('Profit / loss'), usd(paperPnl), T('on {d} deposited', { d: usd(acct.deposited, 0) }), paperPnl >= 0 ? 'var(--green)' : '#fca5a5'],
        [T('Win rate'), acct.stats.winRate === null ? '—' : `${(acct.stats.winRate * 100).toFixed(0)}%`, T('{w} won · {l} lost', { w: acct.stats.wins, l: acct.stats.losses }), undefined],
        [T('Open trades'), String(acct.stats.open), T('{n} closed', { n: acct.stats.closed }), undefined],
      ]
  const TABS: [BotTab, string][] = [['overview', T('Overview')], ['trades', T('Trades')], ['strategy', T('Strategy')], ['learning', T('Learning')], ['activity', T('Activity')], ['settings', T('Settings')]]

  return (
    <>
      <div className={`at-card at-botcard${isLive ? ' live' : ''}`}>
        <div className="at-bothead">
          <div className="at-bothead-id">
            {renaming === null ? (
              <div className="at-bot-title">
                <b className="at-bot-name">{acct.name ?? T('My bot')}</b>
                <span className={`at-run${acct.running ? ' on' : ''}`}>{acct.running ? `● ${T('Running')}` : T('Stopped')}</span>
              </div>
            ) : (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="at-input at-name" value={renaming} maxLength={24} autoFocus onChange={e => setRenaming(e.target.value)} aria-label={T('Bot name')} />
                <button className="btn-ghost" disabled={busy || !BOT_NAME.test(cleanRename)} onClick={() => { void act({ action: 'rename', name: cleanRename }); setRenaming(null) }}>{T('Save')}</button>
                <button className="link-btn" onClick={() => setRenaming(null)}>{T('Cancel')}</button>
              </span>
            )}
            <div className="at-bothead-sub">
              <span>{acct.strategies.map(s => T(STRATEGY[s])).join(' · ')}</span>
              {acct.running && acct.startedAt && <span>· {T('started')} <AgoText ts={acct.startedAt} /></span>}
              {acct.slug && <button className="link-btn" onClick={() => navigate({ name: 'signals', view: 'market', bot: acct.slug })}>{T('Public page')} ↗</button>}
              {acct.slug && (acct.stats.closed > 0 || acct.deposited > 0) && <ShareBotButton className="at-share" get={() => cardFromAccount(acct)} mine />}
            </div>
          </div>
          <div className="at-bothead-ctl">
            <ModeSwitch live={isLive} disabled={busy} onFlip={flip} />
            <button className={`at-startstop${acct.running ? ' stop' : ''}`} disabled={busy} onClick={() => void act({ action: acct.running ? 'stop' : 'start' })}>
              {acct.running ? `■ ${T('Stop')}` : `▶ ${T('Start')}`}
            </button>
          </div>
        </div>

        {goLive && !isLive && <GoLive acct={acct} me={me} act={act} busy={busy} onFund={() => setPanel('fund-live')} onClose={() => setGoLive(false)} />}
        {toPaper && isLive && (
          <div className="at-note warn">
            {T('Back to paper? No new live trades; its open live trades are still managed until they close.')}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-ghost" disabled={busy} onClick={() => { setToPaper(false); void act({ action: 'mode', mode: 'paper' }) }}>{T('Yes, back to paper')}</button>
              <button className="link-btn" onClick={() => setToPaper(false)}>{T('Cancel')}</button>
            </div>
          </div>
        )}

        <div className="at-wallets">
          <div className={`at-wcard${!isLive ? ' on' : ''}`}>
            <div className="at-wcard-top"><span>🧪 {T('Paper wallet')}</span>{!isLive && <span className="at-wcard-use">{T('in use')}</span>}</div>
            <div className="at-wcard-bal">{usd(acct.cash)}</div>
            <div className="at-wcard-sub">{T('virtual USDC · no real money')}</div>
            <div className="at-wcard-actions">
              <button className={`at-wbtn${panel === 'fund-paper' ? ' on' : ''}`} disabled={busy} onClick={() => openPanel('fund-paper')}>+ {T('Fund')}</button>
            </div>
          </div>
          <div className={`at-wcard live${isLive ? ' on' : ''}`}>
            <div className="at-wcard-top"><span>💵 {T('Live wallet')}</span>{isLive && <span className="at-wcard-use live">● {T('in use')}</span>}</div>
            <div className="at-wcard-bal">{live ? usd(live.balanceUsd) : '—'}</div>
            <div className="at-wcard-sub">{live ? <>{T('real USDC on Arc')} · <CopyAddr addr={live.wallet} /></> : T('its own wallet on Arc, for real USDC')}</div>
            <div className="at-wcard-actions">
              {!live
                ? <button className="at-wbtn" disabled={busy || !avail.ok} title={avail.ok ? undefined : avail.why ?? undefined} onClick={() => void act({ action: 'live-wallet' })}>{T('Create live wallet')}</button>
                : <>
                    <button className={`at-wbtn${panel === 'fund-live' ? ' on' : ''}`} onClick={() => openPanel('fund-live')}>+ {T('Fund')}</button>
                    <button className={`at-wbtn ghost${panel === 'withdraw' ? ' on' : ''}`} onClick={() => openPanel('withdraw')}>{T('Withdraw')}</button>
                  </>}
            </div>
          </div>
        </div>
        {panel === 'fund-paper' && <FundPaper busy={busy} onFund={v => void act({ action: 'deposit', amount: v })} onClose={() => setPanel(null)} />}
        {panel === 'fund-live' && live && <FundLive wallet={live.wallet} minUsd={live.limits.minBalanceUsd} onDone={onMe} onClose={() => setPanel(null)} />}
        {panel === 'withdraw' && live && <WithdrawLive acct={acct} me={me} onDone={onMe} onClose={() => setPanel(null)} />}

        <div className="at-stats">
          {stats.map(([label, value, sub, color]) => <Stat key={label} label={label} value={value} sub={sub} color={color} />)}
        </div>
        {paused && <div className="at-note warn">⏸ {T('Paused after {n} losses in a row: no new trades until {t} while it learns from them.', { n: prot!.pauseAfterLosses, t: new Date(paused).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</div>}
        {!acct.running && acct.cash < 2 && !isLive && <div className="at-hint">{T('Fund the paper wallet, then press Start.')}</div>}
        {error && <div className="at-error">⚠ {error}</div>}
      </div>

      <div className="at-tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`at-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            {l}{k === 'overview' && open.length ? ` · ${open.length}` : k === 'trades' ? ` · ${acct.tradesLogged ?? acct.stats.closed}` : ''}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {isLive && liveSpeed && <LiveGateNote rows={liveSpeed} strategies={acct.strategies} />}
          {isLive && board?.routing === 'board' && <div className="at-note" style={{ marginTop: 12 }}>◆ {T('Live bots trade by themselves now: whichever of the three strategies is in profit on paper at live speed, with the settings of the paper bot doing best on it. A strategy that stops working is paused for live until paper proves it again (the strategy board shows each one).')}</div>}
          {isLive && board?.routing === 'board' && <StrategyBoardCard />}
          {isLive && board?.routing === 'dollar' && <div className="at-note" style={{ marginTop: 12 }}>◆ {T('Live bots trade every snipe now, whatever they picked: {s} a trade, all of it sold at about +10%, out within {m} minutes. Your bot learns from its losing trades and the team\'s which coins to skip, but never so much that it stops trading.', { s: usd(acct.live?.plan?.sizeUsd ?? 2, 0), m: acct.live?.plan?.maxHoldMin ?? 3 })}</div>}
          {isLive && board?.routing === 'dollar' && <StrategyBoardCard />}
          {isLive && board?.routing !== 'board' && board?.routing !== 'dollar' && <div className="at-note" style={{ marginTop: 12 }}>◆ {T('Live bots trade Prime and Core signals now: Prime with Precision (all of it sold at +10%), Core with the quick exits (all of it sold at +6%, −7% stop, 10 minutes at most). A grade whose record at live speed fails is passed over until it recovers, and Standard joins once it proves a profit (the Signals tab shows each grade\'s record).')}</div>}
          {!isLive && me.paperSignals === false && <div className="at-note warn" style={{ marginTop: 12 }}>{T('Signals go to live bots only for now (the platform\'s setting): this paper bot isn\'t trading. Switch it to LIVE to trade.')}</div>}
          {acct.team && <TeamCard team={acct.team} acct={acct} onStrategy={() => setTab('strategy')} />}
          <GradeStats acct={acct} />
          <Section title={T('Open trades') + ` · ${open.length}`}>
            {open.length === 0 ? <Empty>{acct.running ? T('Waiting for the next signal. The scanner shows what it is checking.') : T('No open trades. Press Start to trade.')}</Empty> : open.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
          </Section>
          <Section title={T('Recent trades')}>
            {recent.length === 0 ? <Empty>{T('Nothing closed yet.')}</Empty> : recent.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
            {recent.length > 0 && <button className="link-btn" style={{ marginTop: 6 }} onClick={() => setTab('trades')}>{T('All trades')} →</button>}
          </Section>
          {acct.events?.[0] && (
            <Section title={T('Latest')}>
              {acct.events.slice(0, 3).map((e, i) => <EventLine key={`${e.at}:${i}`} e={e} navigate={navigate} />)}
              <button className="link-btn" style={{ marginTop: 6 }} onClick={() => setTab('activity')}>{T('All activity')} →</button>
            </Section>
          )}
        </>
      )}

      {tab === 'trades' && <TradeLog fetchTrades={(limit, before) => botTrades(acct.slug ?? '', limit, before)} name={acct.name ?? 'bot'} total={acct.tradesLogged ?? acct.stats.closed} fallback={acct.positions.filter(p => p.status === 'closed')} navigate={navigate} />}

      {tab === 'strategy' && (
        <Section title={T('Strategies')}>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', margin: '2px 0 8px' }}>{T('Use one, or several at once.')}</div>
          {board?.routing === 'board' && <div className="at-note" style={{ marginBottom: 8 }}>{T('Live bots trade all three strategies by themselves, switched by the strategy board; your picks are what this bot trades on paper.')}</div>}
          {board?.routing === 'dollar' && <div className="at-note" style={{ marginBottom: 8 }}>{T('Live bots trade every snipe at {p}% of their wallet, sold at about +10% within {m} minutes; your picks are what this bot trades on paper.', { p: board.dollar?.walletSharePct ?? 20, m: board.dollar?.exits[0]?.maxHoldMin ?? 3 })}</div>}
          <StrategyPicker selected={acct.strategies} disabled={busy} team={acct.team} access={me.access} onToggle={s => {
            const next = acct.strategies.includes(s) ? acct.strategies.filter(x => x !== s) : [...acct.strategies, s]
            if (next.length) void act({ action: 'strategies', strategies: next })
            else setError(T('Keep at least one strategy.'))
          }} />
          {isLive && acct.live?.plan ? (<>
          <div className="at-label">{T('Live: {s} a trade, sold at about +10%', { s: usd(acct.live.plan.sizeUsd) })}</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {T('Every live trade is {p}% of what the wallet is worth (now {s}, at least {min}), so it grows with the capital, and all of it is sold at +{g}% after costs, or within {m} minutes. What it learned for live trades, from its own and the team\'s:', { p: acct.live.plan.walletSharePct ?? 20, s: usd(acct.live.plan.sizeUsd), min: usd(acct.live.plan.minTradeUsd ?? 2, 0), g: acct.live.plan.takeProfitPct ?? 7.5, m: acct.live.plan.maxHoldMin ?? 3 })}
          </div>
          {(['snipe', 'scalp', 'second-leg'] as const).map(st => { const t = acct.live!.plan!.tuning[st]; return t ? <DollarTuningLine key={st} s={st} t={t} /> : null })}
          </>) : isLive && acct.live?.limits.baseTradeUsd !== undefined ? (<>
          <div className="at-label">{T('Live trade size: from {b}, growing with profit', { b: usd(acct.live.limits.baseTradeUsd, 0) })}</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {T('Each live trade starts at {b} and grows in step with what its live trades make: once they have added 50% to what the wallet went live with, trades are 50% bigger. Losses never take it under {b}, and deposits and withdrawals don\'t count. Above {b}, never more than {p}% of what the wallet holds, and at most {x}. Now: {now} a trade ({g} grown).', { b: usd(acct.live.limits.baseTradeUsd, 0), p: acct.live.limits.maxSharePct ?? 20, x: usd(acct.live.limits.maxTradeUsd, 0), now: usd(acct.live.sizing?.tradeUsd ?? acct.live.limits.baseTradeUsd), g: `${acct.live.sizing?.growthPct ?? 0}%` })}
          </div>
          </>) : (<>
          <div className="at-label">{T('Trade size: from the bot\'s capital')}</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {T('Each trade is a share of what the bot is worth now (at the start, its capital), by the signal\'s grade: {p}% on Prime, {c}% on Core, {s}% on Standard, at least {m}. A $10 bot trades $2 or $1. Never more than 1.5% of the coin\'s pool, and never a trade whose costs eat the take-profit. When many bots take the same signal, they share it under a cap, and each later bot\'s take-profit is a notch higher so they don\'t all sell at once.', { p: acct.protections?.gradeSharePct?.prime ?? 20, c: acct.protections?.gradeSharePct?.core ?? 15, s: acct.protections?.gradeSharePct?.standard ?? 10, m: usd(acct.protections?.minTradeUsd ?? 1, 0) })}
          </div>
          </>)}
          {acct.tuning && acct.strategies.map(s => <TuningLine key={s} s={s} t={acct.tuning[s]} />)}
        </Section>
      )}

      {tab === 'learning' && (
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
      )}

      {tab === 'activity' && <ActivityTab acct={acct} navigate={navigate} />}

      {tab === 'settings' && <SettingsTab acct={acct} act={act} busy={busy} onRename={() => setRenaming(acct.name ?? '')} />}
    </>
  )
}

/**
 * The team this bot works with: every bot on ARCSENSE reads the others' trades
 * (paper and live) and learns from signals it didn't take. The team's record
 * this week per strategy, and a nudge when a winning one isn't followed.
 */
function TeamCard({ team, acct, onStrategy }: { team: TeamView; acct: PaperAccountView; onStrategy: () => void }) {
  const rows = (['snipe', 'scalp', 'second-leg'] as const).filter(s => team.byStrategy[s])
  const missing = rows.filter(s => !acct.strategies.includes(s) && (team.byStrategy[s]!.winRate ?? 0) >= 0.6 && team.byStrategy[s]!.pnlUsd > 0)
  const fromTeam = acct.learnLog?.filter(n => n.kind === 'team' || /of the team's\)/.test(n.text)).length ?? 0
  return (
    <Section title={`🤝 ${T('Team')} · ${T('{n} bots trading', { n: team.bots })}`}>
      <div className="at-step-sub" style={{ marginBottom: 6 }}>
        {T('Every bot learns from every other bot\'s trades, paper and live, including signals it didn\'t take.')}{fromTeam ? ` ${T('{name} has learned {n} times from the team.', { name: acct.name, n: fromTeam })}` : ''}
      </div>
      <div className="at-team">
        {rows.length === 0 ? <span className="at-step-sub">{T('No team trades this week yet.')}</span> : rows.map(s => {
          const r = team.byStrategy[s]!
          return (
            <div key={s} className="at-team-row">
              <Pill color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])}</Pill>
              <span>{T('{n} trades', { n: r.trades })}</span>
              <span>{r.winRate === null ? '—' : T('{w} won', { w: `${Math.round(r.winRate * 100)}%` })}</span>
              <b style={{ color: r.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5', fontFamily: 'var(--mono)' }}>{usd(r.pnlUsd)}</b>
              {acct.strategies.includes(s) ? <span className="at-team-on">✓ {T('following')}</span> : null}
            </div>
          )
        })}
      </div>
      {missing.length > 0 && <div className="at-note" style={{ background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.35)', color: '#99f6e4' }}>
        {T('The team is winning with {s}, which this bot doesn\'t follow.', { s: missing.map(s => T(STRATEGY[s])).join(', ') })} <button className="link-btn" onClick={onStrategy}>{T('Add it')} →</button>
      </div>}
    </Section>
  )
}

const KIND_NAME: Record<string, string> = { 'snipe/snipe': N_('Clean-coin snipes'), 'snipe/scalp': N_('Snipes on risky coins'), 'volume/scalp': N_('Volume spikes'), 'momentum/scalp': N_('Momentum bursts'), 'second-leg/second-leg': N_('Dip rebounds') }
const kindName = (k: string) => T(KIND_NAME[k] ?? k)

/**
 * Why a live bot may be quiet: live bots trade only the kinds of signal that
 * make money at live speed, replayed on real trades (engine/src/signals/liveSpeed.ts).
 */
function LiveGateNote({ rows, strategies }: { rows: LiveSpeedRow[]; strategies: Strategy[] }) {
  const mine = rows.filter(r => strategies.includes(r.key.split('/')[1] as Strategy))
  const open = mine.filter(r => r.ok)
  return (
    <div className={`at-note ${open.length ? '' : 'warn'}`} style={{ marginTop: 12 }}>
      {open.length
        ? T('Live now for: {k}. The other kinds of signal go to paper bots until they make money at live speed.', { k: open.map(r => kindName(r.key)).join(', ') })
        : T('Waiting for proof: no kind of signal this bot follows has made money at live speed yet (every signal is replayed on the coin\'s real trades, bought 2.5s after it and sold 2s after each trigger, as a live bot would). Its money stays in the wallet; it trades by itself once one does.')}
    </div>
  )
}

/** Each kind of signal at live speed: what a live bot would have made on its last replays, and whether live bots trade it. */
function LiveSpeedCard({ rows, all }: { rows: LiveSpeedRow[]; all?: boolean }) {
  return (
    <Section title={T('At live speed')}>
      <div className="at-step-sub" style={{ margin: '2px 0 8px' }}>
        {T('Every signal is replayed on its coin\'s real trades as a live bot trades it: bought 2.5s after the signal, sold 2s after each trigger, costs included.')}{' '}
        {all ? T('Right now live bots take every signal not on probation (the platform\'s setting): these are the numbers to watch.') : T('Live bots trade a kind of signal only once its last 10 or more replays average +0.5% a trade or better.')}
      </div>
      {rows.length === 0 ? <Empty>{T('Replaying the recent signals…')}</Empty> : (
        <div className="at-team">
          {rows.map(r => (
            <div key={r.key} className="at-team-row">
              <b style={{ color: 'var(--text)', minWidth: 150 }}>{kindName(r.key)}</b>
              <span>{T('{n} replays', { n: r.trades })}</span>
              <span>{r.winRate === null ? '—' : T('{w} won', { w: `${Math.round(r.winRate * 100)}%` })}</span>
              <b style={{ fontFamily: 'var(--mono)', color: (r.avgReturn ?? 0) >= 0 ? 'var(--green)' : '#fca5a5' }}>{r.avgReturn === null ? '—' : `${r.avgReturn >= 0 ? '+' : ''}${(r.avgReturn * 100).toFixed(1)}% ${T('a trade')}`}</b>
              {all ? null : r.ok ? <span className="at-quality live">{T('live bots trade it')}</span> : <span className="at-quality paper">{T('paper only')}</span>}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/** The one Paper/Live switch: a single button that flips the bot's mode (live asks first). */
function ModeSwitch({ live, disabled, onFlip }: { live: boolean; disabled: boolean; onFlip: () => void }) {
  return (
    <button className={`at-mode${live ? ' live' : ''}`} role="switch" aria-checked={live} aria-label={T('Paper or live trading')} disabled={disabled} onClick={onFlip}
      title={live ? T('Trading real USDC. Click to go back to paper.') : T('Paper trading with virtual USDC. Click to trade live.')}>
      <span className={`at-mode-opt${!live ? ' on' : ''}`}>{T('PAPER')}</span>
      <span className={`at-mode-opt${live ? ' on' : ''}`}>● {T('LIVE')}</span>
    </button>
  )
}

/** A wallet address, short, that copies itself. */
function CopyAddr({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button className="link-btn at-copy" title={addr} onClick={() => { void navigator.clipboard?.writeText(addr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
      {copied ? T('Copied') : shortAddr(addr)} ⧉
    </button>
  )
}

/** The checklist the switch opens on its way to live: each step with its state and what to do. */
function GoLive({ acct, me, act, busy, onFund, onClose }: { acct: PaperAccountView; me: MeResponse; act: (a: PaperAction) => Promise<void>; busy: boolean; onFund: () => void; onClose: () => void }) {
  const [sure, setSure] = useState(false)
  const avail = acct.liveAvailable ?? me.liveAvailable
  const ready = acct.ready
  const live = acct.live ?? null
  if (!avail.ok) {
    return (
      <div className="at-golive">
        <div className="at-golive-h">{T('Live trading')}<button className="link-btn" onClick={onClose}>✕</button></div>
        <div className="at-note warn" style={{ marginTop: 0 }}>{T('Live trading for bots isn\'t switched on yet on ARCSENSE.')} {avail.why ? <span style={{ opacity: 0.8 }}>({avail.why})</span> : null}</div>
      </div>
    )
  }
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
  const funded = !!live && (live.balanceUsd ?? 0) >= live.limits.minBalanceUsd
  const steps: { ok: boolean; title: string; body: React.ReactNode }[] = [
    {
      ok: !!ready?.ok,
      title: ready?.via === 'team' ? T('Proven by the team') : T('Proven on paper'),
      body: ready ? (
        <>
          <div className="at-progress"><div style={{ width: `${Math.min(100, (ready.trades / (ready.team?.ok && ready.need.minOwnWithTeam ? ready.need.minOwnWithTeam : ready.need.minTrades)) * 100)}%` }} /></div>
          <div className="at-step-sub">
            {T('Its own: {a} paper trades (needs {b})', { a: ready.trades, b: ready.need.minTrades })} · {T('won {a} (needs {b})', { a: pct(ready.winRate), b: pct(ready.need.minWinRate) })} · {T('profit factor {a} (needs {b})', { a: ready.profitFactor === null ? '—' : ready.profitFactor.toFixed(2), b: ready.need.minProfitFactor })} · {T('net {a}', { a: usd(ready.pnlUsd) })}
          </div>
          {ready.team && (
            <div className="at-step-sub">
              {ready.team.ok ? '✓ ' : ''}{T('Or the team: {n} trades on its strategies this week, {w} won, {p}', { n: ready.team.trades, w: pct(ready.team.winRate), p: usd(ready.team.pnlUsd) })}
              {ready.team.ok && ready.need.minOwnWithTeam ? ` · ${T('then {m} of its own without a loss (has {a})', { m: ready.need.minOwnWithTeam, a: ready.trades })}` : ''}
            </div>
          )}
        </>
      ) : null,
    },
    {
      ok: funded,
      title: T('Live wallet funded'),
      body: !live
        ? <button className="at-wbtn" disabled={busy} onClick={() => void act({ action: 'live-wallet' })}>{T('Create live wallet')}</button>
        : funded
          ? <div className="at-step-sub">{T('{v} in its wallet', { v: usd(live.balanceUsd) })}</div>
          : <div className="at-step-sub">{T('It has {v}; it needs at least {m} to go live.', { v: usd(live.balanceUsd), m: usd(live.limits.minBalanceUsd, 0) })} <button className="link-btn" onClick={onFund}>{T('Fund it')} →</button></div>,
    },
  ]
  const allOk = steps.every(s => s.ok)
  return (
    <div className="at-golive">
      <div className="at-golive-h">{T('Switch to LIVE')}<button className="link-btn" onClick={onClose} aria-label={T('Close')}>✕</button></div>
      <ol className="at-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.ok ? 'ok' : ''}>
            <span className="at-step-dot">{s.ok ? '✓' : i + 1}</span>
            <div><b>{s.title}</b>{s.body}</div>
          </li>
        ))}
      </ol>
      {!sure ? (
        <button className="at-golive-go" disabled={busy || !allOk} onClick={() => setSure(true)}>{allOk ? `● ${T('Switch to LIVE')}` : T('Complete the steps above to go live')}</button>
      ) : (
        <div className="at-note warn">
          {T('Real money: this bot will trade its wallet\'s USDC on every signal it takes, with its learned settings, until you switch it back. 15% of each winning trade\'s profit goes to the platform; losing trades pay nothing, and the swaps themselves pay no fee. Results aren\'t guaranteed: most new coins go to zero.')}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn-ghost" style={{ borderColor: LIVE_RED, color: '#fca5a5' }} disabled={busy} onClick={() => { void act({ action: 'mode', mode: 'live' }).then(onClose) }}>{T('Yes, trade live')}</button>
            <button className="link-btn" onClick={() => setSure(false)}>{T('Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Virtual USDC for the paper wallet. */
function FundPaper({ busy, onFund, onClose }: { busy: boolean; onFund: (v: number) => void; onClose: () => void }) {
  const [amount, setAmount] = useState('1000')
  return (
    <div className="at-fundbox">
      <div className="at-golive-h">{T('Fund the paper wallet')}<button className="link-btn" onClick={onClose} aria-label={T('Close')}>✕</button></div>
      <div className="at-step-sub" style={{ marginBottom: 8 }}>{T('Virtual USDC to practise with: no real money moves.')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {[100, 1_000, 10_000].map(v => <button key={v} className="at-chip" disabled={busy} onClick={() => onFund(v)}>+{usd(v, 0)}</button>)}
        <input className="at-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
        <button className="at-wbtn" disabled={busy || !Number(amount)} onClick={() => onFund(Number(amount))}>{T('Add')}</button>
      </div>
    </div>
  )
}

/** Real USDC into the bot's live wallet: from the ARCSENSE wallet in one tap, or from anywhere to its address. */
function FundLive({ wallet, minUsd, onDone, onClose }: { wallet: string; minUsd: number; onDone: () => void; onClose: () => void }) {
  const trader = useTrader()
  const { cash, refresh } = useCash(trader.address)
  const send = useSendUsdc(trader)
  const guard = useWithdrawGuard(trader, wallet)
  const [amount, setAmount] = useState(String(Math.max(minUsd, 10)))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => { void import('qrcode').then(m => m.default.toDataURL(wallet, { margin: 1, width: 160, color: { dark: '#0b1628', light: '#ffffff' } })).then(setQr).catch(() => {}) }, [wallet])
  const n = Number(amount)
  const go = async () => {
    setBusy(true); setMsg(null)
    try {
      await guard.confirm()
      const hash = await send(wallet, amount)
      setMsg({ ok: true, text: T('Sent {v} to the bot\'s wallet.', { v: usd(n) }), hash })
      guard.setPasscode(''); refresh(); notifyBalances(); onDone()
    } catch (e) { setMsg({ ok: false, text: txErrorText(e) }) } finally { setBusy(false) }
  }
  const blocked = busy || !(n > 0) || (cash !== null && n > cash) || (guard.needsPasscode && !guard.passcode)
  return (
    <div className="at-fundbox">
      <div className="at-golive-h">{T('Fund the live wallet')}<button className="link-btn" onClick={onClose} aria-label={T('Close')}>✕</button></div>
      <div className="at-fund-grid">
        <div className="at-fund-opt">
          <b>{T('From my ARCSENSE wallet')}</b>
          {!trader.address ? (
            <>
              <div className="at-step-sub">{T('Unlock your trading wallet or connect a wallet to send in one tap.')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="at-wbtn" onClick={() => openTradingWallet()}>{T('Trading wallet')}</button>
                <button className="at-wbtn ghost" onClick={() => openConnectModal()}>{T('Connect wallet')}</button>
              </div>
            </>
          ) : (
            <>
              <div className="at-step-sub">{trader.kind === 'trading-wallet' ? T('Trading wallet') : T('Connected wallet')} {shortAddr(trader.address)} · {T('{v} available', { v: cash === null ? '…' : usd(cash) })}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {[10, 25, 50, 100].map(v => <button key={v} className={`at-chip${n === v ? ' on' : ''}`} onClick={() => setAmount(String(v))}>${v}</button>)}
                <input className="at-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
              </div>
              <PasscodeField guard={guard} onEnter={() => { if (!blocked) void go() }} />
              <button className="at-wbtn primary" disabled={blocked} onClick={() => void go()}>{busy ? T('Sending…') : T('Send {v} to the bot', { v: n > 0 ? usd(n) : '$' })}</button>
              {cash !== null && n > cash && <div className="at-error" style={{ marginTop: 0 }}>{T('Not enough USDC in this wallet.')}</div>}
            </>
          )}
        </div>
        <div className="at-fund-opt">
          <b>{T('From any wallet or exchange')}</b>
          <div className="at-fund-qr">
            {qr && <img src={qr} alt={T('Deposit address QR code')} />}
            <div>
              <code className="at-addr">{wallet}</code>
              <CopyAddr addr={wallet} />
            </div>
          </div>
          <div className="at-step-sub" style={{ color: '#fcd34d' }}>{T('Send only USDC on the Arc network. The bot needs at least {m} to go live.', { m: usd(minUsd, 0) })}</div>
        </div>
      </div>
      {msg && <div className={msg.ok ? 'at-ok' : 'at-error'}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}{msg.hash ? <> · <a href={`${EXPLORER}/tx/${msg.hash}`} target="_blank" rel="noreferrer">tx ↗</a></> : null}</div>}
    </div>
  )
}

/**
 * Money out of the live wallet. Without email (the default since 2026-09-30):
 * the account passcode, and only back to a wallet that funded the bot. With a
 * verified email, a code sent to it allows any address.
 */
function WithdrawLive({ acct, me, onDone, onClose }: { acct: PaperAccountView; me: MeResponse; onDone: () => void; onClose: () => void }) {
  const slug = acct.slug ?? ''
  const [funders, setFunders] = useState<{ address: string; usd: number }[] | null>(null)
  const [to, setTo] = useState('')
  const [amt, setAmt] = useState('')
  const [pass, setPass] = useState('')
  const [byEmail, setByEmail] = useState(false)
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const emailOk = me.email && me.user.verified
  useEffect(() => {
    let alive = true
    botFunders(slug).then(r => { if (alive) { setFunders(r.funders); if (r.funders[0]) setTo(t => t || r.funders[0].address) } }).catch(() => { if (alive) setFunders([]) })
    return () => { alive = false }
  }, [slug])
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setMsg(null)
    try { await f() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const sent = (hash: string) => { setMsg({ ok: true, text: T('Sent. Transaction {h}', { h: `${hash.slice(0, 10)}…` }) }); setAmt(''); setPass(''); setCode(''); setCodeSent(false); onDone() }
  const n = Number(amt)
  const bal = acct.live?.balanceUsd ?? null
  return (
    <div className="at-fundbox">
      <div className="at-golive-h">{T('Withdraw from the live wallet')}<button className="link-btn" onClick={onClose} aria-label={T('Close')}>✕</button></div>
      {!byEmail ? (
        <>
          <div className="at-step-sub" style={{ marginBottom: 6 }}>{T('Money goes back only to a wallet that funded this bot, confirmed with your account passcode.')}</div>
          {funders === null ? <div className="at-step-sub">{T('Reading its deposits…')}</div>
            : funders.length === 0 ? <div className="at-note warn" style={{ marginTop: 0 }}>{T('No wallet has funded this bot yet (at least $1 of USDC on Arc).')}</div>
            : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {funders.map(f => <button key={f.address} className={`at-chip${to === f.address ? ' on' : ''}`} onClick={() => setTo(f.address)}>{shortAddr(f.address)} · {T('sent {v}', { v: usd(f.usd) })}</button>)}
              </div>
            )}
          {funders && funders.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="at-input" inputMode="decimal" value={amt} placeholder="$" onChange={e => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
              {bal !== null && <button className="link-btn" onClick={() => setAmt(String(Math.max(0, Math.floor((bal - 1) * 100) / 100)))}>{T('Max')}</button>}
              <input className="at-input at-pass" type="password" maxLength={4} value={pass} placeholder="••••" onChange={e => setPass(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} aria-label={T('Passcode')} />
              <button className="at-wbtn primary" disabled={busy || !to || !(n > 0) || pass.length !== 4} onClick={() => void run(async () => sent((await botWithdrawPasscode(slug, to, n, pass)).hash))}>{busy ? T('Sending…') : T('Withdraw')}</button>
            </div>
          )}
          {emailOk && <button className="link-btn" style={{ marginTop: 8 }} onClick={() => { setByEmail(true); setTo(''); setMsg(null) }}>{T('Send to another address (emailed code)')}</button>}
        </>
      ) : (
        <>
          <div className="at-step-sub" style={{ marginBottom: 6 }}>{T('Any Arc address, confirmed with a code sent to {e}.', { e: me.user.email })}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="at-input at-name" value={to} placeholder="0x…" onChange={e => setTo(e.target.value.trim())} aria-label={T('To address')} disabled={codeSent} />
            <input className="at-input" inputMode="decimal" value={amt} placeholder="$" onChange={e => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} disabled={codeSent} />
            {!codeSent
              ? <button className="at-wbtn" disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(to) || !(n > 0)} onClick={() => void run(async () => { setMsg({ ok: true, text: await botWithdrawCode(slug, to, n) }); setCodeSent(true) })}>{T('Email me a code')}</button>
              : <>
                  <input className="at-input" inputMode="numeric" maxLength={6} value={code} placeholder="123456" onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label={T('Code')} />
                  <button className="at-wbtn primary" disabled={busy || code.length !== 6} onClick={() => void run(async () => sent((await botWithdraw(slug, code)).hash))}>{T('Withdraw')}</button>
                </>}
          </div>
          <button className="link-btn" style={{ marginTop: 8 }} onClick={() => { setByEmail(false); setCodeSent(false); setMsg(null) }}>{T('Back to a funding wallet')}</button>
        </>
      )}
      {msg && <div className={msg.ok ? 'at-ok' : 'at-error'}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}</div>}
    </div>
  )
}

/** One line of a bot's activity. */
function EventLine({ e, navigate }: { e: PaperAccountView['events'][number]; navigate: (p: Page) => void }) {
  return (
    <div className={`at-event ${e.kind}`}>
      <span className="at-event-at"><AgoText ts={e.at} /></span>
      {e.symbol && e.token ? <button className="link-btn" onClick={() => navigate({ name: 'argus', address: e.token!, pool: '' })} style={{ textDecoration: 'none', fontWeight: 800 }}>${e.symbol}</button> : null}
      <span>{e.text}</span>
    </div>
  )
}

/** What it did, the signals it passed over (and why), and the live wallet's own log. */
function ActivityTab({ acct, navigate }: { acct: PaperAccountView; navigate: (p: Page) => void }) {
  const [which, setWhich] = useState<'did' | 'skipped' | 'live'>('did')
  const liveEvents = acct.live?.events ?? []
  const list = which === 'did' ? acct.events ?? [] : which === 'skipped' ? acct.skips ?? [] : []
  return (
    <Section title={T('Activity')}>
      <div style={{ display: 'flex', gap: 6, margin: '6px 0', flexWrap: 'wrap' }}>
        <button className={`at-chip${which === 'did' ? ' on' : ''}`} onClick={() => setWhich('did')}>{T('What it did')}</button>
        <button className={`at-chip${which === 'skipped' ? ' on' : ''}`} onClick={() => setWhich('skipped')}>{T('Signals it passed over')} {acct.skips?.length ? acct.skips.length : ''}</button>
        {liveEvents.length > 0 && <button className={`at-chip${which === 'live' ? ' on' : ''}`} onClick={() => setWhich('live')}>{T('Live wallet')}</button>}
      </div>
      {which === 'live'
        ? liveEvents.map((e, i) => (
            <div key={`${e.at}:${i}`} className="at-event">
              <span className="at-event-at"><AgoText ts={e.at} /></span>
              <span>{e.text}{e.hash ? <> · <a href={`${EXPLORER}/tx/${e.hash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>tx ↗</a></> : null}</span>
            </div>
          ))
        : list.length === 0 ? <Empty>{T('Nothing yet.')}</Empty> : list.map((e, i) => <EventLine key={`${e.at}:${i}`} e={e} navigate={navigate} />)}
    </Section>
  )
}

/** Name, notifications, protection, live limits, selling everything live, and starting the paper account over. */
function SettingsTab({ acct, act, busy, onRename }: { acct: PaperAccountView; act: (a: PaperAction) => Promise<void>; busy: boolean; onRename: () => void }) {
  const [resetting, setResetting] = useState(false)
  const prot = acct.protections as PaperAccountView['protections'] | undefined
  const live = acct.live ?? null
  return (
    <>
      <Section title={T('Bot')}>
        <div className="at-setting"><span>{T('Name')}: <b>{acct.name}</b></span><button className="link-btn" onClick={onRename}>✎ {T('Rename')}</button></div>
        <ProfitNotifySwitch />
      </Section>
      {prot && (
        <Section title={T('Protection')}>
          <ul className="at-protect">
            <li>🛡 {T('Rug guard: out at once when liquidity is pulled, an early insider or a whale dumps, the price crashes on heavy selling, or the creator sells.')}</li>
            {prot.maxTradeSharePct !== undefined && !(acct.mode === 'live' && live?.limits.baseTradeUsd !== undefined) && <li>⚖ {T('Each trade is {p}% of what the bot is worth on a Prime signal, {c}% on Core, {s}% on Standard (now at most {m}), at least {min}: a small bot trades small.', { p: prot.gradeSharePct?.prime ?? prot.maxTradeSharePct, c: prot.gradeSharePct?.core ?? 15, s: prot.gradeSharePct?.standard ?? 10, m: prot.maxTradeUsd == null ? '—' : usd(prot.maxTradeUsd), min: usd(prot.minTradeUsd ?? 1, 0) })}</li>}
            <li>👥 {T('Shares each signal with the other bots: together they never buy enough to move the price against themselves, and the one that waited longest goes first.')}</li>
            {prot.neverStops && acct.mode !== 'live' && <li>♾ {T('Never stopped by losses, rugs included: no pause after losing trades, no daily loss limit, no stop when the account falls. It trades as long as it has the cash for a trade.')}</li>}
            {!(prot.neverStops || (acct.mode === 'live' && live?.plan?.neverStops)) && (<>
            <li>⏸ {T('Pauses new trades for 30 minutes after {n} losses in a row (now {s} in a row).', { n: prot.pauseAfterLosses, s: prot.lossStreak })}</li>
            <li>📉 {T('Daily loss limit {l}: no new trades after it until tomorrow (UTC). Today: {t}.', { l: usd(prot.dailyLossLimitUsd, 0), t: usd(prot.todayPnlUsd) })}</li>
            <li>🛑 {T('Stops if the account falls {p}% below what was deposited.', { p: prot.stopBelowPct })}</li>
            </>)}
          </ul>
        </Section>
      )}
      {live && (
        <Section title={T('Live wallet')}>
          <ul className="at-protect">
            {live.plan?.walletSharePct !== undefined ? (<>
              <li>💵 {T('Each trade is {p}% of what the wallet is worth: {now} now, at least {min}, at most {max}, so it grows with the capital. Keeps {r} for gas. Only this bot uses the wallet.', { p: live.plan.walletSharePct, now: usd(live.plan.sizeUsd), min: usd(live.plan.minTradeUsd ?? 2, 0), max: usd(live.plan.maxTradeUsd ?? 50, 0), r: usd(live.limits.reserveUsd) })}</li>
              {live.plan.neverStops && <li>♾ {T('Never stopped by losses, rugs included: no daily loss limit, no pause after losing trades, no switch back to paper. It trades as long as the wallet can pay {min} and gas.', { min: usd(live.plan.minTradeUsd ?? 2, 0) })}</li>}
            </>) : live.limits.baseTradeUsd !== undefined ? (<>
              <li>💵 {T('Each trade is {now} now: {b} to start, grown with what its live trades made ({g} so far), at most {x}. Keeps {r} for gas. Only this bot uses the wallet.', { now: usd(live.sizing?.tradeUsd ?? live.limits.baseTradeUsd), b: usd(live.limits.baseTradeUsd, 0), g: `+${live.sizing?.growthPct ?? 0}%`, x: usd(live.limits.maxTradeUsd, 0), r: usd(live.limits.reserveUsd) })}</li>
              {live.limits.maxSharePct !== undefined && <li>⚖ {T('Above {b}, it never puts more than {p}% of what it is worth into one trade (it reads its balance before every buy).', { b: usd(live.limits.baseTradeUsd, 0), p: live.limits.maxSharePct })}</li>}
            </>) : (<>
              <li>💵 {T('Trades up to {x} a trade and keeps {r} for gas. Only this bot uses the wallet.', { x: usd(live.limits.maxTradeUsd, 0), r: usd(live.limits.reserveUsd, 0) })}</li>
              {live.limits.maxSharePct !== undefined && <li>⚖ {T('It reads its balance before every buy and never puts more than {p}% of what it is worth into one trade.', { p: live.limits.maxSharePct })}</li>}
            </>)}
            {live.limits.preflight && <li>✓ {T('Every buy is checked first: the bot\'s wallet simulates the buy and selling it all straight back. A coin it couldn\'t sell, or a round trip costing over {p}%, is never bought.', { p: live.limits.maxRoundTripPct ?? 20 })}</li>}
            <li>✍ {T('The bot\'s own wallet signs every trade: no approvals to click. Buys pay USDC directly; each coin is approved once, by the bot, so it can always sell.')}</li>
          </ul>
          {live.open > 0 && <button className="btn-ghost" style={{ marginTop: 8 }} disabled={busy} onClick={() => void act({ action: 'sell-live' })}>{T('Sell all live positions ({n})', { n: live.open })}</button>}
        </Section>
      )}
      <Section title={T('Paper account')}>
        <div className="at-setting">
          {resetting ? (
            <span>{T('Start over with an empty account? Its trade log is kept.')}{' '}
              <button className="link-btn" onClick={() => { void act({ action: 'reset' }); setResetting(false) }}>{T('Yes, reset it')}</button>{' · '}
              <button className="link-btn" onClick={() => setResetting(false)}>{T('Cancel')}</button></span>
          ) : <><span>{T('Clears the paper wallet and its open paper trades.')}</span><button className="link-btn" onClick={() => setResetting(true)}>{T('Reset my paper account')}</button></>}
        </div>
      </Section>
    </>
  )
}

const pctMove = (m: number) => `${m >= 1 ? '+' : '−'}${Math.abs(Math.round((m - 1) * 100))}%`

/** One strategy's settings: its size now, exits, target, what it learned to filter, and its record. */
/** The kinds of signal a bot learns filters for apart (since 2026-09-30). */
const RULE_NAME: Record<SignalRule, string> = { momentum: N_('Momentum bursts'), snipe: N_('Snipes'), 'second-leg': N_('Dip rebounds'), volume: N_('Volume spikes') }

/** A set of learned entry filters, in words. */
function filterWords(f: BotFilters): string[] {
  if (f.skip) return [T('skipped for now (they kept losing)')]
  return [
    f.minLiquidityUsd > 1_000 && T('liquidity ≥ {v}', { v: big(f.minLiquidityUsd) }),
    f.minBuyers > 0 && T('≥ {v} buyers', { v: f.minBuyers }),
    f.minBuySellRatio > 0 && T('buys ≥ {v}× sells', { v: f.minBuySellRatio }),
    f.maxRunUp < 100 && T('not up more than {v}', { v: pctMove(f.maxRunUp) }),
    f.minScore > 0 && T('safety score ≥ {v}', { v: f.minScore }),
    f.maxTopBuyerPct < 100 && T('largest buyer ≤ {v}%', { v: Math.round(f.maxTopBuyerPct) }),
    f.avoidFlags.length > 0 && T('skips {v}', { v: f.avoidFlags.map(x => `“${x}”`).join(', ') }),
    f.maxTotalBuyers != null && T('≤ {v} buyers already in', { v: f.maxTotalBuyers }),
    f.maxSellUsd != null && T('≤ {v} sold before the entry', { v: big(f.maxSellUsd) }),
    f.maxOverhang != null && T('the creator\'s coins ≤ {v} of the pool', { v: `${Math.round(f.maxOverhang * 100)}%` }),
    f.maxFarmShare != null && T('≤ {v} of buyers from the creator\'s other coins', { v: `${Math.round(f.maxFarmShare * 100)}%` }),
    f.maxAgeSec != null && T('younger than {v} min', { v: Math.round(f.maxAgeSec / 60) }),
  ].filter((x): x is string => !!x)
}

function TuningLine({ s, t }: { s: Strategy; t: PaperAccountView['tuning'][Strategy] }) {
  // Learned per kind of signal: a momentum burst and a snipe count buyers differently.
  const learned = [
    ...filterWords(t.filters),
    ...(Object.entries(t.rules ?? {}) as [SignalRule, BotFilters][]).map(([r, f]) => { const w = filterWords(f); return w.length ? `${T(RULE_NAME[r])}: ${w.join(', ')}` : '' }).filter(Boolean),
  ]
  return (
    <div className="at-tune">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])} · v{t.version}</Pill>
        <b style={{ fontFamily: 'var(--mono)' }}>{t.sizeUsd === null ? '—' : T(s === 'precision' ? 'about {v} on a Prime signal' : 'about {v} on a Core signal', { v: usd(t.sizeUsd) })}</b>
        {t.closed > 0 && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T('{n} trades, {w} won', { n: t.closed, w: t.winRate === null ? '—' : `${Math.round(t.winRate * 100)}%` })}</span>}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
        {T(s !== 'precision' && (t.plan ?? 1) >= 2
          ? 'Half sold at {tp}, the rest trails 25% under its peak with the stop at break-even · stop {sl} · out after {m} min unless moving, {x} min at most'
          : 'Sells all at {tp} · stop {sl} · out after {m} min unless moving, {x} min at most', {
          tp: pctMove(t.takeProfit), sl: pctMove(t.stopLoss), m: t.timeStopMin, x: t.maxHoldMin,
        })}
      </div>
      {learned.length > 0 && <div style={{ fontSize: '0.72rem', color: '#c4b5fd', marginTop: 2 }}>{T('Learned:')} {learned.join(' · ')}</div>}
    </div>
  )
}

/** What a live bot learned on the $2 plan for one strategy: its entry filters per kind of signal (the exits are the plan's). */
function DollarTuningLine({ s, t }: { s: 'snipe' | 'scalp' | 'second-leg'; t: StrategyTuning }) {
  const learned = (Object.entries(t.rules ?? {}) as [SignalRule, BotFilters][]).map(([r, f]) => { const w = filterWords(f); return w.length ? `${T(RULE_NAME[r])}: ${w.join(', ')}` : '' }).filter(Boolean)
  return (
    <div className="at-tune">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])} · v{t.version}</Pill>
        <span style={{ fontSize: '0.72rem', color: learned.length ? '#c4b5fd' : 'var(--text-muted)' }}>{learned.length ? `${T('Learned:')} ${learned.join(' · ')}` : T('Nothing learned yet: it takes every signal of this kind.')}</span>
      </div>
    </div>
  )
}

/** Every closed trade the bot has made (the engine keeps them all), newest first, with a CSV download. */
function TradeLog({ fetchTrades, name, total, fallback, navigate }: { fetchTrades: (limit: number, before?: number) => Promise<{ trades: BotPosition[]; total: number }>; name: string; total: number; fallback: BotPosition[]; navigate: (p: Page) => void }) {
  const [trades, setTrades] = useState<BotPosition[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchTrades(50).then(r => { if (alive) { setTrades(r.trades); setMore(r.trades.length < r.total); setError(null) } })
      .catch(() => { if (alive) { setTrades(null); setMore(false) } }) // an engine without the log: the account's own list below
    return () => { alive = false }
    // Refetched when the bot or its trade count changes (not for each render's new fetcher).
  }, [name, total])

  const loadMore = async () => {
    if (!trades?.length) return
    setBusy(true)
    try {
      const r = await fetchTrades(100, trades[trades.length - 1].closedAt ?? undefined)
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
        const r = await fetchTrades(500, before)
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

/** Every bot on ARCSENSE, best first: P&L, win rate, open positions. */
/** Every bot on ARCSENSE, live and paper apart (owner's request, 2026-09-30), best first: P&L, win rate, open positions. */
function Marketplace({ navigate, slug }: { navigate: (p: Page) => void; slug: string | null }) {
  const [sort, setSort] = useState<'pnl' | 'winrate' | 'new'>('pnl')
  const [mode, setMode] = useState<'live' | 'paper'>('live')
  const [data, setData] = useState<{ bots: MarketBot[]; total: number; counts?: { live: number; paper: number } } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (slug) return
    let alive = true
    // An engine from before ?mode= sends every bot: kept apart here too.
    const load = () => getMarket(sort, 100, mode).then(d => { if (alive) { setData({ ...d, bots: d.bots.filter(b => (b.mode === 'live') === (mode === 'live')) }); setError(null) } }).catch((e: Error) => { if (alive) setError(e.message) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [sort, mode, slug])
  // No live bots yet: open on paper.
  useEffect(() => { if (data?.counts && data.counts.live === 0 && mode === 'live' && data.counts.paper > 0) setMode('paper') }, [data?.counts, mode])
  if (slug) return <MarketBotPage slug={slug} navigate={navigate} />
  const live = mode === 'live'
  return (
    <Section title={T('Bot marketplace')}>
      <div className="at-market-modes" role="tablist">
        <button role="tab" aria-selected={live} className={`at-market-mode live${live ? ' on' : ''}`} onClick={() => setMode('live')}>
          <b>● {T('Live bots')}</b><span>{data?.counts ? data.counts.live : '…'} · {T('real USDC, their own wallets')}</span>
        </button>
        <button role="tab" aria-selected={!live} className={`at-market-mode${!live ? ' on' : ''}`} onClick={() => setMode('paper')}>
          <b>🧪 {T('Paper bots')}</b><span>{data?.counts ? data.counts.paper : '…'} · {T('virtual USDC, no real money')}</span>
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 6px' }}>
        {([['pnl', T('Top P&L')], ['winrate', T('Win rate')], ['new', T('Newest')]] as const).map(([k, l]) => <button key={k} className={`at-chip${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>{l}</button>)}
      </div>
      {error ? <Empty>⚠ {error}</Empty> : !data ? <Empty>{T('Loading…')}</Empty> : data.bots.length === 0
        ? <Empty>{live ? T('No live bots yet. A bot goes live once its paper record, or the team\'s, proves it.') : T('No bots yet. Create the first one under My bots.')}</Empty>
        : data.bots.map((b, i) => (
        <button key={b.slug} className="at-market-row" onClick={() => navigate({ name: 'signals', view: 'market', bot: b.slug })}>
          <span className="at-rank">{i + 1}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>🤖 {b.name}</b>
              {b.mode === 'live' ? <Pill color={LIVE_RED}>● {T('LIVE')}</Pill> : <Pill color="#64748b">{T('PAPER')}</Pill>}
              {b.running && <span style={{ color: '#22c55e', fontSize: '0.7rem' }}>● {T('Running')}</span>}
              {b.strategies.map(s => <Pill key={s} color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])}</Pill>)}
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {T('{n} trades, {w} won', { n: b.closed, w: b.winRate === null ? '—' : `${Math.round(b.winRate * 100)}%` })} · {T('{n} open', { n: b.positions.length })}{b.learned ? ` · ${T('learned {n} times', { n: b.learned })}` : ''}
              {b.mode === 'live' && b.paper ? ` · ${T('paper record {v}', { v: usd(b.paper.pnlUsd) })}` : ''}
              {b.mode === 'live' && b.wallet ? ` · ${shortAddr(b.wallet)}` : ''}
            </span>
          </span>
          <span style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
            <b style={{ color: b.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(b.pnlUsd)}</b>
            {b.pnlPct !== null && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{b.pnlPct >= 0 ? '+' : ''}{b.pnlPct.toFixed(1)}%</div>}
          </span>
        </button>
      ))}
    </Section>
  )
}

/** One bot's public page (/bots/<name>): its results, open positions valued now, recent trades and what it learned. */
function MarketBotPage({ slug, navigate }: { slug: string; navigate: (p: Page) => void }) {
  const [bot, setBot] = useState<MarketBotDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => getMarketBot(slug).then(b => { if (alive) { setBot(b); setError(null) } }).catch((e: Error) => { if (alive) setError(e.message) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 10_000)
    return () => { alive = false; clearInterval(id) }
  }, [slug])
  const back = <button className="link-btn" onClick={() => navigate({ name: 'signals', view: 'market' })}>← {T('All bots')}</button>
  if (error) return <Section title={slug}>{back}<Empty>⚠ {error}</Empty></Section>
  if (!bot) return <Empty>{T('Loading…')}</Empty>
  const link = `https://arcsense.site/bots/${encodeURIComponent(bot.slug)}`
  return (
    <>
      <div className="at-card" style={{ marginTop: 14 }}>
        {back}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <b className="at-bot-name">🤖 {bot.name}</b>
          {bot.mode === 'live' ? <Pill color={LIVE_RED}>● {T('LIVE')}</Pill> : <Pill color="#64748b">{T('PAPER')}</Pill>}
          <span className={`at-run${bot.running ? ' on' : ''}`}>{bot.running ? `● ${T('Running')}` : T('Stopped')}</span>
          {bot.strategies.map(s => <Pill key={s} color={STRATEGY_COLOR[s]}>{T(STRATEGY[s])}</Pill>)}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            <ShareBotButton className="at-share" get={() => cardFromMarket(bot)} mine={false} />
            <button className="link-btn" style={{ fontSize: '0.72rem' }} onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? T('Copied') : T('Copy link')}</button>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginTop: 10 }}>
          <Stat label={T('Profit / loss')} value={usd(bot.pnlUsd)} color={bot.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5'} sub={bot.pnlPct === null ? undefined : `${bot.pnlPct >= 0 ? '+' : ''}${bot.pnlPct.toFixed(1)}%`} />
          <Stat label={T('Win rate')} value={bot.winRate === null ? '—' : `${Math.round(bot.winRate * 100)}%`} sub={T('{n} closed trades', { n: bot.closed })} />
          <Stat label={T('Open positions')} value={String(bot.positions.length)} />
          <Stat label={T('Learned')} value={T('{n} changes', { n: bot.learned })} sub={bot.ready ? T('ready for live') : undefined} />
          {bot.mode === 'live' && bot.paper && <Stat label={T('Paper record')} value={usd(bot.paper.pnlUsd)} color={bot.paper.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5'} sub={T('{n} trades, {w} won', { n: bot.paper.closed, w: bot.paper.winRate === null ? '—' : `${Math.round(bot.paper.winRate * 100)}%` })} />}
        </div>
        {bot.wallet && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 8 }}>{T('Live wallet')}: <a href={`${EXPLORER}/address/${bot.wallet}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>{shortAddr(bot.wallet)} ↗</a></div>}
      </div>
      <Section title={T('Open positions') + ` · ${bot.positions.length}`}>
        {bot.positions.length === 0 ? <Empty>{T('No open positions right now.')}</Empty> : bot.positions.map(p => (
          <div key={`${p.token}:${p.openedAt}`} className="reward-row" style={{ flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="link-btn" onClick={() => navigate({ name: 'argus', address: p.token, pool: '' })} style={{ textDecoration: 'none' }}>${p.symbol}</button>
              <Pill color={STRATEGY_COLOR[p.strategy]}>{T(STRATEGY[p.strategy])}</Pill>
              {p.mode === 'live' && <Pill color={LIVE_RED}>{T('LIVE')}</Pill>}
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}><AgoText ts={p.openedAt} /></span>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              {T('in')} {price(p.entry)} · {usd(p.sizeUsd)} · {T('now')} {p.price === null ? '—' : price(p.price)}{' '}
              {p.pnlUsd !== null && <b style={{ color: p.pnlUsd >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(p.pnlUsd)}</b>}
            </div>
          </div>
        ))}
      </Section>
      <Section title={T('Recent trades')}>
        {bot.trades.length === 0 ? <Empty>{T('Nothing closed yet.')}</Empty> : bot.trades.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
      </Section>
      {bot.learnLog.length > 0 && (
        <Section title={T('What {name} learned', { name: bot.name })}>
          {bot.learnLog.map((n, i) => (
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
      )}
    </>
  )
}

/** Why the coins being watched aren't signals right now, by their main reason (GET /v1/bot/rejections). */
function RejectionsCard() {
  const [r, setR] = useState<RejectionStats | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => getRejections().then(x => { if (alive) setR(x) }).catch(() => {})
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  if (!r) return null
  const max = r.top[0]?.coins ?? 1
  return (
    <>
      {r.signals?.bots && r.signals.bots.signals > 0 && <SignalOutcomesCard title={T('Signals and bots, last 24h')} o={r.signals.bots} tradedText={T('traded by at least one bot')} />}
      {r.signals?.owner && r.signals.owner.signals > 0 && <SignalOutcomesCard title={T('Signals and the engine\'s own paper book, last 24h')} o={r.signals.owner} tradedText={T('traded')} />}
      {r.top.length > 0 && (
        <Section title={T('Why coins are passed over right now') + ` · ${r.watching}`}>
          {r.top.slice(0, 8).map(x => (
            <div key={x.key} className="at-reason-bar">
              <span className="at-reason-label">{T(x.label)}</span>
              <span className="at-reason-track"><span style={{ width: `${Math.max(3, (x.coins / max) * 100)}%` }} /></span>
              <span className="at-reason-n">{x.coins}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  )
}

/** What became of the signals: how many were traded, and why the rest weren't (GET /v1/bot/rejections `signals`). */
function SignalOutcomesCard({ title, o, tradedText }: { title: string; o: SignalOutcomes; tradedText: string }) {
  const max = o.reasons[0]?.count ?? 1
  return (
    <Section title={title}>
      <div style={{ fontSize: '0.8rem', marginBottom: 6 }}>
        {T('{n} signals · {t} {what}', { n: o.signals, t: o.traded, what: tradedText })}
      </div>
      {o.reasons.length > 0 && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4 }}>{T('Why not, each time a bot passed over one:')}</div>}
      {o.reasons.slice(0, 8).map(x => (
        <div key={x.key} className="at-reason-bar">
          <span className="at-reason-label">{T(x.label)}</span>
          <span className="at-reason-track"><span style={{ width: `${Math.max(3, (x.count / max) * 100)}%` }} /></span>
          <span className="at-reason-n">{x.count}</span>
        </div>
      ))}
    </Section>
  )
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
      {book === 'paper' && stats?.byRule && (
        <div className="at-byrule">
          <span className="at-byrule-h">{T('By signal rule')}</span>
          {([['momentum', T('Momentum burst')], ['snipe', T('Snipe')], ['volume', T('Volume spike')], ['second-leg', T('Dip rebound')]] as const).map(([k, l]) => {
            const r = stats.byRule![k]
            if (!r) return null // an engine from before volume spikes
            return (
              <span key={k}>
                <b>{l}</b> {r.closed ? `${T('{n} closed', { n: r.closed })} · ${r.winRate === null ? '—' : `${Math.round(r.winRate * 100)}%`} ${T('won')} · ` : `${T('none closed yet')} `}
                {r.closed > 0 && <span style={{ color: r.totalPnlUsd >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(r.totalPnlUsd)}</span>}
              </span>
            )
          })}
        </div>
      )}
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
        {s.probation && <span className="at-probation" title={s.probation.why}>{T('On probation: bots sit it out')}</span>}
        {s.quality?.level && !s.probation && <GradeBadge g={s.quality.level} title={[...(s.quality.levelWhy ?? []), ...(s.quality.review ? [s.quality.review] : [])].join(' · ')} />}
        {s.quality?.liveOk && !s.probation && <span className="at-live-ok" title={T('Live bots trade it')}>{T('LIVE')}</span>}
        {s.quality && !s.probation && <span className={`at-quality ${s.quality.grade}`} title={[...s.quality.parts, ...(s.quality.liveSpeed ? [T('at live speed: {n} replays, {a} a trade', { n: s.quality.liveSpeed.trades, a: s.quality.liveSpeed.avgPct === null ? '—' : `${s.quality.liveSpeed.avgPct}%` })] : [])].join(' · ')}>{s.quality.grade === 'live' ? T('Quality {q}', { q: s.quality.score }) : T('Paper only · {q}', { q: s.quality.score })}</span>}
        {s.strategy === 'scalp' && s.rule === 'snipe' && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }} title={T('The snipe rule fired, but the coin carries a risk, so it trades small and sells fast')}>{T('from a snipe on a risky coin')}</span>}
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
        {p.grade && <GradeBadge g={p.grade} />}
        {p.mode === 'live' && <Pill color={LIVE_RED}>{T('LIVE')}</Pill>}
        {p.mode === 'live' && p.crowd && p.crowd.bots > 1 && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title={T('Bots on this signal together bought {u} of its {c} cap', { u: usd(p.crowd.usd), c: usd(p.crowd.capUsd) })}>{T('#{r} of {n} bots', { r: p.crowd.rank + 1, n: p.crowd.bots })}</span>}
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}><AgoText ts={p.openedAt} /></span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: '0.76rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>{T('in')} {price(p.marketEntry)} · {usd(p.sizeUsd, p.sizeUsd < 100 ? 2 : 0)}</span>
        {sold.length > 0 && <span>{T('sold')} {sold.map(f => price(f.price)).join(', ')}</span>}
        {p.status === 'closed'
          ? <b style={{ color: (p.pnlUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(p.pnlUsd)} ({pnlPct! >= 0 ? '+' : ''}{pnlPct!.toFixed(0)}%) · {T(p.tp1Done && p.exitReason === 'stop' ? 'half taken, the rest at break-even' : EXIT[p.exitReason ?? ''] ?? p.exitReason ?? '')}{p.feeUsd ? <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> · {T('15% profit fee {v}', { v: usd(p.feeUsd, 4) })}</span> : null}</b>
          : <span style={{ color: 'var(--text)' }}>{p.tp1Done ? T('half sold, the rest trailing') : T('open')}</span>}
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

const TX_KIND: Record<string, string> = { buy: 'buy', sell: 'sell', approve: 'approval', fee: 'platform fee' }

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
          {l.limits && <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{limitsText(l.limits, l.sizing)}</div>}
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
          {l.limits && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>{limitsText(l.limits, l.sizing)}</div>}
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
      {sign && <TierGrant sign={sign} />}
    </div>
  )
}

/** The owner gives an account a tier for some days (a subscription paid some other way), signed by the owner's wallet. */
function TierGrant({ sign }: { sign: (message: string) => Promise<`0x${string}`> }) {
  const [email, setEmail] = useState('')
  const [tier, setTier] = useState<TierId>('t3')
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const n = Math.floor(Number(days))
  const valid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim()) && Number.isInteger(n) && n >= 0 && n <= 3_660
  const send = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await sendTierGrant({ action: 'grant-tier', email: email.trim().toLowerCase(), tier, days: n }, sign)
      setMsg({ ok: true, text: r.grant ? T('{e} has {t} until {d}.', { e: email.trim(), t: T(tierName(tier)), d: new Date(r.grant.until).toLocaleDateString() }) : T('The grant to {e} was taken back.', { e: email.trim() }) })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message?.split('\n')[0] ?? String(e) }) } finally { setBusy(false) }
  }
  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--adx-card-border)' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 800 }}>{T('Grant a tier')}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('For a subscription paid another way: the account gets the tier for that many days (0 takes a grant back). It counts once tiers are enforced.')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <input className="at-input" style={{ flex: '1 1 200px' }} value={email} placeholder={T('account email')} onChange={e => setEmail(e.target.value)} aria-label={T('account email')} />
        <select className="at-input" style={{ flex: '0 0 auto' }} value={tier} onChange={e => setTier(e.target.value as TierId)} aria-label={T('Tier')}>
          {ARCD_TIERS.filter(t => t.id !== 'free').map(t => <option key={t.id} value={t.id}>{T(t.name)}</option>)}
        </select>
        <input className="at-input" style={{ flex: '0 0 90px' }} value={days} inputMode="numeric" onChange={e => setDays(e.target.value.replace(/[^0-9]/g, ''))} aria-label={T('days')} />
        <button className="btn-ghost" disabled={busy || !valid} onClick={() => void send()}>{busy ? T('Waiting for your signature…') : T('Sign and grant')}</button>
      </div>
      {msg && <div style={{ marginTop: 6, fontSize: '0.74rem', color: msg.ok ? 'var(--green)' : '#fca5a5' }}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}</div>}
    </div>
  )
}

function limitsText(x: NonNullable<BotStatus['live']['limits']>, sizing?: BotStatus['live']['sizing']): string {
  const base = x.minTradeUsd !== undefined
    ? T('Limits: ${m} a trade now (from ${f}, growing with its profit, at most ${a}) · {o} open at once ({s} scalps) · stops for the day after a ${d} loss · keeps ${r} for gas · buys at most {b}% under the quote', { m: sizing?.tradeUsd ?? x.minTradeUsd, f: x.minTradeUsd, a: x.maxTradeUsd, o: x.maxOpen, s: x.maxOpenScalp, d: x.dailyLossUsd, r: x.reserveUsd, b: x.slippageBps / 100 })
    : T('Limits: up to ${a} a trade · {o} open at once ({s} scalps) · stops for the day after a ${d} loss · keeps ${r} for gas · buys at most {b}% under the quote', { a: x.maxTradeUsd, o: x.maxOpen, s: x.maxOpenScalp, d: x.dailyLossUsd, r: x.reserveUsd, b: x.slippageBps / 100 })
  const share = x.minTradeUsd !== undefined
    ? T('above ${f}, no trade over {p}% of the wallet (read before each buy)', { f: x.minTradeUsd, p: Math.round((x.maxShareOfBalance ?? 0) * 100) })
    : T('no trade over {p}% of the wallet (read before each buy)', { p: Math.round((x.maxShareOfBalance ?? 0) * 100) })
  const text = x.maxShareOfBalance ? `${base} · ${share}` : base
  return x.preflight ? `${text} · ${T('each buy simulated with its sale first (round trip at most {p}%)', { p: x.maxRoundTripPct ?? 20 })}` : text
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
