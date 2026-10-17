// /admin (not linked anywhere). Sign-in with an admin wallet (lib/adminSession.ts, engine/src/admin) opens Overview (who's
// online), the fee sweeper, Trades, the Audit log and Flags (components/AdminViews.tsx). Without signing in:
//
// Kill switch: the trade switch, the build pack's kill switch (lib/tradeSwitch.ts,
// engine/src/site/tradeSwitch.ts). Anyone can open it and see what's off; only an admin wallet (ADMIN_EVM_ADDRESSES on the
// engine, else the owner's) can change it, by signing the change. Each change is applied at once and written to the
// engine's append-only audit log. GLOBAL_KILL_SWITCH / KILL_SWITCH_VENUES on Railway do the same without a wallet.
//
// Fees: every fee ARCDEX takes and where it goes (D2/D4 in docs/REPO_MAP.md). The Arc routers' fee is on-chain; their
// owner lowers it to 0.5% from here (lib/routerFees.ts), the change simulated as that wallet before it signs.
//
// Fee ledger: the engine's append-only record of every fee it read on-chain, and its nightly reconciliation against
// the chain (engine/src/fees, GET /v1/fees/summary). Read-only.
import { useCallback, useEffect, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { TRADE_VENUES, TRADE_VENUE_LABEL, type TradeScope } from '../../../api/_marketProtocol'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { t as T, N_ } from '../lib/i18n'
import { useEmbeddedAddress } from '../lib/identity'
import { readTradeSwitch, sendTradeSwitch, useTradeSwitch } from '../lib/tradeSwitch'
import { engineApiUrl } from '../api/marketStream'
import { BRIDGE_FEE_BPS } from '../lib/bridgeKit'
import { DEFAULT_FEE_WALLET, FEE_WALLET, SPOT_FEE_BPS, ARC_EXPLORER } from '../lib/platform'
import { atTarget, readRouterFee, routersInForce, setRouterFee, TARGET_FEE_BPS, type RouterFee } from '../lib/routerFees'
import { pct } from '../lib/routerInfo'
import { SN_FEE } from '../starknet/net'
import { JUP_REFERRAL } from '../lib/jupiter'
import { adminSignIn, adminSignOut, useAdminSession } from '../lib/adminSession'
import { privyIdentityFor, usePrivyState } from '../privy/state'
import AdminAnalytics from '../components/AdminAnalytics'
import { AdminAudit, AdminCopy, AdminFlags, AdminOverview, AdminReports, AdminSweeper, AdminTrades } from '../components/AdminViews'

const SCOPES: TradeScope[] = ['all', ...TRADE_VENUES]
const label = (s: TradeScope) => (s === 'all' ? T('Every venue') : TRADE_VENUE_LABEL[s])
const ago = (at: number) => new Date(at).toLocaleString()

type Tab = 'analytics' | 'overview' | 'fees' | 'trades' | 'copy' | 'reports' | 'audit' | 'flags' | 'switch'
const TABS: { k: Tab; label: string }[] = [
  { k: 'analytics', label: N_('Analytics') }, { k: 'overview', label: N_('Overview') }, { k: 'fees', label: N_('Fees') }, { k: 'trades', label: N_('Trades') },
  { k: 'copy', label: N_('Copy trading') }, { k: 'reports', label: N_('Reports') }, { k: 'audit', label: N_('Audit log') }, { k: 'flags', label: N_('Flags') }, { k: 'switch', label: N_('Kill switch') },
]

export default function AdminPage({ initialTab }: { initialTab?: Tab } = {}) {
  const embedded = useEmbeddedAddress()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const privy = usePrivyState()
  // Someone signed in with Privy signs with its wallet (the connected one): that's how an admin email signs in.
  const privyWallet = privy.authenticated && !!address && privy.evm?.toLowerCase() === address.toLowerCase()
  const [signer, setSigner] = useState<'embedded' | 'connected'>(embedded && !privyWallet ? 'embedded' : 'connected')
  const [tab, setTab] = useState<Tab>(initialTab ?? 'analytics')
  const who = signer === 'embedded' ? embedded : (address ?? null)
  const sign = useCallback(async (message: string) => (signer === 'embedded' ? getEmbeddedWalletClient().signMessage({ message }) : signMessageAsync({ message })), [signer, signMessageAsync])
  const session = useAdminSession()

  return (
    <div className="content-page rt-page" style={{ '--page-w': '960px' } as React.CSSProperties}>
      <h1 className="page-h" style={{ marginBottom: 4 }}>{T('Admin')}</h1>
      <p className="rt-sub">{T('Sign in with an admin wallet to see who’s online, fees, trades and the audit log, and to change flags or run the fee sweeper. Every change asks for your wallet’s signature again and is kept in the audit log. The kill switch and the routers’ fee work without signing in.')}</p>
      <AdminSignInBar embedded={embedded} address={address ?? null} signer={signer} setSigner={setSigner} who={who} sign={sign} />
      <div className="at-tabs" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map(x => (
          <button key={x.k} role="tab" aria-selected={tab === x.k} className={`at-tab${tab === x.k ? ' on' : ''}`} onClick={() => setTab(x.k)}>{T(x.label)}</button>
        ))}
      </div>
      {tab === 'analytics' && (session ? <AdminAnalytics /> : <SignInFirst />)}
      {tab === 'overview' && (session ? <AdminOverview /> : <SignInFirst />)}
      {tab === 'fees' && (
        <>
          <AdminFees embedded={embedded} address={address ?? null} signer={signer} />
          {!!engineApiUrl && <AdminFeeLedger />}
          {session ? <AdminSweeper sign={sign} who={who} session={session.address} /> : <SignInFirst what={T('the fee sweeper')} />}
        </>
      )}
      {tab === 'trades' && (session ? <AdminTrades /> : <SignInFirst />)}
      {tab === 'copy' && (session ? <AdminCopy /> : <SignInFirst />)}
      {tab === 'reports' && (session ? <AdminReports sign={sign} who={who} session={session.address} /> : <SignInFirst />)}
      {tab === 'audit' && (session ? <AdminAudit /> : <SignInFirst />)}
      {tab === 'flags' && (session ? <AdminFlags sign={sign} who={who} session={session.address} /> : <SignInFirst />)}
      {tab === 'switch' && <KillSwitch who={who} sign={sign} />}
    </div>
  )
}

