// A coin's safety rating, the same on every chain (2026-10-04, owner: "avoid buying rugs; set a standard for which
// coins appear"): Safe, Risky or Danger, with the reasons in words, and the listing standard the default lists follow.
//
// On Arc it reads the engine's safety scan (GET /v1/safety, engine/src/bot/boardSafety.ts): the sell test, the contract
// and hook, the creator's sales and record, bundled and linked buyers, wash trading, holders. A coin the engine doesn't
// track, and every Robinhood Chain coin, is rated from its market data alone (lib/risk.ts), and says so.
//
//   danger    you can lose everything to the contract or the creator: it can't be sold back (or a heavy sell tax), its
//             hook can block trades, its contract can mint, freeze, pause or be replaced, the creator already dumped, a
//             launcher who dumps most of its coins, a fake ticker, wash trading on Robinhood Chain
//   risky     signs of manipulation: bundled or linked early buyers, wash trading, thin liquidity, a few wallets holding
//             most of it, a serial launcher, a bigger coin with the same ticker, or high risk from its market data
//   checking  not scanned yet (Arc)
//   safe      none of that, and on Arc the sell test passed
//
// No rating catches every rug; the reasons let people judge the rest.

import type { CoinSafety } from '../../../api/_marketProtocol'
import type { ArcToken } from '../api/radardex'
import type { RhCoin } from '../api/robinhoodMarket'
import { isWashPool } from '../api/robinhoodMarket'
import { copycatOf } from '../api/argusMarket'
import { riskOf, riskReasons, type Risk } from './risk'
import type { Stage } from './coinStage'
import { t as T, N_ } from './i18n'

export type SafetyLevel = 'safe' | 'risky' | 'danger' | 'checking'

export interface SafetyView {
  level: SafetyLevel
  /** Why, in words, the worst first. */
  reasons: string[]
  /** 'chain': the engine's on-chain scan; 'market': market data alone. */
  source: 'chain' | 'market'
}

/** Failed checks that put everything at risk; any other failed check is a manipulation sign (risky). */
const DANGER_CHECKS = new Set(['honeypot', 'hook', 'contract', 'proxy', 'selfdestruct', 'creator', 'launchpad'])

const CHECK_TEXT: Record<string, string> = {
  honeypot: N_('Can’t be sold back, or a heavy sell tax'),
  hook: N_('Its pool hook can block or change trades'),
  contract: N_('Its contract can mint, freeze, pause or take fees'),
  proxy: N_('Its contract can be replaced (an upgradeable proxy)'),
  selfdestruct: N_('Its contract can self-destruct'),
  creator: N_('The creator already sold most of their coins'),
  launchpad: N_('Not a known launchpad’s standard contract'),
  bundle: N_('Bundled launch: a few wallets bought a big share at once'),
  clusters: N_('Early buyers were funded from the same wallet'),
  wash: N_('Wash trading: a few wallets trade with themselves'),
  liquidity: N_('Thin liquidity'),
  holders: N_('A few wallets hold most of it'),
  serial: N_('The creator launched several coins today'),
  copycat: N_('A bigger coin uses the same ticker'),
}
const checkText = (id: string) => T(CHECK_TEXT[id] ?? id)

/** A launcher's dump rate, as the engine's live bots read it: (dumps + 1) / (coins + 4). */
export const launcherRate = (dumps: number, coins: number) => (dumps + 1) / (coins + 4)
export const LAUNCHER = { riskyRate: 0.25, dangerRate: 0.4, dangerDumps: 2 } as const

const RANK: Record<SafetyLevel, number> = { danger: 3, risky: 2, checking: 1, safe: 0 }
/** Worst first, for sorting by safety. */
export const safetyRank = (l: SafetyLevel) => RANK[l]

function fromMarket(risk: Risk, copycat: string | null, extra: { danger?: string[]; safe?: string } = {}): SafetyView {
  const danger = [...(extra.danger ?? [])]
  if (copycat) danger.push(T('Uses the {sym} ticker: not the real {sym}', { sym: copycat }))
  if (danger.length) return { level: 'danger', reasons: danger, source: 'market' }
  // Market data alone can't vouch for a coin: only a low market risk reads as safe.
  if (risk.level !== 'low') return { level: 'risky', reasons: riskReasons(risk, 3), source: 'market' }
  return { level: 'safe', reasons: extra.safe ? [extra.safe] : riskReasons(risk, 2), source: 'market' }
}

/** An Arc coin: the engine's scan (`chain`: undefined while it loads, null when the engine doesn't track the coin or
 * can't be reached) with its market data. */
