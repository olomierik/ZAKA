// The Trenches' fourth lane (2026-10-12, owner: "a column showing smart wallets' buys and sells, and the coins smart
// wallets are buying now, for users to see as a signal"): from the engine's live feed (api/trenchFeed.ts). On top, the
// coins smart wallets bought in the last half hour, most smart buyers first; underneath, each smart wallet's buy and
// sell as it happens, with that wallet's record. A wallet is smart by what the engine has seen it do on this chain
// (engine/src/trench/book.ts): enough closed trades, most of them won, in profit, holding longer than a bot's flip.

import { memo, useMemo, useState } from 'react'
import type { Page } from '../App'
import type { SmartBuyingWire, SmartTradeWire, TrenchChain } from '../../../api/_trenchProtocol'
import type { TrenchFeed } from '../api/trenchFeed'
import { keyOf } from '../api/trenchFeed'
import { ageOf, usd, type TrenchCoin } from '../lib/trenches'
import { CHAINS } from '../lib/chains'
import { TokenPic } from './TrenchRow'
import { IcMax, IcMin, IcTarget } from './TrIcons'
import { t as T } from '../lib/i18n'
import { normWallet, trackWallet, untrackWallet, useTracked } from '../lib/walletTracker'

interface Props {
  chain: TrenchChain
  feed: TrenchFeed
  /** The lanes' coins by key, for their pages and pictures. */
  coins: Map<string, TrenchCoin>
  now: number
  collapsed: boolean
  onCollapse: () => void
  onOpen: (p: Page) => void
  onBuy: (c: { page: Page; symbol: string }, anchor: HTMLElement) => void
}

const shortW = (w: string) => (w.startsWith('0x') ? `${w.slice(0, 5)}…${w.slice(-3)}` : `${w.slice(0, 4)}…${w.slice(-3)}`)
const pct = (x: number) => `${Math.round(x * 100)}%`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`

function walletUrl(chain: TrenchChain, w: string) {
  if (chain === 'sol') return `https://solscan.io/account/${w}`
  if (chain === 'bnb') return `https://bscscan.com/address/${w}`
  if (chain === 'hood') return `https://robinhoodchain.blockscout.com/address/${w}`
  return `https://explorer.arc.io/address/${w}`
}

/** A coin's page when the lanes don't show it (a coin smart wallets bought that isn't listed). */
function pageOf(chain: TrenchChain, token: string, coins: Map<string, TrenchCoin>): Page {
  const c = coins.get(keyOf(chain, token))
  if (c) return c.page
  if (chain === 'sol') return { name: 'sol-token', address: token }
  if (chain === 'bnb') return { name: 'bsc-token', address: token }
  if (chain === 'hood') return { name: 'rh-token', address: token }
  return { name: 'argus', address: token.toLowerCase(), pool: '' }
}

