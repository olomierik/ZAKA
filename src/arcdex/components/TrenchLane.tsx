// A Trenches lane (New, Almost bonded or Migrated): its header (count, a beep on new coins, filters, minimize), then its
// coins. While the mouse is over a lane it holds still ("Paused"), as motion's do, so a coin can be clicked before the
// list moves; the numbers keep updating. Minimized, a lane is a slim strip with its count (a click opens it again).

import { useEffect, useMemo, useRef, useState } from 'react'
import TrenchRow from './TrenchRow'
import { IcBell, IcFilter, IcMax, IcMin, IcPause, IcSparkle, IcDrop, IcFlag } from './TrIcons'
import { defaultSort, filterOf, filterOn, laneKey, LANE_SORTS, PAGE_ROWS, passesFilter, setTrench, sortLane, type LaneId, type LaneSort, type TrenchCoin, type TrenchSettings } from '../lib/trenches'
import type { TChain } from '../lib/chains'
import type { RowFlash } from './TrenchRow'
import { beep } from '../lib/beep'
import { t as T, N_ } from '../lib/i18n'

export const LANE_TITLE: Record<LaneId, string> = { new: N_('New'), near: N_('Almost bonded'), migrated: N_('Migrated') }
const LANE_ICON: Record<LaneId, typeof IcSparkle> = { new: IcSparkle, near: IcDrop, migrated: IcFlag }
const SORT_LABEL: Record<LaneSort, string> = { default: N_('Default order'), new: N_('Newest'), volume: N_('Volume 24h'), mcap: N_('Market cap'), trending: N_('Trending'), gainers: N_('Top gainers 24h') }
/** The lane's own order, named for what it is. */
const defaultLabel = (lane: LaneId) => (lane === 'near' ? N_('Bonding progress') : lane === 'new' ? N_('Newest') : N_('Default order'))

interface Props {
  chain: TChain
  lane: LaneId
  coins: TrenchCoin[]
  s: TrenchSettings
  flash?: Map<string, RowFlash>
  loading: boolean
  now: number
  collapsed: boolean
  onCollapse: () => void
  onOpen: (c: TrenchCoin) => void
  onBuy: (c: TrenchCoin, anchor: HTMLElement) => void
  onFilter: (lane: LaneId) => void
}

/** A coin's key in the live feeds: Solana's addresses keep their case. */
const flashKey = (c: TrenchCoin) => (c.chain === 'sol' ? c.address : c.address.toLowerCase())

