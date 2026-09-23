// ARCDEX — RadarDex + Arc launchpad API aggregator
// All requests proxied through /api/radar to fix CORS

export interface ArcToken {
  address:        string
  symbol:         string
  name:           string
  decimals:       number
  logoUrl:        string
  price:          number    // USDC
  priceChange24h: number    // %
  volume24h:      number    // USDC
  marketCap:      number    // USDC
  liquidity:      number    // USDC
  ageMs:          number    // ms since deploy
  launchpad:      string    // 'Argus' | 'RadarDex' | 'Tolly' | 'Warp' | 'Archemist' | ...
  poolAddress:    string
  txCount24h:     number
  holderCount:    number
  buys24h:        number
  sells24h:       number
  verified:       boolean
  website?:       string
  twitter?:       string
  telegram?:      string
}

export interface OhlcvCandle {
  time:   number
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

export interface Trade {
  txHash:    string
  type:      'buy' | 'sell'
  amountIn:  number
  amountOut: number
  price:     number
  timestamp: number
  maker:     string
}

export function getLaunchpadColor(lp: string): string {
  switch (lp?.toLowerCase()) {
    case 'argus':       return '#7c3aed'
    case 'radardex':    return '#2563eb'
    case 'tolly':       return '#059669'
    case 'warp':        return '#f59e0b'
    case 'archemist':   return '#d97706'
    case 'arcpad':      return '#e11d48'
    case 'minara':      return '#06b6d4'
    case 'pegd':        return '#84cc16'
    default:            return '#475569'
  }
}

// Normalise launchpad label from RadarDex raw value
function normaliseLaunchpad(raw: string | null | undefined): string {
  if (!raw) return 'RadarDex'
  const l = raw.toLowerCase().trim()
  if (l.includes('argus'))    return 'Argus'
  if (l.includes('tolly'))    return 'Tolly'
  if (l.includes('warp'))     return 'Warp'
  if (l.includes('archemist')) return 'Archemist'
  if (l.includes('arcpad'))   return 'ArcPad'
  if (l.includes('minara'))   return 'Minara'
  if (l.includes('pegd'))     return 'PEGD'
  return raw.trim() || 'RadarDex'
}

// Proxy base — all calls go to /api/radar?path=<path>&<other params>
const PROXY = '/api/radar'

let tokenCache: ArcToken[] | null = null
let tokenCacheTs = 0
const CACHE_TTL = 30_000

interface RadarToken {
  address:        string
  symbol:         string
  name:           string
  decimals?:      number
  icon?:          string
  price?:         number
  change24h?:     number
  volume24?:      number
  volume24hFixed?: number
  mcap?:          number
  liquidityUsdc?: number
  firstSeen?:     number
  deployTs?:      number
  txns24?:        number
  launchpad?:     string | null
  buys24?:        number
  sells24?:       number
  holderCount?:   number
  verified?:      boolean
  launched?:      boolean
  website?:       string
  twitter?:       string
  telegram?:      string
}

function mapRadarToken(t: RadarToken): ArcToken {
  const ageMs = t.deployTs
    ? Date.now() - t.deployTs * 1000
    : t.firstSeen
      ? Date.now() - t.firstSeen * 1000
      : 0

  return {
    address:        t.address,
    symbol:         t.symbol,
    name:           t.name,
    decimals:       t.decimals ?? 18,
    logoUrl:        t.icon ?? '',
    price:          t.price ?? 0,
    priceChange24h: t.change24h ?? 0,
    volume24h:      t.volume24hFixed ?? t.volume24 ?? 0,
    marketCap:      t.mcap ?? 0,
    liquidity:      t.liquidityUsdc ?? 0,
    ageMs,
    launchpad:      normaliseLaunchpad(t.launchpad),
    poolAddress:    '',
    txCount24h:     t.txns24 ?? 0,
    holderCount:    t.holderCount ?? 0,
    buys24h:        t.buys24 ?? 0,
    sells24h:       t.sells24 ?? 0,
    verified:       t.verified ?? false,
    website:        t.website,
    twitter:        t.twitter,
    telegram:       t.telegram,
  }
}

// Fetch ALL tokens — paginate in batches of 200 until exhausted
async function fetchAllRadarTokens(): Promise<ArcToken[]> {
  const all: ArcToken[] = []
  let offset = 0
  const batchSize = 200

  while (true) {
    const url = `${PROXY}?path=/tokens&chain=arc&limit=${batchSize}&offset=${offset}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) break
    const data = await res.json() as { tokens?: RadarToken[] }
    const batch = data.tokens ?? []
    all.push(...batch.map(mapRadarToken))
    if (batch.length < batchSize) break   // last page
    offset += batchSize
    if (all.length >= 5000) break         // safety cap
  }

  return all
}

export async function getTokens(forceRefresh = false): Promise<ArcToken[]> {
  if (!forceRefresh && tokenCache && Date.now() - tokenCacheTs < CACHE_TTL) {
    return tokenCache
  }
  const tokens  = await fetchAllRadarTokens()
  tokenCache    = tokens
  tokenCacheTs  = Date.now()
  return tokens
}

export async function getToken(address: string): Promise<ArcToken | null> {
  try {
    const url = `${PROXY}?path=/tokens&chain=arc&address=${address}`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (res.ok) {
      const data = await res.json() as { tokens?: RadarToken[] }
      if (data.tokens?.[0]) return mapRadarToken(data.tokens[0])
    }
  } catch { /* fall through */ }
  const tokens = await getTokens()
  return tokens.find(t => t.address.toLowerCase() === address.toLowerCase()) ?? null
}

export async function getOhlcv(
  tokenAddress: string,
  resolution: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '1h',
  limit = 200,
): Promise<OhlcvCandle[]> {
  try {
    const url = `${PROXY}?path=/candles&chain=arc&token=${tokenAddress}&resolution=${resolution}&limit=${limit}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('ohlcv failed')
    const data = await res.json() as { candles?: OhlcvCandle[] }
    return data.candles ?? generateMockCandles(limit)
  } catch {
    return generateMockCandles(limit)
  }
}

function generateMockCandles(limit: number): OhlcvCandle[] {
  const candles: OhlcvCandle[] = []
  let price = 0.01 + Math.random() * 0.5
  const now = Math.floor(Date.now() / 1000)
  for (let i = limit; i >= 0; i--) {
    const change = (Math.random() - 0.48) * 0.04 * price
    const open = price
    price = Math.max(0.0001, price + change)
    const high = Math.max(open, price) * (1 + Math.random() * 0.01)
    const low  = Math.min(open, price) * (1 - Math.random() * 0.01)
    candles.push({ time: now - i * 3600, open, high, low, close: price, volume: Math.random() * 1000 })
  }
  return candles
}

export async function getTrades(tokenAddress: string, limit = 30): Promise<Trade[]> {
  try {
    const url = `${PROXY}?path=/v1/trades&chain=arc&token=${tokenAddress}&limit=${limit}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('trades failed')
    const data = await res.json() as { trades?: Trade[] }
    return data.trades ?? []
  } catch {
    return []
  }
}

export async function getPlatformStats(): Promise<{
  tokenCount: number; volume24h: number; marketCap: number; liquidity: number
}> {
  try {
    const url = `${PROXY}?path=/stats&chain=arc`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) throw new Error('stats failed')
    const d = await res.json() as {
      tokenCount?: number; volume24h?: number; marketCap?: number; liquidity?: number
    }
    return {
      tokenCount: d.tokenCount ?? 0,
      volume24h:  d.volume24h  ?? 0,
      marketCap:  d.marketCap  ?? 0,
      liquidity:  d.liquidity  ?? 0,
    }
  } catch {
    // Compute from cached tokens if stats endpoint fails
    const tokens = tokenCache ?? []
    return {
      tokenCount: tokens.length,
      volume24h:  tokens.reduce((s, t) => s + t.volume24h, 0),
      marketCap:  tokens.reduce((s, t) => s + t.marketCap, 0),
      liquidity:  tokens.reduce((s, t) => s + t.liquidity, 0),
    }
  }
}
