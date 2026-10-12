// The Trenches (2026-10-12, owner: "a trading terminal like motion.gift … with all the features we have"): the home of
// the app. Pick a chain (Arc, Robinhood Chain, Solana, BNB Chain) and its coins stream into three lanes: New, Almost
// bonded and Migrated. Each row has a quick-buy button with the lane's preset amount; it opens the coin's own trade
// form with that amount filled in, where the coin's checks run before anything is signed.
//
// The data is each chain's own (Arc: the market engine and the chain; the others: their lists from the engine and
// GeckoTerminal, read from the chain where curves are), with the owner's listing rules unless "Show everything" is on.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import TrenchLane, { LANE_TITLE } from '../components/TrenchLane'
import { CustomizeModal, FilterModal } from '../components/TrenchModals'
import ChainLogo from '../components/ChainLogo'
import { IcBolt, IcSliders, IcStar } from '../components/TrIcons'
import { trenchesPage } from '../components/NavBar'
import { CHAINS, CHAIN_LIST, setChain, type TChain } from '../lib/chains'
import { useHead } from '../lib/rpcSettings'
import { LANES, laneCoins, setTrench, shownInLanes, useTrench, SLIPS, type LaneId, type TrenchCoin, type TrenchSettings } from '../lib/trenches'
import { useArcMarket, type Flash } from '../lib/useArcMarket'
import { getLaunchpadColor, type ArcToken } from '../api/radardex'
import { arcStage, arcStageInput, bscStage, bscStageInput, rhStage, rhStageInput, solStage, solStageInput } from '../lib/coinStage'
import { bscSafety, isListable, isRugged, meetsStandard, rhSafety, solSafety, type SafetyView } from '../lib/safety'
import { markDupes } from '../lib/dupes'
import { cachedRhMarket, isWashPool, loadRhMarket, type RhCoin } from '../api/robinhoodMarket'
import { cachedSolMarket, isWashSol, loadSolMarket, type SolCoin } from '../api/solanaMarket'
import { cachedBscMarket, isWashBsc, loadBscMarket, type BscCoin } from '../api/bscMarket'
import { useHlMids } from '../hl/live'
import { COIN_IMAGE, COIN_LC, COIN_POOL, fmtSmallUsd, useCoin } from '../lib/coin'
import { useIsMobile } from '../lib/useMobile'
import { usePrefs } from '../lib/prefs'
import { t as T } from '../lib/i18n'

interface Props { chain: TChain; navigate: (p: Page) => void }

/** A second clock for ages ("12s"), shared by every row. */
function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, ms); return () => clearInterval(id) }, [ms])
  return now
}

interface ChainData { coins: TrenchCoin[]; loading: boolean; live: boolean; perMin?: number; flash?: Map<string, Flash>; hidden: number }

// ── Arc ─────────────────────────────────────────────────────────────────

// Every Arc coin opens the coin page (pages/CoinPage.tsx), which sends ARCDEX's own launchpad coins to their curve page
// and finds the pools of a coin whose row carries none, as a /token/0x… link does.
const arcPage = (t: ArcToken): Page => ({ name: 'argus', address: t.address.toLowerCase(), pool: (t.poolAddress || '').toLowerCase() })

