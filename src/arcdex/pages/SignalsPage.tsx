// Signals: what the market engine's signal bot sees and does (engine/src/bot).
// Every signal opens a paper position (simulated at live prices, no money
// moves); in live mode the bot wallet also trades it with real money. The
// owner's wallet switches modes (a signed message); everyone sees the mode,
// the bot wallet, its trades and both sets of results. The numbers are
// measured results, never a promise.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import type { BotControl, BotPosition, BotStatus, SafetyCheck, TradeSignal } from '../../../api/_marketProtocol'
import { getLaunchpadColor } from '../api/radardex'
import { engineEnabled, getBotPositions, getBotStats, getBotStatus, getSignals, marketStream, sendBotControl, type BotStats, type BotStatsResponse } from '../api/marketStream'
import { AgoText } from '../components/Ago'
import type { Page } from '../App'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { t as T } from '../lib/i18n'
import { shortAddr, useEmbeddedAddress } from '../lib/identity'

type Tab = 'all' | 'snipe' | 'scalp' | 'secondLeg'
type Book = 'paper' | 'live'
const EXPLORER = 'https://explorer.arc.io'
const LIVE_RED = '#ef4444'

const usd = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const price = (n: number) => n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`
const big = (n: number | null) => n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
const STRATEGY: Record<TradeSignal['strategy'], string> = { snipe: 'Snipe', scalp: 'Fast scalp', 'second-leg': 'Second leg' }
const STRATEGY_COLOR: Record<TradeSignal['strategy'], string> = { snipe: '#3b82f6', scalp: '#f59e0b', 'second-leg': '#a855f7' }

export default function SignalsPage({ navigate }: { navigate: (p: Page) => void }) {
  const [stats, setStats] = useState<BotStatsResponse | null>(null)
  const [signals, setSignals] = useState<TradeSignal[]>([])
  const [positions, setPositions] = useState<BotPosition[]>([])
  const [tab, setTab] = useState<Tab>('all')
  const [book, setBook] = useState<Book>('paper')
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [down, setDown] = useState(false)

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    // Engines from before live trading have no /v1/bot/status: the page still works without it.
    const load = () => Promise.all([getBotStats(), getSignals(100), getBotPositions('all', 200), getBotStatus().catch(() => null)])
      .then(([s, sig, pos, st]) => { if (!alive) return; setStats(s); setSignals(sig); setPositions(pos); setStatus(st); setDown(false) })
      .catch(() => { if (alive) setDown(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    const off = marketStream.subscribe({ channel: 'signals' }, m => {
      if (m.t === 'SIGNAL') setSignals(list => [m.d, ...list.filter(x => x.id !== m.d.id)].slice(0, 100))
      if (m.t === 'BOT_POSITION') setPositions(list => [m.d, ...list.filter(x => x.id !== m.d.id)])
    })
    return () => { alive = false; clearInterval(id); off() }
  }, [])

  const set = book === 'live' ? stats?.live : stats
  const shown: BotStats | null = set ? set[tab] ?? null : null
  const mine = useMemo(() => positions.filter(p => (p.mode === 'live') === (book === 'live')), [positions, book])
  const open = useMemo(() => mine.filter(p => p.status === 'open'), [mine])
  const closed = useMemo(() => mine.filter(p => p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)), [mine])
  const mode = status?.mode ?? stats?.mode ?? 'paper'

  return (
    <div className="token-page content-page">
      <h2 className="page-h" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {T('Signals')}
        {engineEnabled && !down && stats && <ModeBadge mode={mode} />}
      </h2>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {T('New coins that pass every hard safety check and show real buying, from every Arc launchpad.')}{' '}
        <b style={{ color: 'var(--text)' }}>{T('Paper trading:')}</b>{' '}{T('each signal opens a simulated position at the live price, with real costs. No money moves.')}{' '}
        <b style={{ color: LIVE_RED }}>{T('Live mode:')}</b>{' '}{T('the bot wallet also buys and sells each signal with real USDC, within hard limits.')}
      </div>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        <Pill color={STRATEGY_COLOR.scalp}>{T('Fast scalp')}</Pill>{' '}
        {T('Coins with a risk flag (the creator holds a big stake, launches coin after coin, or copies a ticker) are traded small and fast: a fifth of the size, most of it sold at +30%, out the moment the creator sells, never held over 15 minutes.')}
      </div>
      <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', fontSize: '0.74rem', color: '#fcd34d', lineHeight: 1.45 }}>
        {T('These are measured results, not a promise: no strategy can guarantee a win rate, and most new coins go to zero. Not financial advice.')}
      </div>

      {!engineEnabled || down ? (
        <Empty>{T("The signal engine isn't reachable right now. Signals and results appear here when it's back.")}</Empty>
      ) : (
        <>
          {status && <BotPanel status={status} onStatus={setStatus} navigate={navigate} />}

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
          {stats && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>{T('Watching {n} coins launched in the last 48 hours.', { n: stats.watching })}</div>}

          <Section title={T('Live signals')}>
            {signals.length === 0 ? <Empty>{T('No signals yet. Most launches fail a safety check; a signal appears the moment one passes them all.')}</Empty>
              : signals.map(s => <SignalRow key={s.id} s={s} navigate={navigate} />)}
          </Section>

          <Section title={(book === 'live' ? T('Open live positions') : T('Open positions')) + ` · ${open.length}`}>
            {open.length === 0 ? <Empty>{T('No open positions.')}</Empty> : open.map(p => <PositionRow key={p.id} p={p} navigate={navigate} />)}
          </Section>

          <Section title={(book === 'live' ? T('Closed live positions') : T('Closed positions')) + ` · ${closed.length}`}>
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

const EXIT: Record<string, string> = { tp1: 'took profit', trail: 'trailing stop', stop: 'stop loss', time: 'time stop', safety: 'failed a safety check', creator: 'the creator sold', manual: 'sold by the owner' }

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
        <span>{T('in')} {price(p.marketEntry)} · {usd(p.sizeUsd, 0)}</span>
        {sold.length > 0 && <span>{T('sold')} {sold.map(f => price(f.price)).join(', ')}</span>}
        {p.status === 'closed'
          ? <b style={{ color: (p.pnlUsd ?? 0) >= 0 ? 'var(--green)' : '#fca5a5' }}>{usd(p.pnlUsd)} ({pnlPct! >= 0 ? '+' : ''}{pnlPct!.toFixed(0)}%) · {T(EXIT[p.exitReason ?? ''] ?? p.exitReason ?? '')}</b>
          : <span style={{ color: 'var(--text)' }}>{p.tp1Done ? T('profit taken, trailing') : T('open')}</span>}
      </div>
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
