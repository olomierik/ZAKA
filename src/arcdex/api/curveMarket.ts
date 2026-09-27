// Mercuri's and SolonPad's coins — every one on its launchpad's bonding
// curve or graduated from it — from the server's index
// (/api/launchpad?of=curves, api/_curveIndex.ts). GeckoTerminal's market
// list has none of them: a coin on a bonding curve has no DEX pool, and a
// graduated one's plain Uniswap pool isn't filed under its launchpad.

import type { CurveMarketRow } from '../../../api/_curveIndex'
import type { ArcToken } from './radardex'

export type { CurveMarketRow }

const NATIVE = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-f]{40}$/
/** A curve or v3 pool (an address) or a v4 pool (a PoolId). */
const POOL = /^0x[0-9a-f]{40}([0-9a-f]{24})?$/
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** A served row, checked field by field; null if it isn't one. */
function rowOf(v: unknown): CurveMarketRow | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const token = text(r.token, 42).toLowerCase(), curve = text(r.curve, 42).toLowerCase(), pool = text(r.pool, 66).toLowerCase()
  if (!ADDRESS.test(token) || !ADDRESS.test(curve) || !POOL.test(pool) || (r.launchpad !== 'Mercuri' && r.launchpad !== 'SolonPad')) return null
  const symbol = text(r.symbol, 24)
  if (!symbol) return null
  const image = text(r.image, 500)
  const creator = text(r.creator, 42).toLowerCase()
  const quote = text(r.quote, 42).toLowerCase()
  const progress = num(r.progress)
  return {
    token, curve, pool, launchpad: r.launchpad,
    // Its market's quote: native USDC unless a graduated coin's pool says otherwise.
    quote: ADDRESS.test(quote) || quote === NATIVE ? quote : NATIVE,
    name: text(r.name, 64) || symbol, symbol,
    image: /^https:\/\//.test(image) ? image : null,
    creator: ADDRESS.test(creator) ? creator : null,
    launchedAt: num(r.launchedAt) ?? 0,
    priceUsd: num(r.priceUsd), marketCapUsd: num(r.marketCapUsd), liquidityUsd: num(r.liquidityUsd),
    volume24h: num(r.volume24h) ?? 0, buys24h: num(r.buys24h) ?? 0, sells24h: num(r.sells24h) ?? 0,
    change24h: num(r.change24h) ?? 0,
    progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
    graduated: r.graduated === true,
    lastTradeAt: num(r.lastTradeAt),
  }
}

let last: { at: number; rows: Promise<CurveMarketRow[]> } | null = null

/** The coins, as the server last indexed them (one request per 15s, however many ask). */
export function getCurveMarket(): Promise<CurveMarketRow[]> {
  if (!last || Date.now() - last.at > 15_000) {
    const rows = fetch('/api/launchpad?of=curves', { signal: AbortSignal.timeout(15_000) })
      .then(res => (res.ok ? res.json() as Promise<{ coins?: unknown }> : Promise.reject(new Error(`curve index → ${res.status}`))))
      .then(d => (Array.isArray(d.coins) ? d.coins : []).map(rowOf).filter((r): r is CurveMarketRow => r !== null))
    last = { at: Date.now(), rows }
    // A failed read isn't kept: the next caller asks again.
    rows.catch(() => { if (last?.rows === rows) last = null })
  }
  return last.rows
}

/** A coin as a Terminal row. It opens on its curve (or, graduated, its
 * Uniswap pool), quoted in native USDC (or that pool's USDC). */
export function curveRowToArcToken(c: CurveMarketRow, now = Date.now()): ArcToken {
  return {
    address: c.token,
    symbol: c.symbol,
    name: c.name,
    decimals: 18,
    logoUrl: c.image ?? '',
    price: c.priceUsd ?? 0,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange24h: c.change24h,
    volume24h: c.volume24h,
    marketCap: c.marketCapUsd ?? 0,
    liquidity: c.liquidityUsd ?? 0,
    ageMs: c.launchedAt ? Math.max(0, now - c.launchedAt) : 0,
    launchpad: c.launchpad,
    poolAddress: c.pool,
    txCount24h: c.buys24h + c.sells24h,
    holderCount: 0,
    buys24h: c.buys24h,
    sells24h: c.sells24h,
    verified: true, // announced by its launchpad's own factory
    graduated: c.graduated,
    bondingProgress: c.progress === null ? null : Math.round(c.progress * 1000) / 10,
    spark: [],
    deployer: c.creator ?? undefined,
    quoteSymbol: 'USDC',
    quoteAddress: c.quote,
  }
}
