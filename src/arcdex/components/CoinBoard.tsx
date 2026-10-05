// The coin board (2026-10-04, owner: "show and classify coins as new, near bond, graduated; avoid buying rugs"): three
// live columns, as memecoin traders know them from GMGN and Axiom: New (launched in the last hour), Near bond (closest
// to graduating first, then the rest still on their curve) and Graduated (off the curve, or launched into a pool; the
// youngest first). Each coin carries its safety rating (lib/safety.ts). The same board serves Arc and Robinhood Chain;
// each page turns its rows into BoardCoin. Phones: one column at a time.

import { useState } from 'react'
import SafetyBadge from './SafetyBadge'
import { STAGE, type Stage } from '../lib/coinStage'
import type { SafetyView } from '../lib/safety'
import { t as T } from '../lib/i18n'
import { useLogo } from '../lib/logo'

export interface BoardCoin {
  key: string
  symbol: string
  name: string
  logo: string | null
  launchpad: string | null
  launchpadColor?: string
  ageMs: number
  marketCap: number
  liquidity: number
  volume24h: number
  change24h: number
  /** Unknown: null. */
  holders: number | null
  /** Unique wallets trading in 24h (Robinhood Chain, where holders aren't known). */
  traders24h?: number | null
  /** 0–100 along its curve, for a coin still on one (null: unknown, or off the curve). */
  progress: number | null
  stage: Stage
  safety: SafetyView
  /** Trades in the last 15 minutes, when it's one of the busiest. */
  hot?: number
  /** ARCDEX's own coin: "Official", no safety rating. */
  official?: boolean
  /** The first coin launched with its ticker (lib/dupes.ts), or a later one. */
  og?: boolean
  dup?: boolean
}

type Col = 'new' | 'near' | 'graduated'
const MAX = 40

const fmt = (n: number) => (!n || !Number.isFinite(n) ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`)
const age = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d` }

/** The coin's image, else its ticker's first letters on a colour of its own. */
function Logo({ src, symbol, size }: { src: string | null; symbol: string; size: number }) {
  const { url, onError } = useLogo(src, size)
  if (!url) {
    return <span className="cb-logo" style={{ width: size, height: size, fontSize: size * 0.35, background: `hsl(${(symbol.charCodeAt(0) * 17 + 180) % 360},60%,25%)` }}>{symbol.slice(0, 2).toUpperCase()}</span>
  }
  return <img className="cb-logo" src={url} alt="" style={{ width: size, height: size }} onError={onError} loading="lazy" />
}

export default function CoinBoard({ coins, onOpen, mobile }: { coins: BoardCoin[]; onOpen: (c: BoardCoin) => void; mobile: boolean }) {
  const [col, setCol] = useState<Col>('new')
  const fresh = coins.filter(c => c.stage === 'new').sort((a, b) => a.ageMs - b.ageMs)
  // About to graduate first; then the rest still bonding, closest first.
  const near = [
    ...coins.filter(c => c.stage === 'near').sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)),
    ...coins.filter(c => c.stage === 'bonding').sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1) || b.volume24h - a.volume24h),
  ]
  const grads = coins.filter(c => c.stage === 'graduated').sort((a, b) => a.ageMs - b.ageMs)
  const cols: { id: Col; title: string; hint: string; list: BoardCoin[] }[] = [
    { id: 'new', title: '✨ ' + T('New'), hint: T('Launched in the last hour, newest first'), list: fresh },
    { id: 'near', title: '🚀 ' + T('Near bond'), hint: T('{pct}%+ along the curve first, then the rest still bonding', { pct: STAGE.nearPct }), list: near },
    { id: 'graduated', title: '🎓 ' + T('Graduated'), hint: T('Off the curve and trading in a pool, youngest first'), list: grads },
  ]
  const shown = mobile ? cols.filter(c => c.id === col) : cols
  return (
    <div className="coin-board">
      {mobile && (
        <div className="cb-tabs" role="tablist">
          {cols.map(c => (
            <button key={c.id} role="tab" aria-selected={col === c.id} className={col === c.id ? 'on' : ''} onClick={() => setCol(c.id)}>
              {c.title} <span>{c.list.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cb-cols">
        {shown.map(c => (
          <section key={c.id} className="cb-col">
            {!mobile && <header><b>{c.title}</b><span>{c.list.length}</span><small>{c.hint}</small></header>}
            {mobile && <small className="cb-hint">{c.hint}</small>}
            <div className="cb-list">
              {c.list.length === 0 && <div className="cb-empty">{c.id === 'new' ? T('No launches in the last hour.') : c.id === 'near' ? T('No coin on a curve right now.') : T('No graduated coins to show.')}</div>}
              {c.list.slice(0, MAX).map((x, i) => (
                <button key={x.key} className={`cb-card${x.stage === 'near' ? ' near' : ''}`} onClick={() => onOpen(x)}>
                  {c.id === 'near' && i > 0 && x.stage === 'bonding' && c.list[i - 1].stage === 'near' && <span className="cb-divider">{T('Still bonding')}</span>}
                  <Logo src={x.logo} symbol={x.symbol} size={36} />
                  <div className="cb-main">
                    <div className="cb-top">
                      <b>{x.symbol}</b>
                      {x.official && <span className="mk-official">{T('Official')}</span>}
                      {x.og && <span className="cb-og" title={T('The first coin launched with this ticker; the others are duplicates.')}>OG</span>}
                      {x.dup && <span className="cb-dup" title={T('A later coin using the OG’s ticker: not the original.')}>{T('Duplicate')}</span>}
                      {x.launchpad && <span className="cb-lp" style={x.launchpadColor ? { color: x.launchpadColor, borderColor: x.launchpadColor + '55' } : undefined}>{x.launchpad}</span>}
                      {x.hot ? <span className="cb-hot" title={T('{n} trades in the last 15 minutes', { n: x.hot })}>🔥 {x.hot}</span> : null}
                      <span className="cb-age">{age(x.ageMs)}</span>
                    </div>
                    <div className="cb-name">{x.name}</div>
                    <div className="cb-stats">
                      <span>{T('MC')} <b>{fmt(x.marketCap)}</b></span>
                      <span>{T('Liq')} <b>{fmt(x.liquidity)}</b></span>
                      {x.holders !== null ? <span>👥 <b>{x.holders.toLocaleString()}</b></span> : x.traders24h ? <span title={T('Wallets trading in 24h')}>👥 <b>{x.traders24h.toLocaleString()}</b></span> : null}
                      <span className={x.change24h >= 0 ? 'up' : 'down'}>{x.change24h >= 0 ? '+' : ''}{x.change24h.toFixed(1)}%</span>
                    </div>
                    {x.progress !== null && x.stage !== 'graduated' && x.stage !== 'established' && (
                      <div className="cb-bar" title={T('{pct}% of the way to graduating', { pct: x.progress.toFixed(0) })}>
                        <i style={{ width: `${Math.max(2, Math.min(100, x.progress))}%` }} /><span>{x.progress.toFixed(0)}%</span>
                      </div>
                    )}
                  </div>
                  {x.official ? <span /> : <SafetyBadge view={x.safety} icon />}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
