// ── DexScreener API client ────────────────────────────────────────────
// Proxied through /api/dex to avoid CORS.
// DexScreener updates Arc pairs every ~5s; we poll every 6s.

const BASE = '/api/dex'

export interface DexPair {
  chainId:       string
  dexId:         string
  pairAddress:   string
  baseToken:     { address: string; name: string; symbol: string }
  quoteToken:    { address: string; name: string; symbol: string }
  priceUsd:      string
  priceChange:   { m5: number; h1: number; h6: number; h24: number }
  volume:        { m5: number; h1: number; h6: number; h24: number }
  liquidity:     { usd: number; base: number; quote: number }
  txns:          { m5: {buys:number;sells:number}; h1: {buys:number;sells:number}; h6: {buys:number;sells:number}; h24: {buys:number;sells:number} }
  fdv:           number
  marketCap:     number | null
  pairCreatedAt: number
  info?: {
    imageUrl?:  string
    header?:    string
    websites?:  { url: string; label: string }[]
    socials?:   { type: string; url: string }[]
  }
}

// Map dexId → launchpad display name + color
export const DEX_LABELS: Record<string, { name: string; color: string }> = {
  'argus':           { name: 'Argus',       color: '#f97316' },
  'minara-fun':      { name: 'Minara',      color: '#a855f7' },
  'radardex':        { name: 'RadarDex',    color: '#3b82f6' },
  'tolly':           { name: 'Tolly',       color: '#22c55e' },
  'warp':            { name: 'Warp',        color: '#06b6d4' },
  'archemist':       { name: 'Archemist',   color: '#eab308' },
  'o1-launchpad':    { name: 'o1',          color: '#ec4899' },
  'uniswap-v4':      { name: 'Uniswap V4',  color: '#ff007a' },
  'uniswap-v3':      { name: 'Uniswap V3',  color: '#ff007a' },
  'uniswap':         { name: 'Uniswap V3',  color: '#ff007a' },
  'pegd':            { name: 'PEGD',        color: '#14b8a6' },
}

function dexLabel(dexId: string) {
  const lower = dexId.toLowerCase()
  for (const [key, val] of Object.entries(DEX_LABELS)) {
    if (lower.includes(key)) return val
  }
  // try to detect uniswap version from dexId
  if (lower.includes('v4')) return { name: 'Uniswap V4', color: '#ff007a' }
  if (lower.includes('v3') || lower.includes('uni')) return { name: 'Uniswap V3', color: '#ff007a' }
  return { name: dexId, color: '#64748b' }
}

export function getLaunchpad(pair: DexPair) { return dexLabel(pair.dexId) }

// ── search / list Arc pairs ───────────────────────────────────────────
async function fetchPairs(path: string): Promise<DexPair[]> {
  const res = await fetch(`${BASE}?path=${encodeURIComponent(path)}`)
  if (!res.ok) return []
  const d: { pairs?: DexPair[] } = await res.json() as { pairs?: DexPair[] }
  return (d.pairs ?? []).filter(p => p.chainId === 'arc')
}

export async function getTrendingPairs(): Promise<DexPair[]> {
  // DexScreener search for trending Arc tokens by volume
  const res = await fetch(`${BASE}?path=${encodeURIComponent('/latest/dex/search?q=USDC&chainId=arc')}`)
  if (!res.ok) return []
  const d: { pairs?: DexPair[] } = await res.json() as { pairs?: DexPair[] }
  const pairs = (d.pairs ?? []).filter(p => p.chainId === 'arc')
  // sort by 24h volume desc → "trending"
  return pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
}

export async function getPairsByToken(tokenAddress: string): Promise<DexPair[]> {
  return fetchPairs(`/latest/dex/tokens/${tokenAddress}`)
}

export async function getPairByAddress(pairAddress: string): Promise<DexPair | null> {
  const pairs = await fetchPairs(`/latest/dex/pairs/arc/${pairAddress}`)
  return pairs[0] ?? null
}

// Batch fetch multiple pair addresses at once (max 30 per call per DexScreener docs)
export async function getPairsBatch(addresses: string[]): Promise<DexPair[]> {
  const chunks: string[][] = []
  for (let i = 0; i < addresses.length; i += 30)
    chunks.push(addresses.slice(i, i + 30))
  const results = await Promise.all(
    chunks.map(chunk => fetchPairs(`/latest/dex/pairs/arc/${chunk.join(',')}`))
  )
  return results.flat()
}

