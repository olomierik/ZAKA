// A coin's page on desktop, in motion.gift's layout (2026-10-12), shared by every chain: on the left the coin's header
// (picture, ticker, tags, market cap, its numbers, its pools), the chart and the tabs underneath (trades, holders…);
// on the right its moves (5m, 1h, 6h, 24h), the day's flow, the trade form and the coin's checks. Each chain's page
// fills these in with its own data and trade form; phones keep each page's own layout.

import { useState, type ReactNode } from 'react'
import { TokenPic } from './TrenchRow'
import ChainLogo from './ChainLogo'
import { usd } from '../lib/trenches'
import type { TChain } from '../lib/chains'
import { t as T } from '../lib/i18n'

export interface TkStat { label: string; value: ReactNode; tone?: 'up' | 'down' }
export interface TkTab { id: string; label: string; count?: number | null; body: ReactNode }

interface Props {
  chain: TChain
  image: string | null
  symbol: string
  name: string
  tags?: ReactNode
  links?: ReactNode
  mc: number | null
  /** The price moved up or down (the market cap flashes). */
  dir?: 'up' | 'down' | null
  stats: TkStat[]
  pools?: ReactNode
  notices?: ReactNode
  chart: ReactNode
  tabs: TkTab[]
  /** The page's own bottom, with its own tabs, instead of `tabs`. */
  bottom?: ReactNode
  changes: { label: string; pct: number | null }[]
  flow?: { volume: number | null; buys: number | null; sells: number | null }
  trade: ReactNode
  side?: ReactNode
}

const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)}%`

export default function TokenLayout(p: Props) {
  const [tab, setTab] = useState(p.tabs[0]?.id ?? '')
  const current = p.tabs.find(t => t.id === tab) ?? p.tabs[0]
  const buys = p.flow?.buys ?? null, sells = p.flow?.sells ?? null
  const buyShare = buys !== null && sells !== null && buys + sells > 0 ? (buys / (buys + sells)) * 100 : null
  return (
    <div className="tk-page">
      <div className="tk-left">
        <div className="tk-head">
          <div className="tk-id">
            <span className="tk-img"><span className="tr-pic"><TokenPic src={p.image} symbol={p.symbol} size={44} /></span><span className="tk-chain"><ChainLogo chain={p.chain} size={15} /></span></span>
            <div className="tk-id-txt">
              <div className="tk-id-l1"><b>{p.symbol}</b><span title={p.name}>{p.name}</span>{p.links}</div>
              <div className="tk-id-l2">{p.tags}</div>
            </div>
          </div>
          <div className="tk-mc"><b key={p.mc ?? 0} className={p.dir ? `tick-${p.dir}` : ''}>{p.mc ? usd(p.mc) : '…'}</b><small>{T('Market cap')}</small></div>
          <div className="tk-stats">
            {p.stats.map(s => <div key={s.label}><span>{s.label}</span><b className={s.tone ?? ''}>{s.value}</b></div>)}
          </div>
          {p.pools && <div className="tk-pools">{p.pools}</div>}
        </div>
        {p.notices}
        <div className="tk-chart">{p.chart}</div>
        <div className="tk-bottom">
          {p.bottom ?? (
            <>
              <div className="tk-tabs" role="tablist">
                {p.tabs.map(t => (
                  <button key={t.id} role="tab" aria-selected={t.id === current?.id} className={t.id === current?.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                    {t.label}{t.count != null && <span>{t.count.toLocaleString()}</span>}
                  </button>
                ))}
              </div>
              <div className="tk-tab-body">{current?.body}</div>
            </>
          )}
        </div>
      </div>
      <aside className="tk-right">
        <div className="tk-chg">
          {p.changes.map(c => (
            <div key={c.label}><span>{c.label}</span><b className={c.pct === null ? '' : c.pct >= 0 ? 'up' : 'down'}>{c.pct === null ? '—' : pct(c.pct)}</b></div>
          ))}
        </div>
        {p.flow && (
          <div className="tk-flow">
            <div><span>{T('Vol')}</span><b>{p.flow.volume ? usd(p.flow.volume) : '—'}</b></div>
            <div><span>{T('Buys')}</span><b className="up">{buys !== null ? buys.toLocaleString() : '—'}</b></div>
            <div><span>{T('Sells')}</span><b className="down">{sells !== null ? sells.toLocaleString() : '—'}</b></div>
            <div><span>{T('Buy share')}</span><b className={buyShare === null ? '' : buyShare >= 50 ? 'up' : 'down'}>{buyShare === null ? '—' : `${buyShare.toFixed(0)}%`}</b></div>
            {buyShare !== null && <i className="tk-flow-bar"><i style={{ width: `${buyShare}%` }} /></i>}
          </div>
        )}
        <div className="tk-trade">{p.trade}</div>
        {p.side}
      </aside>
    </div>
  )
}

/** A panel in the right column (the coin's checks, its position, its pools…). */
export function TkPanel({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="tk-panel">
      {title && <div className="tk-panel-h"><b>{title}</b>{right}</div>}
      {children}
    </section>
  )
}
