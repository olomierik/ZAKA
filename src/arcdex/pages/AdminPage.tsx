// /admin (not linked anywhere): the trade switch, the build pack's kill switch (lib/tradeSwitch.ts,
// engine/src/site/tradeSwitch.ts). Anyone can open it and see what's off; only an admin wallet (ADMIN_EVM_ADDRESSES on the
// engine, else the owner's) can change it, by signing the change. Each change is applied at once and written to the
// engine's append-only audit log. GLOBAL_KILL_SWITCH / KILL_SWITCH_VENUES on Railway do the same without a wallet.
import { useCallback, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { TRADE_VENUES, TRADE_VENUE_LABEL, type TradeScope } from '../../../api/_marketProtocol'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { t as T } from '../lib/i18n'
import { useEmbeddedAddress } from '../lib/identity'
import { readTradeSwitch, sendTradeSwitch, useTradeSwitch } from '../lib/tradeSwitch'
import { engineApiUrl } from '../api/marketStream'

const SCOPES: TradeScope[] = ['all', ...TRADE_VENUES]
const label = (s: TradeScope) => (s === 'all' ? T('Every venue') : TRADE_VENUE_LABEL[s])
const ago = (at: number) => new Date(at).toLocaleString()

export default function AdminPage() {
  const state = useTradeSwitch()
  const embedded = useEmbeddedAddress()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [signer, setSigner] = useState<'embedded' | 'connected'>(embedded ? 'embedded' : 'connected')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<TradeScope | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const who = signer === 'embedded' ? embedded : address
  const sign = useCallback(async (message: string) => (signer === 'embedded' ? getEmbeddedWalletClient().signMessage({ message }) : signMessageAsync({ message })), [signer, signMessageAsync])

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
    <div className="content-page rt-page" style={{ '--page-w': '880px' } as React.CSSProperties}>
      <h1 className="page-h" style={{ marginBottom: 4 }}>{T('Trade switch')}</h1>
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
          <div className="fx-fine" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {T('Sign with')}
            <select value={signer} onChange={e => setSigner(e.target.value as 'embedded' | 'connected')} style={{ padding: '4px 8px', borderRadius: 8, background: 'var(--bg-3)', color: 'inherit', border: '1px solid var(--adx-card-border)' }}>
              <option value="embedded" disabled={!embedded}>{T('Trading wallet')}{embedded ? ` (${embedded.slice(0, 6)}…${embedded.slice(-4)})` : ''}</option>
              <option value="connected" disabled={!address}>{T('Connected wallet')}{address ? ` (${address.slice(0, 6)}…${address.slice(-4)})` : ''}</option>
            </select>
            {!who && <span>{T('Unlock the trading wallet or connect a wallet to sign.')}</span>}
          </div>
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
    </div>
  )
}
