// The coin's safety rating on every buy path (the build pack's Phase 5: "risk label shown on every buy path"). Each coin
// page, and the Swap page for the coin picked there, provides its rating (lib/safety.ts) with <BuyRiskProvider>; every
// trade form (Arc's swap and curve widgets, Solana, BNB Chain, Robinhood Chain, and paying from a Solana wallet) shows
// it right above its Buy button, on desktop and in the phone's trade sheet.
//
//   safe / checking / risky   the label and its reasons; buying goes ahead
//   danger                    buying waits for a tick: "I understand I could lose everything I put in"
//   no rating at all          a form outside a page that rates the coin says so, rather than showing nothing
//   $ARCDEX                   "Official" instead of a rating (owner, 2026-10-04: no safety rating on our own coin)
//
// Selling is never held up: a risk label must never keep someone in a coin. Behind the protective flag `buyRisk` (on; only
// a deploy with VITE_FLAG_BUY_RISK=off turns it off, never /admin).

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { SAFETY_COLOR, SAFETY_ICON, SAFETY_LABEL, type SafetyView } from './safety'
import { t as T } from './i18n'
import { useFlag } from './flags'

/** A page's rating for its coin: a rating, 'official' for $ARCDEX, or null when the page couldn't rate it. */
export type ProvidedRisk = SafetyView | 'official' | null
const Ctx = createContext<ProvidedRisk | undefined>(undefined)

/** Gives every trade form under it the coin's rating. */
export function BuyRiskProvider({ view, children }: { view: ProvidedRisk; children: ReactNode }) {
  return <Ctx.Provider value={view}>{children}</Ctx.Provider>
}

/** What a form shows when no page rated the coin. */
export const UNRATED: SafetyView = { level: 'checking', reasons: [], source: 'market' }

/** What a buy may do under a rating. */
export function buyGate(level: SafetyView['level']): 'go' | 'confirm' {
  return level === 'danger' ? 'confirm' : 'go'
}

export interface BuyRisk {
  view: SafetyView
  /** Whether a page rated the coin ($ARCDEX counts as rated: it's marked Official). */
  rated: boolean
  official: boolean
  /** True while a buy has to wait (a Danger coin not yet acknowledged). */
  blocks: boolean
  /** The label (and, for Danger, the tick), for right above the Buy button. Null when selling. */
  node: ReactNode
}

/** The coin's rating for a trade form. `buying`: whether the form is on its buy side (selling is never held up). */
export function useBuyRisk(buying: boolean): BuyRisk {
  const provided = useContext(Ctx)
  const on = useFlag('buyRisk')
  const official = provided === 'official'
  const view = provided == null || provided === 'official' ? UNRATED : provided
  const rated = provided != null
  const [ack, setAck] = useState(false)
  // A new rating (another coin, or a coin that became Danger) asks again.
  const key = `${view.level}:${view.reasons[0] ?? ''}`
  useEffect(() => { setAck(false) }, [key])
  const confirm = on && buying && !official && buyGate(view.level) === 'confirm'
  const node = !buying || !on ? null : official ? <OfficialLine /> : <BuyRiskLine view={view} rated={rated} confirm={confirm} ack={ack} onAck={setAck} />
  return { view, rated, official, blocks: confirm && !ack, node }
}

/** The label alone, for a form that rates its coin itself and never needs a tick (Starknet: AVNU's verified tokens). */
export function BuyRiskLabel({ view }: { view: SafetyView }) {
  return <BuyRiskLine view={view} rated confirm={false} ack={false} onAck={() => {}} />
}

const box = { borderRadius: 8, padding: '6px 8px', margin: '6px 0', fontSize: '0.74rem', lineHeight: 1.35 } as const

function OfficialLine() {
  return (
    <div className="buy-risk buy-risk-official" role="status" data-buy-risk="official" style={{ ...box, border: '1px solid var(--border)' }}>
      <strong style={{ color: 'var(--accent-text, var(--green))' }}>◆ {T('Official')}</strong>{' '}
      <span style={{ color: 'var(--text-muted)' }}>{T('ARCDEX’s own coin.')}</span>
    </div>
  )
}

function BuyRiskLine({ view, rated, confirm, ack, onAck }: { view: SafetyView; rated: boolean; confirm: boolean; ack: boolean; onAck: (v: boolean) => void }) {
  const c = SAFETY_COLOR[view.level]
  const head = rated ? `${SAFETY_ICON[view.level]} ${T(SAFETY_LABEL[view.level])}` : `${SAFETY_ICON.checking} ${T('Not rated here')}`
  const reasons = rated ? view.reasons.slice(0, 2) : [T('Open the coin’s page to see its safety rating before buying.')]
  const source = view.source === 'chain' ? T('From ARCDEX’s on-chain safety scan. Not financial advice.') : T('From its market data only: not scanned on-chain. Not financial advice.')
  return (
    <div className={`buy-risk buy-risk-${view.level}`} role={view.level === 'danger' ? 'alert' : 'status'} data-buy-risk={rated ? view.level : 'unrated'}
      title={[head, ...view.reasons.map(r => '• ' + r), rated ? source : ''].filter(Boolean).join('\n')}
      style={{ ...box, border: `1px solid ${c}55`, background: `${c}14` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ color: c, whiteSpace: 'nowrap' }}>{head}</strong>
        {reasons.length > 0 && <span style={{ color: 'var(--text-muted)' }}>{reasons.join(' · ')}</span>}
      </div>
      {confirm && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4, cursor: 'pointer', color: 'var(--text)' }}>
          <input type="checkbox" checked={ack} onChange={e => onAck(e.target.checked)} style={{ marginTop: 2 }} />
          <span>{T('I understand this coin is rated Danger and I could lose everything I put in.')}</span>
        </label>
      )}
    </div>
  )
}
