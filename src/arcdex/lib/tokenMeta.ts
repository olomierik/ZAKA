// Live coin data shared by every list and page: symbol / image / price /
// changes / market cap / bonded status, from the same market list the
// Terminal uses (one shared fetch per minute), plus Arc's blue chips.

import { useEffect, useMemo, useState } from 'react'
import { getArgusMarket, type ArgusPool } from '../api/argusMarket'
import { getCurveMarket, type CurveMarketRow } from '../api/curveMarket'
import { gtGet } from '../api/gtClient'

export interface TokenMeta {
  address: string
  symbol: string
  name: string
  image: string | null
  priceUsd: number
  pool: string
  change24h: number
  change1h: number
  marketCapUsd: number | null
  volume24h: number
  liquidityUsd: number
  bonded: boolean | null
  createdAt: string | null
  /** Where it launched ("Argus", "Mercuri", …); null for the blue chips (Circle's own tokens and the like). */
  launchpad: string | null
}

const toMeta = (p: ArgusPool): TokenMeta => ({
  address: p.token.address, symbol: p.token.symbol, name: p.token.name, image: p.token.image, priceUsd: p.priceUsd,
  pool: p.pool, change24h: p.change.h24, change1h: p.change.h1, marketCapUsd: p.marketCapUsd ?? p.fdvUsd,
  volume24h: p.volume24h, liquidityUsd: p.liquidityUsd, bonded: p.bonded ?? null, createdAt: p.createdAt,
  launchpad: p.launchpad ?? 'Argus',
})

/** A Mercuri or SolonPad coin (api/curveMarket.ts): "bonded" once it has
 * graduated; an instant launch never had a curve (neither bonding nor graduated). */
const curveMeta = (c: CurveMarketRow): TokenMeta => ({
  address: c.token, symbol: c.symbol, name: c.name, image: c.image, priceUsd: c.priceUsd ?? 0,
  pool: c.pool, change24h: c.change24h, change1h: 0, marketCapUsd: c.marketCapUsd,
  volume24h: c.volume24h, liquidityUsd: c.liquidityUsd ?? 0, bonded: c.mode === 'instant' ? null : c.graduated,
  createdAt: c.launchedAt ? new Date(c.launchedAt).toISOString() : null,
  launchpad: c.launchpad,
})

/** The market list with the curve coins it lacks, each placed by its 24h
 * volume; the list's own order is kept. */
export function withCurveCoins(list: TokenMeta[], curves: TokenMeta[]): TokenMeta[] {
  const have = new Set(list.map(t => t.address))
  const extra = curves.filter(c => !have.has(c.address)).sort((a, b) => b.volume24h - a.volume24h)
  if (!extra.length) return list
  const out: TokenMeta[] = []
  let j = 0
  for (const t of list) {
    while (j < extra.length && extra[j].volume24h > t.volume24h) out.push(extra[j++])
    out.push(t)
  }
  return out.concat(extra.slice(j))
}

let cache: { at: number; list: Promise<TokenMeta[]> } | null = null
const listeners = new Set<(l: TokenMeta[]) => void>()

export function loadMarket(): Promise<TokenMeta[]> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const at = Date.now()
    cache = {
      at,
      list: getArgusMarket(more => { const l = more.map(toMeta); cache = { at, list: Promise.resolve(l) }; listeners.forEach(f => f(l)) })
        .then(p => p.map(toMeta))
        .catch(() => [] as TokenMeta[]),
    }
  }
  return cache.list
}

export function loadTokenMeta(): Promise<Map<string, TokenMeta>> {
  return loadMarket().then(l => new Map(l.map(t => [t.address, t])))
}

/** The live market list (Trending order), refreshed every minute — with
 * Mercuri's and SolonPad's coins, which GeckoTerminal has no pools for. */
export function useMarket(): TokenMeta[] {
  const [l, setL] = useState<TokenMeta[]>([])
  const [curves, setCurves] = useState<TokenMeta[]>([])
  useEffect(() => {
    let alive = true
    const upd = (x: TokenMeta[]) => { if (alive) setL(x) }
    const updCurves = () => { void getCurveMarket().then(r => { if (alive) setCurves(r.map(curveMeta)) }).catch(() => {}) }
    listeners.add(upd)
    void loadMarket().then(upd)
    updCurves()
    const id = setInterval(() => { if (!document.hidden) { void loadMarket().then(upd); updCurves() } }, 60_000)
    return () => { alive = false; listeners.delete(upd); clearInterval(id) }
  }, [])
  return useMemo(() => withCurveCoins(l, curves), [l, curves])
}

export function useTokenMeta(): Map<string, TokenMeta> {
  const l = useMarket()
  const [m, setM] = useState<Map<string, TokenMeta>>(new Map())
  useEffect(() => { setM(new Map(l.map(t => [t.address, t]))) }, [l])
  return m
}

// ── Arc blue chips (fomo's "Crypto" list) ─────────────────────────────

export const BLUE_CHIPS = [
  '0x93ffd195481e8c08eb25a158689e4d9e61313111', // WETH
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', // cirBTC
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', // EURC
  '0xece5ca8bf9220718e5727754026757512212cb3c', // ARGUS
]

type R = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } | { id: string }[] }> }
let chips: { at: number; p: Promise<TokenMeta[]> } | null = null

export function loadBlueChips(): Promise<TokenMeta[]> {
  if (!chips || Date.now() - chips.at > 60_000) {
    chips = {
      at: Date.now(),
      p: gtGet<{ data?: R[]; included?: R[] }>(`/networks/arc/tokens/multi/${BLUE_CHIPS.join(',')}`, { include: 'top_pools' }).then(d => {
        const pools = new Map((d.included ?? []).filter(i => i.type === 'pool').map(i => [i.id, i.attributes]))
        const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }
        return (d.data ?? []).map(t => {
          const a = t.attributes
          const top = (t.relationships?.top_pools?.data as { id: string }[] | undefined)?.map(r => pools.get(r.id)).find(Boolean)
          const pc = (top?.price_change_percentage ?? {}) as Record<string, unknown>
          const img = a.image_url as string | undefined
          return {
            address: String(a.address).toLowerCase(), symbol: String(a.symbol ?? ''), name: String(a.name ?? ''),
            image: img && !img.includes('missing') ? img : null, priceUsd: n(a.price_usd), pool: String(top?.address ?? '').toLowerCase(),
            change24h: n(pc.h24), change1h: n(pc.h1), marketCapUsd: n(a.market_cap_usd) || n(a.fdv_usd) || null,
            volume24h: n((a.volume_usd as Record<string, unknown> | undefined)?.h24), liquidityUsd: n(a.total_reserve_in_usd), bonded: null, createdAt: null, launchpad: null,
          } as TokenMeta
        }).sort((x, y) => BLUE_CHIPS.indexOf(x.address) - BLUE_CHIPS.indexOf(y.address))
      }).catch(() => [] as TokenMeta[]),
    }
  }
  return chips.p
}
