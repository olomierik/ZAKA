// /admin → Analytics (owner, 2026-10-17: "the number of users who have logged in, who are trading, how much has been
// traded, and the fees we've collected; monitor how the money the application is performing"). Read from the engine's
// GET /v1/admin/analytics (engine/src/analytics.ts) with the admin session, again every minute.
//
// The same view for everyone (`pub`, pages/StatsPage.tsx at /analytics; owner, 2026-10-17: "put it there for everyone
// to see the number of users, wallets, volume traded, fees collected"): GET /v1/stats, the totals and the daily
// series, with no wallet address, transaction or check counts in it.
import { useCallback, useEffect, useState } from 'react'
import { adminFetch } from '../lib/adminSession'
import { engineApiUrl } from '../api/marketStream'
import { t as T, N_ } from '../lib/i18n'

interface DayRow { day: string; signIns: number; newUsers: number; traders: number; trades: number; volumeUsd: number; feesUsd: number }
export interface AnalyticsReport {
  at: number
  days: number
  visitors: { online: number; today: number; total: number } | null
  users: { total: number; new24h: number; active24h: number; active7d: number; byKind: Record<string, number> }
  traders: { total: number; d1: number; d7: number; d30: number }
  trades: { total: number; d1: number; d7: number; d30: number; volume: { total: number; d1: number; d7: number; d30: number }; byChain: Record<string, { trades: number; volumeUsd: number }>; byVenue: Record<string, { trades: number; volumeUsd: number }> }
  fees: { total: number; d1: number; d7: number; d30: number; bySource: Record<string, number>; reportedByTrades?: number }
  /** Admin only. */
  funnel?: { visitorsToday: number | null; signedIn24h: number; traded24h: number }
  checks?: Record<'pending' | 'ok' | 'failed' | 'mismatch' | 'unverified', number>
  daily: DayRow[]
  topTraders?: { address: string; trades: number; volumeUsd: number; feesUsd: number }[]
  /** Public rows carry no address, transaction or status. */
  latest: { chain: string; venue: string; side: 'buy' | 'sell' | string; address?: string; usd: number; feeUsd?: number; coin: string | null; tx?: string; at: number; status?: string }[]
}

async function publicStats(days: number): Promise<AnalyticsReport> {
  if (!engineApiUrl) throw new Error(T('The stats aren’t available on this build.'))
  const r = await fetch(`${engineApiUrl}/v1/stats?days=${days}`, { signal: AbortSignal.timeout(15_000) })
  const j = await r.json().catch(() => null) as (AnalyticsReport & { error?: string }) | null
  if (!r.ok || !j) throw new Error(j?.error ?? T('The stats didn’t load (the engine answered {s}).', { s: r.status }))
  return j
}

const KIND_LABEL: Record<string, string> = { privy: N_('Email or social (Privy)'), wallet: N_('Wallet app'), trading: N_('Trading wallet'), solana: N_('Solana wallet') }
const CHAIN_LABEL: Record<string, string> = { arc: 'Arc', robinhood: 'Robinhood Chain', solana: 'Solana', bnb: 'BNB Chain', base: 'Base', arbitrum: 'Arbitrum', ethereum: 'Ethereum', hyperliquid: 'Hyperliquid', starknet: 'Starknet' }
const STATUS_LABEL: Record<string, string> = { ok: N_('counted'), pending: N_('checking'), failed: N_('failed'), mismatch: N_('not this wallet'), unverified: N_('not checkable') }
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
const big = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : usd(n))
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 220)

/** Bars for one series of the daily rows (oldest left), with its total for the period. */
function DayBars({ rows, pick, title, money }: { rows: DayRow[]; pick: (r: DayRow) => number; title: string; money?: boolean }) {
  const vals = rows.map(pick)
  const max = Math.max(1e-9, ...vals)
  const total = vals.reduce((s, v) => s + v, 0)
  return (
    <div className="an-chart">
      <div className="an-chart-h"><strong>{title}</strong><span>{money ? big(total) : total.toLocaleString()}</span></div>
      <svg viewBox={`0 0 ${Math.max(1, rows.length) * 10} 60`} preserveAspectRatio="none" role="img" aria-label={title}>
        {vals.map((v, i) => (
          <rect key={rows[i].day} x={i * 10 + 1} y={60 - (v / max) * 58} width={8} height={v > 0 ? Math.max(1.5, (v / max) * 58) : 0} rx={1.5}>
            <title>{`${rows[i].day}: ${money ? usd(v) : v}`}</title>
          </rect>
        ))}
      </svg>
      <div className="an-chart-x"><span>{rows[0]?.day.slice(5)}</span><span>{rows[rows.length - 1]?.day.slice(5)}</span></div>
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'up' }) {
  return <div className={`an-kpi${tone ? ` ${tone}` : ''}`}><span>{label}</span><b>{value}</b><small>{sub}</small></div>
}

