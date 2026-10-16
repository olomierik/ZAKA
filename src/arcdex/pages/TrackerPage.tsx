// The wallet tracker (owner, 2026-10-16: GMGN's wallet tracking, in ARCDEX's own look): follow any wallet on Arc,
// Robinhood Chain, Solana or BNB Chain, and see its buys and sells as they happen, with its record on each chain.
// The wallets followed are kept in this browser (lib/walletTracker.ts); the trades come from the engine.

import { useMemo, useState } from 'react'
import type { Page } from '../App'
import type { TrenchChain, WalletRecordWire } from '../../../api/_trenchProtocol'
import ChainLogo from '../components/ChainLogo'
import Ago from '../components/Ago'
import { TokenPic } from '../components/TrenchRow'
import { CHAIN_LABEL, TRACK_LIMIT, coinPageOf, normWallet, ownerOf, trackWallet, untrackWallet, updateTracked, useTrackerFeed, useTracked, type FeedItem, type TrackedWallet } from '../lib/walletTracker'
import { useTrenchFeed } from '../api/trenchFeed'
import { useChain } from '../lib/chains'
import { enableAlertNotifications } from '../lib/notify'
import { engineEnabled } from '../api/marketStream'
import { t as T } from '../lib/i18n'

interface Props { navigate: (p: Page) => void; focus?: string }