function SmartLane({ chain, feed, coins, now, collapsed, onCollapse, onOpen, onBuy }: Props) {
  const v = feed.smart
  const [tab, setTab] = useState<'buying' | 'live'>('buying')
  // Smart trades since the last snapshot first, then the snapshot's, once each.
  const trades = useMemo(() => {
    const seen = new Set<string>()
    const out: SmartTradeWire[] = []
    for (const t of [...feed.smartLive, ...(v?.trades ?? [])]) {
      const k = `${t.w}:${t.t}:${t.ts}:${t.side}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(t)
    }
    return out.slice(0, 60)
  }, [feed.smartLive, v])
  const symbolOf = (token: string, s: string) => s || coins.get(keyOf(chain, token))?.symbol || shortW(token)
  const imageOf = (token: string, i: string | null) => i ?? coins.get(keyOf(chain, token))?.image ?? null

  if (collapsed) {
    return (
      <section className="tr-lane tr-lane-min" onClick={onCollapse} title={T('Show {lane}', { lane: T('Smart money') })}>
        <button className="tr-sq" aria-label={T('Show {lane}', { lane: T('Smart money') })}><IcMax /></button>
        <span className="tr-lane-vt"><IcTarget /> {T('Smart money')} <i>{v?.buying.length ?? 0}</i></span>
      </section>
    )
  }

  const rule = v?.rule
  const ruleText = rule ? T('A wallet counts as smart after {n}+ closed trades on {chain}, {w}+ of them won, {p}+ in profit, holding over {s}s on average (bots that flip in seconds don’t count). Measured from the trades ARCDEX has seen since {since}.', {
    n: rule.minTrades, chain: CHAINS[chain].name, w: pct(rule.minWinRate), p: usd(rule.minProfitUsd), s: rule.minHoldSec, since: new Date(v!.since).toLocaleString(),
  }) : ''

  return (
    <section className="tr-lane tr-smart">
      <header className="tr-lane-h">
        <span className="tr-lane-ic"><IcTarget /></span>
        <b>{T('Smart money')}</b>
        <span className="tr-count" title={ruleText}>{v ? T('{n} wallets', { n: v.smart }) : '—'}</span>
        <span className="tr-grow" />
        <div className="tr-seg" role="tablist">
          <button role="tab" aria-selected={tab === 'buying'} className={tab === 'buying' ? 'on' : ''} onClick={() => setTab('buying')}>{T('Buying now')}</button>
          <button role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>{T('Live')}</button>
        </div>
        <button className="tr-sq tr-minb" onClick={onCollapse} title={T('Minimize')}><IcMin /></button>
      </header>
      <div className="tr-list">
        {!feed.on && <div className="tr-empty">{T('Connecting to the live feed…')}</div>}
        {feed.on && v && v.smart === 0 && (
          <div className="tr-empty tr-learn">
            <b>{T('Learning which wallets win on {chain}', { chain: CHAINS[chain].name })}</b>
            <span>{T('{n} wallets followed since {since}. None has a winning record yet.', { n: v.followed.toLocaleString(), since: new Date(v.since).toLocaleTimeString() })}</span>
            <small>{ruleText}</small>
          </div>
        )}
        {feed.on && v && v.smart > 0 && tab === 'buying' && (
          v.buying.length === 0
            ? <div className="tr-empty">{T('No smart wallet has bought in the last {m} minutes.', { m: v.windowMin })}</div>
            : v.buying.map(b => <BuyingRow key={b.t} b={b} chain={chain} now={now} symbol={symbolOf(b.t, b.s)} image={imageOf(b.t, b.i)} onOpen={() => onOpen(pageOf(chain, b.t, coins))} onBuy={el => onBuy({ page: pageOf(chain, b.t, coins), symbol: symbolOf(b.t, b.s) }, el)} />)
        )}
        {feed.on && v && v.smart > 0 && tab === 'live' && (
          trades.length === 0
            ? <div className="tr-empty">{T('No smart wallet has traded yet since you opened this page.')}</div>
            : trades.map(t => (
              <div key={`${t.w}:${t.t}:${t.ts}:${t.side}`} className={`tr-sm-tr ${t.side === 'B' ? 'b' : 's'}`} onClick={() => onOpen(pageOf(chain, t.t, coins))}>
                <span className="tr-sm-side">{t.side === 'B' ? T('BUY') : T('SELL')}</span>
                <span className="tr-sm-pic"><TokenPic src={imageOf(t.t, t.i)} symbol={symbolOf(t.t, t.s)} size={26} /></span>
                <span className="tr-sm-main">
                  <b>{symbolOf(t.t, t.s)} <em>{usd(t.u)}</em></b>
                  <a href={walletUrl(chain, t.w)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={T('This wallet: {n} closed trades, {w} won, {p} realized', { n: t.n, w: pct(t.wr), p: signed(t.pnl) })}>
                    {shortW(t.w)} · {pct(t.wr)} · {signed(t.pnl)}
                  </a>
                  <TrackBtn wallet={t.w} />
                </span>
                <span className="tr-sm-age">{ageOf(t.ts, now)}{t.m ? <small>MC {usd(t.m)}</small> : null}</span>
              </div>
            ))
        )}
      </div>
      {feed.on && v && v.smart > 0 && <footer className="tr-sm-f" title={ruleText}>{T('Smart = a winning record on {chain}, measured by ARCDEX from on-chain trades. Not advice.', { chain: CHAINS[chain].name })}</footer>}
    </section>
  )
}

function BuyingRow({ b, chain, now, symbol, image, onOpen, onBuy }: { b: SmartBuyingWire; chain: TrenchChain; now: number; symbol: string; image: string | null; onOpen: () => void; onBuy: (el: HTMLElement) => void }) {
  return (
    <article className="tr-sm-buy" onClick={onOpen}>
      <span className="tr-sm-pic lg"><TokenPic src={image} symbol={symbol} size={40} /></span>
      <span className="tr-sm-main">
        <b>{symbol} {b.m ? <small>MC {usd(b.m)}</small> : null}</b>
        <span className="tr-sm-who">
          <i className="tr-sm-n">{b.buyers === 1 ? T('1 smart wallet') : T('{n} smart wallets', { n: b.buyers })}</i>
          <span className="up">{signed(b.buyUsd - b.sellUsd)}</span>
          {b.sellers > 0 && <span className="down" title={T('Smart wallets selling it')}>{T('{n} selling', { n: b.sellers })}</span>}
        </span>
        <small className="tr-sm-when">{T('last buy {age} ago', { age: ageOf(b.last, now) })} · {CHAINS[chain].short}</small>
      </span>
      <button className="tr-buy sm" onClick={e => { e.stopPropagation(); onBuy(e.currentTarget) }}>{T('Buy')}</button>
    </article>
  )
}

export default memo(SmartLane)

/** Follow a smart wallet in the wallet tracker (pages/TrackerPage.tsx), or stop. */
function TrackBtn({ wallet }: { wallet: string }) {
  const on = useTracked().some(w => w.address === normWallet(wallet))
  return (
    <button className={`tr-sm-track${on ? ' on' : ''}`} title={on ? T('Following in the wallet tracker: click to stop') : T('Follow this wallet in the wallet tracker')}
      onClick={e => { e.stopPropagation(); try { if (on) untrackWallet(wallet); else trackWallet(wallet) } catch { /* the limit: the tracker page says so */ } }}>
      {on ? T('Tracking') : T('Track')}
    </button>
  )
}
