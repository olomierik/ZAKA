// /predict → BTC 5m · 15m → Live autotrade: real money on Polymarket from the user's own trading wallet
// (lib/updownLive.ts, lib/polyLive.ts; owner, 2026-11-03). What the engine's live-speed paper book made with $100, the
// wallet on Polygon (pUSD, POL for gas, Polymarket's approvals), funding, the capital, the risks to accept, Start/Stop,
// and the live record and log. Trading happens in this browser while ARCDEX is open (components/UpdownLiveRunner.tsx).

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { LIVE_RULES, type UpdownStatus } from '../../../api/_updownProtocol'
import { useTrader } from '../lib/identity'
import { useFlag } from '../lib/flags'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { t as T } from '../lib/i18n'
import { liveStats, setLiveSettings, useLiveBook, useLiveSettings, type LiveCapital } from '../lib/updownLive'
import type { PolyAccount } from '../lib/polyLive'

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const cls = (n: number) => (n > 0 ? 'fx-up' : n < 0 ? 'fx-down' : '')
const lib = () => import('../lib/polyLive')

export default function UpdownLiveCard({ status }: { status: UpdownStatus }) {
  const on = useFlag('updownLive')
  const s = useLiveSettings()
  const trader = useTrader()
  const me = trader.kind === 'trading-wallet' ? trader.address : null
  const book = useLiveBook(me)
  const [acct, setAcct] = useState<PolyAccount | null>(null)
  const [acctErr, setAcctErr] = useState<string | null>(null)
  const [geo, setGeo] = useState<{ blocked: boolean; country: string } | null>(null)
  const [dep, setDep] = useState<{ evm?: string; svm?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    if (!me) return
    try { setAcct(await (await lib()).polyAccount()); setAcctErr(null) } catch (e) { setAcctErr((e as Error).message) }
  }
  useEffect(() => { void load(); const id = setInterval(() => { if (!document.hidden) void load() }, 15_000); return () => clearInterval(id) }, [me])
  useEffect(() => {
    fetch('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(8_000) }).then(r => r.json()).then(setGeo, () => setGeo(null))
  }, [])

  const act = async (name: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(name)
    try { await f(); if (done) toast.success(done); await load() } catch (e) { toast.error((e as Error).message.slice(0, 200)) } finally { setBusy(null) }
  }

  const sim = status.liveSim
  const st = liveStats(book)
  const openCost = book.positions.filter(p => p.status === 'open').reduce((a, p) => a + p.cost - p.proceeds, 0)
  const minStart = s.capital * 0.5
  const can = {
    geo: geo ? !geo.blocked : false,
    funded: (acct?.pusd ?? 0) >= minStart,
    gas: (acct?.pol ?? 0) >= 0.05,
    approved: acct?.approved === true,
  }
  const ready = !!me && can.geo && can.funded && can.gas && can.approved && s.accepted

  const start = () => {
    setLiveSettings({ on: true, startedAt: Date.now(), startEquity: (acct?.pusd ?? 0) + openCost, halted: null, pauseUntil: 0 })
    toast.success(T('Live autotrade is on. Keep this tab open.'))
  }

  if (!on) return <div className="spot-panel ud-live"><div className="spot-panel-h"><span>{T('Live autotrade')}</span></div><div className="fx-empty">{T('Live autotrade is switched off by ARCDEX for now.')}</div></div>

  return (
    <div className={`spot-panel ud-live ${s.on ? 'on' : ''}`}>
      <div className="spot-panel-h">
        <span>{T('Live autotrade · real money')}</span>
        <span className={`ud-live-badge ${s.on ? 'on' : ''}`}>{s.on ? T('LIVE') : s.halted ? T('STOPPED') : T('OFF')}</span>
      </div>
      <div className="ud-live-body">
        <div>
          <p className="ud-sub">{T('The same decisions as the paper autotrader, traded with your own money on Polymarket from your ARCDEX trading wallet. Small accounts only, with hard limits so one bad run can’t empty it.')}</p>
          {sim && (
            <div className="ud-live-sim">
              <b>{T('What $100 would have done at live speed (paper)')}</b>
              <div>{T('{n} trades, {w} won, {pnl} after fees', { n: String(sim.won + sim.lost), w: String(sim.won), pnl: signed(sim.pnl) })} · {T('balance {b}', { b: usd(sim.bankroll) })}{sim.halted ? ` · ${T(sim.halted)}` : ''}</div>
              <small>{T('Filled {ms} ms later than the paper book, as late as an order from a browser far from Polymarket’s servers lands. Measured since {d}; not a promise.', { ms: String(sim.extraDelayMs), d: new Date(sim.since).toLocaleDateString() })}</small>
            </div>
          )}
          <ul className="ud-live-rules">
            <li>{T('Each order: at most {p}% of your capital (${a} on ${c}), less when the edge is thin; nothing under $1.', { p: String(LIVE_RULES.orderShare * 100), a: (s.capital * LIVE_RULES.orderShare).toFixed(2), c: String(s.capital) })}</li>
            <li>{T('At most {w}% of your capital in one window, and {n} positions open at once.', { w: String(LIVE_RULES.windowShare * 100), n: String(LIVE_RULES.maxOpen) })}</li>
            <li>{T('Stops for the day after losing {d}%, pauses an hour after {l} losses in a row, and stops for good {x}% under where it started.', { d: String(LIVE_RULES.dailyLossShare * 100), l: String(LIVE_RULES.lossStreak), x: String(LIVE_RULES.drawdownStop * 100) })}</li>
            <li>{T('Never pays more than the engine’s price, never sells under its floor: what can’t fill there is cancelled.')}</li>
          </ul>
        </div>

        <div className="ud-live-acct">
          {!me ? (
            <div className="ud-live-step">
              <b>{T('Trades from your ARCDEX trading wallet')}</b>
              <p className="fx-fine">{T('It signs each order by itself, so the autotrader needs no pop-ups. Unlock it, or create one.')}</p>
              <button className="ud-btn" onClick={openTradingWallet}>{T('Open the trading wallet')}</button>
            </div>
          ) : (
            <>
              <div className="ud-row"><span>{T('Your wallet on Polygon')}</span><b title={me}><button className="ud-link-btn" onClick={() => { void navigator.clipboard?.writeText(me); toast.success(T('Copied')) }}>{me.slice(0, 6)}…{me.slice(-4)} ⧉</button></b></div>
              <div className="ud-row"><span>{T('pUSD (to trade)')}</span><b>{acct ? usd(acct.pusd) : '…'}</b></div>
              <div className="ud-row"><span>{T('POL (for gas)')}</span><b className={acct && !can.gas ? 'fx-down' : ''}>{acct ? acct.pol.toFixed(3) : '…'}</b></div>
              {acct && acct.usdce > 0.01 && <div className="ud-row"><span>USDC.e</span><b>{usd(acct.usdce)}</b></div>}
              {acctErr && <div className="fx-fine fx-down">{acctErr}</div>}
              <div className="ud-checks">
                <div>{geo ? (can.geo ? '✓' : '✕') : '○'} {geo ? (can.geo ? T('Polymarket accepts orders from your country ({c})', { c: geo.country }) : T('Polymarket refuses orders from your country ({c})', { c: geo.country })) : T('Checking where you are…')}</div>
                <div>{can.funded ? '✓' : '○'} {T('At least ${m} of pUSD', { m: minStart.toFixed(0) })}</div>
                <div>{can.gas ? '✓' : '○'} {T('A little POL for gas (0.05 or more, about $0.01)')}</div>
                <div>{can.approved ? '✓' : '○'} {T('Polymarket’s trading approvals')}{!can.approved && <button className="ud-link-btn" disabled={!can.gas || busy !== null} onClick={() => void act('setup', async () => (await lib()).polySetup(), T('Trading approvals are set.'))}>{busy === 'setup' ? '…' : T('Set up')}</button>}</div>
              </div>
              <div className="ud-live-fund">
                <button className="ud-link-btn" disabled={busy !== null} onClick={() => void act('dep', async () => setDep(await (await lib()).polyDepositAddresses()))}>{T('How to fund it')}</button>
                {dep && (
                  <div className="fx-fine">
                    {dep.evm && <div>{T('Send USDC from Base, Arbitrum, Polygon or Ethereum to')} <code>{dep.evm}</code> {T('(at least $2; $7 from Ethereum). It arrives as pUSD in this wallet.')}</div>}
                    {dep.svm && <div>{T('Or USDC from Solana to')} <code>{dep.svm}</code></div>}
                    <div>{T('For gas, send about 1 POL on Polygon to your wallet address above.')}</div>
                  </div>
                )}
              </div>
            </>
          )}
          <div className="ud-live-cap">
            <span>{T('Capital')}</span>
            {LIVE_RULES.capitals.map(c => <button key={c} className={s.capital === c ? 'active' : ''} disabled={s.on} onClick={() => setLiveSettings({ capital: c as LiveCapital })}>${c}</button>)}
          </div>
          <label className="ud-accept">
            <input type="checkbox" checked={s.accepted} disabled={s.on} onChange={e => setLiveSettings({ accepted: e.target.checked })} />
            <span>{T('I understand this trades my own money, that it can lose, that the strategy is unproven with real money, and that it runs only while ARCDEX is open in this browser.')}</span>
          </label>
          {s.on
            ? <button className="ud-btn stop" onClick={() => { setLiveSettings({ on: false }); toast(T('Live autotrade is off. Open positions are still held to their result.')) }}>{T('Stop live autotrade')}</button>
            : <button className="ud-btn go" disabled={!ready} onClick={start}>{T('Start live autotrade with ${c}', { c: String(s.capital) })}</button>}
          {s.halted && !s.on && <div className="ud-warn">{T('It stopped by itself: {r}. Start it again only if you mean to.', { r: s.halted })}</div>}
        </div>
      </div>

      {me && (book.positions.length > 0 || book.events.length > 0) && (
        <div className="ud-live-rec">
          <div className="ud-stats">
            <div><span>{T('Live trades')}</span><b>{st.trades}{st.open ? ` · ${st.open} ${T('open')}` : ''}</b></div>
            <div><span>{T('Won')}</span><b>{st.closed ? `${st.won}/${st.closed}` : '—'}</b></div>
            <div><span>{T('Live P&L')}</span><b className={cls(st.pnl)}>{signed(st.pnl)}</b></div>
            <div><span>{T('Staked')}</span><b>{usd(st.staked)}</b></div>
          </div>
          <div className="ud-journal">
            {[...book.events].reverse().slice(0, 15).map((e, i) => <div key={i}><time>{new Date(e.at).toLocaleTimeString()}</time> {T(e.k, e.v && { ...e.v, ...(e.v.side ? { side: T(e.v.side) } : {}) })}</div>)}
          </div>
        </div>
      )}
      <div className="hl-foot fx-fine">{T('Polymarket checks the country an order comes from; using a VPN to get around that breaks its terms. ARCDEX never holds your money: your trading wallet does, and you can export its key.')}</div>
    </div>
  )
}
