// The admin panel's signed-in views (pages/AdminPage.tsx; engine/src/admin/api.ts): who's online, the fee sweeper,
// ARCDEX's trades, the audit log and the runtime flags. Reads need the admin session; a change (a real sweep, a flag)
// also asks the admin's wallet to sign exactly that change.
import { useCallback, useEffect, useState } from 'react'
import { SITE_FLAGS, flagChangeMessage, sweepRunMessage, type FlagsState, type SiteFlag, type SweepItem, type SweepRun, type TradeSwitchState } from '../../../api/_marketProtocol'
import { adminFetch } from '../lib/adminSession'
import { applyRuntimeFlags, useFlag } from '../lib/flags'
import { t as T, N_ } from '../lib/i18n'
import { ARC_EXPLORER } from '../lib/platform'

type Sign = (message: string) => Promise<`0x${string}`>
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)
const when = (at: number) => new Date(at).toLocaleString()
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
const errText = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).split('\n')[0].slice(0, 220)

/** Loads `path` as the admin, again on demand. */
function useAdminData<T>(path: string, everyMs = 0) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => { setErr(''); adminFetch<T>(path).then(setData, e => setErr(errText(e))) }, [path])
  useEffect(() => {
    load()
    if (!everyMs) return
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, everyMs)
    return () => clearInterval(id)
  }, [load, everyMs])
  return { data, err, load }
}

function Head({ title, onReload }: { title: string; onReload: () => void }) {
  return (
    <div className="rt-health-h">
      <strong>{title}</strong>
      <button className="btn-ghost" onClick={onReload}>{T('Read again')}</button>
    </div>
  )
}
const Err = ({ text }: { text: string }) => (text ? <div role="status" style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{text}</div> : null)

// ── Overview ─────────────────────────────────────────────────────────────

interface Live {
  at: number
  traffic: { online: number; today: number; total: number } | null
  sections: Record<string, number> | null
  sockets: number
  admins: { address: string; issuedAt: number; expiresAt: number; ip: string; device: string }[]
  bots: { bots: number; running: number; live: number } | null
  trading: TradeSwitchState | null
}
const SECTION_LABEL: Record<string, string> = {
  trenches: N_('Trenches'), token: N_('Coin pages'), futures: N_('Futures'), predict: N_('Predict'), portfolio: N_('Portfolio'),
  swap: N_('Swap'), bridge: N_('Bridge'), admin: N_('Admin'), landing: N_('About page'), other: N_('Other pages'),
}

