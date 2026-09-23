const BASE = '/api/gecko'
const NET  = 'arc'

export interface GeckoPool {
  id:         string
  address:    string
  name:       string
  dexId:      string
  dexName:    string
  baseSymbol: string
  baseName:   string
  baseAddress:string
  logoUrl:    string | null
  priceUsd:   number
  priceChange: { m5: number; h1: number; h6: number; h24: number }
  volumeH24:  number
  liquidityUsd:number
  marketCapUsd:number | null
  fdvUsd:     number | null
  txns:       { buys: number; sells: number; buyers: number; sellers: number }
  poolCreatedAt: string
  reserveUsd: number
}

export interface GeckoTrade {
  txHash:      string
  txFrom:      string
  kind:        'buy' | 'sell'
  volumeUsd:   number
  fromAmount:  string
  toAmount:    string
  fromToken:   string
  toToken:     string
  timestamp:   string
  blockNumber: number
}

// DEX → launchpad display name map
const DEX_LABELS: Record<string, string> = {
  'argus':                'Argus',
  'minara-fun':           'Minara.fun',
  'radardex':             'RadarDex',
  'tolly-arc':            'Tolly',
  'warp-arc':             'Warp',
  'archemist-arc':        'Archemist',
  'o1-launchpad-arc':     'o1 Launchpad',
  'uniswap-v3-arc':       'Uniswap V3',
  'uniswap-v4-arc':       'Uniswap V4',
  'pegd-arc':             'PEGD',
}

export function dexLabel(dexId: string) {
  return DEX_LABELS[dexId.toLowerCase()] ?? dexId
}

export const LAUNCHPAD_COLORS: Record<string, string> = {
  'Argus':        '#7c3aed',
  'Minara.fun':   '#ec4899',
  'RadarDex':     '#3b82f6',
  'Tolly':        '#f59e0b',
  'Warp':         '#06b6d4',
  'Archemist':    '#10b981',
  'o1 Launchpad': '#f97316',
  'Uniswap V3':   '#ff007a',
  'Uniswap V4':   '#ff007a',
  'PEGD':         '#8b5cf6',
}