export default function TrenchLane({ chain, lane, coins, s, flash, loading, now, collapsed, onCollapse, onOpen, onBuy, onFilter }: Props) {
  const filter = filterOf(s, chain, lane)
  const sort: LaneSort = s.laneSort?.[laneKey(chain, lane)] ?? defaultSort(lane)
  const all = useMemo(() => sortLane(coins.filter(c => passesFilter(c, filter, now)), sort), [coins, filter, now, sort])
  // Every coin is reachable: the lane draws PAGE_ROWS at a time, and the next ones once its end scrolls into view.
  const [limit, setLimit] = useState(PAGE_ROWS)
  useEffect(() => { setLimit(PAGE_ROWS) }, [sort, filter, chain])
  const list = useMemo(() => all.slice(0, limit), [all, limit])
  const more = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = more.current
    if (!el || all.length <= limit || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setLimit(l => l + PAGE_ROWS) }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [all.length, limit])

  // Hover holds the order and the members; each coin's numbers still update.
  const [held, setHeld] = useState<string[] | null>(null)
  const byKey = useMemo(() => new Map(list.map(c => [c.key, c])), [list])
  const lastSeen = useRef(new Map<string, TrenchCoin>())
  useEffect(() => { for (const c of list) lastSeen.current.set(c.key, c) }, [list])
  const shown = held ? held.map(k => byKey.get(k) ?? lastSeen.current.get(k)).filter((c): c is TrenchCoin => !!c) : list

  // A coin that joins the lane after its first fill shows as new (and beeps, when the bell is on).
  const known = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const soundOn = !!s.laneSound[laneKey(chain, lane)]
  useEffect(() => {
    if (loading && !list.length) return
    const keys = new Set(list.map(c => c.key))
    if (known.current === null) { known.current = keys; return }
    const added = [...keys].filter(k => !known.current!.has(k))
    for (const k of keys) known.current.add(k)
    if (!added.length) return
    if (soundOn && !document.hidden) beep()
    setFresh(new Set(added))
    const id = setTimeout(() => setFresh(new Set()), 2_500)
    return () => clearTimeout(id)
  }, [list, loading, soundOn])
  const Icon = LANE_ICON[lane]

  if (collapsed) {
    return (
      <section className="tr-lane tr-lane-min" onClick={onCollapse} title={T('Show {lane}', { lane: T(LANE_TITLE[lane]) })}>
        <button className="tr-sq" aria-label={T('Show {lane}', { lane: T(LANE_TITLE[lane]) })}><IcMax /></button>
        <span className="tr-lane-vt"><Icon /> {T(LANE_TITLE[lane])} <i>{all.length}</i></span>
      </section>
    )
  }

  return (
    <section className="tr-lane" onMouseEnter={() => { if (s.pauseOnHover) setHeld(list.map(c => c.key)) }} onMouseLeave={() => setHeld(null)}>
      <header className="tr-lane-h">
        <span className="tr-lane-ic"><Icon /></span>
        <b>{T(LANE_TITLE[lane])}</b>
        <span className="tr-count">{all.length}</span>
        <select className="tr-sort" value={sort} aria-label={T('Sort')} title={T('Sort')}
          onChange={e => { const v = e.target.value as LaneSort; setTrench(st => ({ laneSort: { ...(st.laneSort ?? {}), [laneKey(chain, lane)]: v } })) }}>
          {LANE_SORTS.filter(o => !(o === 'new' && lane === 'new')).map(o => <option key={o} value={o}>{T(o === 'default' ? defaultLabel(lane) : SORT_LABEL[o])}</option>)}
        </select>
        {lane === 'near' && <button className={`tr-pctmc${s.pctMc ? ' on' : ''}`} onClick={() => setTrench({ pctMc: !s.pctMc })} title={T('Show how far each coin is along its curve instead of its market cap')}>% MC</button>}
        {held && <span className="tr-paused"><IcPause /> {T('Paused')}</span>}
        <span className="tr-grow" />
        <button className={`tr-sq${soundOn ? ' on' : ''}`} onClick={() => setTrench(st => ({ laneSound: { ...st.laneSound, [laneKey(chain, lane)]: !soundOn } }))} title={soundOn ? T('Beep on new coins: on') : T('Beep on new coins: off')}><IcBell on={soundOn} /></button>
        <button className={`tr-sq${filterOn(filter) ? ' on' : ''}`} onClick={() => onFilter(lane)} title={T('Filters')}><IcFilter /></button>
        <button className="tr-sq tr-minb" onClick={onCollapse} title={T('Minimize')}><IcMin /></button>
      </header>
      <div className="tr-list">
        {shown.length === 0 && (
          <div className="tr-empty">
            {loading ? T('Loading…') : filterOn(filter) ? T('No coin matches this lane’s filters.') : lane === 'new' ? T('No launches in the last hour.') : lane === 'near' ? T('No coin on a curve right now.') : T('No migrated coins to show.')}
          </div>
        )}
        {shown.map(c => (
          <TrenchRow key={c.key} c={c} s={s} now={now} flash={flash?.get(flashKey(c))} fresh={fresh.has(c.key)} onOpen={onOpen} onBuy={onBuy} />
        ))}
        {all.length > limit && (
          <div ref={more} className="tr-more">
            <button onClick={() => setLimit(l => l + PAGE_ROWS)}>{T('Show {n} more', { n: Math.min(PAGE_ROWS, all.length - limit) })}</button>
          </div>
        )}
      </div>
    </section>
  )
}
