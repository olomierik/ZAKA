// The Trenches (2026-10-12, owner: "a trading terminal like motion.gift … with all the features we have"): the home of
// the app. Pick a chain (Arc, Robinhood Chain, Solana, BNB Chain) and its coins stream into lanes: New, Almost bonded
// and Migrated, and Trending now (what people are buying across every chain). A row's Buy asks for the
// amount, then opens the coin's own trade form with it, where the coin's checks run before anything is signed.
// $ARCDEX's contract, price and burned amount sit on top. Each lane can be minimized to a slim strip.
//
// The data is each chain's own (Arc: the market engine and the chain; the others: their lists from the engine and
// GeckoTerminal, plus the engine's live feed of their launchpads: launches within seconds, every trade's blink, prices
// and progress; api/trenchFeed.ts), with the owner's listing rules unless "Show everything" is on.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import TrenchLane, { LANE_TITLE } from '../components/TrenchLane'
import TrenchTrendLane from '../components/TrenchTrendLane'
import TrenchCoinBar from '../components/TrenchCoinBar'
import TrenchBuyPop from '../components/TrenchBuyPop'
import type { RowFlash } from '../components/TrenchRow'
import { CustomizeModal, FilterModal } from '../components/TrenchModals'
import ChainLogo from '../components/ChainLogo'
import { IcSliders, IcStar } from '../components/TrIcons'
import { trenchesPage } from '../components/NavBar'
import { CHAINS, CHAIN_LIST, setChain, type TChain } from '../lib/chains'
import { useHead } from '../lib/rpcSettings'
import { LANES, isCollapsed, laneCoins, setTrench, shownInLanes, toggleCollapsed, useTrench, SLIPS, type LaneId, type TrenchCoin, type TrenchSettings } from '../lib/trenches'
import { useArcMarket } from '../lib/useArcMarket'
import { keyOf, useTrenchFeed, type LiveTick, type TrenchFeed } from '../api/trenchFeed'
import type { TrenchCoinWire } from '../../../api/_trenchProtocol'
import { WSOL } from '../../../api/_solCore'
import { BNB_NATIVE, BSC_USD1, BSC_USDT } from '../../../api/_bscCore'
import { getLaunchpadColor, type ArcToken } from '../api/radardex'
import { arcStage, arcStageInput, bscStage, bscStageInput, rhStage, rhStageInput, solStage, solStageInput } from '../lib/coinStage'
import { bscSafety, isListable, isRugged, meetsStandard, rhSafety, solSafety, type SafetyView } from '../lib/safety'
import { markDupes } from '../lib/dupes'
import { cachedRhMarket, isWashPool, loadRhMarket, type RhCoin } from '../api/robinhoodMarket'
import { cachedSolMarket, isWashSol, loadSolMarket, type SolCoin } from '../api/solanaMarket'
import { cachedBscMarket, isWashBsc, loadBscMarket, type BscCoin } from '../api/bscMarket'
import { useHlMids } from '../hl/live'
import { COIN_IMAGE } from '../lib/coin'
import { useIsMobile } from '../lib/useMobile'
import { usePrefs } from '../lib/prefs'
import { t as T } from '../lib/i18n'
import { useLatestTheses } from '../lib/latestTheses'
import { useDsCoins, useShownAddresses, withDs } from '../lib/useDexData'
import { useMutes } from '../lib/mutes'
import { useTrader } from '../lib/identity'

interface Props { chain: TChain; navigate: (p: Page) => void }

/** A second clock for ages ("12s"), shared by every row. */
function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, ms); return () => clearInterval(id) }, [ms])
  return now
}

interface ChainData { coins: TrenchCoin[]; loading: boolean; live: boolean; perMin?: number; flash?: Map<string, RowFlash>; hidden: number }

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
        launcher: scan?.launcher ?? null, hour: m.hourOf(t), page: arcPage(t),
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
  /** A coin the live feed saw launch, before the list has it. */
  fromWire: (w: TrenchCoinWire) => C
  /** A listed coin with the feed's latest price, market cap and progress (its 24h counts stay the list's). */
  patch: (c: C, t: LiveTick) => C
}

