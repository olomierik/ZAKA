// Portfolio: the trader's Hyperliquid account (2026-10-11), counted in the total. Its value, open futures positions
// and predictions held, each opening its page, plus Deposit and Withdraw. Read every 60 seconds (balances, positions
// and every mid in one go), not streamed: the trading pages stream; this page only needs the totals.

import { useCallback, useEffect, useState } from 'react'
import { t as T } from '../lib/i18n'
import type { Page } from '../App'
import { onBalances } from '../lib/balances'
import { HL_TRADING, hlInfo } from '../hl/client'
import { loadAccount, type HlAccountState } from '../hl/account'
import { symbolOf } from '../hl/markets'
import { HlFundingModal, money, useHlGate } from './HlShared'

/** The deposit / withdraw dialog, with its own access checks, mounted only while it's open. */
function Funding({ account, initial, onClose, onDone }: { account: HlAccountState | null; initial: 'deposit' | 'withdraw'; onClose: () => void; onDone: () => void }) {
  const gate = useHlGate()
  return <HlFundingModal gate={gate} account={account} initial={initial} onClose={onClose} onDone={onDone} />
}

export default function HlHoldings({ owner, navigate, onValue }: { owner: string | null; navigate: (p: Page) => void; onValue?: (usd: number) => void }) {
  const [acct, setAcct] = useState<HlAccountState | null>(null)
  const [mids, setMids] = useState<Record<string, number>>({})
  const [funding, setFunding] = useState<'deposit' | 'withdraw' | null>(null)

  const load = useCallback(async () => {
    if (!owner) { setAcct(null); onValue?.(0); return }
    const [a, m] = await Promise.all([
      loadAccount(owner).catch(() => null),
      hlInfo<Record<string, string>>({ type: 'allMids' }).catch(() => ({} as Record<string, string>)),
    ])
    const mid: Record<string, number> = {}
    for (const k in m) mid[k] = Number(m[k])
    setAcct(a); setMids(mid)
    const outcomes = (a?.outcomes ?? []).reduce((s, h) => s + h.size * (mid[h.coin] ?? 0), 0)
    onValue?.((a?.accountValue ?? 0) + outcomes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, onValue])

  useEffect(() => {
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    const off = onBalances(() => void load())
    return () => { clearInterval(id); off() }
  }, [load])

  if (!acct || (acct.accountValue < 0.01 && !acct.positions.length && !acct.outcomes.length)) return null
  const outcomesValue = acct.outcomes.reduce((s, h) => s + h.size * (mids[h.coin] ?? 0), 0)
  return (
    <div className="rh-holdings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: '0.95rem' }}>📈 {T('On Hyperliquid')}</b>
        {HL_TRADING && <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: '0.74rem' }} onClick={() => setFunding('deposit')}>＋ {T('Deposit')}</button>
          <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: '0.74rem' }} onClick={() => setFunding('withdraw')}>{T('Withdraw')}</button>
        </span>}
      </div>
      <div className="arc-card" style={{ padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.8rem' }}>
        <div><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{T('Account value')}</div><b className="sensitive mono">{money(acct.accountValue)}</b></div>
        <div><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{T('Withdrawable')}</div><b className="sensitive mono">{money(acct.withdrawable)}</b></div>
        {acct.outcomes.length > 0 && <div><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{T('Predictions held')}</div><b className="sensitive mono">{money(outcomesValue)}</b></div>}
      </div>
      {acct.positions.map(p => (
        <button key={p.coin} className="arc-card" onClick={() => navigate({ name: 'perps', coin: p.coin })}
          style={{ width: '100%', padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-2)', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', border: '1px solid var(--adx-border)' }}>
          <span style={{ fontWeight: 700 }}>{symbolOf(p.coin)}</span>
          <span className={p.szi > 0 ? 'fx-up' : 'fx-down'} style={{ fontSize: '0.76rem' }}>{p.szi > 0 ? T('Long') : T('Short')} {p.leverage.value}×</span>
          <span className="mono sensitive" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{Math.abs(p.szi)} @ {p.entryPx}</span>
          <span className={`mono sensitive ${p.unrealizedPnl >= 0 ? 'fx-up' : 'fx-down'}`} style={{ marginLeft: 'auto', fontWeight: 700 }}>{p.unrealizedPnl >= 0 ? '+' : '−'}{money(Math.abs(p.unrealizedPnl))}</span>
        </button>
      ))}
      {acct.outcomes.length > 0 && (
        <button className="link-btn" style={{ fontSize: '0.78rem' }} onClick={() => navigate({ name: 'predict' })}>{T('Your predictions')} ({acct.outcomes.length}) →</button>
      )}
      {funding && <Funding account={acct} initial={funding} onClose={() => setFunding(null)} onDone={() => void load()} />}
    </div>
  )
}
