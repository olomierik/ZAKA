// The Trenches' two panels, after motion.gift's: Customize (how rows look, how lanes behave, what the listing rules
// hide, how quick buys send) and a lane's Filters (keywords, launchpads, market cap, liquidity, trades, age, curve).
// Everything applies as it's clicked and is kept in this browser (lib/trenches.ts).

import { useState } from 'react'
import { EMPTY_FILTER, LANES, SLIPS, filterOf, laneKey, resetTrenchDisplay, setTrench, useTrench, type LaneFilter, type LaneId, type Slip } from '../lib/trenches'
import { LISTING } from '../lib/safety'
import { CHAINS, type TChain } from '../lib/chains'
import { LANE_TITLE } from './TrenchLane'
import { t as T } from '../lib/i18n'

function Choice<V extends string | boolean>({ value, options, onPick }: { value: V; options: [V, string][]; onPick: (v: V) => void }) {
  return (
    <div className="tr-seg tr-choice">
      {options.map(([v, l]) => <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>{l}</button>)}
    </div>
  )
}


export function CustomizeModal({ onClose }: { onClose: () => void }) {
  const s = useTrench()
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card tr-modal" onClick={e => e.stopPropagation()}>
        <div className="tr-modal-h">
          <b>{T('Trenches display')}</b>
          <button className="tr-x" onClick={resetTrenchDisplay} title={T('Reset')}>↺</button>
          <button className="tr-x" onClick={onClose} aria-label={T('Close')}>✕</button>
        </div>
        <div className="tr-opts">
          <div className="tr-opt"><span>{T('Metrics size')}</span><Choice value={s.metricsLarge} options={[[false, T('Small')], [true, T('Large')]]} onPick={v => setTrench({ metricsLarge: v })} /></div>
          <div className="tr-opt"><span>{T('Image shape')}</span><Choice value={s.imageShape} options={[['square', T('Square')], ['circle', T('Circle')]]} onPick={v => setTrench({ imageShape: v })} /></div>
          <div className="tr-opt"><span>{T('Bonding ring')}<small>{T('The picture’s ring fills as the coin moves along its curve.')}</small></span><Choice value={s.ring} options={[[true, T('On')], [false, T('Off')]]} onPick={v => setTrench({ ring: v })} /></div>
          <div className="tr-opt"><span>{T('Buy button')}</span><Choice value={s.buttonSize} options={[['small', T('Small')], ['large', T('Large')]]} onPick={v => setTrench({ buttonSize: v })} /></div>
          <div className="tr-opt"><span>{T('Pause lanes on hover')}<small>{T('A lane holds still under the mouse, so a coin can be clicked before the list moves.')}</small></span><Choice value={s.pauseOnHover} options={[[true, T('On')], [false, T('Off')]]} onPick={v => setTrench({ pauseOnHover: v })} /></div>
          <div className="tr-opt"><span>{T('Almost bonded shows')}</span><Choice value={s.pctMc} options={[[false, T('Market cap')], [true, T('% of the curve')]]} onPick={v => setTrench({ pctMc: v })} /></div>
          <div className="tr-opt tr-opt-col">
            <span>{T('Arc quick-buy slippage')}</span>
            <Choice value={String(s.slip)} options={SLIPS.map(v => [String(v), `${v}%`] as [string, string])} onPick={v => setTrench({ slip: Number(v) as Slip })} />
            <small>{T('The trade form opens with this much slippage allowed; you can change it there. Robinhood Chain, Solana and BNB Chain routes check their own prices before signing.')}</small>
          </div>
          <div className="tr-opt"><span>{T('Fresh launches in New')}<small>{T('Coins under an hour old show in New below the ${mc} minimum. They’re still left out when rugged or rated Danger.', { mc: LISTING.minMarketCapUsd.toLocaleString() })}</small></span><Choice value={s.freshNew} options={[[true, T('On')], [false, T('Off')]]} onPick={v => setTrench({ freshNew: v })} /></div>
          <div className="tr-opt tr-opt-col tr-opt-warn">
            <span>{T('Coins the listing rules hide')}</span>
            <small>{T('ARCDEX leaves out coins under ${mc} of market cap, rugged coins, coins rated Danger, and pool coins under ${liq} of liquidity or {h} holders. $ARCDEX always shows.', { mc: LISTING.minMarketCapUsd.toLocaleString(), liq: LISTING.minLiquidityUsd.toLocaleString(), h: LISTING.minHolders })}</small>
            <Choice value={s.showAll} options={[[false, T('Hide them')], [true, T('Show everything (risky)')]]} onPick={v => setTrench({ showAll: v })} />
          </div>
        </div>
        <div className="tr-modal-f"><small>{T('Everything here applies as you click.')}</small><button className="tr-done" onClick={onClose}>{T('Done')}</button></div>
      </div>
    </div>
  )
}

