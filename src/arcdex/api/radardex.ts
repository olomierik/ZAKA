// ARCDEX — RadarDex API aggregator, all requests proxied via /api/radar

export interface ArcToken {
  address:         string
  symbol:          string
  name:            string
  decimals:        number
  logoUrl:         string
  price:           number
  priceChange5m:   number
  priceChange1h:   number
  priceChange24h:  number
  volume24h:       number
  marketCap:       number
  liquidity:       number
  ageMs:           number
  launchpad:       string
  poolAddress:     string
  txCount24h:      number
  holderCount:     number
  buys24h:         number
  sells24h:        number
  verified:        boolean
  graduated:       boolean
  bondingProgress: number | null   // 0-100 or null if already graduated
  spark:           number[]        // 16-point sparkline
  website?:        string
  twitter?:        string
  telegram?:       string
  deployer?:       string
  quoteSymbol:     string          // 'USDC' | 'EURC' | 'ARGUS' | ...
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
    case 'arcdex':     return '#3b82f6'
    case 'argus':      return '#7c3aed'
    case 'tolly':      return '#059669'
    case 'warp':       return '#f59e0b'
    case 'archemist':  return '#d97706'
    case 'arcpad':     return '#e11d48'
    case 'minara':     return '#06b6d4'
    case 'pegd':       return '#84cc16'
    case 'arc.fun':    return '#ec4899'
    case 'unknown':    return '#334155'
    default:           return '#475569'
  }
}

// RadarDex (the data aggregator we read from — not a launchpad) tells us
// the true origin launchpad for only a small fraction of tokens; the rest
// come back with `launchpad: null`. Verified directly against the live
// API: of 500 sampled tokens, 499 had launchpad === null and 1 had
// "arcfun". Labeling every null as "RadarDex" was actively wrong — that
// name belongs to the data source, not an on-chain launch venue, and
// claiming it as one for ~99.8% of tokens is exactly the kind of false
// attribution DexScreener-style terminals don't do. Show "Unknown"
// instead: honest about what we don't know, rather than a fabricated
// answer with a real name attached to it.
function normaliseLaunchpad(raw: string | null | undefined): string {
  if (!raw) return 'Unknown'
  const l = raw.toLowerCase().trim()
  if (l.includes('argus'))     return 'Argus'
  if (l.includes('tolly'))     return 'Tolly'
  if (l.includes('warp'))      return 'Warp'
  if (l.includes('archemist')) return 'Archemist'
  if (l.includes('arcpad'))    return 'ArcPad'
  if (l.includes('minara'))    return 'Minara'
  if (l.includes('pegd'))      return 'PEGD'
  if (l.includes('arcfun') || l.includes('arc.fun')) return 'Arc.fun'
  return raw.trim() || 'Unknown'
}

const PROXY = '/api/radar'

let tokenCache: ArcToken[] | null = null
let tokenCacheTs = 0
const CACHE_TTL = 15_000

interface RadarToken {
  address:         string
  symbol:          string
  name:            string
  decimals?:       number
  icon?:           string
  price?:          number
  change5m?:       number
  change1h?:       number
  change24h?:      number
  volume24?:       number
  volume24hFixed?: number
  mcap?:           number
  liquidityUsdc?:  number
  firstSeen?:      number
  deployTs?:       number
  txns24?:         number
  launchpad?:      string | null
  buys24?:         number
  sells24?:        number
  holderCount?:    number
  verified?:       boolean
  launched?:       boolean
  bondingProgress?: number | null
  spark?:          number[]
  website?:        string
  twitter?:        string
  telegram?:       string
  deployer?:       string
  quoteSymbols?:   string[]
  hasUsdc?:        boolean
  hasEusd?:        boolean
}

