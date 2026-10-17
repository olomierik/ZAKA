// Copy trading from your own wallet (lib/copyTrade.ts, components/CopyRunner.tsx): pick leaders, set the rules, and the
// built-in trading wallet copies their Arc trades while ARCDEX is open. Non-custodial: the funds never leave the user's
// own wallet. Replaces the engine-held copy wallets (owner, 2026-10-16: "I don't want ARCDEX to hold users' copy trade
// wallets"; 2026-10-17: "copy trading from the user's own wallet").

import { useState } from 'react'
import type { Page } from '../App'
import { COPY, DEFAULT_RULE, removeRule, setCopySettings, spentToday, upsertRule, useCopyLog, useCopyLots, useCopySettings, type CopyRule } from '../lib/copyTrade'
import { coinPageOf, isTracked, trackWallet, useTracked } from '../lib/walletTracker'
import { useTrenchFeed } from '../api/trenchFeed'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { useFlag } from '../lib/flags'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { ARC_EXPLORER } from '../lib/platform'
import Ago from '../components/Ago'
import { t as T } from '../lib/i18n'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const usd = (n: number) => (Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`)
const fmtAmt = (raw: string, d: number) => { const n = Number(raw) / 10 ** d; return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toPrecision(3) }

/** A number field that takes what's typed as it is and saves it, kept within bounds, once the field is left. */
function NumField({ value, min, max, step, onSave }: { value: number; min: number; max: number; step: string; onSave: (n: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const save = () => {
    if (text === null) return
    const n = Number(text)
    setText(null)
    if (text.trim() !== '' && Number.isFinite(n)) onSave(Math.min(max, Math.max(min, n)))
  }
  return (
    <input type="number" inputMode="decimal" min={min} max={max} step={step} value={text ?? String(value)}
      onChange={e => setText(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

function RuleCard({ r, label, navigate }: { r: CopyRule; label: string; navigate: (p: Page) => void }) {
  const set = (patch: Partial<CopyRule>) => upsertRule({ ...r, ...patch })
  return (
    <div className={`ct-rule${r.on ? '' : ' off'}`}>
      <div className="ct-rule-h">
        <button className="ct-who" onClick={() => navigate({ name: 'tracker', address: r.leader })} title={r.leader}>{label}</button>
        <label className="ct-switch" title={r.on ? T('Copying this leader') : T('Paused')}>
          <input type="checkbox" checked={r.on} onChange={e => set({ on: e.target.checked })} /><i /><span>{r.on ? T('On') : T('Paused')}</span>
        </label>
        <button className="ct-x" onClick={() => removeRule(r.leader)} title={T('Stop copying this leader')}>✕</button>
      </div>
      <div className="ct-fields">
        <label>{T('Size')}
          <select value={r.sizing} onChange={e => set({ sizing: e.target.value as CopyRule['sizing'] })}>
            <option value="fixed">{T('Fixed amount')}</option>
            <option value="match">{T('Leader’s size, capped')}</option>
          </select>
        </label>
        <label>{r.sizing === 'fixed' ? T('Per trade ($)') : T('Most per trade ($)')}
          <NumField min={COPY.minUsd} max={COPY.maxUsd} step="1" value={r.maxUsd} onSave={n => set({ maxUsd: n })} />
        </label>
        <label>{T('Slippage (%)')}
          <NumField min={COPY.minSlip} max={COPY.maxSlip} step="0.5" value={r.slippagePct} onSave={n => set({ slippagePct: n })} />
        </label>
        <label>{T('Coins')}
          <select value={r.safety} onChange={e => set({ safety: e.target.value as CopyRule['safety'] })}>
            <option value="skip-danger">{T('Skip Danger')}</option>
            <option value="safe-only">{T('Safe coins only')}</option>
          </select>
        </label>
        <label className="ct-check"><input type="checkbox" checked={r.sells} onChange={e => set({ sells: e.target.checked })} />{T('Copy sells')}</label>
      </div>
    </div>
  )
}

export default function CopyTradePage({ navigate, leader }: { navigate: (p: Page) => void; leader?: string }) {
  const on = useFlag('walletCopy')
  const s = useCopySettings()
  const trader = useTrader()
  const me = trader.kind === 'trading-wallet' ? trader.address : null
  const { cash } = useCash(me)
  const log = useCopyLog(me)
  const lots = useCopyLots(me)
  const tracked = useTracked()
  const smart = useTrenchFeed('arc').smart
  const [addr, setAddr] = useState(leader ?? '')
  const [err, setErr] = useState('')
  const [ack, setAck] = useState(s.accepted)
  const labelOf = (a: string) => tracked.find(w => w.address === a)?.label || short(a)
  const spent = me ? spentToday(me) : 0

  const add = (a: string) => {
    setErr('')
    const x = a.trim().toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(x)) { setErr(T('Copy trading follows Arc wallets: paste an 0x… address.')); return }
    if (me && x === me.toLowerCase()) { setErr(T('That’s your own wallet.')); return }
    try {
      upsertRule(DEFAULT_RULE(x))
      if (!isTracked(x)) try { trackWallet(x) } catch { /* the tracker is full: copying still works */ }
      setAddr('')
    } catch { setErr(T('You can copy up to {n} leaders.', { n: COPY.maxLeaders })) }
  }
  const suggestions = [
    ...tracked.filter(w => w.address.startsWith('0x')).map(w => ({ w: w.address, label: w.label || short(w.address), note: T('Followed') })),
    ...(smart?.top ?? []).map(w => ({ w: w.w.toLowerCase(), label: short(w.w), note: `${Math.round(w.wr * 100)}% · ${w.pnl >= 0 ? '+' : '−'}${usd(Math.abs(w.pnl))}` })),
  ].filter((x, i, a) => !s.rules.some(r => r.leader === x.w) && a.findIndex(y => y.w === x.w) === i).slice(0, 8)

  return (
    <div className="content-page ct-page" style={{ ['--page-w' as string]: '1000px' }}>
      <h1 className="page-h">{T('Copy trading')}</h1>
      <p className="wt-sub">{T('Pick traders to copy. Your own trading wallet makes the same trades on Arc within seconds, under your rules. Your money never leaves your wallet.')}</p>

      {!on && <div className="wt-err">{T('Copy trading is switched off for now.')}</div>}

      <section className="ct-card">
        <div className="ct-status">
          <div>
            <b>{!s.on ? T('Copying is off') : me ? T('Copying is on') : T('Copying is paused until your trading wallet is unlocked')}</b>
            <small>{me ? T('From your trading wallet {w} · {cash} USDC', { w: short(me), cash: cash === null ? '…' : cash.toFixed(2) }) : T('Copy trading uses your built-in trading wallet, which signs without pop-ups.')}</small>
          </div>
          <div className="ct-acts">
            {!me && <button className="ct-btn" onClick={openTradingWallet}>{T('Open the trading wallet')}</button>}
            {s.on
              ? <button className="ct-btn stop" onClick={() => setCopySettings({ on: false })}>{T('Stop all copying')}</button>
              : me && <button className="ct-btn" disabled={!on || !ack || !s.rules.some(r => r.on)} onClick={() => setCopySettings({ on: true, accepted: true })}>{T('Start copying')}</button>}
          </div>
        </div>
        <div className="ct-budget">
          <label>{T('Daily budget ($)')} <NumField min={COPY.minUsd} max={COPY.maxDailyUsd} step="5" value={s.dailyCapUsd} onSave={n => setCopySettings({ dailyCapUsd: n })} /></label>
          <span>{T('Spent today: {n}', { n: usd(spent) })}</span>
          <span className="ct-keep">{T('Copies happen only while ARCDEX is open in a tab on this device.')}</span>
        </div>
        {!s.accepted && (
          <div className="ct-risks">
            <b>⚠ {T('Read this first')}</b>
            <ul>
              <li>{T('Copying copies losses as faithfully as gains. Meme coins can lose most or all of their value in minutes.')}</li>
              <li>{T('Copies are made after the leader trades, at a different price, and some are skipped (your rules, the safety check, the budget, a price that moved).')}</li>
              <li>{T('Your trading wallet signs every copy by itself, without asking you each time, while copying is on.')}</li>
              <li>{T('Only Arc trades in Uniswap pools are copied for now, not coins still on a launchpad’s curve. Every copy pays ARCDEX’s normal fee and gas.')}</li>
              <li>{T('Past results of a leader don’t predict future ones. Nothing here is investment advice.')}</li>
            </ul>
            <label className="ct-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />{T('I understand, and only use money I can afford to lose.')}</label>
          </div>
        )}
      </section>

      <section className="ct-card">
        <div className="ct-h"><b>{T('Leaders')}</b><span>{s.rules.length}/{COPY.maxLeaders}</span></div>
        <form className="wt-add ct-add" onSubmit={e => { e.preventDefault(); add(addr) }}>
          <input value={addr} onChange={e => { setAddr(e.target.value); setErr('') }} placeholder={T('Leader’s Arc wallet (0x…)')} spellCheck={false} />
          <button type="submit" disabled={!addr.trim()}>{T('Copy')}</button>
        </form>
        {err && <div className="wt-err">{err}</div>}
        {s.rules.map(r => <RuleCard key={r.leader} r={r} label={labelOf(r.leader)} navigate={navigate} />)}
        {!s.rules.length && <p className="wt-empty">{T('No leaders yet. Paste a wallet, or pick one below.')}</p>}
        {suggestions.length > 0 && (
          <div className="ct-sugg">
            {suggestions.map(x => (
              <button key={x.w} onClick={() => add(x.w)} title={x.w}><b>{x.label}</b><small>{x.note}</small><span>+ {T('Copy')}</span></button>
            ))}
          </div>
        )}
      </section>

      {lots.length > 0 && (
        <section className="ct-card">
          <div className="ct-h"><b>{T('Copied coins')}</b></div>
          {lots.map(l => (
            <button key={`${l.leader}:${l.token}`} className="ct-lot" onClick={() => navigate(coinPageOf('arc', l.token))}>
              <b>{l.symbol || short(l.token)}</b><span>{fmtAmt(l.raw, l.decimals)}</span><span>{T('cost {n}', { n: usd(l.spentUsd) })}</span><small>{T('from {w}', { w: labelOf(l.leader) })}</small>
            </button>
          ))}
        </section>
      )}

      <section className="ct-card">
        <div className="ct-h"><b>{T('Activity')}</b></div>
        {log.slice(0, 60).map(e => (
          <div key={`${e.id}:${e.at}`} className={`ct-ev ${e.status}`}>
            <span className="wt-age"><Ago ts={e.at} /></span>
            <span className={`wt-side ${e.side === 'B' ? 'buy' : 'sell'}`}>{e.side === 'B' ? T('Buy') : T('Sell')}</span>
            <b>{e.symbol}</b>
            <span className="ct-st">{e.status === 'filled' ? `${T('Copied')} ${usd(e.usd ?? 0)}` : e.status === 'failed' ? T('Failed') : T('Skipped')}</span>
            <small>{e.why ? T(e.why, e.whyVars) : (e.lagMs ? T('{s}s after {w}', { s: (e.lagMs / 1000).toFixed(1), w: labelOf(e.leader) }) : labelOf(e.leader))}</small>
            {e.tx && <a href={`${ARC_EXPLORER}/tx/${e.tx}`} target="_blank" rel="noopener noreferrer">↗</a>}
          </div>
        ))}
        {!log.length && <p className="wt-empty">{T('Nothing copied yet. Each copy, and each trade skipped and why, shows here.')}</p>}
      </section>
    </div>
  )
}