const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const str = (n: number | null) => (n === null ? '' : String(n))

export function FilterModal({ chain, lane: first, launchpads, onClose }: { chain: TChain; lane: LaneId; launchpads: string[]; onClose: () => void }) {
  const s = useTrench()
  const [lane, setLane] = useState<LaneId>(first)
  const [draft, setDraft] = useState<Record<LaneId, LaneFilter>>(() => ({ new: filterOf(s, chain, 'new'), near: filterOf(s, chain, 'near'), migrated: filterOf(s, chain, 'migrated') }))
  const [all, setAll] = useState(false)
  const f = draft[lane]
  const set = (p: Partial<LaneFilter>) => setDraft(d => ({ ...d, [lane]: { ...d[lane], ...p } }))
  const apply = () => {
    setTrench(st => {
      const filters = { ...st.filters }
      for (const l of LANES) filters[laneKey(chain, l)] = all ? f : draft[l]
      return { filters }
    })
    onClose()
  }
  const field = (label: string, k: keyof LaneFilter, ph = '0') => (
    <label className="tr-field"><span>{label}</span><input type="number" min="0" inputMode="decimal" placeholder={ph} value={str(f[k] as number | null)} onChange={e => set({ [k]: num(e.target.value) } as Partial<LaneFilter>)} /></label>
  )
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card tr-modal" onClick={e => e.stopPropagation()}>
        <div className="tr-modal-h">
          <b>{T('Filters')} · {CHAINS[chain].name}</b>
          <button className="tr-x" onClick={() => set(EMPTY_FILTER)} title={T('Reset')}>↺</button>
          <button className="tr-x" onClick={onClose} aria-label={T('Close')}>✕</button>
        </div>
        <div className="tr-seg tr-lane-tabs">
          {LANES.map(l => <button key={l} className={lane === l ? 'on' : ''} onClick={() => setLane(l)}>{T(LANE_TITLE[l])}</button>)}
        </div>
        <div className="tr-fgrid2">
          <label className="tr-field"><span>{T('Search keywords')}</span><input placeholder={T('keyword1, keyword2…')} value={f.include} onChange={e => set({ include: e.target.value })} /></label>
          <label className="tr-field"><span>{T('Exclude keywords')}</span><input placeholder={T('keyword1, keyword2…')} value={f.exclude} onChange={e => set({ exclude: e.target.value })} /></label>
        </div>
        {launchpads.length > 0 && (
          <div className="tr-fsec">
            <div className="tr-fsec-h"><span>{T('Launchpads')}</span>
              <button onClick={() => set({ launchpads: [] })}>{T('All')}</button>
            </div>
            <div className="tr-chips">
              {launchpads.map(lp => {
                const on = f.launchpads.includes(lp)
                return <button key={lp} className={on ? 'on' : ''} onClick={() => set({ launchpads: on ? f.launchpads.filter(x => x !== lp) : [...f.launchpads, lp] })}>{lp}</button>
              })}
            </div>
          </div>
        )}
        <div className="tr-fsec-h"><span>{T('Metrics')}</span></div>
        <div className="tr-fgrid3">
          {field(T('Min MC $'), 'minMc')}
          {field(T('Max MC $'), 'maxMc', '∞')}
          {field(T('Min liquidity $'), 'minLiq')}
          {field(T('Min trades (24h)'), 'minTx')}
          {field(T('Max age (min)'), 'maxAgeMin', '∞')}
          {field(T('Min bonding %'), 'minProgress')}
        </div>
        <div className="tr-modal-f">
          <label className="tr-toggle"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /><span>{T('Apply to all lanes')}</span></label>
          <button className="tr-done" onClick={apply}>{T('Apply')}</button>
        </div>
      </div>
    </div>
  )
}