export function AdminOverview() {
  const { data, err, load } = useAdminData<Live>('/v1/admin/live', 15_000)
  const sections = Object.entries(data?.sections ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...sections.map(([, n]) => n))
  const off = data?.trading && (!data.trading.on || Object.keys(data.trading.venues).length > 0)
  return (
    <section className="spot-panel rt-health">
      <Head title={T('Live sessions')} onReload={load} />
      <Err text={err} />
      {data && (
        <>
          <div className="rt-health-grid">
            <Stat label={T('Online now')} value={String(data.traffic?.online ?? '—')} hint={T('pages that beat in the last 75 seconds')} />
            <Stat label={T('Visitors today')} value={String(data.traffic?.today ?? '—')} />
            <Stat label={T('Visitors in all')} value={String(data.traffic?.total ?? '—')} />
            <Stat label={T('Live connections')} value={String(data.sockets)} hint={T('open WebSocket connections to the engine')} />
            {data.bots && <Stat label={T('Bots')} value={`${data.bots.running} / ${data.bots.bots}`} hint={T('{n} live', { n: data.bots.live })} />}
            <Stat label={T('Trading')} value={off ? T('Off somewhere') : T('On everywhere')} tone={off ? 'down' : 'up'} />
          </div>
          {sections.length > 0 && (
            <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong style={{ fontSize: '0.8rem' }}>{T('Where they are')}</strong>
              {sections.map(([k, n]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr 40px', gap: 8, alignItems: 'center' }}>
                  <span>{T(SECTION_LABEL[k] ?? k)}</span>
                  <span style={{ height: 8, borderRadius: 4, background: 'var(--green)', width: `${(n / max) * 100}%`, opacity: 0.8 }} />
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
                </div>
              ))}
            </div>
          )}
          <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong style={{ fontSize: '0.8rem' }}>{T('Admins signed in')}</strong>
            {data.admins.map(a => (
              <span key={`${a.address}-${a.issuedAt}`} style={{ overflowWrap: 'anywhere' }}>{short(a.address)} · {T('since {when}', { when: when(a.issuedAt) })} · {a.ip} · {a.device || T('unknown device')}</span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'up' | 'down' }) {
  return (
    <div className={`rt-prov ${tone ?? 'up'}`}>
      <span className="rt-dot" aria-hidden />
      <div><strong>{label}</strong>{hint && <small>{hint}</small>}</div>
      <span className="rt-ms" style={{ fontSize: '1rem', fontWeight: 700 }}>{value}</span>
    </div>
  )
}

// ── The fee sweeper ──────────────────────────────────────────────────────

interface FeesView { plan: SweepItem[] | { error: string } | null; runs: SweepRun[] }
const SOURCE: Record<SweepItem['source'], string> = { 'bot-fees': N_('Fees bots owe'), relay: N_('Held at Relay'), jupiter: N_('Jupiter referral account') }
const STATUS: Record<SweepRun['status'], string> = { ok: N_('done'), partial: N_('partly done'), failed: N_('failed'), paused: N_('paused'), noop: N_('nothing to do') }

export function AdminSweeper({ sign, who, session }: { sign: Sign; who: `0x${string}` | null; session: string }) {
  const { data, err, load } = useAdminData<FeesView>('/v1/admin/fees')
  const [busy, setBusy] = useState<'dry' | 'real' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const sameWallet = !!who && who.toLowerCase() === session.toLowerCase()

  async function run(mode: 'dry' | 'real') {
    setMsg(null); setBusy(mode)
    try {
      let body: Record<string, unknown> = { mode }
      if (mode === 'real') {
        if (!confirm(T('Run the sweep for real? Fees bots owe are sent to the fee wallet; the rest is reported for you to claim.'))) return
        const at = Date.now()
        body = { mode, at, signature: await sign(sweepRunMessage(at)) }
      }
      const r = await adminFetch<{ run: SweepRun }>('/v1/admin/sweep', { method: 'POST', body })
      const ok = r.run.status === 'ok' || r.run.status === 'noop'
      setMsg({ ok, text: T('Sweep ({mode}): {status}. Sent {sent}; for you to claim {owner}.', { mode: mode === 'dry' ? T('dry run') : T('for real'), status: T(STATUS[r.run.status]), sent: usd(r.run.sentUsd), owner: usd(r.run.totals.ownerUsd) }) + (r.run.note ? ` ${r.run.note}` : '') })
      load()
    } catch (e) { setMsg({ ok: false, text: errText(e) }) } finally { setBusy(null) }
  }

  const plan = Array.isArray(data?.plan) ? data!.plan : null
  const planErr = data?.plan && !Array.isArray(data.plan) ? data.plan.error : ''
  return (
    <section className="spot-panel rt-health">
      <Head title={T('Fee sweeper')} onReload={load} />
      <p className="fx-fine" style={{ margin: 0 }}>{T('Fees are paid to the fee wallet inside each trade. The sweeper finds what still sits elsewhere: fees bots owe (sent to the fee wallet), and fees held at Relay or in Jupiter’s referral account (for you to claim with that wallet). It runs every day; a second run the same day does nothing.')}</p>
      <Err text={err || planErr} />
      {plan && (plan.length === 0 ? <span className="fx-fine">{T('Nothing is held outside the fee wallet.')}</span> : (
        <div className="rt-health-grid rt-fees">
          {plan.map(i => (
            <div key={i.id} className={`rt-prov ${i.below ? 'up' : i.action === 'owner' ? 'warn' : 'up'}`}>
              <span className="rt-dot" aria-hidden />
              <div>
                <strong>{T(SOURCE[i.source])}</strong>
                <small>{i.amount} {i.token}{i.usd !== null ? ` (${usd(i.usd)})` : ''} · {i.below ? T('under the threshold') : i.action === 'engine' ? T('the sweeper sends it') : T('for you to claim')}</small>
              </div>
              <small className="rt-detail">{short(i.holder)}{i.how ? ` · ${i.how}` : ''}</small>
            </div>
          ))}
        </div>
      ))}
      <div className="fx-fine" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn-ghost" disabled={!!busy} onClick={() => void run('dry')}>{busy === 'dry' ? T('Running…') : T('Dry run')}</button>
        <button className="btn-ghost" disabled={!!busy || !sameWallet} title={sameWallet ? undefined : T('Sign with the wallet you signed in with.')} onClick={() => void run('real')}>
          {busy === 'real' ? T('Check your wallet…') : T('Run for real')}
        </button>
      </div>
      {msg && <div role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)', fontSize: '0.82rem' }}>{msg.text}</div>}
      {!!data?.runs?.length && (
        <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <strong style={{ fontSize: '0.8rem' }}>{T('Recent runs')}</strong>
          {data.runs.slice(0, 10).map(r => (
            <span key={r.id} style={{ overflowWrap: 'anywhere' }}>
              {when(r.at)} · {r.mode === 'dry' ? T('dry run') : T('for real')} · {T(STATUS[r.status])} · {T('sent {sent}, to claim {owner}', { sent: usd(r.sentUsd), owner: usd(r.totals.ownerUsd) })} · {r.by === 'engine' ? T('scheduled') : short(r.by)}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Trades ───────────────────────────────────────────────────────────────

interface TradesView { source: 'supabase' | 'ledger'; rows: { tx: string; at: number; trader: string; token: string; side: 'buy' | 'sell'; usd: number; feeUsd: number; venue: string }[]; day: { trades: number; volumeUsd: number; feesUsd: number } }

export function AdminTrades() {
  const { data, err, load } = useAdminData<TradesView>('/v1/admin/trades', 30_000)
  return (
    <section className="spot-panel rt-health">
      <Head title={T('Trades')} onReload={load} />
      <Err text={err} />
      {data && (
        <>
          <div className="rt-health-grid">
            <Stat label={T('Trades, last 24 hours')} value={String(data.day.trades)} />
            {data.source === 'supabase' && <Stat label={T('Volume, last 24 hours')} value={usd(data.day.volumeUsd)} />}
            <Stat label={T('Fees, last 24 hours')} value={usd(data.day.feesUsd)} />
          </div>
          {data.source === 'ledger' && <span className="fx-fine">{T('From the fee ledger: the trades index (Supabase) isn’t readable from the engine, so each row is a fee received.')}</span>}
          <div style={{ overflowX: 'auto' }}>
            <table className="fx-fine" style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                <th>{T('When')}</th><th>{T('Side')}</th><th>{T('USD')}</th><th>{T('Fee')}</th><th>{T('Trader')}</th><th>{T('Coin')}</th><th>{T('Transaction')}</th>
              </tr></thead>
              <tbody>
                {data.rows.slice(0, 100).map(r => (
                  <tr key={`${r.tx}-${r.at}-${r.token}`} style={{ borderTop: '1px solid var(--adx-card-border)' }}>
                    <td style={{ padding: '4px 6px 4px 0', whiteSpace: 'nowrap' }}>{when(r.at)}</td>
                    <td style={{ color: r.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>{data.source === 'ledger' ? T('fee') : r.side === 'buy' ? T('Buy') : T('Sell')}</td>
                    <td>{data.source === 'ledger' ? '—' : usd(r.usd)}</td>
                    <td>{usd(r.feeUsd)}</td>
                    <td>{r.trader ? short(r.trader) : '—'}</td>
                    <td>{short(r.token)}</td>
                    <td>{/^0x[0-9a-fA-F]{64}$/.test(r.tx) ? <a href={`${ARC_EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">{short(r.tx)}</a> : short(r.tx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length === 0 && <span className="fx-fine">{T('No trades yet.')}</span>}
        </>
      )}
    </section>
  )
}

// ── The audit log ────────────────────────────────────────────────────────

interface AuditView { entries: { at: number; actor: string; action: string; detail: Record<string, unknown> }[] }
const ACTION: Record<string, string> = {
  'admin.login': N_('Signed in'), 'admin.logout': N_('Signed out'), 'admin.logout-all': N_('Signed every admin out'),
  'trade-switch': N_('Trade switch'), 'flag.change': N_('Flag changed'), 'sweep.run': N_('Fee sweep'),
}

export function AdminAudit() {
  const { data, err, load } = useAdminData<AuditView>('/v1/admin/audit?limit=200', 30_000)
  return (
    <section className="spot-panel rt-health">
      <Head title={T('Audit log')} onReload={load} />
      <p className="fx-fine" style={{ margin: 0 }}>{T('Every admin action, kept for good: the table refuses changes and deletions.')}</p>
      <Err text={err} />
      {data && (data.entries.length === 0 ? <span className="fx-fine">{T('Nothing yet.')}</span> : (
        <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {data.entries.map((e, i) => (
            <span key={`${e.at}-${i}`} style={{ overflowWrap: 'anywhere' }}>
              {when(e.at)} · <strong>{T(ACTION[e.action] ?? e.action)}</strong> · {e.actor === 'engine' ? T('the engine') : short(e.actor)}
              {Object.keys(e.detail ?? {}).length > 0 && <> · <code style={{ fontSize: '0.72rem' }}>{JSON.stringify(e.detail).slice(0, 240)}</code></>}
            </span>
          ))}
        </div>
      ))}
    </section>
  )
}

// ── Flags ────────────────────────────────────────────────────────────────

export function AdminFlags({ sign, who, session }: { sign: Sign; who: `0x${string}` | null; session: string }) {
  const { data, err, load } = useAdminData<FlagsState>('/v1/flags')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<SiteFlag | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const sameWallet = !!who && who.toLowerCase() === session.toLowerCase()
  const live: Record<SiteFlag, boolean> = {
    withdrawLimits: useFlag('withdrawLimits'), buyRisk: useFlag('buyRisk'), walletsCard: useFlag('walletsCard'), jupiter: useFlag('jupiter'), privy: useFlag('privy'), pushAlerts: useFlag('pushAlerts'),
  }

  async function change(f: SiteFlag, on: boolean) {
    setMsg(null)
    const r = reason.replace(/\s+/g, ' ').trim()
    if (r.length < 3) { setMsg({ ok: false, text: T('Write a reason first (3 characters or more): it goes in the audit log.') }); return }
    setBusy(f)
    try {
      const at = Date.now()
      const signature = await sign(flagChangeMessage(f, on, r, at))
      const res = await adminFetch<{ state?: FlagsState }>('/v1/admin/flags', { method: 'POST', body: { flag: f, on, reason: r, at, signature } })
      if (res.state) applyRuntimeFlags(res.state.flags)
      setMsg({ ok: true, text: T('{flag} is now {state}. Open pages pick it up within 5 minutes.', { flag: f, state: on ? T('on') : T('off') }) })
      setReason('')
      load()
    } catch (e) { setMsg({ ok: false, text: errText(e) }) } finally { setBusy(null) }
  }

  return (
    <section className="spot-panel rt-health">
      <Head title={T('Flags')} onReload={load} />
      <p className="fx-fine" style={{ margin: 0 }}>{T('Turn a feature on or off for everyone without a deploy. A flag set on Netlify (VITE_FLAG_…) still wins, and protections can only be turned on here: turning one off takes a deploy.')}</p>
      <Err text={err} />
      <div className="rt-health-grid rt-fees">
        {(Object.keys(SITE_FLAGS) as SiteFlag[]).map(f => {
          const set = data?.flags[f]
          const here = live[f]
          const protective = SITE_FLAGS[f].protective
          return (
            <div key={f} className={`rt-prov ${here ? 'up' : 'warn'}`}>
              <span className="rt-dot" aria-hidden />
              <div>
                <strong>{T(SITE_FLAGS[f].label)}</strong>
                <small>{f} · {T('in this browser: {state}', { state: here ? T('on') : T('off') })} · {set === undefined ? T('not set here (the default)') : T('set here: {state}', { state: set ? T('on') : T('off') })}</small>
              </div>
              <button className="btn-ghost" disabled={!!busy || !sameWallet || (protective && here)} title={protective && here ? T('A protection: turning it off takes a deploy.') : !sameWallet ? T('Sign with the wallet you signed in with.') : undefined}
                onClick={() => void change(f, !here)}>
                {busy === f ? T('Check your wallet…') : here ? T('Turn off') : T('Turn on')}
              </button>
            </div>
          )
        })}
      </div>
      <label className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {T('Reason (kept in the audit log)')}
        <input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} placeholder={T('e.g. Jupiter incident, using Relay')}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: 'var(--bg-3)', color: 'inherit' }} />
      </label>
      {msg && <div role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)', fontSize: '0.82rem' }}>{msg.text}</div>}
      {!!data?.history?.length && (
        <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <strong style={{ fontSize: '0.8rem' }}>{T('Recent changes')}</strong>
          {data.history.slice(0, 10).map(h => <span key={`${h.at}-${h.flag}`}>{when(h.at)} · {h.flag} · {h.on ? T('on') : T('off')} · {h.reason}</span>)}
        </div>
      )}
    </section>
  )
}