export default function AdminAnalytics({ pub = false }: { pub?: boolean } = {}) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<AnalyticsReport | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    setErr('')
    ;(pub ? publicStats(days) : adminFetch<AnalyticsReport>(`/v1/admin/analytics?days=${days}`)).then(setData, e => setErr(errText(e)))
  }, [days, pub])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, pub ? 30_000 : 60_000)
    return () => clearInterval(id)
  }, [load])

  const chains = Object.entries(data?.trades.byChain ?? {}).sort((a, b) => b[1].volumeUsd - a[1].volumeUsd)
  const sources = Object.entries(data?.fees.bySource ?? {}).sort((a, b) => b[1] - a[1])
  return (
    <section className="spot-panel rt-health an" data-testid={pub ? 'public-stats' : 'admin-analytics'}>
      <div className="rt-health-h">
        <strong>{pub ? T('Live, from the chain') : T('Analytics')}</strong>
        <span style={{ flex: 1 }} />
        <div className="an-days">{[7, 30, 90].map(d => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{T('{n} days', { n: d })}</button>)}</div>
        <button className="btn-ghost" onClick={load}>{T('Read again')}</button>
      </div>
      {err && <div role="status" style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{err}</div>}
      {!data && !err && <div className="fx-fine">{T('Loading…')}</div>}
      {data && (
        <>
          <div className="an-kpis">
            <Kpi label={pub ? T('Users (wallets)') : T('Users')} value={data.users.total.toLocaleString()} sub={T('{n} new in 24h · {a} active in 7 days', { n: data.users.new24h, a: data.users.active7d })} />
            <Kpi label={T('Traders')} value={data.traders.total.toLocaleString()} sub={T('{d1} today · {d7} in 7 days', { d1: data.traders.d1, d7: data.traders.d7 })} />
            <Kpi label={T('Volume traded')} value={big(data.trades.volume.total)} sub={T('{d1} today · {d7} in 7 days', { d1: big(data.trades.volume.d1), d7: big(data.trades.volume.d7) })} />
            <Kpi label={T('Trades')} value={data.trades.total.toLocaleString()} sub={T('{d1} today · {d7} in 7 days', { d1: data.trades.d1, d7: data.trades.d7 })} />
            <Kpi label={T('Fees collected')} value={usd(data.fees.total)} sub={T('{d1} today · {d30} in 30 days', { d1: usd(data.fees.d1), d30: usd(data.fees.d30) })} tone="up" />
            <Kpi label={T('Online now')} value={String(data.visitors?.online ?? '—')} sub={T('{n} visitors today', { n: data.visitors?.today ?? '—' })} />
          </div>

          {data.funnel && <div className="an-funnel">
            <span><b>{data.funnel.visitorsToday ?? '—'}</b> {T('visitors today')}</span><i aria-hidden>→</i>
            <span><b>{data.funnel.signedIn24h}</b> {T('signed in')}</span><i aria-hidden>→</i>
            <span><b>{data.funnel.traded24h}</b> {T('traded')}</span>
          </div>}

          <div className="an-charts">
            <DayBars rows={data.daily} pick={r => r.volumeUsd} title={T('Volume per day')} money />
            <DayBars rows={data.daily} pick={r => r.feesUsd} title={T('Fees per day')} money />
            <DayBars rows={data.daily} pick={r => r.traders} title={T('Traders per day')} />
            <DayBars rows={data.daily} pick={r => r.newUsers} title={T('New users per day')} />
          </div>

          <div className="an-cols">
            <div>
              <strong className="an-h">{T('By chain')}</strong>
              {chains.length === 0 && <div className="fx-fine">{T('No trades counted yet.')}</div>}
              {chains.map(([c, v]) => <div key={c} className="an-row"><span>{CHAIN_LABEL[c] ?? c}</span><span>{T('{n} trades', { n: v.trades })}</span><b>{big(v.volumeUsd)}</b></div>)}
            </div>
            <div>
              <strong className="an-h">{T('Fees by source')}</strong>
              {sources.length === 0 && <div className="fx-fine">{T('No fees in the ledger yet.')}</div>}
              {sources.map(([s, v]) => <div key={s} className="an-row"><span>{s}</span><b>{usd(v)}</b></div>)}
            </div>
            <div>
              <strong className="an-h">{T('How users sign in')}</strong>
              {Object.keys(data.users.byKind).length === 0 && <div className="fx-fine">{T('No sign-ins yet.')}</div>}
              {Object.entries(data.users.byKind).map(([k, n]) => <div key={k} className="an-row"><span>{T(KIND_LABEL[k] ?? k)}</span><b>{n}</b></div>)}
            </div>
          </div>
          {data.checks && <div className="fx-fine">{T('Trades checked on their chains: {ok} counted, {p} waiting, {f} failed or not from that wallet, {u} not checkable.', { ok: data.checks.ok, p: data.checks.pending, f: data.checks.failed + data.checks.mismatch, u: data.checks.unverified })}</div>}

          {!!data.topTraders?.length && (
            <>
              <strong className="an-h">{T('Top traders')}</strong>
              <div className="an-table">
                {data.topTraders.map(t => <div key={t.address} className="an-row"><code>{short(t.address)}</code><span>{T('{n} trades', { n: t.trades })}</span><b>{big(t.volumeUsd)}</b><span>{usd(t.feesUsd)}</span></div>)}
              </div>
            </>
          )}
          {data.latest.length > 0 && (
            <>
              <strong className="an-h">{pub ? T('Latest trades') : T('Latest trades from the site')}</strong>
              <div className="an-table">
                {data.latest.slice(0, 20).map(t => (
                  <div key={`${t.chain}${t.tx ?? ''}${t.at}${t.usd}`} className="an-row">
                    <span className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? T('Buy') : T('Sell')}</span>
                    <span>{CHAIN_LABEL[t.chain] ?? t.chain} · {t.venue}</span>
                    <b>{usd(t.usd)}</b>
                    {t.address && <code>{short(t.address)}</code>}
                    {t.status && <span className={`an-st ${t.status}`}>{T(STATUS_LABEL[t.status] ?? t.status)}</span>}
                    <span>{new Date(t.at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="fx-fine">{T('Users are wallets used on the site. A trade counts once its transaction is found on its chain, sent by that wallet; ARCDEX’s Arc router trades are read from the chain directly. Fees are the fee ledger’s, read on-chain.')}</div>
        </>
      )}
    </section>
  )
}
