// One coin in a Trenches lane, laid out as motion.gift's rows: the picture in a ring that fills as the coin bonds,
// its ticker, name and tags, its age and socials; volume, market cap, liquidity and trades on the right; its
// holders, safety and recent moves underneath, and Buy (which asks for the amount). Every live trade blinks the row
// green or red and floats its dollars up from the market cap ("+$120"), so the busy coins show themselves.

import { memo, useEffect, useState } from 'react'
import type { TrenchCoin, TrenchSettings } from '../lib/trenches'
import { ageOf, count, usd } from '../lib/trenches'
import { useLogo } from '../lib/logo'
import { toggleWatch, usePrefs } from '../lib/prefs'
import { t as T } from '../lib/i18n'
import { SAFETY_LABEL } from '../lib/safety'
import { IcBolt, IcCopy, IcCrosshair, IcDev, IcGlobe, IcLayers, IcPulse, IcRocket, IcSearch, IcShield, IcStar, IcTelegram, IcUser, IcUsers, IcX } from './TrIcons'
import { launchpadIcon } from '../lib/launchpadIcon'

const short = (a: string) => (a.startsWith('0x') ? `${a.slice(0, 4)}…${a.slice(-3)}` : `${a.slice(0, 4)}…${a.slice(-4)}`)
const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)}%`
/** A market cap or liquidity not known yet (a launch before its first trade) reads as a dash, not $0. */
const known = (n: number) => (n > 0 ? usd(n) : '—')
/** Market caps under $30K in green, bigger ones orange (motion's metric colours). */
const mcClass = (mc: number) => (mc >= 30_000 ? 'mc hi' : 'mc')

/** A coin's picture over its letters: the letters show until (or unless) the picture loads. */
export function TokenPic({ src, symbol, size }: { src: string | null; symbol: string; size: number }) {
  const { url, onError } = useLogo(src, size)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => setLoaded(false), [url])
  const h = ([...symbol].reduce((a, ch) => a + ch.charCodeAt(0), 0) * 37) % 360
  return (
    <>
      <span className="tr-ini" style={{ ['--h' as string]: h }}>{symbol.replace(/^\$/, '').slice(0, 2).toUpperCase() || '?'}</span>
      {url && <img className={loaded ? 'on' : ''} src={url} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={onError} />}
    </>
  )
}

/** A live trade on the row: its side, a counter that restarts the blink, and its dollars when known. */
export interface RowFlash { side: 'buy' | 'sell'; n: number; usd?: number | null }

interface Props {
  c: TrenchCoin
  s: TrenchSettings
  flash?: RowFlash
  fresh?: boolean
  now: number
  onOpen: (c: TrenchCoin) => void
  onBuy: (c: TrenchCoin, anchor: HTMLElement) => void
}

const popText = (f: RowFlash) => {
  const u = f.usd ?? 0
  const amt = u >= 1000 ? `$${(u / 1000).toFixed(1)}K` : u >= 10 ? `$${u.toFixed(0)}` : `$${u.toFixed(2)}`
  return u > 0 ? `${f.side === 'buy' ? '+' : '−'}${amt}` : f.side === 'buy' ? T('Buy') : T('Sell')
}

function Row({ c, s, flash, fresh, now, onOpen, onBuy }: Props) {
  const starred = usePrefs().watchlist.includes(c.address.toLowerCase())
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard?.writeText(c.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})
  }
  const done = c.stage === 'graduated' || c.stage === 'established'
  const ring = !s.ring ? 0 : done ? 1 : c.onCurve && c.progress !== null ? Math.max(0.02, Math.min(1, c.progress / 100)) : 0
  // GMGN's window: the last hour's numbers (Arc's from the engine, the others' from DexScreener).
  const want1h = s.window === '1h'
  const hr = want1h && c.hour ? c.hour : null
  // 1h asked for but not known for this coin: dashes, not the day's numbers under the 1h label.
  const unknown1h = want1h && !hr
  const buys = hr ? hr.buys : c.buys24h, sells = hr ? hr.sells : c.sells24h
  const vol = hr ? hr.vol : c.volume24h
  const tx = buys + sells
  const buyShare = tx > 0 ? (buys / tx) * 100 : 50
  const win = hr ? '1h' : '24h'
  const fresh1h = c.createdAt > 0 && now - c.createdAt < 3_600_000
  const showPct = s.pctMc && c.onCurve && c.progress !== null
  const lvl = c.official ? null : c.safety.level
  const xUrl = `https://x.com/search?q=${encodeURIComponent(c.address)}`

  return (
    <article
      className={`tr-row${c.hot ? ' hot' : ''}${flash ? ` fl-${flash.side}-${flash.n % 2}` : ''}${fresh ? ' fresh' : ''}${s.metricsLarge ? '' : ' small'}`}
      onClick={() => onOpen(c)}
    >
      <div className="tr-lft">
        <span className={`tr-tile${done ? ' done' : ''}${s.imageShape === 'circle' ? ' round' : ''}`} style={{ ['--lp' as string]: c.launchpadColor ?? '#8b918d', ['--p' as string]: ring }}>
          <span className="tr-pic"><TokenPic src={c.image} symbol={c.symbol} size={56} /></span>
          {c.launchpad && <LaunchpadBadge name={c.launchpad} color={c.launchpadColor} />}
        </span>
        <button className="tr-ca" onClick={copy} title={T('Copy the contract address')}>{copied ? T('Copied') : short(c.address)}</button>
      </div>

      <div className="tr-mid">
        <div className="tr-l1">
          <b className="tr-tk">{c.symbol}</b>
          <span className="tr-nm">{c.name}</span>
          <button className="tr-ico" onClick={copy} title={T('Copy the contract address')}><IcCopy /></button>
          <button className={`tr-ico star${starred ? ' on' : ''}`} onClick={e => { e.stopPropagation(); toggleWatch(c.address) }} title={starred ? T('Remove from watchlist') : T('Add to watchlist')}><IcStar on={starred} /></button>
        </div>
        <div className="tr-l2">
          {c.official && <span className="tr-pill ok">{T('Official')}</span>}
          {c.og && <span className="tr-pill ok" title={T('The first coin launched with this ticker; the others are duplicates.')}>OG</span>}
          {c.dup && <span className="tr-pill warn" title={c.dupSame ? T('Launched again by the creator of the OG coin with this ticker.') : T('A later coin using the OG’s ticker: not the original.')}>{c.dupSame ? T('Dup · same dev') : T('Duplicate')}</span>}
          {c.fee && <span className="tr-pill">{c.fee}</span>}
          <span className="tr-pill q">{c.quote || '—'}</span>
          {c.onCurve && <span className="tr-pill">{c.progress !== null ? `BC ${c.progress.toFixed(1)}%` : T('Bonding')}</span>}
          {c.stage === 'graduated' && <span className="tr-pill mig">{T('migrated')}</span>}
          {c.launchpad && <span className="tr-pill lp" style={{ color: c.launchpadColor }}>{c.launchpad}</span>}
        </div>
        <div className="tr-l3">
          <span className={`tr-age${fresh1h ? ' young' : ''}`}>{ageOf(c.createdAt, now)}</span>
          {c.website && <a className="tr-st" href={c.website} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={T('Website')}><IcGlobe /></a>}
          {c.twitter && (
            <a className="tr-xh" href={c.twitter.startsWith('http') ? c.twitter : `https://x.com/${c.twitter.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="X">
              <IcX /><span>{c.twitter.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, '@').replace(/\/.*$/, '').slice(0, 18)}</span>
            </a>
          )}
          {c.telegram && <a className="tr-st" href={c.telegram} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="Telegram"><IcTelegram /></a>}
          <a className="tr-st" href={xUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={T('Search the contract on X')}><IcSearch /></a>
          {c.hot ? <span className="tr-hot" title={T('{n} trades in the last 15 minutes', { n: c.hot })}>🔥 {c.hot}</span> : null}
        </div>
      </div>

      {flash && <span key={flash.n} className={`tr-pop ${flash.side}${(flash.usd ?? 0) >= 500 ? ' big' : ''}`} aria-hidden>{popText(flash)}</span>}
      <div className="tr-rgt">
        <span className="tr-kv"><i title={T('Volume, {w}', { w: win })}>V</i><b>{unknown1h ? '—' : usd(vol)}</b><i>{showPct ? 'BC' : 'MC'}</i><b className={showPct ? 'mc' : mcClass(c.marketCap)}>{showPct ? `${c.progress!.toFixed(0)}%` : known(c.marketCap)}</b></span>
        <span className="tr-f">
          <i>L</i><b>{known(c.liquidity)}</b>
          <i>TX</i><b>{unknown1h ? '—' : count(tx)}</b>
          <span className={`tr-txbar${unknown1h ? ' na' : ''}`} title={hr ? T('{b} buys / {s} sells in the last hour', { b: buys, s: sells }) : T('{b} buys / {s} sells in 24h', { b: buys, s: sells })}><i style={{ width: `${buyShare}%` }} /></span>
        </span>
      </div>

      <div className="tr-risk">
        {c.holders !== null
          ? <span className="tr-rp" title={T('Holders')}><IcUser />{count(c.holders)}</span>
          : <span className="tr-rp" title={T('Wallets trading in 24h')}><IcUsers />{c.traders24h ? count(c.traders24h) : '—'}</span>}
        {lvl && <span className={`tr-rp s-${lvl}`} title={c.safety.reasons.join(' · ') || T(SAFETY_LABEL[lvl])}><IcShield />{T(SAFETY_LABEL[lvl])}</span>}
        {c.change1h !== null && <span className={`tr-rp ${c.change1h >= 0 ? 'up' : 'down'}`} title={T('1h change')}><IcPulse />{pct(c.change1h)}</span>}
        <span className={`tr-rp ${c.change24h >= 0 ? 'up' : 'down'}`} title={T('24h change')}>24h {pct(c.change24h)}</span>
        {c.early && <EarlyChips e={c.early} />}
        {c.launcher && c.launcher.coins > 0 && (
          <span className={`tr-rp${c.launcher.dumps > 0 ? ' down' : ''}`} title={T('Its launcher’s last {n} coins: {d} dumped early', { n: c.launcher.coins, d: c.launcher.dumps })}><IcRocket />{c.launcher.dumps}/{c.launcher.coins}</span>
        )}
      </div>

      {c.thesis && (
        <div className="tr-thesis" title={c.thesis.body}>
          <span aria-hidden>💬</span><q>{c.thesis.body}</q><small>{short(c.thesis.author)} · {ageOf(c.thesis.at, now)}</small>
        </div>
      )}

      <div className="tr-buyw">
        <button className={`tr-buy${s.buttonSize === 'small' ? ' sm' : ''}`} onClick={e => { e.stopPropagation(); onBuy(c, e.currentTarget) }} title={T('Buy {sym}', { sym: c.symbol })}>
          <IcBolt /><span>{T('Buy')}</span>
        </button>
      </div>
    </article>
  )
}

/** The launchpad's own icon on the coin's picture (its coloured letter until the icon loads, or when it has none). */
function LaunchpadBadge({ name, color }: { name: string; color?: string }) {
  const icon = launchpadIcon(name)
  const [ok, setOk] = useState(false)
  return (
    <span className={`tr-lpb${ok ? ' img' : ''}`} style={{ background: ok ? '#fff' : color ?? '#8b918d' }} title={name}>
      {!ok && name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase()}
      {/* Loaded invisibly: a lazy image that's display:none is never fetched. */}
      {icon && <img src={icon} alt="" decoding="async" onLoad={() => setOk(true)} onError={() => setOk(false)} style={ok ? undefined : { position: 'absolute', opacity: 0, width: 1, height: 1 }} />}
    </span>
  )
}

/** GMGN's and fomo's first-moments chips: the creator's sales of its own buy, bundlers and snipers. */
function EarlyChips({ e }: { e: NonNullable<TrenchCoin['early']> }) {
  const dv = e.devSold
  return (
    <>
      <span className={`tr-rp${dv === null ? '' : dv >= 50 ? ' down' : dv > 0 ? ' warn' : ' up'}`}
        title={dv === null ? T('Dev sold: not known') : dv === 0 ? T('The dev hasn’t sold any of its buy') : T('The dev sold {p}% of its buy', { p: dv })}>
        <IcDev />{dv === null ? T('DS ?') : dv === 0 ? T('DH') : `DS ${dv}%`}
      </span>
      <span className={`tr-rp${e.bundlers >= 3 ? ' down' : ''}`} title={T('{n} wallets bought in the launch’s own second (bundlers)', { n: e.bundlers })}><IcLayers />{e.bundlers}</span>
      <span className={`tr-rp${e.snipers >= 10 ? ' warn' : ''}`} title={T('{n} wallets bought in its first 15 seconds (snipers)', { n: e.snipers })}><IcCrosshair />{e.snipers}</span>
    </>
  )
}

export default memo(Row)