/** Who signs, and the admin session. */
function AdminSignInBar({ embedded, address, signer, setSigner, who, sign }: { embedded: `0x${string}` | null; address: `0x${string}` | null; signer: 'embedded' | 'connected'; setSigner: (s: 'embedded' | 'connected') => void; who: `0x${string}` | null; sign: (m: string) => Promise<`0x${string}`> }) {
  const session = useAdminSession()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(id) }, [])
  async function signIn() {
    if (!who) return
    setBusy(true); setMsg('')
    // Signing with the Privy wallet: its identity token goes too, so an admin email signs in (engine: admin/privyIdentity.ts).
    try { await adminSignIn(who, sign, await privyIdentityFor(who)) } catch (e) {
      const why = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message).split('\n')[0] : String(e)
      // The engine's admins are ADMIN_EVM_ADDRESSES and ADMIN_EMAILS on Railway: say which wallet tried, and how else.
      setMsg(/not an admin/.test(why) ? T('{wallet} isn’t an admin wallet. Sign in with Privy under an admin email and sign with its wallet, or add the wallet to ADMIN_EVM_ADDRESSES on Railway (arcdex-engine).', { wallet: who }) : why)
    } finally { setBusy(false) }
  }
  const mins = session ? Math.max(0, Math.round((session.expiresAt - Date.now()) / 60_000)) : 0
  return (
    <section className="spot-panel rt-health" style={{ marginBottom: 12 }}>
      <div className="fx-fine" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {session ? (
          <>
            <span className="rt-dot up" aria-hidden />
            <strong style={{ fontSize: '0.86rem' }}>{T('Signed in as {who}', { who: short(session.address) })}</strong>
            <span>{T('ends in {n} min', { n: mins })}</span>
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={() => void adminSignOut()}>{T('Sign out')}</button>
            <button className="btn-ghost" title={T('Ends every admin session, yours included (if a key or device may be compromised).')} onClick={() => { if (confirm(T('Sign every admin out now?'))) void adminSignOut(true) }}>{T('Sign out every admin')}</button>
          </>
        ) : (
          <>
            {T('Sign with')}
            <select value={signer} onChange={e => setSigner(e.target.value as 'embedded' | 'connected')} style={{ padding: '4px 8px', borderRadius: 8, background: 'var(--bg-3)', color: 'inherit', border: '1px solid var(--adx-card-border)' }}>
              <option value="embedded" disabled={!embedded}>{T('Trading wallet')}{embedded ? ` (${short(embedded)})` : ''}</option>
              <option value="connected" disabled={!address}>{T('Connected wallet')}{address ? ` (${short(address)})` : ''}</option>
            </select>
            <button className="btn-primary" disabled={!who || busy || !engineApiUrl} onClick={() => void signIn()} style={{ padding: '6px 14px' }}>
              {busy ? T('Check your wallet…') : T('Sign in as admin')}
            </button>
            {!who && <span>{T('Unlock the trading wallet or connect a wallet to sign.')}</span>}
          </>
        )}
      </div>
      {msg && <div role="status" style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{msg}</div>}
    </section>
  )
}