const short = (a: string) => (a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : `${a.slice(0, 4)}…${a.slice(-4)}`)
const usd = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : Math.abs(n) >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`
const MIN_SIZES = [0, 10, 100, 1000] as const

function Records({ records }: { records: WalletRecordWire[] | undefined }) {
  if (!records?.length) return <span className="wt-rec none">{T('No closed trades seen yet')}</span>
  return (
    <span className="wt-recs">
      {records.map(r => (
        <span key={r.c} className="wt-rec" title={T('{n} closed trades on {chain} · {open} open', { n: r.trades, chain: CHAIN_LABEL[r.c], open: r.open })}>
          <ChainLogo chain={r.c} size={12} />
          {r.smart && <b className="wt-smart">{T('Smart')}</b>}
          <span>{Math.round(r.winRate * 100)}%</span>
          <span className={r.pnl >= 0 ? 'up' : 'down'}>{signed(r.pnl)}</span>
        </span>
      ))}
    </span>
  )
}

function WalletCard({ w, records, on, onPick }: { w: TrackedWallet; records?: WalletRecordWire[]; on: boolean; onPick: () => void }) {
  const [edit, setEdit] = useState(false)
  const [label, setLabel] = useState(w.label)
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard?.writeText(w.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})
  const toggleAlerts = async () => {
    if (!w.alerts) await enableAlertNotifications().catch(() => false)
    updateTracked(w.address, { alerts: !w.alerts })
  }
  return (
    <div className={`wt-card${on ? ' on' : ''}`}>
      <button className="wt-card-main" onClick={onPick} title={T('Show only this wallet’s trades')}>
        {edit ? null : <b>{w.label || short(w.address)}</b>}
        {w.label && !edit && <small>{short(w.address)}</small>}
      </button>
      {edit && (
        <form className="wt-rename" onSubmit={e => { e.preventDefault(); updateTracked(w.address, { label }); setEdit(false) }}>
          <input autoFocus value={label} maxLength={32} placeholder={T('Label')} onChange={e => setLabel(e.target.value)} onBlur={() => { updateTracked(w.address, { label }); setEdit(false) }} />
        </form>
      )}
      <Records records={records} />
      <span className="wt-card-acts">
        <button onClick={copy} title={T('Copy the address')}>{copied ? '✓' : '⧉'}</button>
        <button onClick={() => { setLabel(w.label); setEdit(true) }} title={T('Rename')}>✎</button>
        <button className={w.alerts ? 'on' : ''} onClick={() => void toggleAlerts()} title={w.alerts ? T('Alerts on: a notice for each of its trades') : T('Alerts off')}>{w.alerts ? '🔔' : '🔕'}</button>
        <button onClick={() => untrackWallet(w.address)} title={T('Stop following')}>✕</button>
      </span>
    </div>
  )
}

function FeedRow({ t, who, navigate }: { t: FeedItem; who: string; navigate: (p: Page) => void }) {
  return (
    <button className={`wt-row${t.live ? ' live' : ''}`} onClick={() => navigate(coinPageOf(t.c, t.t))}>
      <span className="wt-age"><Ago ts={t.ts} /></span>
      <span className="wt-who" title={t.w}>{who}</span>
      <span className={`wt-side ${t.side === 'B' ? 'buy' : 'sell'}`}>{t.side === 'B' ? T('Buy') : T('Sell')}</span>
      <span className="wt-coin">
        <span className="wt-pic"><TokenPic src={t.i} symbol={t.s || '?'} size={22} /></span>
        <b>{t.s || short(t.t)}</b>
        <ChainLogo chain={t.c} size={12} />
      </span>
      <span className={`wt-usd ${t.side === 'B' ? 'buy' : 'sell'}`}>{usd(t.u)}</span>
      <span className="wt-mc">{t.m > 0 ? `MC ${usd(t.m)}` : ''}</span>
    </button>
  )
}

export default function TrackerPage({ navigate, focus }: Props) {
  const tracked = useTracked()
  const chain = useChain()
  const focused = focus ? normWallet(focus) : null
  const following = tracked.map(w => w.address)
  // A wallet opened by link that isn't followed yet is read too, so its trades show before following it.
  const wallets = focused && !following.includes(focused) ? [focused, ...following] : following
  const feed = useTrackerFeed(wallets)
  const smart = useTrenchFeed(chain as TrenchChain).smart
  const [addr, setAddr] = useState(focus ?? '')
  const [label, setLabel] = useState('')
  const [err, setErr] = useState('')
  const [only, setOnly] = useState<string | null>(focused)
  const [side, setSide] = useState<'all' | 'B' | 'S'>('all')
  const [min, setMin] = useState<(typeof MIN_SIZES)[number]>(0)

  const add = (a = addr, l = label) => {
    setErr('')
    try { trackWallet(a, l); setAddr(''); setLabel('') }
    catch (e) { setErr((e as Error).message === 'limit' ? T('You can follow up to {n} wallets.', { n: TRACK_LIMIT }) : T('That isn’t an EVM or Solana wallet address.')) }
  }

  const items = useMemo(() => feed.items.filter(t =>
    (!only || (t.c === 'sol' ? t.w === only : t.w.toLowerCase() === only)) && (side === 'all' || t.side === side) && t.u >= min,
  ), [feed.items, only, side, min])
  const nameOf = (t: FeedItem) => { const o = ownerOf(t, tracked); return o?.label || short(t.w) }
  const suggestions = (smart?.top ?? []).filter(s => !following.includes(normWallet(s.w) ?? s.w)).slice(0, 6)

  return (
    <div className="content-page wt-page" style={{ ['--page-w' as string]: '1180px' }}>
      <div className="wt-head">
        <div>
          <h1 className="page-h">{T('Wallet tracker')}</h1>
          <p className="wt-sub">{T('Follow any wallet on Arc, Robinhood Chain, Solana or BNB Chain and see its buys and sells the moment they happen.')}</p>
        </div>
        <form className="wt-add" onSubmit={e => { e.preventDefault(); add() }}>
          <input value={addr} onChange={e => { setAddr(e.target.value); setErr('') }} placeholder={T('Wallet address (0x… or Solana)')} spellCheck={false} />
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder={T('Label (optional)')} maxLength={32} />
          <button type="submit" disabled={!addr.trim()}>{T('Track')}</button>
        </form>
      </div>
      {err && <div className="wt-err">{err}</div>}
      {!engineEnabled && <div className="wt-err">{T('The live feed isn’t reachable right now.')}</div>}
      {focused && !following.includes(focused) && (
        <div className="wt-focus">
          <span>{T('Showing {w}, not followed yet.', { w: short(focused) })}</span>
          <button onClick={() => add(focused, '')}>{T('Track')}</button>
        </div>
      )}

      <div className="wt-grid">
        <aside className="wt-list">
          <div className="wt-list-h">
            <b>{T('Following')}</b><span>{tracked.length}/{TRACK_LIMIT}</span>
            {only && <button className="link-btn" onClick={() => setOnly(null)}>{T('Show all')}</button>}
          </div>
          {tracked.map(w => <WalletCard key={w.address} w={w} records={feed.records.get(w.address)} on={only === w.address} onPick={() => setOnly(o => (o === w.address ? null : w.address))} />)}
          {!tracked.length && <p className="wt-empty">{T('No wallets yet. Paste an address above, or start with one of the smart wallets below.')}</p>}
          {suggestions.length > 0 && (
            <div className="wt-suggest">
              <div className="wt-list-h"><b>{T('Smart wallets on {chain}', { chain: CHAIN_LABEL[chain as TrenchChain] })}</b></div>
              {suggestions.map(s => (
                <div key={s.w} className="wt-sg">
                  <span title={s.w}>{short(s.w)}</span>
                  <span className="wt-rec"><span>{Math.round(s.wr * 100)}%</span><span className={s.pnl >= 0 ? 'up' : 'down'}>{signed(s.pnl)}</span></span>
                  <button onClick={() => add(s.w, '')}>{T('Track')}</button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="wt-feed">
          <div className="wt-feed-h">
            <span className="wt-live"><i />{T('Live')}</span>
            <div className="tr-seg" role="group" aria-label={T('Side')}>
              {(['all', 'B', 'S'] as const).map(s => <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s === 'all' ? T('All') : s === 'B' ? T('Buys') : T('Sells')}</button>)}
            </div>
            <select className="disc-select" value={min} onChange={e => setMin(Number(e.target.value) as (typeof MIN_SIZES)[number])} aria-label={T('Min size')}>
              {MIN_SIZES.map(m => <option key={m} value={m}>{m === 0 ? T('Any size') : `≥ ${usd(m)}`}</option>)}
            </select>
          </div>
          {items.map(t => <FeedRow key={t.key} t={t} who={nameOf(t)} navigate={navigate} />)}
          {!items.length && (
            <p className="wt-empty">{feed.loading ? T('Loading…') : wallets.length
              ? T('No trades yet. New ones show here the moment they happen; on Solana, Robinhood Chain and BNB Chain, trades are kept from when you start following.')
              : T('Follow a wallet to see its trades here.')}</p>
          )}
        </section>
      </div>
    </div>
  )
}
