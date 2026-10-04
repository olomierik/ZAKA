// GeckoTerminal from the browser. Tries the app's CDN-cached proxy first
// (one upstream call shared by every viewer); if that's throttled — the
// proxy runs on Vercel's shared IPs, which GeckoTerminal often 429s — it
// calls GeckoTerminal directly (it serves CORS: *) on the visitor's own
// per-IP quota.

import type { GtList } from '../../../api/_argusCore'
import { siteFetch } from './siteFetch'

const DIRECT = 'https://api.geckoterminal.com/api/v2'
const HEADERS = { Accept: 'application/json;version=20230302' }

function withQuery(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  if (!qs) return path
  return path + (path.includes('?') ? '&' : '?') + qs
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// GeckoTerminal's free tier is ~30 calls/min per IP with only a small
// burst allowance — measured in-browser, calls 350ms apart started failing
// after ~4. Pacing at its sustained rate avoids the failure + 2s-retry
// cycle, which was slower overall. (The market build streams its rows as
// each call lands, so the first ones still show within a second or two.)
const MIN_GAP_MS = 2_000
// One call every MIN_GAP_MS, urgent ones first: the page someone is looking
// at (a Robinhood coin's price, trades, chart) never waits behind a market
// list's dozen-plus calls.
const waiting: { urgent: boolean; go: () => void }[] = []
let lastGo = 0
let pump: ReturnType<typeof setTimeout> | null = null
function release() {
  pump = null
  if (!waiting.length) return
  const wait = lastGo + MIN_GAP_MS - Date.now()
  if (wait > 0) { pump = setTimeout(release, wait); return }
  const i = waiting.findIndex(w => w.urgent)
  const [next] = waiting.splice(i >= 0 ? i : 0, 1)
  lastGo = Date.now()
  next.go()
  if (waiting.length) pump = setTimeout(release, MIN_GAP_MS)
}
function paced(urgent = false): Promise<void> {
  return new Promise(go => { waiting.push({ urgent, go }); if (!pump) release() })
}

async function direct<T>(pathWithQuery: string, urgent = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await paced(urgent)
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

/** `proxyOnly`: for fast polling (the coin page's live trades), never fall
 * back to the visitor's own free-tier quota, which the rest of the page needs. */
export async function gtGet<T>(path: string, params: Record<string, string> = {}, opts: { proxyOnly?: boolean } = {}): Promise<T> {
  try {
    const res = await siteFetch(`/api/gecko?${new URLSearchParams({ path, ...params })}`)
    if (res.ok) return await (res.json() as Promise<T>)
    if (opts.proxyOnly) throw new Error(`gecko proxy ${res.status}`)
  } catch (e) { if (opts.proxyOnly) throw e /* else fall through to direct */ }
  return direct<T>(withQuery(path, params))
}

/** Direct-only fetcher for rebuilding the Argus market list in-browser —
 * used exactly when the proxy side was throttled, so skip it. */
export const gtDirectFetcher = (path: string): Promise<GtList | null> => direct<GtList>(path).catch(() => null)

/** Direct only, on the visitor's own quota: Robinhood Chain's data
 * (api/robinhoodMarket.ts). The app's proxy serves Arc's network only, and
 * its shared quota stays Arc's. */
export const gtDirect = <T>(path: string, params: Record<string, string> = {}, opts: { urgent?: boolean } = {}): Promise<T> =>
  direct<T>(withQuery(path, params), opts.urgent)