/** The feed's coin as a list row: its numbers since launch are its 24h numbers (it's under two hours old). */
function wireBase(w: TrenchCoinWire, chain: 'hood' | 'sol' | 'bnb'): RhCoin {
  const a = keyOf(chain, w.a)
  return {
    address: a, symbol: w.s || a.slice(0, 6), name: w.n || w.s || a, image: w.i, decimals: chain === 'sol' ? 6 : 18, stock: false,
    pool: w.pool ?? a, dex: '', quote: '', quoteSymbol: w.q, priceUsd: w.p, change5m: 0, change1h: 0,
    change24h: w.o > 0 && w.p > 0 ? (w.p / w.o - 1) * 100 : 0, volume24h: w.v, liquidity: w.l, marketCap: w.m,
    buys24h: w.b, sells24h: w.x, traders24h: w.w, createdAt: w.c, feePct: null, launchpad: w.lp || null,
  }
}
const priced = <C extends RhCoin>(c: C, t: LiveTick): C => ({ ...c, priceUsd: t.p || c.priceUsd, marketCap: t.m || c.marketCap })

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

const RH: Kind<RhCoin> = {
  chain: 'hood', stage: rhStage, input: rhStageInput, safety: c => rhSafety(c), wash: isWashPool, page: c => ({ name: 'rh-token', address: c.address, pool: c.pool }),
  fromWire: w => wireBase(w, 'hood'), patch: priced,
}
const SOL: Kind<SolCoin> = {
  chain: 'sol', stage: solStage, input: solStageInput, safety: c => solSafety(c), wash: isWashSol, page: c => ({ name: 'sol-token', address: c.address, pool: c.pool }),
  fromWire: w => ({ ...wireBase(w, 'sol'), dex: w.gr ? 'pumpswap' : 'pump-fun', quote: WSOL, curveProgress: w.gr ? 100 : w.g, graduated: w.gr }),
  // pump.fun's curves and PumpSwap pools tick with their progress (100 once in its pool).
  patch: (c, t) => ({ ...priced(c, t), ...(t.g !== null && (c.dex === 'pump-fun' || c.dex === 'pumpswap') ? { curveProgress: t.g, graduated: t.g >= 100 || !!c.graduated } : {}) }),
}
const BSC: Kind<BscCoin> = {
  chain: 'bnb', stage: bscStage, input: bscStageInput, safety: c => bscSafety(c), wash: isWashBsc, page: c => ({ name: 'bsc-token', address: c.address, pool: c.pool }),
  fromWire: w => {
    // four.meme vouched for every coin the feed launches (its quote comes from four.meme's own contract).
    const quote = w.q === 'USDT' ? BSC_USDT : w.q === 'USD1' ? BSC_USD1 : BNB_NATIVE
    return { ...wireBase(w, 'bnb'), pool: keyOf('bnb', w.a), dex: w.gr ? 'pancakeswap_v2' : 'four-meme', quote, four: { quote, graduated: w.gr, progress: w.g ?? 0 } }
  },
  patch: (c, t) => ({ ...priced(c, t), ...(c.four && t.g !== null ? { four: { ...c.four, progress: t.g, graduated: c.four.graduated || t.g >= 100 } } : {}) }),
}

/** The list's rows with the feed's latest numbers, and the coins the feed saw launch that the list doesn't have yet. */
function mergeFeed<C extends RhCoin>(rows: C[], feed: TrenchFeed, k: Kind<C>): C[] {
  if (!feed.on && !feed.ticks.size) return rows
  const seen = new Set<string>()
  const out: C[] = rows.map(r => {
    const key = keyOf(k.chain, r.address)
    seen.add(key)
    const t = feed.ticks.get(key)
    return t ? k.patch(r, t) : r
  })
  for (const w of feed.launches) {
    const key = keyOf(k.chain, w.a)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(k.fromWire(w))
  }
  return out
}