/** The coins the listing rules let into the lanes (lib/trenches.ts shownInLanes), and how many they leave out. */
function useArcData(showAll: boolean, freshNew: boolean): ChainData {
  const m = useArcMarket()
  const { coins, hidden } = useMemo(() => {
    const out: TrenchCoin[] = []
    let hidden = 0
    for (const t of m.tokens) {
      const official = m.isOfficial(t)
      const facts = { official, stage: arcStage(t), rugged: m.rugged(t), danger: m.safetyOf(t).level === 'danger', listable: m.listable(t), standard: m.passes(t) }
      if (!shownInLanes(facts, { showAll, freshNew })) { hidden++; continue }
      const inp = arcStageInput(t)
      const d = m.dupes.get(t.address)
      const scan = m.scanOf(t)
      out.push({
        key: `arc:${t.address.toLowerCase()}`, chain: 'arc', address: t.address.toLowerCase(), pool: t.poolAddress || null,
        symbol: official ? 'ARCDEX' : t.symbol, name: t.name, image: official ? COIN_IMAGE : t.logoUrl || null,
        launchpad: t.launchpad || null, launchpadColor: getLaunchpadColor(t.launchpad), quote: t.quoteSymbol || 'USDC',
        createdAt: t.createdAt ?? (t.ageMs > 0 ? Date.now() - t.ageMs : 0),
        marketCap: t.marketCap, liquidity: t.liquidity, volume24h: t.volume24h, change24h: t.priceChange24h,
        change1h: t.priceChange1h || null, buys24h: t.buys24h, sells24h: t.sells24h,
        holders: t.holderCount > 0 ? t.holderCount : null, traders24h: null,
        progress: inp.onCurve ? inp.progress : null, onCurve: inp.onCurve, stage: arcStage(t), safety: m.safetyOf(t),
        fee: null, twitter: t.twitter || null, hot: m.hotOf(t), official, og: d?.og, dup: d?.dup, dupSame: d?.sameCreator,
        launcher: scan?.launcher ?? null, page: arcPage(t),
      })
    }
    return { coins: out, hidden }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.tokens, m.dupes, m.safetyOf, m.passes, m.listable, m.rugged, showAll, freshNew])
  return { coins, hidden, loading: m.loading, live: m.live, perMin: m.perMin, flash: m.flash }
}

// ── Robinhood Chain, Solana, BNB Chain (one shape: RhCoin) ──────────────

