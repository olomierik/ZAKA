// A coin's risk score: 0–100, higher is riskier, with the reasons behind it.
//
// One model for every coin in the app. The Terminal scores each row from
// the market data it already has — liquidity, market cap, age, holders,
// trading, the 24h move, copycat tickers — with no extra requests (it's a
// list of hundreds, often on a phone connection). A coin page adds what it
// reads for that one coin: GeckoTerminal's honeypot flag and trust score,
// the top-10 share, the dev's holdings and sells, the creator tax and, for
// launchpad coins, whether the launch buyers look bundled. So a coin page's
// score can be higher than its Terminal row's.
//
// It's a heuristic from public data, not a guarantee, and the UI says so.

import type { ArcToken } from '../api/radardex'
import { copycatOf } from '../api/argusMarket'
import { agoShort } from './ago'
import { t as T, N_ } from './i18n'

export type RiskLevel = 'low' | 'medium' | 'high'

/** One thing that raised the score: its points and how to say it. */
interface Factor { pts: number; key: string; vars?: Record<string, string | number> }

export interface Risk {
  score: number
  level: RiskLevel
  /** What raised the score, biggest first (only the ones worth saying). */
  factors: Factor[]
}

export interface RiskInput {
  liquidityUsd?: number | null
  marketCapUsd?: number | null
  /** Unknown: null or 0. */
  ageMs?: number | null
  /** Or when it launched (ms), for the age to be taken now. */
  launchedAt?: number | null
  /** Unknown: null or 0. */
  holders?: number | null
  txns24h?: number | null
  buys24h?: number | null
  sells24h?: number | null
  /** % */
  change24h?: number | null
  /** An ArcLaunchpad coin on its curve: the liquidity can't be pulled, and
   * launch buys are capped on-chain (anti-snipe, anti-bundle). */
  curve?: boolean
  bonded?: boolean | null
  /** The ticker it imitates (a fake USDT, EURC…). */
  copycat?: string | null
  /** A bigger coin uses the same ticker (this is the smaller one). */
  sameTicker?: boolean
  // ── what a coin page adds ──
  honeypot?: boolean | null
  gtScore?: number | null
  top10Pct?: number | null
  devPct?: number | null
  devSoldUsd?: number | null
  /** The higher of the buy and sell creator tax. */
  taxBps?: number | null
  /** Launchpad launch-buyer check (api/trustScore.ts): 100 = no bundling seen. */
  trustScore?: number | null
}