function useListData<C extends RhCoin>(r: Rows<C>, k: Kind<C>, showAll: boolean, freshNew: boolean, feed: TrenchFeed): ChainData {
  const merged = useMemo(() => mergeFeed(r.rows, feed, k), [r.rows, feed, k])
  const { coins, hidden } = useMemo(() => toCoins(merged, k, showAll, freshNew), [merged, k, showAll, freshNew])
  return {
    coins, hidden, loading: r.loading && !feed.launches.length, live: feed.on ? feed.live : !r.loading,
    perMin: feed.on ? feed.perMin : undefined, flash: feed.flash,
  }
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
function ArcView({ navigate, s }: ViewProps) { const feed = useTrenchFeed('arc'); return <TrenchView chain="arc" data={useArcData(s.showAll, s.freshNew)} feed={feed} navigate={navigate} s={s} /> }
function HoodView({ navigate, s }: ViewProps) { const feed = useTrenchFeed('hood'); return <TrenchView chain="hood" data={useListData(useRows(cachedRhMarket, loadRhMarket, 60_000), RH, s.showAll, s.freshNew, feed)} feed={feed} navigate={navigate} s={s} /> }
function SolView({ navigate, s }: ViewProps) { const feed = useTrenchFeed('sol'); return <TrenchView chain="sol" data={useListData(useRows(cachedSolMarket, loadSolMarket, 45_000), SOL, s.showAll, s.freshNew, feed)} feed={feed} navigate={navigate} s={s} /> }
function BscView({ navigate, s }: ViewProps) { const feed = useTrenchFeed('bnb'); return <TrenchView chain="bnb" data={useListData(useRows(cachedBscMarket, loadBscMarket, 45_000), BSC, s.showAll, s.freshNew, feed)} feed={feed} navigate={navigate} s={s} /> }

type MLane = LaneId | 'smart'

function TrenchView({ chain, data, feed, navigate, s }: { chain: TChain; data: ChainData; feed: TrenchFeed; navigate: (p: Page) => void; s: TrenchSettings }) {
  const mobile = useIsMobile()
  const now = useNow()
  const head = useHead(chain)
  const mids = useHlMids()
  const info = CHAINS[chain]
  const [customize, setCustomize] = useState(false)
  const [filterLane, setFilterLane] = useState<LaneId | null>(null)
  const [mLane, setMLane] = useState<MLane>('smart')
  const [buyFor, setBuyFor] = useState<{ page: Page; symbol: string; anchor: HTMLElement } | null>(null)

  const watch = usePrefs().watchlist
  // Each coin's newest thesis, as fomo shows it, leaving out wallets this trader muted.
  const theses = useLatestTheses()
  const { muted } = useMutes(useTrader())
  const listed = useMemo(() => (s.watchOnly ? data.coins.filter(c => watch.includes(c.address.toLowerCase())) : data.coins), [data.coins, s.watchOnly, watch])
  // DexScreener's numbers, links and last hour for the coins the lanes show (lib/dexData.ts), and the engine's count of
  // each launch's bundlers, snipers and dev sales (its feed).
  const shown = useShownAddresses(useMemo(() => LANES.map(l => laneCoins(listed, l)), [listed]))
  const ds = useDsCoins(chain, shown)
  const early = useMemo(() => new Map(feed.launches.filter(w => w.bn !== undefined).map(w => [keyOf(chain, w.a), { bundlers: w.bn ?? 0, snipers: w.sn ?? 0, devSold: w.dv ?? null }])), [feed.launches, chain])
  const coins = useMemo(() => listed.map(c => {
    let out = withDs(c, ds.get(c.address))
    const e = early.get(keyOf(chain, c.address))
    if (e) out = { ...out, early: e }
    const th = theses.get(c.address.toLowerCase())
    return th && !muted.has(th.author) ? { ...out, thesis: th } : out
  }), [listed, ds, early, chain, theses, muted])
  const lanes = useMemo(() => Object.fromEntries(LANES.map(l => [l, laneCoins(coins, l)])) as Record<LaneId, TrenchCoin[]>, [coins])
  const launchpads = useMemo(() => [...new Set(data.coins.map(c => c.launchpad).filter((x): x is string => !!x))].sort(), [data.coins])

  const open = useCallback((c: TrenchCoin) => navigate(c.page), [navigate])
  // Buy asks for the amount; the coin's own trade form then opens with it (and on Arc the slippage), checks and all.
  const askBuy = useCallback((c: TrenchCoin, anchor: HTMLElement) => setBuyFor({ page: c.page, symbol: c.symbol, anchor }), [])
  const native = info.nativeHl ? mids[info.nativeHl] : null
  const coll = (l: MLane) => isCollapsed(s, chain, l)
  // Minimized lanes take a slim strip; the Trending lane is a little narrower than the coin lanes.
  const columns = [coll('smart') ? '44px' : 'minmax(240px, 0.72fr)', ...LANES.map(l => (coll(l) ? '44px' : 'minmax(0, 1fr)'))].join(' ')
  const perMin = data.perMin ?? (feed.on ? feed.perMin : undefined)

  return (
    <div className="tr-page">
      <TrenchCoinBar navigate={navigate} />
      <div className="tr-bar">
        <span className="tr-bar-title"><IcSliders /> {T('Trenches')}</span>
        {/* Phones: the chains in a dropdown (owner, 2026-10-18); the chips didn't fit beside the rest. */}
        {mobile && <ChainSelect chain={chain} onPick={c => navigate(trenchesPage(c))} />}
        <div className="tr-chips-row">
          {CHAIN_LIST.map(c => (
            <button key={c} className={`tr-chain${c === chain ? ' on' : ''}`} onClick={() => navigate(trenchesPage(c))}>
              <ChainLogo chain={c} size={15} />{CHAINS[c].short}
            </button>
          ))}
        </div>
        {chain === 'arc' && (
          <div className="tr-seg" role="group" aria-label={T('Slippage')} title={T('Buy opens Arc’s trade form with this slippage')}>
            {SLIPS.map(v => <button key={v} className={s.slip === v ? 'on' : ''} onClick={() => setTrench({ slip: v })}>{v}%</button>)}
          </div>
        )}
        <div className="tr-seg" role="group" aria-label={T('Window')} title={T('Volume, trades and the buy/sell bar over the last hour or day')}>
          {(['1h', '24h'] as const).map(w => <button key={w} className={s.window === w ? 'on' : ''} onClick={() => setTrench({ window: w })}>{w}</button>)}
        </div>
        <button className={`tr-watch${s.watchOnly ? ' on' : ''}`} onClick={() => setTrench({ watchOnly: !s.watchOnly })} title={T('Only the coins on your watchlist')}><IcStar on={s.watchOnly} /> <span className="lbl">{T('Watchlist')}</span></button>
        <span className="tr-grow" />
        <span className={`tr-live${data.live ? ' on' : ''}`}><i />{data.live ? T('Live') : T('Connecting…')}{perMin ? <small> · {T('{n} trades/min', { n: perMin })}</small> : null}</span>
        {head && <span className="tr-meta">{chain === 'sol' ? T('Slot') : T('Block')} <b>{head.head.toLocaleString()}</b></span>}
        {native ? <span className="tr-meta">{info.native} <b>${native.toLocaleString(undefined, { maximumFractionDigits: native >= 100 ? 0 : 2 })}</b></span> : null}
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
          <button role="tab" aria-selected={mLane === 'smart'} className={mLane === 'smart' ? 'on' : ''} onClick={() => setMLane('smart')}>
            {T('Trending')}
          </button>
          {LANES.map(l => (
            <button key={l} role="tab" aria-selected={mLane === l} className={mLane === l ? 'on' : ''} onClick={() => setMLane(l)}>
              {T(l === 'near' && mobile ? 'Bonding' : LANE_TITLE[l])} <span>{lanes[l].length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tr-lanes" style={mobile ? undefined : { ['--tr-cols' as string]: columns }}>
        {/* Trending leads, on the left, before New (owner, 2026-10-17). */}
        {(!mobile || mLane === 'smart') && (
          <TrenchTrendLane chain={chain} collapsed={!mobile && coll('smart')} onCollapse={() => toggleCollapsed(chain, 'smart')}
            onOpen={navigate} onBuy={navigate} />
        )}
        {(mobile ? (mLane === 'smart' ? [] : [mLane]) : LANES).map(l => (
          <TrenchLane key={l} chain={chain} lane={l} coins={lanes[l]} s={s} flash={data.flash} loading={data.loading} now={now}
            collapsed={!mobile && coll(l)} onCollapse={() => toggleCollapsed(chain, l)}
            onOpen={open} onBuy={askBuy} onFilter={setFilterLane} />
        ))}
      </div>

      {buyFor && (
        <TrenchBuyPop anchor={buyFor.anchor} symbol={buyFor.symbol} unit={info.quote}
          onBuy={amount => { setBuyFor(null); navigate({ ...buyFor.page, buy: { amount, slip: s.slip } } as Page) }}
          onClose={() => setBuyFor(null)} />
      )}
      {customize && <CustomizeModal onClose={() => setCustomize(false)} />}
      {filterLane && <FilterModal chain={chain} lane={filterLane} launchpads={launchpads} onClose={() => setFilterLane(null)} />}
    </div>
  )
}

/** The chain picker on phones: the current chain as a button, the others in a menu under it. */
function ChainSelect({ chain, onPick }: { chain: TChain; onPick: (c: TChain) => void }) {
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close) }
  }, [open])
  return (
    <div className="tr-csel" onPointerDown={e => e.stopPropagation()}>
      <button className="tr-csel-btn" aria-haspopup="listbox" aria-expanded={!!open}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setOpen(o => (o ? null : { top: r.bottom + 4, left: r.left })) }}>
        <ChainLogo chain={chain} size={16} /><span>{CHAINS[chain].name}</span><i aria-hidden>▾</i>
      </button>
      {open && (
        // Fixed, so the bar's sideways scroll doesn't clip it.
        <div className="tr-csel-menu" role="listbox" aria-label={T('Chain')} style={{ top: open.top, left: open.left }}>
          {CHAIN_LIST.map(c => (
            <button key={c} role="option" aria-selected={c === chain} className={c === chain ? 'on' : ''} onClick={() => { setOpen(null); if (c !== chain) onPick(c) }}>
              <ChainLogo chain={c} size={18} /><span>{CHAINS[c].name}</span>{c === chain && <b aria-hidden>✓</b>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
