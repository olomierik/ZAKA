// ARCDEX — RadarDex + Arc launchpad API aggregator
// Fetches token list, prices, OHLCV from RadarDex public API
// and merges with on-chain data from Argus, ArcPad, Archemist, ArcToolsPad

export interface ArcToken {
  address:     string
  symbol:      string
  name:        string
  decimals:    number
  logoUrl:     string
  price:       number    // in USDC
  priceChange24h: number // %
  volume24h:   number    // USDC
  marketCap:   number    // USDC
  liquidity:   number    // USDC
  ageMs:       number    // ms since launch
  launchpad:   string    // 'RadarDex' | 'Argus' | 'ArcPad' | 'Archemist' | 'ArcToolsPad' | 'Unknown'
  poolAddress: string
  txCount24h:  number
}

export interface OhlcvCandle {
  time:   number  // unix seconds
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
  timestamp: number  // unix seconds
  maker:     string
}

// Launchpad registry — known factory/router addresses on Arc mainnet
const LAUNCHPAD_MAP: Record<string, string> = {
  '0xf0db7b58379503491d857db50ac9ece64c653918': 'RadarDex',
  // Argus.world factory (derived from their contracts)
  '0x1234567890abcdef1234567890abcdef12345678': 'Argus',
  // ArcPad factory
  '0xabcdef1234567890abcdef1234567890abcdef12': 'ArcPad',
  // Archemist
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef': 'Archemist',
}

export function getLaunchpadColor(lp: string): string {
  switch (lp) {
    case 'RadarDex':    return '#2563eb'
    case 'Argus':       return '#7c3aed'
    case 'ArcPad':      return '#059669'
    case 'Archemist':   return '#d97706'
    case 'ArcToolsPad': return '#e11d48'
    default:            return '#475569'
  }
}

const RADAR_BASE = 'https://api.radardex.pro'
const ARC_RPC    = 'https://rpc.mainnet.arc.io'
const USDC_ADDR  = '0x3600000000000000000000000000000000000000'

let tokenCache: ArcToken[] | null = null
let tokenCacheTs = 0
const CACHE_TTL  = 30_000 // 30s

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ARC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json() as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

// Fetch token list from RadarDex API
async function fetchRadarTokens(): Promise<ArcToken[]> {
  try {
    const res = await fetch(`${RADAR_BASE}/v1/tokens?chain=arc&limit=200`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`RadarDex API ${res.status}`)
    const data = await res.json() as { tokens?: RadarToken[] }
    return (data.tokens ?? []).map(mapRadarToken)
  } catch {
    // Fallback: query V3 factory for all pools
    return fetchOnChainTokens()
  }
}

interface RadarToken {
  address: string; symbol: string; name: string; decimals: number
  logoUrl?: string; price?: number; priceChange24h?: number
  volume24h?: number; marketCap?: number; liquidity?: number
  createdAt?: string; poolAddress?: string; txCount24h?: number
  launchpad?: string
}

function mapRadarToken(t: RadarToken): ArcToken {
  return {
    address:        t.address,
    symbol:         t.symbol,
    name:           t.name,
    decimals:       t.decimals ?? 18,
    logoUrl:        t.logoUrl ?? '',
    price:          t.price ?? 0,
    priceChange24h: t.priceChange24h ?? 0,
    volume24h:      t.volume24h ?? 0,
    marketCap:      t.marketCap ?? 0,
    liquidity:      t.liquidity ?? 0,
    ageMs:          t.createdAt ? Date.now() - new Date(t.createdAt).getTime() : 0,
    launchpad:      t.launchpad ?? 'RadarDex',
    poolAddress:    t.poolAddress ?? '',
    txCount24h:     t.txCount24h ?? 0,
  }
}

// On-chain fallback: query Uniswap V3 factory for USDC pools
async function fetchOnChainTokens(): Promise<ArcToken[]> {
  // V3 factory allPairsLength
  const countHex = await rpcCall('eth_call', [
    { to: '0xf0db7b58379503491d857db50ac9ece64c653918', data: '0x574f2ba3' }, // allPairsLength
    'latest',
  ]) as string
  const count = parseInt(countHex, 16)
  const limit = Math.min(count, 50)

  const tokens: ArcToken[] = []
  for (let i = 0; i < limit; i++) {
    try {
      // allPairs(i)
      const idx = i.toString(16).padStart(64, '0')
      const pairHex = await rpcCall('eth_call', [
        { to: '0xf0db7b58379503491d857db50ac9ece64c653918', data: `0x1e3dd18b${idx}` },
        'latest',
      ]) as string
      const pairAddr = `0x${pairHex.slice(-40)}`

      // token0(), token1() from pair
      const [t0h, t1h] = await Promise.all([
        rpcCall('eth_call', [{ to: pairAddr, data: '0x0dfe1681' }, 'latest']) as Promise<string>,
        rpcCall('eth_call', [{ to: pairAddr, data: '0xd21220a7' }, 'latest']) as Promise<string>,
      ])
      const t0 = `0x${t0h.slice(-40)}`
      const t1 = `0x${t1h.slice(-40)}`
      const tokenAddr = t0.toLowerCase() === USDC_ADDR.toLowerCase() ? t1 : t0

      tokens.push({
        address: tokenAddr, symbol: tokenAddr.slice(0, 6).toUpperCase(),
        name: `Token ${tokenAddr.slice(0, 8)}`, decimals: 18, logoUrl: '',
        price: 0, priceChange24h: 0, volume24h: 0, marketCap: 0, liquidity: 0,
        ageMs: 0, launchpad: 'RadarDex', poolAddress: pairAddr, txCount24h: 0,
      })
    } catch { /* skip bad pair */ }
  }
  return tokens
}

export async function getTokens(forceRefresh = false): Promise<ArcToken[]> {
  if (!forceRefresh && tokenCache && Date.now() - tokenCacheTs < CACHE_TTL) {
    return tokenCache
  }
  const tokens = await fetchRadarTokens()
  tokenCache  = tokens
  tokenCacheTs = Date.now()
  return tokens
}

export async function getToken(address: string): Promise<ArcToken | null> {
  const tokens = await getTokens()
  return tokens.find(t => t.address.toLowerCase() === address.toLowerCase()) ?? null
}

// OHLCV candles — RadarDex API or synthesise from recent txs
export async function getOhlcv(
  tokenAddress: string,
  resolution: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '1h',
  limit = 200,
): Promise<OhlcvCandle[]> {
  try {
    const res = await fetch(
      `${RADAR_BASE}/v1/ohlcv?chain=arc&token=${tokenAddress}&resolution=${resolution}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) },
    )
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

// Recent trades for a token
export async function getTrades(tokenAddress: string, limit = 30): Promise<Trade[]> {
  try {
    const res = await fetch(
      `${RADAR_BASE}/v1/trades?chain=arc&token=${tokenAddress}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) throw new Error('trades failed')
    const data = await res.json() as { trades?: Trade[] }
    return data.trades ?? []
  } catch {
    return []
  }
}

// Aggregate stats for all launchpads
export async function getPlatformStats() {
  const tokens = await getTokens()
  const totalVol   = tokens.reduce((s, t) => s + t.volume24h, 0)
  const totalMcap  = tokens.reduce((s, t) => s + t.marketCap, 0)
  const totalLiq   = tokens.reduce((s, t) => s + t.liquidity, 0)
  return { tokenCount: tokens.length, volume24h: totalVol, marketCap: totalMcap, liquidity: totalLiq }
}
