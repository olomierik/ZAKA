// The Trenches' fourth lane: Trending now (2026-10-17, owner: "I don't think the smart wallet column is good; use it
// to show the trending coins on fomo, for users to experience what people are buying now"). It replaces Smart money.
//
// fomo's own Trending is Mobula's pulse feed (sorted by fees paid), reached only with a fomo user's sign-in or a paid
// Mobula plan, so this lane makes the same list from what ARCDEX can read for free: the busiest listed coins on Arc,
// Robinhood Chain, Solana and BNB Chain (the engine's /api/trending), ranked by how many buys each had in the last
// hour, read live from DexScreener (lib/dexData.ts) every 15 seconds. All chains, or just the one on screen.

import { memo, useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import type { TrendChain, TrendRow, TrendingAnswer } from '../../../api/trending'
import { siteFetch } from '../api/siteFetch'
import { dsCoins, type DsCoin } from '../lib/dexData'
import { usd } from '../lib/trenches'
import { CHAINS, type TChain } from '../lib/chains'
import { launchpadIcon } from '../lib/launchpadIcon'
import ChainLogo from './ChainLogo'
import { TokenPic } from './TrenchRow'
import { IcFire, IcMax, IcMin } from './TrIcons'
import { t as T } from '../lib/i18n'

const TCHAIN: Record<TrendChain, TChain> = { arc: 'arc', robinhood: 'hood', solana: 'sol', bsc: 'bnb' }
/** Coins read from each chain's list, and shown. */
export const TREND = { perChain: 30, shown: 40, refreshMs: 15_000 }

export interface TrendCoin {
  chain: TChain
  address: string
  pool: string
  symbol: string
  name: string
  image: string | null
  launchpad: string | null
  marketCap: number
  change1h: number | null
  change24h: number
  buys1h: number | null
  sells1h: number | null
  volume1h: number | null
  volume24h: number
}

/** A list row with DexScreener's last hour on it. */
export function trendCoin(r: TrendRow, d: DsCoin | null | undefined): TrendCoin {
  return {
    chain: TCHAIN[r.chain], address: r.address, pool: r.pool, symbol: r.symbol, name: r.name, image: r.image ?? d?.image ?? null,
    launchpad: r.launchpad, marketCap: d && d.marketCap > 0 ? d.marketCap : r.marketCapUsd, change1h: d ? d.change1h : null,
    change24h: d && d.change24h ? d.change24h : r.change24h, buys1h: d ? d.buys1h : null, sells1h: d ? d.sells1h : null,
    volume1h: d ? d.volume1h : null, volume24h: d && d.volume24h > 0 ? d.volume24h : r.volume24h,
  }
}

/** What people are buying now: the most buys in the last hour first, then the hour's volume, then the day's. */
export function rankTrend(cs: TrendCoin[]): TrendCoin[] {
  return [...cs].sort((a, b) => (b.buys1h ?? -1) - (a.buys1h ?? -1) || (b.volume1h ?? -1) - (a.volume1h ?? -1) || b.volume24h - a.volume24h)
}

export function pageOfTrend(c: TrendCoin): Page {
  if (c.chain === 'sol') return { name: 'sol-token', address: c.address, pool: c.pool }
  if (c.chain === 'bnb') return { name: 'bsc-token', address: c.address, pool: c.pool }
  if (c.chain === 'hood') return { name: 'rh-token', address: c.address, pool: c.pool }
  return { name: 'argus', address: c.address.toLowerCase(), pool: c.pool.toLowerCase() }
}

function useTrending(): TrendCoin[] | null {
  const [coins, setCoins] = useState<TrendCoin[] | null>(null)
  useEffect(() => {
    let live = true
    const load = async () => {
      if (document.hidden) return
      const r = await siteFetch('/api/trending').catch(() => null)
      const a = r?.ok ? ((await r.json().catch(() => null)) as TrendingAnswer | null) : null
      if (!a || !live) return
      const byChain = new Map<TrendChain, TrendRow[]>()
      for (const row of a.rows) {
        const l = byChain.get(row.chain) ?? []
        if (l.length < TREND.perChain) l.push(row)
        byChain.set(row.chain, l)
      }
      const read = await Promise.all([...byChain].map(async ([ch, rows]) => {
        const ds = await dsCoins(TCHAIN[ch], rows.map(x => x.address)).catch(() => new Map<string, DsCoin | null>())
        return rows.map(x => trendCoin(x, ds.get(x.address)))
      }))
      if (live) setCoins(rankTrend(read.flat()))
    }
    void load()
    const id = setInterval(() => void load(), TREND.refreshMs)
    return () => { live = false; clearInterval(id) }
  }, [])
  return coins
}

interface Props {
  chain: TChain
  collapsed: boolean
  onCollapse: () => void
  onOpen: (p: Page) => void
  /** Buy opens the coin's own page (its chain may not be the one on screen, so its trade form asks the amount). */
  onBuy: (p: Page) => void
}

const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)}%`

function TrendLane({ chain, collapsed, onCollapse, onOpen, onBuy }: Props) {
  const all = useTrending()
  const [scope, setScope] = useState<'all' | 'chain'>('all')
  const list = useMemo(() => (all ?? []).filter(c => scope === 'all' || c.chain === chain).slice(0, TREND.shown), [all, scope, chain])

  if (collapsed) {
    return (
      <section className="tr-lane tr-lane-min" onClick={onCollapse} title={T('Show {lane}', { lane: T('Trending now') })}>
        <button className="tr-sq" aria-label={T('Show {lane}', { lane: T('Trending now') })}><IcMax /></button>
        <span className="tr-lane-vt"><IcFire /> {T('Trending now')} <i>{list.length}</i></span>
      </section>
    )
  }

  return (
    <section className="tr-lane tr-trend">
      <header className="tr-lane-h">
        <span className="tr-lane-ic"><IcFire /></span>
        <b>{T('Trending now')}</b>
        <span className="tr-grow" />
        <div className="tr-seg" role="tablist">
          <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{T('All chains')}</button>
          <button role="tab" aria-selected={scope === 'chain'} className={scope === 'chain' ? 'on' : ''} onClick={() => setScope('chain')}>{CHAINS[chain].short}</button>
        </div>
        <button className="tr-sq tr-minb" onClick={onCollapse} title={T('Minimize')}><IcMin /></button>
      </header>
      <div className="tr-list">
        {all === null && <div className="tr-empty">{T('Loading…')}</div>}
        {all !== null && list.length === 0 && <div className="tr-empty">{T('Nothing trending on {chain} right now.', { chain: CHAINS[chain].name })}</div>}
        {list.map((c, i) => {
          const tx = (c.buys1h ?? 0) + (c.sells1h ?? 0)
          const share = tx > 0 ? ((c.buys1h ?? 0) / tx) * 100 : 50
          const lp = launchpadIcon(c.launchpad)
          return (
            <article key={`${c.chain}:${c.address}`} className="tr-tn" onClick={() => onOpen(pageOfTrend(c))}>
              <span className="tr-tn-rank">{i + 1}</span>
              <span className="tr-sm-pic lg">
                <TokenPic src={c.image} symbol={c.symbol} size={40} />
                <span className="tr-tn-chain" title={CHAINS[c.chain].name}><ChainLogo chain={c.chain} size={14} /></span>
              </span>
              <span className="tr-sm-main">
                <b>{c.symbol}{lp && <img className="tr-tn-lp" src={lp} alt="" title={c.launchpad ?? ''} loading="lazy" />} <small>MC {usd(c.marketCap)}</small></b>
                <span className="tr-sm-who">
                  {c.buys1h !== null
                    ? <i className="tr-sm-n" title={T('{b} buys / {s} sells in the last hour', { b: c.buys1h, s: c.sells1h ?? 0 })}>{T('{n} buys in 1h', { n: c.buys1h.toLocaleString() })}</i>
                    : <i className="tr-sm-n">{T('24h vol {v}', { v: usd(c.volume24h) })}</i>}
                  {c.change1h !== null && <span className={c.change1h >= 0 ? 'up' : 'down'}>1h {pct(c.change1h)}</span>}
                </span>
                {tx > 0 && <span className="tr-txbar tr-tn-bar"><i style={{ width: `${share}%` }} /></span>}
              </span>
              <button className="tr-buy sm" onClick={e => { e.stopPropagation(); onBuy(pageOfTrend(c)) }}>{T('Buy')}</button>
            </article>
          )
        })}
      </div>
      <footer className="tr-sm-f">{T('The busiest listed coins on every chain, ranked by buys in the last hour (DexScreener). Not advice.')}</footer>
    </section>
  )
}

export default memo(TrendLane)