function SignInFirst({ what }: { what?: string }) {
  return (
    <section className="spot-panel rt-health">
      <span className="fx-fine">{what ? T('Sign in as an admin to see {what}.', { what }) : T('Sign in as an admin to see this.')}</span>
    </section>
  )
}

/** The trade switch: anyone sees what's off; an admin wallet signs each change. */
function KillSwitch({ who, sign }: { who: `0x${string}` | null; sign: (m: string) => Promise<`0x${string}`> }) {
  const state = useTradeSwitch()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<TradeScope | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function flip(scope: TradeScope, on: boolean) {
    setMsg(null)
    const r = reason.replace(/\s+/g, ' ').trim()
    if (r.length < 3) { setMsg({ ok: false, text: T('Write a reason first (3 characters or more): it goes in the audit log and on the banner.') }); return }
    setBusy(scope)
    try {
      await sendTradeSwitch({ scope, on, reason: r }, sign)
      setMsg({ ok: true, text: on ? T('Trading is back on: {where}.', { where: label(scope) }) : T('Trading is off: {where}. New trades there are refused before signing.', { where: label(scope) }) })
      setReason('')
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(null) }
  }

  const offOf = (s: TradeScope) => (s === 'all' ? state?.all ?? null : state?.venues?.[s] ?? null)
  const forced = (s: TradeScope) => !!state && (s === 'all' ? state.env.all : state.env.venues.includes(s))

  return (
    <>
      <p className="rt-sub">{T('Turn trading off everywhere or on one venue. New trades there are refused before anything is signed; withdrawals, transfers and the bridge keep working, and Hyperliquid positions can still be closed. Only an admin wallet can change it, and every change is kept in the audit log.')}</p>
      {!engineApiUrl ? <section className="spot-panel rt-health"><span>{T('The engine isn’t configured on this build, so the switch can’t be read.')}</span></section> : (
        <section className="spot-panel rt-health">
          <div className="rt-health-h">
            <strong>{!state ? T('Reading…') : state.on && !Object.keys(state.venues).length ? T('Trading is on everywhere') : T('Trading is off somewhere')}</strong>
            <button className="btn-ghost" onClick={() => { void readTradeSwitch() }}>{T('Read again')}</button>
          </div>
          <div className="rt-health-grid">
            {SCOPES.map(s => {
              const off = offOf(s)
              return (
                <div key={s} className={`rt-prov ${off ? 'down' : 'up'}`}>
                  <span className="rt-dot" aria-hidden />
                  <div><strong>{label(s)}</strong>{off && <small className="rt-detail">{off.reason}</small>}</div>
                  <button className="btn-ghost" disabled={!!busy || !who || forced(s)} title={forced(s) ? T('Set on the engine (Railway): only removing it there turns it back on.') : undefined}
                    onClick={() => void flip(s, !!off)}>
                    {busy === s ? T('Check your wallet…') : off ? T('Turn on') : T('Turn off')}
                  </button>
                </div>
              )
            })}
          </div>
          <label className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {T('Reason (shown on the banner and kept in the audit log)')}
            <input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} placeholder={T('e.g. Router incident, investigating')}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: 'var(--bg-3)', color: 'inherit' }} />
          </label>
          {!who && <span className="fx-fine">{T('Unlock the trading wallet or connect a wallet to sign.')}</span>}
          {msg && <div role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)', fontSize: '0.82rem' }}>{msg.text}</div>}
        </section>
      )}
      {!!state?.history?.length && (
        <section className="spot-panel rt-health">
          <strong>{T('Recent changes')}</strong>
          {state.history.slice(0, 10).map(h => (
            <div key={`${h.at}-${h.scope}`} className="fx-fine">{ago(h.at)} · {label(h.scope)} · {h.on ? T('on') : T('off')} · {h.reason}</div>
          ))}
        </section>
      )}
    </>
  )
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Every fee ARCDEX takes, where it goes, and the Arc routers' owner control. */
function AdminFees({ embedded, address, signer }: { embedded: `0x${string}` | null; address: `0x${string}` | null; signer: 'embedded' | 'connected' }) {
  const [routers, setRouters] = useState<RouterFee[] | null>(null)
  const [readErr, setReadErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const from = signer === 'embedded' ? embedded : address
  const kind = signer === 'embedded' ? 'trading-wallet' as const : 'wallet' as const

  const load = useCallback(() => {
    setReadErr('')
    Promise.all(routersInForce().map(readRouterFee)).then(setRouters, (e: unknown) => setReadErr(e instanceof Error ? e.message.split('\n')[0] : String(e)))
  }, [])
  useEffect(load, [load])

  async function lower(r: RouterFee) {
    if (!from) return
    setMsg(null); setBusy(r.address)
    try {
      const hash = await setRouterFee(r, TARGET_FEE_BPS, from, kind)
      setMsg({ ok: true, text: T('{name}’s fee is now {pct}.', { name: r.name, pct: pct(TARGET_FEE_BPS) }) + ` ${short(hash)}` })
      load()
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      setMsg({ ok: false, text: m.split('\n')[0].slice(0, 220) })
    } finally { setBusy(null) }
  }

  const walletMoved = FEE_WALLET !== DEFAULT_FEE_WALLET
  return (
    <section className="spot-panel rt-health">
      <div className="rt-health-h">
        <strong>{T('Fees')}</strong>
        <button className="btn-ghost" onClick={load}>{T('Read again')}</button>
      </div>
      <p className="fx-fine" style={{ margin: 0 }}>
        {T('Spot fee: {pct} everywhere (owner’s decision, 2026-10-15). Fees off Arc are set by the site; the Arc routers’ fee is on-chain and only their owner can change it.', { pct: pct(SPOT_FEE_BPS) })}
      </p>
      <div className="rt-health-grid rt-fees">
        {(routers ?? []).map(r => {
          const isOwner = !!from && from.toLowerCase() === r.owner.toLowerCase()
          const walletOff = r.feeWallet.toLowerCase() !== FEE_WALLET
          return (
            <div key={r.address} className={`rt-prov ${atTarget(r) && !walletOff ? 'up' : 'warn'}`}>
              <span className="rt-dot" aria-hidden />
              <div>
                <strong>{r.name}</strong>
                <small>{T('Fee {pct} · referrers {share} of it', { pct: pct(r.feeBps), share: pct(r.referralShareBps) })}</small>
              </div>
              {!atTarget(r) && (
                <button className="btn-ghost" disabled={!!busy || !isOwner} title={isOwner ? undefined : T('Sign with the router’s owner ({owner}) to change it.', { owner: short(r.owner) })}
                  onClick={() => void lower(r)}>
                  {busy === r.address ? T('Check your wallet…') : T('Set to {pct}', { pct: pct(TARGET_FEE_BPS) })}
                </button>
              )}
              <small className="rt-detail">
                {T('Owner')} <a href={`${ARC_EXPLORER}/address/${r.owner}`} target="_blank" rel="noreferrer">{short(r.owner)}</a>
                {' · '}{T('Fee wallet')} <a href={`${ARC_EXPLORER}/address/${r.feeWallet}`} target="_blank" rel="noreferrer">{short(r.feeWallet)}</a>
                {walletOff && <> · {T('not the site’s fee wallet: its owner changes it with setFeeWallet')}</>}
              </small>
            </div>
          )
        })}
        <div className="rt-prov up">
          <span className="rt-dot" aria-hidden />
          <div><strong>{T('Solana, BNB Chain, Robinhood Chain')}</strong><small>{T('Fee {pct} (Relay and Across app fees)', { pct: pct(SPOT_FEE_BPS) })}</small></div>
        </div>
        <div className={`rt-prov ${JUP_REFERRAL ? 'up' : 'warn'}`}>
          <span className="rt-dot" aria-hidden />
          <div><strong>{T('Solana swaps (Jupiter)')}</strong><small>{JUP_REFERRAL ? T('Fee {pct} (Jupiter referral fee, paid in the transaction)', { pct: pct(SPOT_FEE_BPS) }) : T('Not on: set VITE_JUP_REFERRAL_ACCOUNT and JUPITER_API_KEY on Netlify (Relay trades them meanwhile)')}</small></div>
        </div>
        <div className={`rt-prov ${SN_FEE ? 'up' : 'warn'}`}>
          <span className="rt-dot" aria-hidden />
          <div><strong>Starknet</strong><small>{SN_FEE ? T('Fee {pct} (AVNU integrator fee)', { pct: pct(SN_FEE.bps) }) : T('No fee: set VITE_STARKNET_FEE_RECIPIENT (a Starknet address) on Netlify')}</small></div>
        </div>
        <div className="rt-prov up">
          <span className="rt-dot" aria-hidden />
          <div><strong>{T('Bridge')}</strong><small>{T('Fee {pct}, $0.05 to $50 (90% to the fee wallet, 10% to Circle)', { pct: pct(BRIDGE_FEE_BPS) })}</small></div>
        </div>
        <div className="rt-prov up">
          <span className="rt-dot" aria-hidden />
          <div><strong>ArcLaunchpad</strong><small>{T('1% a trade and 40% of creator tax, fixed in the contract; $3 a launch')}</small></div>
        </div>
      </div>
      <div className="fx-fine">
        {T('Fee wallet (VITE_FEE_RECIPIENT_EVM)')}: <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noreferrer">{short(FEE_WALLET)}</a>
        {walletMoved ? '' : ` · ${T('the default')}`}
      </div>
      {readErr && <div role="status" style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{T('Couldn’t read the routers: {why}', { why: readErr })}</div>}
      {msg && <div role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)', fontSize: '0.82rem' }}>{msg.text}</div>}
    </section>
  )
}

interface FeeRowView { id: string; at: number; chain: string; source: string; symbol: string; amount: string; amountUsd: number | null; tx: string | null; status: string; recipient?: string; trader?: string | null }
interface ReconView { at: number; source: string; scope: string; ledger: string; onchain: string; diff: string; ok: boolean }
interface FeeSummaryView { rows: number; bySource: Record<string, { usd: number; rows: number }>; latest: FeeRowView[]; reconciliations: ReconView[]; lastReconciled: number | null; allOk: boolean | null
  /** Referral rebates the Arc routers paid referrers (engines before Phase 5 don't send it). */
  rebates?: { usdc: string; usd: number; rows: number; referrers: number }; rebatesScannedTo?: number | null }

const SOURCE_LABEL: Record<string, string> = {
  'arc-router': N_('Arc swap router'), 'arc-curve': N_('Arc curve router'), 'arc-ur': N_('Universal Router (Arc)'), 'arc-launchpad': 'ArcLaunchpad',
  across: N_('Across (Robinhood Chain sales)'), 'arc-other': N_('Other Arc contracts'), relay: N_('Relay (held for the fee wallet)'), jupiter: N_('Jupiter referral'),
  'arc-referral': N_('Referral rebate'), 'arc-copy': N_('Copy trading fees'),
}
const STATUS_LABEL: Record<string, string> = { received: N_('received'), accrued: N_('accrued'), claimed: N_('claimed'), opening: N_('opening balance'), rebate: N_('paid to the referrer') }
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`

/** The engine's fee ledger: what it recorded from the chain, and whether the nightly reconciliation agreed. */
function AdminFeeLedger() {
  const [sum, setSum] = useState<FeeSummaryView | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    setErr('')
    fetch(`${engineApiUrl}/v1/fees/summary`, { cache: 'no-store', signal: AbortSignal.timeout(6_000) })
      .then(async r => { if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`); return r.json() as Promise<FeeSummaryView> })
      .then(setSum, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(load, [load])

  const sources = sum ? Object.entries(sum.bySource).sort((a, b) => b[1].usd - a[1].usd) : []
  const total = sources.reduce((s, [, v]) => s + v.usd, 0)
  const bad = sum?.reconciliations.filter(r => !r.ok) ?? []
  return (
    <section className="spot-panel rt-health">
      <div className="rt-health-h">
        <strong>{T('Fee ledger')}</strong>
        <button className="btn-ghost" onClick={load}>{T('Read again')}</button>
      </div>
      <p className="fx-fine" style={{ margin: 0 }}>
        {T('Every fee the engine read on-chain, kept for good (rows are never changed or removed). Each night it checks the ledger against the chain: Arc receipts block by block, and the balances Relay and Jupiter hold for the fee wallet.')}{' '}
        {T('Referral rebates too: each one against the router’s event, the transfer that paid it, the share of the fee, and the referrer the router holds for that trader.')}
      </p>
      {err && <div role="status" style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{T('Couldn’t read the ledger: {why}', { why: err })}</div>}
      {!sum && !err && <span className="fx-fine">{T('Reading…')}</span>}
      {sum && (
        <>
          <div className={`rt-prov ${sum.allOk === false ? 'down' : sum.allOk ? 'up' : 'warn'}`}>
            <span className="rt-dot" aria-hidden />
            <div>
              <strong>{sum.allOk === false ? T('Reconciliation found a difference') : sum.allOk ? T('Ledger matches the chain') : T('Not reconciled yet')}</strong>
              <small>{sum.lastReconciled ? T('Last checked {when}', { when: ago(sum.lastReconciled) }) : T('The first check runs after 00:30 UTC')}</small>
            </div>
            {bad.length > 0 && (
              <small className="rt-detail">{bad.slice(0, 4).map(r => `${r.source} ${r.scope}: ${T('ledger')} ${r.ledger}, ${T('on-chain')} ${r.onchain}`).join(' · ')}</small>
            )}
          </div>
          <div className="rt-health-grid rt-fees">
            {sources.length === 0 && <span className="fx-fine">{T('No fees recorded yet.')}</span>}
            {sources.map(([k, v]) => (
              <div key={k} className="rt-prov up">
                <span className="rt-dot" aria-hidden />
                <div><strong>{T(SOURCE_LABEL[k] ?? k)}</strong><small>{T('{n} fees', { n: v.rows })}</small></div>
                <span className="rt-ms">{usd(v.usd)}</span>
              </div>
            ))}
          </div>
          {sources.length > 0 && <div className="fx-fine">{T('In all: {usd} from {n} rows', { usd: usd(total), n: sum.rows })}</div>}
          {sum.rebates && (
            <div className="rt-prov up" data-rebates>
              <span className="rt-dot" aria-hidden />
              <div>
                <strong>{T('Referral rebates')}</strong>
                <small>{T('{n} paid to {r} referrers, in the trade, by the Arc routers', { n: sum.rebates.rows, r: sum.rebates.referrers })}{sum.rebatesScannedTo ? ` · ${T('read to block {b}', { b: sum.rebatesScannedTo.toLocaleString() })}` : ''}</small>
              </div>
              <span className="rt-ms" title={`${sum.rebates.usdc} USDC`}>{sum.rebates.usdc} USDC</span>
            </div>
          )}
          {sum.latest.length > 0 && (
            <div className="fx-fine" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong style={{ fontSize: '0.8rem' }}>{T('Latest')}</strong>
              {sum.latest.slice(0, 10).map(r => (
                <span key={r.id} style={{ overflowWrap: 'anywhere' }}>
                  {ago(r.at)} · {T(SOURCE_LABEL[r.source] ?? r.source)} · {r.amount} {r.symbol}{r.amountUsd != null ? ` (${usd(r.amountUsd)})` : ''} · {T(STATUS_LABEL[r.status] ?? r.status)}
                  {r.status === 'rebate' && r.recipient && <> {short(r.recipient)}{r.trader ? <> · {T('trader')} {short(r.trader)}</> : null}</>}
                  {r.tx && r.chain === 'arc' && <> · <a href={`${ARC_EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">{short(r.tx)}</a></>}
                  {r.tx && r.chain === 'solana' && <> · <a href={`https://solscan.io/tx/${r.tx}`} target="_blank" rel="noreferrer">{short(r.tx)}</a></>}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