export function arcSafety(t: ArcToken, risk: Risk, chain: CoinSafety | null | undefined, onCurve: boolean): SafetyView {
  const copycat = copycatOf(t.symbol, t.address)
  if (chain === undefined) return { level: 'checking', reasons: [T('Checking it on-chain…')], source: 'chain' }
  if (chain === null) return fromMarket(risk, copycat)
  const danger: string[] = [], risky: string[] = []
  for (const f of chain.fails) (DANGER_CHECKS.has(f.id) ? danger : risky).push(checkText(f.id))
  for (const r of chain.risks) risky.push(checkText(r.id))
  if (copycat) danger.push(T('Uses the {sym} ticker: not the real {sym}', { sym: copycat }))
  const l = chain.launcher
  if (l && l.dumps > 0) {
    const rate = launcherRate(l.dumps, l.coins)
    const text = T('The creator dumped {d} of their last {n} coins soon after launch', { d: l.dumps, n: l.coins })
    if (l.dumps >= LAUNCHER.dangerDumps && rate > LAUNCHER.dangerRate) danger.push(text)
    else if (rate > LAUNCHER.riskyRate) risky.push(text)
  }
  if (risk.level === 'high') risky.push(...riskReasons(risk, 2))
  if (danger.length) return { level: 'danger', reasons: [...danger, ...risky], source: 'chain' }
  if (risky.length) return { level: 'risky', reasons: risky, source: 'chain' }
  if (chain.at === 0 || (!onCurve && chain.sellable !== true)) return { level: 'checking', reasons: [T('Checking it on-chain…')], source: 'chain' }
  return { level: 'safe', reasons: [onCurve ? T('On its launchpad’s curve: it always buys back') : T('Sold back fine in a test trade'), T('No red flags in its contract, creator or buyers')], source: 'chain' }
}

/** A Robinhood Chain coin's market risk (lib/risk.ts): its traders stand in for holders, which aren't known there. */
export function rhRisk(c: RhCoin): Risk {
  return riskOf({
    liquidityUsd: c.liquidity, marketCapUsd: c.marketCap, launchedAt: c.createdAt || null,
    holders: null, txns24h: c.buys24h + c.sells24h, buys24h: c.buys24h, sells24h: c.sells24h, change24h: c.change24h,
  })
}

/** A Robinhood Chain coin, from its market data: on-chain checks run on Arc only so far. */
export function rhSafety(c: RhCoin, risk: Risk = rhRisk(c)): SafetyView {
  if (c.stock && !c.launchpad) return { level: 'safe', reasons: [T('A Robinhood stock token: issued by Robinhood')], source: 'market' }
  return fromMarket(risk, null, { danger: isWashPool(c) ? [T('Wash trading: a few wallets trade with themselves')] : [] })
}

// ── the listing standard ───────────────────────────────────────────────

/** What a coin needs to be in the default lists (owner's call: $2K suggested). Under it, or in danger, a coin is still
 * found by search and shown with "Show risky coins". Below minMarketCapUsd, or rugged, a coin isn't listed at all,
 * "Show risky coins" or not (owner, 2026-10-04: "don't show coins that already rugged or are below 15K market cap, on
 * all chains, except our native coin"); a search still finds it. */
export const LISTING = { minLiquidityUsd: 2_000, minHolders: 20, minMarketCapUsd: 15_000 } as const

/** Already rugged: its creator sold most of their coins (the engine's check), it fell 90%+ in a day, or its pool's
 * liquidity was drained (under $500; a curve's can't be). */
export function isRugged(o: { change24h: number; liquidityUsd: number; onCurve: boolean; chain?: CoinSafety | null }): boolean {
  if (o.chain?.fails.some(f => f.id === 'creator')) return true
  if (o.change24h <= -90) return true
  return !o.onCurve && o.liquidityUsd > 0 && o.liquidityUsd < 500
}

/** Whether a coin is listed at all (ARCDEX's own coin always is): $15K of market cap or more, and not rugged. */
export function isListable(o: { official: boolean; marketCapUsd: number; rugged: boolean }): boolean {
  return o.official || (o.marketCapUsd >= LISTING.minMarketCapUsd && !o.rugged)
}

export function meetsStandard(o: { level: SafetyLevel; stage: Stage; onCurve: boolean; liquidityUsd: number; holders: number | null }): boolean {
  if (o.level === 'danger') return false
  // A new coin's first minutes and a curve's early days are thin by nature; danger still keeps them out.
  if (o.stage === 'new' || o.onCurve) return true
  if (o.liquidityUsd < LISTING.minLiquidityUsd) return false
  return o.holders === null || o.holders >= LISTING.minHolders
}

export const SAFETY_LABEL: Record<SafetyLevel, string> = { safe: N_('Safe'), risky: N_('Risky'), danger: N_('Danger'), checking: N_('Checking') }
export const SAFETY_ICON: Record<SafetyLevel, string> = { safe: '✅', risky: '⚠', danger: '⛔', checking: '◌' }
export const SAFETY_COLOR: Record<SafetyLevel, string> = { safe: '#0ecb81', risky: '#f0b90b', danger: '#f6465d', checking: '#848e9c' }