function mapRadarToken(t: RadarToken): ArcToken {
  const ageMs = t.deployTs
    ? Date.now() - t.deployTs * 1000
    : t.firstSeen
      ? Date.now() - t.firstSeen * 1000
      : 0

  const bp = t.bondingProgress ?? null
  const graduated = bp === null || bp >= 100 || t.launched === true

  // Primary quote — pick from quoteSymbols
  const quoteSymbol = (() => {
    const qs = (t.quoteSymbols ?? []).map(s => s.toUpperCase())
    if (qs.includes('USDC'))  return 'USDC'
    if (qs.includes('EURC'))  return 'EURC'
    if (qs.includes('ARGUS')) return 'ARGUS'
    if (qs.includes('XAUM'))  return 'XAUM'
    return qs[0] ?? 'USDC'
  })()

  return {
    address:         t.address,
    symbol:          t.symbol,
    name:            t.name,
    decimals:        t.decimals ?? 18,
    logoUrl:         t.icon ?? '',
    price:           t.price ?? 0,
    priceChange5m:   t.change5m ?? 0,
    priceChange1h:   t.change1h ?? 0,
    priceChange24h:  t.change24h ?? 0,
    volume24h:       t.volume24hFixed ?? t.volume24 ?? 0,
    marketCap:       t.mcap ?? 0,
    liquidity:       t.liquidityUsdc ?? 0,
    ageMs,
    launchpad:       normaliseLaunchpad(t.launchpad),
    poolAddress:     '',
    txCount24h:      t.txns24 ?? 0,
    holderCount:     t.holderCount ?? 0,
    buys24h:         t.buys24 ?? 0,
    sells24h:        t.sells24 ?? 0,
    verified:        t.verified ?? false,
    graduated,
    bondingProgress: graduated ? 100 : (bp ?? 0),
    spark:           t.spark ?? [],
    website:         t.website,
    twitter:         t.twitter,
    telegram:        t.telegram,
    deployer:        t.deployer,
    quoteSymbol,
  }
}

// Fetch first batch quickly (200), then load rest in background
export async function getTokens(forceRefresh = false): Promise<ArcToken[]> {
  if (!forceRefresh && tokenCache && Date.now() - tokenCacheTs < CACHE_TTL) {
    return tokenCache
  }

  // First batch — fast
  const first = await fetchBatch(0, 200)
  tokenCache   = first
  tokenCacheTs = Date.now()

  // Continue loading rest in background without blocking UI
  void fetchRemainingInBackground(200)

  return first
}

async function fetchBatch(offset: number, limit: number): Promise<ArcToken[]> {
  const url = `${PROXY}?path=/tokens&chain=arc&limit=${limit}&offset=${offset}`
  const res  = await fetch(url, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) return []
  const data = await res.json() as { tokens?: RadarToken[] }
  return (data.tokens ?? []).map(mapRadarToken)
}

async function fetchRemainingInBackground(startOffset: number): Promise<void> {
  let offset = startOffset
  while (true) {
    try {
      const batch = await fetchBatch(offset, 200)
      if (batch.length === 0) break
      tokenCache   = [...(tokenCache ?? []), ...batch]
      tokenCacheTs = Date.now()
      if (batch.length < 200) break
      offset += 200
      if (offset >= 5000) break
    } catch { break }
  }
}

export async function getToken(address: string): Promise<ArcToken | null> {
  try {
    const url = `${PROXY}?path=/tokens&chain=arc&address=${address}`
    const res  = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (res.ok) {
      const data = await res.json() as { tokens?: RadarToken[] }
      if (data.tokens?.[0]) return mapRadarToken(data.tokens[0])
    }
  } catch { /* fall through */ }
  const tokens = await getTokens()
  return tokens.find(t => t.address.toLowerCase() === address.toLowerCase()) ?? null
}

interface RadarTrade {
  hash?:      string
  txHash?:    string
  side?:      string
  type?:      string
  amountIn?:  number
  amountOut?: number
  price?:     number
  timestamp?: number
  time?:      number
  maker?:     string
  sender?:    string
  from?:      string
}

export async function getTrades(tokenAddress: string, limit = 50): Promise<Trade[]> {
  try {
    const url  = `${PROXY}?path=/v1/trades&chain=arc&token=${tokenAddress}&limit=${limit}`
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('trades')
    const data = await res.json() as { trades?: RadarTrade[] }
    return (data.trades ?? []).map(t => ({
      txHash:    t.txHash ?? t.hash ?? '',
      type:      (t.side ?? t.type ?? 'buy').toLowerCase().includes('sell') ? 'sell' : 'buy',
      amountIn:  t.amountIn  ?? 0,
      amountOut: t.amountOut ?? 0,
      price:     t.price     ?? 0,
      timestamp: t.timestamp ?? t.time ?? 0,
      maker:     t.maker ?? t.sender ?? t.from ?? '',
    }))
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
    if (!res.ok) throw new Error('stats')
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
    const tokens = tokenCache ?? []
    return {
      tokenCount: tokens.length,
      volume24h:  tokens.reduce((s, t) => s + t.volume24h, 0),
      marketCap:  tokens.reduce((s, t) => s + t.marketCap, 0),
      liquidity:  tokens.reduce((s, t) => s + t.liquidity, 0),
    }
  }
}
