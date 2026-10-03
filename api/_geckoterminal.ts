// Shared upstream for /api/gecko and /api/argus. (The leading
// underscore keeps Vercel from deploying this file as its own function.)
//
// Default: GeckoTerminal's free public API (~30 calls/min, shared by IP —
// and Vercel's edge IPs are shared with other projects, so throttling is
// possible under load). Set COINGECKO_API_KEY in Vercel to switch to
// CoinGecko's on-chain API: same paths and response shapes (it *is*
// GeckoTerminal's data — argus.world's source), with a dedicated rate limit.
//
// CoinGecko keys come in two kinds that look alike (both "CG-…"): Pro/paid
// keys work on pro-api.coingecko.com with x-cg-pro-api-key, Demo keys on
// api.coingecko.com with x-cg-demo-api-key. The key is tried as Pro, then as
// Demo; one neither accepts falls back to the free API, so a wrong or expired
// key can never take the market data down. A key whose plan has run out of
// credits (429 "monthly credit limit", code 10006; seen 2026-10-01, when it
// emptied the $ARCD card and every market list) is benched for 30 minutes and
// the free API answers meanwhile. Every response says which upstream served
// it (X-Arcdex-Upstream) — never the key.

declare const process: { env: Record<string, string | undefined> }

export type Upstream = 'coingecko-pro' | 'coingecko-demo' | 'geckoterminal'

const TIERS: Record<Upstream, { base: string; keyHeader?: string; next?: Upstream }> = {
  'coingecko-pro': { base: 'https://pro-api.coingecko.com/api/v3/onchain', keyHeader: 'x-cg-pro-api-key', next: 'coingecko-demo' },
  'coingecko-demo': { base: 'https://api.coingecko.com/api/v3/onchain', keyHeader: 'x-cg-demo-api-key', next: 'geckoterminal' },
  geckoterminal: { base: 'https://api.geckoterminal.com/api/v2' },
}

/** The upstream refused the key itself (as opposed to the request). */
async function keyRejected(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 401 && res.status !== 403) return false
  const text = await res.clone().text().catch(() => '')
  return /api[ _-]?key|root url|unauthori[sz]ed/i.test(text)
}

/** The key's plan has no credits left this month (nothing to do with the request). */
async function outOfCredits(res: Response): Promise<boolean> {
  if (res.status !== 429 && res.status !== 402) return false
  const text = await res.clone().text().catch(() => '')
  return /credit limit|10006|overage/i.test(text)
}

/** How long a key out of credits is left alone before it's tried again. */
export const OUT_OF_CREDITS_BENCH_MS = 30 * 60_000

export function createUpstream(rawKey: string | undefined, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const key = rawKey?.trim() || undefined
  let tier: Upstream = key ? 'coingecko-pro' : 'geckoterminal'
  let benchedUntil = 0
  return {
    upstream: () => (benchedUntil > now() ? 'geckoterminal' : tier),
    /** GET `path` (e.g. "/networks/arc/pools/0x…?include=base_token") from the current upstream. */
    async fetch(path: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
      for (;;) {
        const used: Upstream = benchedUntil > now() ? 'geckoterminal' : tier
        const t = TIERS[used]
        const headers: Record<string, string> = { Accept: 'application/json;version=20230302', 'User-Agent': 'ARCDEX/1.0' }
        if (t.keyHeader && key) headers[t.keyHeader] = key
        const res = await fetchImpl(`${t.base}${path}`, { headers, signal: init.signal })
        if (t.keyHeader && await outOfCredits(res)) {
          if (benchedUntil <= now()) console.warn(`COINGECKO_API_KEY is out of credits on ${used}; using the free GeckoTerminal API for ${OUT_OF_CREDITS_BENCH_MS / 60_000} minutes`)
          benchedUntil = now() + OUT_OF_CREDITS_BENCH_MS
          continue
        }
        if (!t.next || !(await keyRejected(res))) return res
        // Concurrent requests may all see the rejection: step down once.
        if (tier === used) {
          tier = t.next
          console.warn(`COINGECKO_API_KEY not accepted by ${used}; using ${tier}`)
        }
      }
    },
  }
}

// The market engine serves these functions too (engine/src/site): every visitor's calls then leave from its one IP,
// so it meters them (GeckoTerminal's free API allows ~30 a minute per IP) by plugging its own fetch in here.
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let impl: FetchLike = (input, init) => fetch(input, init)
export function setGtFetch(f: FetchLike | null) { impl = f ?? ((input, init) => fetch(input, init)) }

const gt = createUpstream(process.env.COINGECKO_API_KEY, ((input: RequestInfo | URL, init?: RequestInit) => impl(input, init)) as typeof fetch)
export const gtFetch = gt.fetch
export const gtUpstream = gt.upstream