// Top pools from GeckoTerminal (for New / Graduated tabs — GT has lifecycle data)
export async function getNewPools(): Promise<DexPair[]> {
  const res = await fetch(`/api/gecko?path=${encodeURIComponent('/networks/arc/new_pools')}&include=base_token,dex&page=1`)
  if (!res.ok) return []
  type GeckoResp = { data: GeckoPool[]; included: GeckoIncluded[] }
  const d: GeckoResp = await res.json() as GeckoResp
  return geckoToDex(d.data ?? [], d.included ?? [])
}

export async function getGraduatedPools(): Promise<DexPair[]> {
  // GeckoTerminal "trending" with high volume = graduated tokens
  const res = await fetch(`/api/gecko?path=${encodeURIComponent('/networks/arc/trending_pools')}&include=base_token,dex&page=1`)
  if (!res.ok) return []
  type GeckoResp = { data: GeckoPool[]; included: GeckoIncluded[] }
  const d: GeckoResp = await res.json() as GeckoResp
  return geckoToDex(d.data ?? [], d.included ?? []).filter(p => (p.volume?.h24 ?? 0) > 50000)
}

// ── GeckoTerminal → DexPair adapter ──────────────────────────────────
interface GeckoPool {
  id: string
  attributes: {
    address: string
    name: string
    base_token_price_usd: string
    fdv_usd: string
    market_cap_usd: string | null
    price_change_percentage: { m5: string; h1: string; h6: string; h24: string }
    volume_usd: { m5: string; h1: string; h6: string; h24: string }
    reserve_in_usd: string
    pool_created_at: string
    transactions: { m5: {buys:number;sells:number}; h1: {buys:number;sells:number}; h6: {buys:number;sells:number}; h24: {buys:number;sells:number} }
  }
  relationships: {
    base_token?: { data: { id: string } }
    quote_token?: { data: { id: string } }
    dex?: { data: { id: string } }
  }
}
interface GeckoIncluded {
  id: string; type: string
  attributes: { address: string; name: string; symbol: string; image_url?: string; decimals?: number }
}

function geckoToDex(pools: GeckoPool[], included: GeckoIncluded[]): DexPair[] {
  const tokenMap = new Map(included.filter(i => i.type === 'token').map(i => [i.id, i]))
  const dexMap   = new Map(included.filter(i => i.type === 'dex').map(i => [i.id, i]))

  return pools.map(p => {
    const attr = p.attributes
    const baseId  = p.relationships.base_token?.data.id ?? ''
    const quoteId = p.relationships.quote_token?.data.id ?? ''
    const dexId   = p.relationships.dex?.data.id ?? 'unknown'
    const base  = tokenMap.get(baseId)
    const quote = tokenMap.get(quoteId)
    const dex   = dexMap.get(dexId)

    const nameParts = attr.name.split(' / ')
    return {
      chainId:     'arc',
      dexId:       dex?.attributes?.name ?? dexId,
      pairAddress: attr.address,
      baseToken:   { address: base?.attributes?.address ?? '', name: nameParts[0] ?? '', symbol: base?.attributes?.symbol ?? nameParts[0] ?? '' },
      quoteToken:  { address: quote?.attributes?.address ?? '', name: nameParts[1] ?? '', symbol: quote?.attributes?.symbol ?? nameParts[1] ?? '' },
      priceUsd:    attr.base_token_price_usd,
      priceChange: { m5: Number(attr.price_change_percentage.m5 ?? 0), h1: Number(attr.price_change_percentage.h1 ?? 0), h6: Number(attr.price_change_percentage.h6 ?? 0), h24: Number(attr.price_change_percentage.h24 ?? 0) },
      volume:      { m5: Number(attr.volume_usd.m5 ?? 0), h1: Number(attr.volume_usd.h1 ?? 0), h6: Number(attr.volume_usd.h6 ?? 0), h24: Number(attr.volume_usd.h24 ?? 0) },
      liquidity:   { usd: Number(attr.reserve_in_usd ?? 0), base: 0, quote: 0 },
      txns:        attr.transactions,
      fdv:         Number(attr.fdv_usd ?? 0),
      marketCap:   attr.market_cap_usd ? Number(attr.market_cap_usd) : null,
      pairCreatedAt: new Date(attr.pool_created_at).getTime(),
      info: base?.attributes?.image_url ? { imageUrl: base.attributes.image_url } : undefined,
    } satisfies DexPair
  })
}
