// /copy — copy trading (the build pack's Phase 7; engine/src/copy has the design). A follower signs the risk notices,
// gets a copy wallet the engine holds, funds it with USDC on Arc and follows verified leaders: each leader trade through
// ARCDEX's routers is mirrored within seconds, under the follower's rules (most per trade, slippage cap, safety level).
// One button stops every rule at once. /copy/<address> opens with that leader in the rule form.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { COPY, COPY_TERMS, COPY_TERMS_VERSION, LEADER_MIN, type CopyExecutionV, type CopyLeaderV, type CopyRuleV, type CopySafety } from '../../../api/_copyProtocol'
import type { Page } from '../App'
import { copyAvailable, deleteRule, getCopyLeaders, getCopyMe, getCopyStatus, getDestinations, openCopyWallet, saveRule, setCopyStopped, signInForCopy, withdrawCopy, type CopyMeV, type CopyStatusV } from '../api/copy'
import { getProfiles, type Profile } from '../api/social'
import { AgoText } from '../components/Ago'
import { openConnectModal } from '../components/ConnectWallet'
import { PasscodeField, WithdrawLimits, useWithdrawGuard } from '../components/WithdrawGuard'
import { notifyBalances } from '../lib/balances'
import { t as T, N_ } from '../lib/i18n'
import { shortAddr, useTrader, type Trader } from '../lib/identity'
import { ARC_EXPLORER as EXPLORER } from '../lib/platform'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { txErrorText } from '../lib/tx'
import { useCash, useSendUsdc } from '../lib/usdc'

const usd = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)
const SAFETY: Record<CopySafety, string> = { 'not-danger': N_('Skip Danger coins'), 'safe-only': N_('Safe coins only') }
const STATUS: Record<CopyExecutionV['status'], string> = { filled: N_('Copied'), skipped: N_('Skipped'), failed: N_('Failed') }

function nameOf(a: string, p: Map<string, Profile>) {
  const x = p.get(a.toLowerCase())
  return x?.display_name || (x?.username ? `@${x.username}` : shortAddr(a))
}

