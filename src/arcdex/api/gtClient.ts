// GeckoTerminal from the browser. Tries the app's CDN-cached proxy first
// (one upstream call shared by every viewer); if that's throttled — the
// proxy runs on Vercel's shared IPs, which GeckoTerminal often 429s — it
// calls GeckoTerminal directly (it serves CORS: *) on the visitor's own
// per-IP quota.

import type { GtList } from '../../../api/_argusCore'

const DIRECT = 'https://api.geckoterminal.com/api/v2'
const HEADERS = { Accept: 'application/json;version=20230302' }

function withQuery(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  if (!qs) return path
  return path + (path.includes('?') ? '&' : '?') + qs
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// GeckoTerminal also has a burst limit: space direct calls out a little.
const MIN_GAP_MS = 350
let nextSlot = 0
async function paced() {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + MIN_GAP_MS
  if (at > now) await sleep(at - now)
}

async function direct<T>(pathWithQuery: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await paced()
    let res: Response
    try {
      res = await fetch(`${DIRECT}${pathWithQuery}`, { headers: HEADERS })
    } catch (e) {
      // A throttled response carries no CORS headers, so the browser
      // reports it as a network error rather than a 429 — retry it once
      // the same way.
      if (attempt === 0) { await sleep(2_000); continue }
      throw e
    }
    if (res.ok) return res.json() as Promise<T>
    if (res.status === 429 && attempt === 0) { await sleep(2_000); continue }
    throw new Error(`geckoterminal ${pathWithQuery.split('?')[0]} → ${res.status}`)
  }
}

export async function gtGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  try {
    const res = await fetch(`/api/gecko?${new URLSearchParams({ path, ...params })}`)
    if (res.ok) return await (res.json() as Promise<T>)
  } catch { /* fall through to direct */ }
  return direct<T>(withQuery(path, params))
}

/** Direct-only fetcher for rebuilding the Argus market list in-browser —
 * used exactly when the proxy side was throttled, so skip it. */
export const gtDirectFetcher = (path: string): Promise<GtList | null> => direct<GtList>(path).catch(() => null)