async function gecko<T>(path: string, params?: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ path, ...params })
  const res = await fetch(`${BASE}?${qs}`)
  if (!res.ok) throw new Error(`gecko ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

function parsePool(pool: { id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }, dexMap: Record<string, { id: string; name: string }>): GeckoPool {
  const a = pool.attributes as Record<string, unknown>
  const dexRel = (pool.relationships as Record<string, { data: { id: string } }> | undefined)?.dex?.data
  const dexId   = dexRel?.id ?? ''
  const dexInfo = dexMap[dexId]
  const txnsH1  = (a.transactions as Record<string, { buys: number; sells: number; buyers: number; sellers: number }>)?.h1 ?? { buys: 0, sells: 0, buyers: 0, sellers: 0 }
  const pc      = a.price_change_percentage as Record<string, string> ?? {}
  const baseToken = (a.name as string).split('/')[0].trim()

  return {
    id:          pool.id,
    address:     a.address as string,
    name:        a.name as string,
    dexId:       dexId,
    dexName:     dexLabel(dexInfo?.name ?? dexId),
    baseSymbol:  baseToken.replace(/[^A-Z0-9$]/gi, ''),
    baseName:    baseToken,
    baseAddress: '',
    logoUrl:     null,
    priceUsd:    parseFloat(a.base_token_price_usd as string ?? '0') || 0,
    priceChange: {
      m5:  parseFloat(pc.m5  ?? '0') || 0,
      h1:  parseFloat(pc.h1  ?? '0') || 0,
      h6:  parseFloat(pc.h6  ?? '0') || 0,
      h24: parseFloat(pc.h24 ?? '0') || 0,
    },
    volumeH24:   parseFloat((a.volume_usd as Record<string, string>)?.h24 ?? '0') || 0,
    liquidityUsd: parseFloat((a.reserve_in_usd as string) ?? '0') || 0,
    marketCapUsd: a.market_cap_usd ? parseFloat(a.market_cap_usd as string) : null,
    fdvUsd:       a.fdv_usd ? parseFloat(a.fdv_usd as string) : null,
    txns:         txnsH1,
    poolCreatedAt: a.pool_created_at as string ?? '',
    reserveUsd:   parseFloat((a.reserve_in_usd as string) ?? '0') || 0,
  }
}

function buildDexMap(included: { id: string; type: string; attributes: { name: string } }[]): Record<string, { id: string; name: string }> {
  const map: Record<string, { id: string; name: string }> = {}
  for (const item of included) {
    if (item.type === 'dex') map[item.id] = { id: item.id, name: item.attributes.name }
  }
  return map
}

export async function getTrendingPools(page = 1): Promise<GeckoPool[]> {
  const d = await gecko<{ data: { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }[]; included: { id: string; type: string; attributes: { name: string } }[] }>(
    `/networks/${NET}/trending_pools`, { page: String(page), include: 'dex' }
  )
  const dexMap = buildDexMap(d.included ?? [])
  return d.data.map(p => parsePool(p, dexMap))
}

export async function getNewPools(page = 1): Promise<GeckoPool[]> {
  const d = await gecko<{ data: { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }[]; included: { id: string; type: string; attributes: { name: string } }[] }>(
    `/networks/${NET}/new_pools`, { page: String(page), include: 'dex' }
  )
  const dexMap = buildDexMap(d.included ?? [])
  return d.data.map(p => parsePool(p, dexMap))
}

export async function getAllPools(page = 1): Promise<GeckoPool[]> {
  const d = await gecko<{ data: { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }[]; included: { id: string; type: string; attributes: { name: string } }[] }>(
    `/networks/${NET}/pools`, { page: String(page), include: 'dex', sort: 'h24_volume_usd_liquidity_desc' }
  )
  const dexMap = buildDexMap(d.included ?? [])
  return d.data.map(p => parsePool(p, dexMap))
}

export async function getPoolTrades(poolAddress: string): Promise<GeckoTrade[]> {
  const d = await gecko<{ data: { id: string; attributes: Record<string, unknown> }[] }>(
    `/networks/${NET}/pools/${poolAddress}/trades`
  )
  return d.data.map(t => {
    const a = t.attributes as Record<string, unknown>
    return {
      txHash:      a.tx_hash as string,
      txFrom:      a.tx_from_address as string,
      kind:        a.kind as 'buy' | 'sell',
      volumeUsd:   parseFloat(a.volume_in_usd as string ?? '0') || 0,
      fromAmount:  a.from_token_amount as string,
      toAmount:    a.to_token_amount as string,
      fromToken:   a.from_token_address as string,
      toToken:     a.to_token_address as string,
      timestamp:   a.block_timestamp as string,
      blockNumber: a.block_number as number,
    }
  })
}

export interface OhlcvCandle { time: number; open: number; high: number; low: number; close: number; volume: number }

type ChartRes = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

// GeckoTerminal buckets OHLCV as {timeframe: day|hour|minute} + an `aggregate`
// multiplier — map our chart-button resolutions onto that shape.
const RES_TO_GECKO: Record<ChartRes, { timeframe: 'day' | 'hour' | 'minute'; aggregate: number }> = {
  '1m':  { timeframe: 'minute', aggregate: 1 },
  '5m':  { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h':  { timeframe: 'hour',   aggregate: 1 },
  '4h':  { timeframe: 'hour',   aggregate: 4 },
  '1d':  { timeframe: 'day',    aggregate: 1 },
}

export async function getPoolOhlcv(poolAddress: string, resolution: ChartRes, limit = 200): Promise<OhlcvCandle[]> {
  const { timeframe, aggregate } = RES_TO_GECKO[resolution]
  const d = await gecko<{ data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } }>(
    `/networks/${NET}/pools/${poolAddress}/ohlcv/${timeframe}`,
    { aggregate: String(aggregate), limit: String(limit) }
  )
  const rows = d.data?.attributes?.ohlcv_list ?? []
  // GeckoTerminal returns newest-first; charts need ascending time order.
  return rows
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

export async function searchPools(query: string): Promise<GeckoPool[]> {
  const d = await gecko<{ data: { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }[]; included: { id: string; type: string; attributes: { name: string } }[] }>(
    `/search/pools`, { query, network: NET, include: 'dex' }
  )
  const dexMap = buildDexMap(d.included ?? [])
  return (d.data ?? []).map(p => parsePool(p, dexMap))
}