function CopyAddr({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button className="link-btn" title={addr} onClick={() => { void navigator.clipboard?.writeText(addr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
      {copied ? T('Copied') : shortAddr(addr)} ⧉
    </button>
  )
}

export default function CopyPage({ navigate, leader: preset }: { navigate: (p: Page) => void; leader?: string }) {
  const trader = useTrader()
  const [status, setStatus] = useState<CopyStatusV | null>(null)
  const [me, setMe] = useState<CopyMeV | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [leaders, setLeaders] = useState<CopyLeaderV[] | null>(null)
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [draft, setDraft] = useState<string | null>(preset?.toLowerCase() ?? null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, l, m] = await Promise.all([getCopyStatus(), getCopyLeaders(50), getCopyMe(trader.address)])
    setStatus(s)
    setLeaders(l)
    setMe(m)
    setSignedOut(!!trader.address && !m)
    const addrs = [...(l ?? []).map(x => x.address), ...(m?.rules ?? []).map(r => r.leader)]
    if (addrs.length) setProfiles(await getProfiles(addrs).catch(() => new Map()))
  }, [trader.address])
  useEffect(() => {
    void load()
    // While copies are under way, every 3 seconds; while following anyone, every 5; otherwise every 15.
    const id = setInterval(() => { void load() }, me?.inFlight.length ? 3_000 : me?.rules.some(r => r.enabled) ? 5_000 : 15_000)
    return () => clearInterval(id)
  }, [load, me?.inFlight.length, me?.rules])

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try { await fn(); await load() } catch (e) { setErr(txErrorText(e)) }
  }

  if (!copyAvailable()) return <div className="content-page"><h1 className="page-h">{T('Copy trading')}</h1><p className="cp-sub">{T('Copy trading needs the ARCDEX engine, which isn’t reachable from here.')}</p></div>

  const wallet = me?.wallet ?? null
  const accepted = (me?.accepted ?? 0) >= COPY_TERMS_VERSION
  return (
    <div className="content-page cp-page" style={{ '--page-w': '1080px' } as React.CSSProperties}>
      <div className="cp-head">
        <div>
          <h1 className="page-h">{T('Copy trading')}</h1>
          <p className="cp-sub">{T('Mirror verified traders on Arc. When a leader you follow trades through ARCDEX, your copy wallet makes the same trade within seconds, under your rules.')}</p>
        </div>
        {status && (
          <div className={`cp-state ${status.on ? 'on' : 'off'}`}>
            <b>{status.on ? T('Copying is on') : T('Copying is off')}</b>
            {!status.on && status.why && <small>{status.why}</small>}
            {status.stats.withinWindow !== null && <small>{T('{p}% of copies landed within {s}s of the leader · median {m}', { p: Math.round(status.stats.withinWindow * 100), s: COPY.windowMs / 1000, m: secs(status.stats.p50Ms) })}</small>}
          </div>
        )}
      </div>

      <section className="spot-panel cp-risk" aria-label={T('Risks')}>
        <b>⚠ {T('Read this first')}</b>
        <ul>{COPY_TERMS.map(t => <li key={t}>{T(t)}</li>)}</ul>
      </section>

      {err && <div className="at-error" role="alert">⚠ {err}</div>}

      {!trader.address ? (
        <section className="spot-panel cp-box">
          <b>{T('Connect a wallet to copy traders')}</b>
          <div className="cp-row">
            <button className="at-wbtn primary" onClick={() => openTradingWallet()}>{T('Trading wallet')}</button>
            <button className="at-wbtn ghost" onClick={() => openConnectModal()}>{T('Connect wallet')}</button>
          </div>
        </section>
      ) : signedOut ? (
        <section className="spot-panel cp-box">
          <b>{T('Sign in to see your copy wallet')}</b>
          <div className="cp-row"><button className="at-wbtn primary" onClick={() => void run(() => signInForCopy(trader))}>{T('Sign in with {w}', { w: shortAddr(trader.address) })}</button></div>
        </section>
      ) : !accepted ? (
        status?.on
          ? <OpenBox trader={trader} on={status.on} renewing={!!wallet} onOpen={() => run(() => openCopyWallet(trader))} />
          : <section className="spot-panel cp-box"><b>{T('Copying is off')}</b>{status?.why && <p className="fx-fine">{status.why}</p>}</section>
      ) : wallet && me && (
        <>
          <WalletPanel trader={trader} me={me} onChange={load} run={run} />
          <section className="spot-panel cp-box">
            <div className="cp-h"><b>{T('Leaders you follow')}</b><button className="at-wbtn" onClick={() => setDraft('')}>+ {T('Follow a leader')}</button></div>
            {draft !== null && <RuleForm key={draft} initial={me.rules.find(r => r.leader === draft) ?? null} leader={draft} onCancel={() => setDraft(null)} onSave={r => run(async () => { await saveRule(trader, r); setDraft(null) })} />}
            {me.rules.length === 0 ? <div className="cp-empty">{T('You don’t follow anyone yet. Pick a leader below.')}</div> : (
              <div className="cp-table cp-rules">
                <div className="cp-tr cp-th"><span>{T('Leader')}</span><span>{T('Most per trade')}</span><span>{T('Slippage cap')}</span><span>{T('Safety')}</span><span>{T('Status')}</span><span /></div>
                {me.rules.map(r => (
                  <div key={r.id} className="cp-tr">
                    <span><button className="link-btn" onClick={() => navigate({ name: 'trader', address: r.leader })}>{nameOf(r.leader, profiles)}</button></span>
                    <span><i className="cp-l">{T('Most per trade')}</i>{usd(r.maxPerTradeUsd)}</span>
                    <span><i className="cp-l">{T('Slippage cap')}</i>{(r.slippageBps / 100).toFixed(1)}%</span>
                    <span><i className="cp-l">{T('Safety')}</i>{T(SAFETY[r.safety])}</span>
                    <span><button className={`cp-pill ${r.enabled ? 'on' : ''}`} onClick={() => void run(() => saveRule(trader, { ...r, enabled: !r.enabled }))}>{r.enabled ? T('Copying') : T('Paused')}</button></span>
                    <span className="cp-acts">
                      <button className="link-btn" onClick={() => setDraft(r.leader)}>{T('Edit')}</button>
                      <button className="link-btn cp-del" onClick={() => { if (confirm(T('Stop following this leader? Coins already copied stay in your copy wallet.'))) void run(() => deleteRule(trader, r.id)) }}>{T('Remove')}</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <Activity me={me} profiles={profiles} />
        </>
      )}

      <section className="spot-panel cp-box">
        <div className="cp-h"><b>{T('Leaders you can copy')}</b></div>
        <p className="fx-fine">{T('Verified on-chain from ARCDEX’s own router trades: {t}+ trades over {d}+ days, {c}+ sales with a cost here, and no wash-trading flag. Past results don’t predict future ones.', { t: LEADER_MIN.trades, d: LEADER_MIN.days, c: LEADER_MIN.counted })}</p>
        {leaders === null ? <div className="cp-empty">{T('Loading…')}</div> : leaders.length === 0 ? <div className="cp-empty">{T('No wallet qualifies yet.')}</div> : (
          <div className="cp-table cp-leaders">
            <div className="cp-tr cp-th"><span>{T('Leader')}</span><span>{T('Realized PnL')}</span><span>{T('Volume')}</span><span>{T('Trades')}</span><span>{T('Win rate')}</span><span>{T('Followers')}</span><span /></div>
            {leaders.map(l => {
              const pnl = Number(l.realized)
              const following = me?.rules.some(r => r.leader === l.address)
              return (
                <div key={l.address} className="cp-tr">
                  <span><button className="link-btn" onClick={() => navigate({ name: 'trader', address: l.address })}>{nameOf(l.address, profiles)}</button></span>
                  <span className={pnl >= 0 ? 'up' : 'down'}><i className="cp-l">{T('Realized PnL')}</i>{usd(pnl)}</span>
                  <span><i className="cp-l">{T('Volume')}</i>{usd(Number(l.volume), 0)}</span>
                  <span><i className="cp-l">{T('Trades')}</i>{l.trades}</span>
                  <span><i className="cp-l">{T('Win rate')}</i>{l.winRate === null ? '—' : `${Math.round(l.winRate * 100)}%`}</span>
                  <span><i className="cp-l">{T('Followers')}</i>{l.followers}</span>
                  <span>{accepted && wallet ? <button className="at-wbtn" onClick={() => { setDraft(l.address); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>{following ? T('Edit') : T('Copy')}</button> : null}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>
      <p className="fx-fine">{T('Copies are made only from ARCDEX leaders’ trades on Arc, in coins with a Uniswap v4 pool against USDC, and only in coins ARCDEX’s safety scanner can rate. Every copied trade pays ARCDEX’s normal trading fee ({f}), and gas from the copy wallet.', { f: status?.feeBps === null || status?.feeBps === undefined ? '…' : `${(status.feeBps / 100).toFixed(2).replace(/\.?0+$/, '')}%` })}</p>
    </div>
  )
}

function OpenBox({ trader, on, renewing, onOpen }: { trader: Trader; on: boolean; renewing: boolean; onOpen: () => Promise<void> }) {
  const [read, setRead] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <section className="spot-panel cp-box">
      <b>{renewing ? T('The copy trading terms changed: read and sign them again to keep copying.') : T('Open a copy wallet')}</b>
      <p className="fx-fine">{T('Your wallet ({w}) signs the notices above. ARCDEX then makes a copy wallet for you on Arc and holds its key; you fund it with USDC and only you can withdraw from it.', { w: shortAddr(trader.address ?? '') })}</p>
      {!on && <p className="fx-fine">{T('Copying is off for now: you can open the wallet, but nothing is copied until ARCDEX switches it on.')}</p>}
      <label className="cp-check"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} /> {T('I’ve read the notices above and understand I can lose what I put in.')}</label>
      <div className="cp-row"><button className="at-wbtn primary" disabled={!read || busy} onClick={() => { setBusy(true); void onOpen().finally(() => setBusy(false)) }}>{busy ? T('Signing…') : renewing ? T('Sign the new terms') : T('Sign and open my copy wallet')}</button></div>
    </section>
  )
}

function WalletPanel({ trader, me, onChange, run }: { trader: Trader; me: CopyMeV; onChange: () => Promise<void>; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const w = me.wallet!
  const [open, setOpen] = useState<'fund' | 'withdraw' | null>(null)
  return (
    <section className={`spot-panel cp-box cp-wallet${me.stopped ? ' stopped' : ''}`}>
      <div className="cp-h">
        <b>{T('Your copy wallet')}</b>
        <button className={`cp-stop${me.stopped ? ' resume' : ''}`} onClick={() => void run(() => setCopyStopped(trader, !me.stopped))}>
          {me.stopped ? `▶ ${T('Resume copying')}` : `■ ${T('Stop all copying')}`}
        </button>
      </div>
      {me.stopped && <div className="cp-stopped" role="status">{T('Copying is stopped: no new copies are made, and copies under way stop before their next transaction. Coins you hold stay in the wallet.')}</div>}
      <div className="cp-stats">
        <div><small>{T('USDC')}</small><b>{usd(w.balanceUsd)}</b></div>
        <div><small>{T('Fees owed')}</small><b>{usd(w.feeDueUsd)}</b></div>
        <div><small>{T('Fees paid')}</small><b>{usd(w.feesPaidUsd)}</b></div>
        <div><small>{T('Coins held')}</small><b>{me.lots.length}</b></div>
      </div>
      <div className="cp-row">
        <span className="fx-fine">{T('Address on Arc')} <CopyAddr addr={w.address} /></span>
        <button className={`at-wbtn${open === 'fund' ? ' on' : ''}`} onClick={() => setOpen(open === 'fund' ? null : 'fund')}>+ {T('Fund')}</button>
        <button className={`at-wbtn ghost${open === 'withdraw' ? ' on' : ''}`} onClick={() => setOpen(open === 'withdraw' ? null : 'withdraw')}>{T('Withdraw')}</button>
      </div>
      {open === 'fund' && <FundCopy trader={trader} wallet={w.address} onDone={() => void onChange()} />}
      {open === 'withdraw' && <WithdrawCopy trader={trader} balance={w.balanceUsd} onDone={() => void onChange()} />}
    </section>
  )
}

function FundCopy({ trader, wallet, onDone }: { trader: Trader; wallet: string; onDone: () => void }) {
  const { cash, refresh } = useCash(trader.address)
  const send = useSendUsdc(trader)
  const [amount, setAmount] = useState('25')
  const n = Number(amount)
  const guard = useWithdrawGuard(trader, wallet, n > 0 ? n : 0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null)
  const go = async () => {
    setBusy(true); setMsg(null)
    try {
      await guard.confirm()
      const hash = await send(wallet, amount)
      guard.record(hash, n, usd(n))
      setMsg({ ok: true, text: T('Sent {v} to your copy wallet.', { v: usd(n) }), hash })
      guard.setPasscode(''); refresh(); notifyBalances(); onDone()
    } catch (e) { setMsg({ ok: false, text: txErrorText(e) }) } finally { setBusy(false) }
  }
  const blocked = busy || !(n > 0) || (cash !== null && n > cash) || guard.missing || guard.overLimit || guard.limitsLoading
  return (
    <div className="cp-sub-box">
      <div className="fx-fine">{T('From {w} · {v} available', { w: shortAddr(trader.address ?? ''), v: cash === null ? '…' : usd(cash) })}</div>
      <div className="cp-row">
        {[10, 25, 50, 100].map(v => <button key={v} className={`at-chip${n === v ? ' on' : ''}`} onClick={() => setAmount(String(v))}>${v}</button>)}
        <input className="at-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
      </div>
      <WithdrawLimits guard={guard} />
      <PasscodeField guard={guard} onEnter={() => { if (!blocked) void go() }} />
      <div className="cp-row"><button className="at-wbtn primary" disabled={blocked} onClick={() => void go()}>{busy ? T('Sending…') : T('Send {v}', { v: n > 0 ? usd(n) : '$' })}</button></div>
      <div className="fx-fine">{T('Or send USDC on Arc from anywhere to {a}. Only USDC on the Arc network.', { a: wallet })}</div>
      {msg && <div className={msg.ok ? 'at-ok' : 'at-error'}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}{msg.hash ? <> · <a href={`${EXPLORER}/tx/${msg.hash}`} target="_blank" rel="noreferrer">tx ↗</a></> : null}</div>}
    </div>
  )
}

function WithdrawCopy({ trader, balance, onDone }: { trader: Trader; balance: number | null; onDone: () => void }) {
  const [dests, setDests] = useState<{ address: string; usd: number | null }[] | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null)
  useEffect(() => {
    let alive = true
    void getDestinations(trader).then(d => { if (alive) { setDests(d); setTo(d[0]?.address ?? '') } }).catch(e => { if (alive) setMsg({ ok: false, text: txErrorText(e) }) })
    return () => { alive = false }
  }, [trader])
  const most = balance === null ? null : Math.max(0, Math.floor((balance - 0.05) * 100) / 100)
  const n = Number(amount)
  const go = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await withdrawCopy(trader, to, n)
      setMsg({ ok: true, text: T('Sent {v}.', { v: usd(n) }), hash: r.hash })
      setAmount(''); notifyBalances(); onDone()
    } catch (e) { setMsg({ ok: false, text: txErrorText(e) }) } finally { setBusy(false) }
  }
  return (
    <div className="cp-sub-box">
      <div className="fx-fine">{T('Withdrawals go only to the wallet you signed in with, or to a wallet that funded the copy wallet. Fees owed are paid first. Your wallet signs each one.')}</div>
      {dests === null ? <div className="fx-fine">{T('Loading…')}</div> : (
        <div className="cp-dests">
          {dests.map(d => (
            <label key={d.address} className="cp-check">
              <input type="radio" name="cp-to" checked={to === d.address} onChange={() => setTo(d.address)} />
              {shortAddr(d.address)} {d.address === trader.address?.toLowerCase() ? `· ${T('you')}` : d.usd !== null ? `· ${T('funded {v}', { v: usd(d.usd) })}` : ''}
            </label>
          ))}
        </div>
      )}
      <div className="cp-row">
        <input className="at-input" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={T('Amount')} />
        {most !== null && <button className="at-chip" onClick={() => setAmount(String(most))}>{T('Max {v}', { v: usd(most) })}</button>}
        <button className="at-wbtn primary" disabled={busy || !to || !(n > 0) || (most !== null && n > most)} onClick={() => void go()}>{busy ? T('Signing…') : T('Sign and withdraw')}</button>
      </div>
      {msg && <div className={msg.ok ? 'at-ok' : 'at-error'}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}{msg.hash ? <> · <a href={`${EXPLORER}/tx/${msg.hash}`} target="_blank" rel="noreferrer">tx ↗</a></> : null}</div>}
    </div>
  )
}

function RuleForm({ initial, leader, onSave, onCancel }: { initial: CopyRuleV | null; leader: string; onSave: (r: { leader: string; maxPerTradeUsd: number; slippageBps: number; safety: CopySafety; enabled: boolean }) => Promise<void>; onCancel: () => void }) {
  const [addr, setAddr] = useState(leader)
  const [max, setMax] = useState(String(initial?.maxPerTradeUsd ?? 10))
  const [slip, setSlip] = useState(String((initial?.slippageBps ?? COPY.defaultSlippageBps) / 100))
  const [safety, setSafety] = useState<CopySafety>(initial?.safety ?? 'not-danger')
  const [busy, setBusy] = useState(false)
  const m = Number(max), s = Math.round(Number(slip) * 100)
  const bad = useMemo(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr.trim())) return T('Paste the leader’s wallet address')
    if (!(m >= COPY.minPerTradeUsd && m <= COPY.maxPerTradeUsd)) return T('The most per trade is between {a} and {b}', { a: usd(COPY.minPerTradeUsd, 0), b: usd(COPY.maxPerTradeUsd, 0) })
    if (!(s >= COPY.minSlippageBps && s <= COPY.maxSlippageBps)) return T('The slippage cap is between {a}% and {b}%', { a: COPY.minSlippageBps / 100, b: COPY.maxSlippageBps / 100 })
    return null
  }, [addr, m, s])
  return (
    <div className="cp-sub-box cp-form">
      <label><span>{T('Leader’s wallet')}</span><input className="at-input cp-wide" value={addr} disabled={!!initial} placeholder="0x…" onChange={e => setAddr(e.target.value.trim())} /></label>
      <label><span>{T('Most per trade (USD)')}</span>
        <span className="cp-row">{[5, 10, 25, 50].map(v => <button key={v} type="button" className={`at-chip${m === v ? ' on' : ''}`} onClick={() => setMax(String(v))}>${v}</button>)}<input className="at-input" inputMode="decimal" value={max} onChange={e => setMax(e.target.value.replace(/[^0-9.]/g, ''))} /></span>
        <small className="fx-fine">{T('A smaller leader buy is copied at its own size. Your wallet’s USDC and a small gas reserve also cap it.')}</small>
      </label>
      <label><span>{T('Slippage cap (%)')}</span>
        <span className="cp-row">{[1, 3, 5, 10].map(v => <button key={v} type="button" className={`at-chip${Number(slip) === v ? ' on' : ''}`} onClick={() => setSlip(String(v))}>{v}%</button>)}<input className="at-input" inputMode="decimal" value={slip} onChange={e => setSlip(e.target.value.replace(/[^0-9.]/g, ''))} /></span>
        <small className="fx-fine">{T('A copy is never bought at a price this much worse than the leader’s: if the price moved further, it’s skipped.')}</small>
      </label>
      <div className="cp-field"><span>{T('Safety')}</span>
        <span className="cp-row">{(Object.keys(SAFETY) as CopySafety[]).map(k => <button key={k} type="button" className={`at-chip${safety === k ? ' on' : ''}`} onClick={() => setSafety(k)}>{T(SAFETY[k])}</button>)}</span>
        <small className="fx-fine">{T('Coins ARCDEX rates Danger, or can’t rate, are never copied. "Safe coins only" skips Risky ones too.')}</small>
      </div>
      {bad && addr && <div className="at-error">{bad}</div>}
      <div className="cp-row">
        <button className="at-wbtn primary" disabled={!!bad || busy} onClick={() => { setBusy(true); void onSave({ leader: addr.trim().toLowerCase(), maxPerTradeUsd: m, slippageBps: s, safety, enabled: initial?.enabled ?? true }).finally(() => setBusy(false)) }}>{busy ? T('Saving…') : initial ? T('Save') : T('Start copying')}</button>
        <button className="at-wbtn ghost" onClick={onCancel}>{T('Cancel')}</button>
      </div>
    </div>
  )
}

function Activity({ me, profiles }: { me: CopyMeV; profiles: Map<string, Profile> }) {
  return (
    <section className="spot-panel cp-box">
      <div className="cp-h"><b>{T('Your copies')}</b>{me.inFlight.length > 0 && <span className="cp-busy">● {T('{n} under way', { n: me.inFlight.length })}</span>}</div>
      {me.executions.length === 0 ? <div className="cp-empty">{T('Nothing copied yet. Copies show here as leaders trade, with every skip and why.')}</div> : (
        <div className="cp-table cp-acts-t">
          <div className="cp-tr cp-th"><span>{T('When')}</span><span>{T('Leader')}</span><span>{T('Trade')}</span><span>{T('Amount')}</span><span>{T('After the leader')}</span><span>{T('Result')}</span></div>
          {me.executions.slice(0, 50).map(e => (
            <div key={e.id} className={`cp-tr cp-${e.status}`}>
              <span><AgoText ts={e.at} /></span>
              <span><i className="cp-l">{T('Leader')}</i>{nameOf(e.leader, profiles)}</span>
              <span className={e.side === 'buy' ? 'up' : 'down'}><i className="cp-l">{T('Trade')}</i>{e.side === 'buy' ? T('Buy') : T('Sell')} {e.symbol ?? shortAddr(e.token)}</span>
              <span><i className="cp-l">{T('Amount')}</i>{usd(e.usd)}</span>
              <span><i className="cp-l">{T('After the leader')}</i>{secs(e.latencyMs)}</span>
              <span className="cp-res"><span><b>{T(STATUS[e.status])}</b>{e.tx ? <> · <a href={`${EXPLORER}/tx/${e.tx}`} target="_blank" rel="noreferrer">tx ↗</a></> : null}</span>{e.reason && <small>{e.reason}</small>}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