const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`
/** Factors below this aren't worth a line of their own (they still count). */
const SAY = 6

export function riskOf(i: RiskInput): Risk {
  if (i.honeypot) return { score: 100, level: 'high', factors: [{ pts: 100, key: N_('Honeypot risk — you may not be able to sell') }] }
  const f: Factor[] = []
  const add = (pts: number, key: string, vars?: Factor['vars']) => { if (pts > 0) f.push({ pts, key, vars }) }

  // Liquidity: how much money backs the price. On a launchpad curve it
  // can't be pulled, so it counts half.
  const liq = i.liquidityUsd ?? 0
  const liqPts = liq <= 0 ? 24 : liq < 1_000 ? 35 : liq < 5_000 ? 24 : liq < 20_000 ? 12 : liq < 100_000 ? 5 : 0
  add(i.curve ? Math.round(liqPts / 2) : liqPts,
    liq <= 0 ? N_('No liquidity yet') : liq < 1_000 ? N_('Very thin liquidity ({usd})') : liq < 5_000 ? N_('Thin liquidity ({usd})') : N_('Low liquidity ({usd})'), { usd: usd(liq) })

  // A big market cap on little liquidity: the price is easy to move, and a
  // few holders selling can drain the pool.
  const mc = i.marketCapUsd ?? 0
  if (!i.curve && liq > 0 && mc > 0) {
    const x = mc / liq
    add(x > 50 ? 15 : x > 20 ? 10 : x > 10 ? 4 : 0, N_('Market cap is {x}× its liquidity'), { x: Math.round(x) })
  }

  // New coins are where most rugs happen.
  const age = i.ageMs || (i.launchedAt ? Math.max(1, Date.now() - i.launchedAt) : 0)
  if (age > 0) add(age < 3_600_000 ? 15 : age < 6 * 3_600_000 ? 10 : age < 86_400_000 ? 6 : age < 7 * 86_400_000 ? 2 : 0, N_('Launched {age} ago'), { age: agoShort(Date.now() - age) })
  else add(4, N_('Age unknown'))

  const holders = i.holders ?? 0
  if (holders > 0) add(holders < 25 ? 15 : holders < 100 ? 8 : holders < 500 ? 3 : 0, N_('Only {n} holders'), { n: holders })
  else add(4, N_('Holder count unknown'))

  const txns = i.txns24h ?? 0
  if (txns === 0 && (age === 0 || age > 3_600_000)) add(8, N_('No trades in 24h'))
  else if (txns < 10) add(4, N_('Few trades in 24h'))

  const ch = i.change24h ?? 0
  add(ch <= -80 ? 15 : ch <= -50 ? 10 : ch <= -30 ? 5 : 0, N_('Down {pct}% in 24h'), { pct: Math.round(-ch) })

  const buys = i.buys24h ?? 0, sells = i.sells24h ?? 0
  if (sells >= 10 && sells > 2 * buys) add(6, N_('{sells} sells vs {buys} buys in 24h'), { sells, buys })

  if (i.copycat) add(25, N_('Uses the {sym} ticker — not the real {sym}'), { sym: i.copycat })
  if (i.sameTicker) add(15, N_('A bigger coin uses the same ticker'))

  // A coin page's own checks.
  if (i.gtScore != null) add(i.gtScore < 30 ? 10 : i.gtScore < 50 ? 4 : 0, N_('Low GeckoTerminal trust score ({score}/100)'), { score: Math.round(i.gtScore) })
  if (i.top10Pct != null) add(i.top10Pct > 50 ? 15 : i.top10Pct > 30 ? 8 : 0, N_('Top 10 wallets hold {pct}%'), { pct: i.top10Pct.toFixed(1) })
  if (i.devPct != null) add(i.devPct > 20 ? 15 : i.devPct > 10 ? 8 : 0, N_('Dev holds {pct}% of supply'), { pct: i.devPct.toFixed(2) })
  if (i.devSoldUsd) add(12, N_('Dev sold {usd} in recent trades'), { usd: usd(i.devSoldUsd) })
  if (i.taxBps != null) add(i.taxBps >= 1_000 ? 15 : i.taxBps >= 300 ? 6 : 0, N_('{pct}% creator tax'), { pct: i.taxBps / 100 })
  if (i.trustScore != null) add(i.trustScore < 50 ? 15 : i.trustScore < 75 ? 7 : 0, N_('Launch buyers look bundled'))

  let score = f.reduce((s, x) => s + x.pts, 0)
  if (i.bonded) score -= 5
  score = Math.max(0, Math.min(100, Math.round(score)))
  f.sort((a, b) => b.pts - a.pts)
  return { score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', factors: f.filter(x => x.pts >= SAY) }
}

/** A Terminal row's quick score, from its market data alone. */
export function tokenRisk(t: ArcToken, o: { sameTicker?: boolean } = {}): Risk {
  return riskOf({
    liquidityUsd: t.liquidity, marketCapUsd: t.marketCap, ageMs: t.ageMs || null,
    holders: t.holderCount || null, txns24h: t.txCount24h, buys24h: t.buys24h, sells24h: t.sells24h,
    change24h: t.priceChange24h, curve: t.launchpad === 'ARCDEX', bonded: t.graduated || null,
    copycat: copycatOf(t.symbol, t.address), sameTicker: o.sameTicker,
  })
}

export const RISK_COLOR: Record<RiskLevel, string> = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' }
export const riskLabel = (l: RiskLevel) => (l === 'low' ? T('Low') : l === 'medium' ? T('Medium') : T('High'))
/** The reasons, in the reader's language. */
export const riskReasons = (r: Risk, max = 4) => r.factors.slice(0, max).map(x => T(x.key, x.vars))
/** "Low risk" / "Medium risk" / "High risk". */
export const riskText = (l: RiskLevel) => (l === 'low' ? T('Low risk') : l === 'medium' ? T('Medium risk') : T('High risk'))