type Rows<C> = { rows: C[]; loading: boolean }
function useRows<C>(cached: () => C[], load: (on: (r: C[]) => void) => Promise<unknown>, everyMs: number): Rows<C> {
  const [rows, setRows] = useState<C[]>(cached)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    const get = () => load(r => { if (live && r.length) setRows(r) }).finally(() => { if (live) setLoading(false) })
    void get()
    const id = setInterval(() => { if (!document.hidden) void get() }, everyMs)
    return () => { live = false; clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { rows, loading }
}

interface Kind<C extends RhCoin> {
  chain: Exclude<TChain, 'arc'>
  stage: (c: C) => ReturnType<typeof rhStage>
  input: (c: C) => ReturnType<typeof rhStageInput>
  safety: (c: C) => SafetyView
  wash: (c: C, now: number) => boolean
  page: (c: C) => Page
}

function toCoins<C extends RhCoin>(rows: C[], k: Kind<C>, showAll: boolean, freshNew: boolean): { coins: TrenchCoin[]; hidden: number } {
  const now = Date.now()
  const listed: { c: C; v: SafetyView }[] = []
  let hidden = 0
  for (const c of rows) {
    const inp = k.input(c)
    const stage = k.stage(c)
    const rugged = isRugged({ change24h: c.change24h, liquidityUsd: c.liquidity, onCurve: inp.onCurve })
    const v = k.safety(c)
    const facts = {
      official: false, stage, rugged, danger: v.level === 'danger', wash: k.wash(c, now),
      listable: isListable({ official: false, marketCapUsd: c.marketCap, rugged }),
      standard: meetsStandard({ level: v.level, stage, onCurve: inp.onCurve, liquidityUsd: c.liquidity, holders: null }),
    }
    if (!shownInLanes(facts, { showAll, freshNew })) { hidden++; continue }
    listed.push({ c, v })
  }
  const dupes = markDupes(listed.map(x => x.c), { key: c => c.address, symbol: c => c.symbol, launchedAt: c => c.createdAt, creator: () => null })
  const coins = listed.map(({ c, v }): TrenchCoin => {
    const inp = k.input(c)
    const d = dupes.get(c.address)
    return {
      key: `${k.chain}:${c.address}`, chain: k.chain, address: c.address, pool: c.pool || null, symbol: c.symbol, name: c.name,
      image: c.image, launchpad: c.launchpad, quote: c.quoteSymbol, createdAt: c.createdAt, marketCap: c.marketCap,
      liquidity: c.liquidity, volume24h: c.volume24h, change24h: c.change24h, change1h: c.change1h || null,
      buys24h: c.buys24h, sells24h: c.sells24h, holders: null, traders24h: c.traders24h || null,
      progress: inp.onCurve ? inp.progress : null, onCurve: inp.onCurve, stage: k.stage(c), safety: v,
      fee: c.feePct !== null && c.feePct > 0 ? `${T('Fee')} ${c.feePct}%` : null, twitter: null, og: d?.og, dup: d?.dup,
      page: k.page(c),
    }
  })
  return { coins, hidden }
}

const RH: Kind<RhCoin> = { chain: 'hood', stage: rhStage, input: rhStageInput, safety: c => rhSafety(c), wash: isWashPool, page: c => ({ name: 'rh-token', address: c.address, pool: c.pool }) }
const SOL: Kind<SolCoin> = { chain: 'sol', stage: solStage, input: solStageInput, safety: c => solSafety(c), wash: isWashSol, page: c => ({ name: 'sol-token', address: c.address, pool: c.pool }) }
const BSC: Kind<BscCoin> = { chain: 'bnb', stage: bscStage, input: bscStageInput, safety: c => bscSafety(c), wash: isWashBsc, page: c => ({ name: 'bsc-token', address: c.address, pool: c.pool }) }

function useListData<C extends RhCoin>(r: Rows<C>, k: Kind<C>, showAll: boolean, freshNew: boolean): ChainData {
  const { coins, hidden } = useMemo(() => toCoins(r.rows, k, showAll, freshNew), [r.rows, k, showAll, freshNew])
  return { coins, hidden, loading: r.loading, live: !r.loading }
}

// ── the page ────────────────────────────────────────────────────────────

export default function Trenches({ chain, navigate }: Props) {
  useEffect(() => { setChain(chain) }, [chain])
  useEffect(() => { document.title = `${T('Trenches')} · ${CHAINS[chain].name} | ARCDEX` }, [chain])
  const s = useTrench()
  // Each chain's data hooks live in their own component, so switching chains starts the new one cleanly.
  if (chain === 'arc') return <ArcView navigate={navigate} s={s} />
  if (chain === 'hood') return <HoodView navigate={navigate} s={s} />
  if (chain === 'sol') return <SolView navigate={navigate} s={s} />
  return <BscView navigate={navigate} s={s} />
}

type ViewProps = { navigate: (p: Page) => void; s: TrenchSettings }
function ArcView({ navigate, s }: ViewProps) { return <TrenchView chain="arc" data={useArcData(s.showAll, s.freshNew)} navigate={navigate} s={s} /> }
function HoodView({ navigate, s }: ViewProps) { return <TrenchView chain="hood" data={useListData(useRows(cachedRhMarket, loadRhMarket, 60_000), RH, s.showAll, s.freshNew)} navigate={navigate} s={s} /> }
function SolView({ navigate, s }: ViewProps) { return <TrenchView chain="sol" data={useListData(useRows(cachedSolMarket, loadSolMarket, 45_000), SOL, s.showAll, s.freshNew)} navigate={navigate} s={s} /> }
function BscView({ navigate, s }: ViewProps) { return <TrenchView chain="bnb" data={useListData(useRows(cachedBscMarket, loadBscMarket, 45_000), BSC, s.showAll, s.freshNew)} navigate={navigate} s={s} /> }

function TrenchView({ chain, data, navigate, s }: { chain: TChain; data: ChainData; navigate: (p: Page) => void; s: TrenchSettings }) {
  const mobile = useIsMobile()
  const now = useNow()
  const head = useHead(chain)
  const mids = useHlMids()
  const coinQ = useCoin()
  const info = CHAINS[chain]
  const [customize, setCustomize] = useState(false)
  const [filterLane, setFilterLane] = useState<LaneId | null>(null)
  const [mLane, setMLane] = useState<LaneId>('new')

  const watch = usePrefs().watchlist
  const coins = useMemo(() => (s.watchOnly ? data.coins.filter(c => watch.includes(c.address.toLowerCase())) : data.coins), [data.coins, s.watchOnly, watch])
  const lanes = useMemo(() => Object.fromEntries(LANES.map(l => [l, laneCoins(coins, l)])) as Record<LaneId, TrenchCoin[]>, [coins])
  const launchpads = useMemo(() => [...new Set(data.coins.map(c => c.launchpad).filter((x): x is string => !!x))].sort(), [data.coins])

  const open = useCallback((c: TrenchCoin) => navigate(c.page), [navigate])
  // A quick buy opens the coin's own trade form with the amount (and on Arc the slippage) filled in.
  const buy = useCallback((c: TrenchCoin, amount: number) => navigate({ ...c.page, buy: { amount, slip: s.slip } } as Page), [navigate, s.slip])

  const p1 = s.presets[chain][0]
  const setP1 = (v: string) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return
    setTrench(st => ({ presets: { ...st.presets, [chain]: [n, st.presets[chain][1], st.presets[chain][2]] as [number, number, number] } }))
  }
  const native = info.nativeHl ? mids[info.nativeHl] : null

  return (
    <div className="tr-page">
      <div className="tr-bar">
        <span className="tr-bar-title"><IcSliders /> {T('Trenches')}</span>
        <div className="tr-chips-row">
          {CHAIN_LIST.map(c => (
            <button key={c} className={`tr-chain${c === chain ? ' on' : ''}`} onClick={() => navigate(trenchesPage(c))}>
              <ChainLogo chain={c} size={15} />{CHAINS[c].short}
            </button>
          ))}
        </div>
        <label className="tr-qin tr-qin-bar" title={T('Default quick-buy amount (P1)')}>
          <IcBolt /><input type="number" min="0" step="any" value={p1} onChange={e => setP1(e.target.value)} aria-label={T('Quick-buy amount')} /><small>{info.quote}</small>
        </label>
        {chain === 'arc' && (
          <div className="tr-seg" role="group" aria-label={T('Slippage')} title={T('Arc quick buys open the trade form with this slippage')}>
            {SLIPS.map(v => <button key={v} className={s.slip === v ? 'on' : ''} onClick={() => setTrench({ slip: v })}>{v}%</button>)}
          </div>
        )}
        <button className={`tr-watch${s.watchOnly ? ' on' : ''}`} onClick={() => setTrench({ watchOnly: !s.watchOnly })} title={T('Only the coins on your watchlist')}><IcStar on={s.watchOnly} /> {T('Watchlist')}</button>
        <span className="tr-grow" />
        <span className={`tr-live${data.live ? ' on' : ''}`}><i />{data.live ? T('Live') : T('Connecting…')}{data.perMin ? <small> · {T('{n} trades/min', { n: data.perMin })}</small> : null}</span>
        {head && <span className="tr-meta">{chain === 'sol' ? T('Slot') : T('Block')} <b>{head.head.toLocaleString()}</b></span>}
        {native ? <span className="tr-meta">{info.native} <b>${native.toLocaleString(undefined, { maximumFractionDigits: native >= 100 ? 0 : 2 })}</b></span>
          : chain === 'arc' && coinQ?.priceUsd ? <button className="tr-meta tr-meta-btn" onClick={() => navigate({ name: 'argus', address: COIN_LC, pool: COIN_POOL })}>ARCDEX <b>{fmtSmallUsd(coinQ.priceUsd)}</b></button> : null}
        <button className="tr-meta-btn tr-cust" onClick={() => setCustomize(true)}><IcSliders /> {T('Customize')}</button>
        <label className="tr-switch" title={T('Show how far each coin is along its curve instead of its market cap')}>
          <input type="checkbox" checked={s.pctMc} onChange={e => setTrench({ pctMc: e.target.checked })} /><i /><span>% MC</span>
        </label>
        <span className="tr-meta">{T('{n} tokens', { n: data.coins.length })}</span>
      </div>

      {data.hidden > 0 && !s.showAll && (
        <div className="tr-note">
          {data.hidden === 1 ? T('1 coin hidden by the listing rules (rugged, rated Danger, too thin, or under $15,000 of market cap).') : T('{n} coins hidden by the listing rules (rugged, rated Danger, too thin, or under $15,000 of market cap).', { n: data.hidden })}
          <button onClick={() => setTrench({ showAll: true })}>{T('Show everything')}</button>
        </div>
      )}

      {mobile && (
        <div className="tr-mtabs" role="tablist">
          {LANES.map(l => (
            <button key={l} role="tab" aria-selected={mLane === l} className={mLane === l ? 'on' : ''} onClick={() => setMLane(l)}>
              {T(LANE_TITLE[l])} <span>{lanes[l].length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tr-lanes">
        {(mobile ? [mLane] : LANES).map(l => (
          <TrenchLane key={l} chain={chain} lane={l} coins={lanes[l]} s={s} flash={data.flash} loading={data.loading} now={now}
            onOpen={open} onBuy={buy} onFilter={setFilterLane} />
        ))}
      </div>

      {customize && <CustomizeModal onClose={() => setCustomize(false)} />}
      {filterLane && <FilterModal chain={chain} lane={filterLane} launchpads={launchpads} onClose={() => setFilterLane(null)} />}
    </div>
  )
}

