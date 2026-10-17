// The Trenches (2026-10-12, owner: "a trading terminal like motion.gift"): every chain's coins as one shape, in three
// lanes as memecoin terminals show them. New (launched in the last hour, newest first), Almost bonded (closest to
// graduating first, then the rest on their curve) and Migrated (off the curve, or launched into a pool; youngest
// first). Each coin keeps its safety rating, OG/duplicate tags and the owner's listing rules (lib/safety.ts).
// The display settings, minimized lanes and lane filters are kept in this browser. (Quick-buy presets are gone: a row's
// Buy asks for the amount, owner's request of 2026-10-12; old settings keep their unused `presets`.)

import { useSyncExternalStore } from 'react'
import type { Page } from '../App'
import type { Stage } from './coinStage'
import type { SafetyView } from './safety'
import type { TChain } from './chains'

export interface TrenchCoin {
  key: string
  chain: TChain
  address: string
  pool: string | null
  symbol: string
  name: string
  image: string | null
  launchpad: string | null
  launchpadColor?: string
  /** The pool's quote (USDC, ETH, SOL, BNB, USDT…). */
  quote: string
  /** When it launched (ms), 0 when unknown. */
  createdAt: number
  marketCap: number
  liquidity: number
  volume24h: number
  change24h: number
  change1h: number | null
  buys24h: number
  sells24h: number
  /** ARCDEX's holder index (Arc), else null. */
  holders: number | null
  /** Wallets trading in 24h, where holders aren't known. */
  traders24h: number | null
  /** 0–100 along its curve (null: off the curve, or unknown). */
  progress: number | null
  onCurve: boolean
  stage: Stage
  safety: SafetyView
  /** The pool's fee tier or the creator's tax, as known. */
  fee: string | null
  twitter: string | null
  /** Its website and Telegram (DexScreener's coin info, lib/dexData.ts), when known. */
  website?: string | null
  telegram?: string | null
  /** Its first moments (engine/src/trench/book.ts EARLY), for coins the engine saw launch: bundlers, snipers and the
   * share of the creator's own buy sold (null: not known). */
  early?: { bundlers: number; snipers: number; devSold: number | null } | null
  /** Trades in the last 15 minutes (the busiest coins). */
  hot?: number
  official?: boolean
  og?: boolean
  dup?: boolean
  dupSame?: boolean
  /** Its launcher's last coins and how many it dumped early (Arc's scan). */
  launcher?: { coins: number; dumps: number } | null
  /** The last hour's volume and trades (Arc's from the engine, the others' from DexScreener), for the 1h window. */
  hour?: { vol: number; buys: number; sells: number } | null
  /** The newest thesis anyone posted on the coin (lib/latestTheses.ts). */
  thesis?: { body: string; author: string; at: number } | null
  page: Page
}

export type LaneId = 'new' | 'near' | 'migrated'
export const LANES: LaneId[] = ['new', 'near', 'migrated']
export const MAX_ROWS = 60

/** What the listing rules need to know about a coin (lib/safety.ts works each one out). */
export interface ListingFacts {
  /** $ARCDEX: always shown, never rated. */
  official: boolean
  stage: Stage
  rugged: boolean
  /** Rated Danger. */
  danger: boolean
  /** The owner's listing rule: $15K of market cap and not rugged (isListable). */
  listable: boolean
  /** The safety standard: not Danger, and a pool coin deep enough (meetsStandard). */
  standard: boolean
  /** A wash-traded pool (the Robinhood Chain, Solana and BNB Chain lists). */
  wash?: boolean
}

/** Whether a coin shows in the lanes. "Show everything" shows them all. Otherwise $ARCDEX always shows; a coin under an
 * hour old shows in New below the $15K minimum when `freshNew` is on, unless rugged or rated Danger; any other coin
 * only when it's listable and up to the standard. Every coin left out counts in the lanes' "hidden" note, so the note
 * says exactly how many "Show everything" brings back. */
export function shownInLanes(f: ListingFacts, s: Pick<TrenchSettings, 'showAll' | 'freshNew'>): boolean {
  if (s.showAll || f.official) return true
  if (f.wash) return false
  if (s.freshNew && f.stage === 'new') return !f.rugged && !f.danger
  return f.listable && f.standard
}

/** The coins in a lane, in its order. */
export function laneCoins(coins: TrenchCoin[], lane: LaneId): TrenchCoin[] {
  if (lane === 'new') return coins.filter(c => c.stage === 'new').sort((a, b) => b.createdAt - a.createdAt)
  if (lane === 'near') return [
    ...coins.filter(c => c.stage === 'near').sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)),
    ...coins.filter(c => c.stage === 'bonding').sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1) || b.volume24h - a.volume24h),
  ]
  return coins.filter(c => c.stage === 'graduated' || c.stage === 'established').sort((a, b) => b.createdAt - a.createdAt || b.volume24h - a.volume24h)
}

// ── settings (Customize, presets, filters) ─────────────────────────────

/** Arc quick buys' slippage (the trade form opens with it); other chains' routes guard their own prices. */
export type Slip = 1 | 3 | 5 | 10
export const SLIPS: Slip[] = [1, 3, 5, 10]
export type PresetId = 0 | 1 | 2

export interface LaneFilter {
  include: string
  exclude: string
  launchpads: string[]
  minMc: number | null
  maxMc: number | null
  minLiq: number | null
  minTx: number | null
  maxAgeMin: number | null
  minProgress: number | null
}
export const EMPTY_FILTER: LaneFilter = { include: '', exclude: '', launchpads: [], minMc: null, maxMc: null, minLiq: null, minTx: null, maxAgeMin: null, minProgress: null }

