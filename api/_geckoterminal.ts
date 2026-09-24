// Shared upstream config for /api/gecko and /api/argus. (The leading
// underscore keeps Vercel from deploying this file as its own function.)
//
// Default: GeckoTerminal's free public API (~30 calls/min, shared by IP —
// and Vercel's edge IPs are shared with other projects, so throttling is
// possible under load). Set COINGECKO_API_KEY in Vercel to switch to
// CoinGecko's paid on-chain API: same paths and response shapes (it *is*
// GeckoTerminal's data), with a dedicated rate limit.

declare const process: { env: Record<string, string | undefined> }

const KEY = process.env.COINGECKO_API_KEY

export const GT_BASE = KEY ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.geckoterminal.com/api/v2'

export function gtHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json;version=20230302', 'User-Agent': 'ARCDEX/1.0' }
  if (KEY) h['x-cg-pro-api-key'] = KEY
  return h
}