export interface TrenchSettings {
  /** Quick-buy amounts, per chain: P1, P2, P3. */
  presets: Record<TChain, [number, number, number]>
  /** The preset each lane buys with, per chain. */
  lanePreset: Record<string, PresetId>
  slip: Slip
  /** Bonding progress as % of the curve, or the market cap. */
  pctMc: boolean
  /** The rows' volume, trades and buy/sell bar over the last hour or day (as GMGN's window). */
  window: '1h' | '24h'
  imageShape: 'square' | 'circle'
  ring: boolean
  metricsLarge: boolean
  buttonSize: 'small' | 'large'
  pauseOnHover: boolean
  /** Show coins the listing rules hide: under $15K, rugged, rated Danger, too thin (owner's rule: off by default). */
  showAll: boolean
  /** Coins under an hour old show in New below the $15K listing minimum (never rugged or rated Danger). */
  freshNew: boolean
  /** Only the coins on the watchlist (☆ on a row). */
  watchOnly: boolean
  /** Beep when a coin enters a lane, per lane. */
  laneSound: Record<string, boolean>
  filters: Record<string, LaneFilter>
  /** Lanes minimized to a slim strip, per chain and lane (the smart lane is `smart`). */
  collapsed: Record<string, boolean>
}

const DEFAULTS: TrenchSettings = {
  presets: { arc: [5, 25, 100], hood: [5, 25, 100], sol: [0.05, 0.25, 1], bnb: [0.01, 0.05, 0.25] },
  lanePreset: {},
  slip: 3,
  pctMc: false,
  window: '24h',
  imageShape: 'square',
  ring: true,
  metricsLarge: true,
  buttonSize: 'large',
  pauseOnHover: true,
  showAll: false,
  freshNew: true,
  watchOnly: false,
  laneSound: {},
  filters: {},
  collapsed: {},
}

const KEY = 'arcdex:trenches:v1'
const EVENT = 'arcdex:trenches'

function load(): TrenchSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const s = JSON.parse(raw) as Partial<TrenchSettings>
    return { ...DEFAULTS, ...s, presets: { ...DEFAULTS.presets, ...(s.presets ?? {}) } }
  } catch { return DEFAULTS }
}
let state: TrenchSettings = load()

export const getTrench = () => state
export function setTrench(patch: Partial<TrenchSettings> | ((s: TrenchSettings) => Partial<TrenchSettings>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage blocked: this page only */ }
  window.dispatchEvent(new Event(EVENT))
}
export function resetTrenchDisplay() {
  setTrench({ imageShape: DEFAULTS.imageShape, ring: DEFAULTS.ring, metricsLarge: DEFAULTS.metricsLarge, buttonSize: DEFAULTS.buttonSize, pauseOnHover: DEFAULTS.pauseOnHover, pctMc: DEFAULTS.pctMc })
}
function subscribe(f: () => void) {
  window.addEventListener(EVENT, f)
  return () => window.removeEventListener(EVENT, f)
}
export function useTrench(): TrenchSettings {
  return useSyncExternalStore(subscribe, getTrench, () => DEFAULTS)
}

export const laneKey = (chain: TChain, lane: LaneId | 'smart') => `${chain}:${lane}`
export const isCollapsed = (s: TrenchSettings, chain: TChain, lane: LaneId | 'smart') => !!s.collapsed?.[laneKey(chain, lane)]
export function toggleCollapsed(chain: TChain, lane: LaneId | 'smart') {
  setTrench(st => ({ collapsed: { ...(st.collapsed ?? {}), [laneKey(chain, lane)]: !st.collapsed?.[laneKey(chain, lane)] } }))
}
export const presetOf = (s: TrenchSettings, chain: TChain, lane: LaneId): PresetId => s.lanePreset[laneKey(chain, lane)] ?? 0
export const filterOf = (s: TrenchSettings, chain: TChain, lane: LaneId): LaneFilter => s.filters[laneKey(chain, lane)] ?? EMPTY_FILTER
export const filterOn = (f: LaneFilter) => JSON.stringify(f) !== JSON.stringify(EMPTY_FILTER)

/** Whether a coin passes a lane's filters. */
export function passesFilter(c: TrenchCoin, f: LaneFilter, now = Date.now()): boolean {
  const words = (s: string) => s.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
  const text = `${c.symbol} ${c.name}`.toLowerCase()
  const inc = words(f.include)
  if (inc.length && !inc.some(w => text.includes(w))) return false
  if (words(f.exclude).some(w => text.includes(w))) return false
  if (f.launchpads.length && !f.launchpads.includes(c.launchpad ?? '')) return false
  if (f.minMc !== null && c.marketCap < f.minMc) return false
  if (f.maxMc !== null && c.marketCap > f.maxMc) return false
  if (f.minLiq !== null && c.liquidity < f.minLiq) return false
  if (f.minTx !== null && c.buys24h + c.sells24h < f.minTx) return false
  if (f.maxAgeMin !== null && c.createdAt > 0 && now - c.createdAt > f.maxAgeMin * 60_000) return false
  if (f.minProgress !== null && (c.progress ?? -1) < f.minProgress) return false
  return true
}

// ── numbers, as the rows show them ─────────────────────────────────────

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '$0'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}
export function count(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`
}
export function ageOf(createdAt: number, now = Date.now()): string {
  if (!createdAt) return '—'
  const s = Math.max(0, Math.floor((now - createdAt) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}
/** Quick-buy amount as shown on the button ($5, 0.05). */
export function amountText(n: number, quote: 'USDC' | 'SOL' | 'BNB'): string {
  const s = n >= 100 ? n.toFixed(0) : n >= 1 ? String(Math.round(n * 100) / 100) : String(Math.round(n * 10_000) / 10_000)
  return quote === 'USDC' ? `$${s}` : s
}
