// The site's read functions (/api/argus, /api/gecko, /api/holders,
// /api/launchpad, /api/radar, /api/dex) are served by the market engine
// (engine/src/site/siteApi.ts) since 2026-10-02, when Vercel paused
// arcsense.site for the CPU these used there. This calls the engine first and
// the same path on the site (Vercel) only when the engine can't be reached
// (down, or an engine without these routes yet): the engine's answers,
// errors included, are final, so a throttled upstream never sends every
// visitor back to Vercel.

import { engineApiUrl } from './marketStream'

/** Same-path GETs in flight (and for 1.5s after), shared (2026-10-05): a coin page asked for /api/argus and /api/gecko
 * two and three times at once from different parts of the page. Each caller gets its own copy of the answer, and its
 * own timeout or abort still ends its own wait. */
const inflight = new Map<string, Promise<Response>>()
const SHARE_MS = 1_500

const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

export async function siteFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if ((init.method ?? 'GET').toUpperCase() !== 'GET' || init.body || init.headers) return direct(path, init)
  let shared = inflight.get(path)
  if (!shared) {
    shared = direct(path, { ...init, signal: AbortSignal.timeout(30_000) })
    const p = shared
    void p.catch(() => {}).finally(() => setTimeout(() => { if (inflight.get(path) === p) inflight.delete(path) }, SHARE_MS))
    inflight.set(path, p)
  }
  const res = init.signal ? await Promise.race([shared, aborted(init.signal)]) : await shared
  return res.clone()
}

/** Engines older than the site functions answer 404 with no X-Arcdex-Served-By: those fall back too. */
async function direct(path: string, init: RequestInit = {}): Promise<Response> {
  if (engineApiUrl) {
    try {
      const res = await fetch(`${engineApiUrl}${path}`, init)
      if (res.status !== 404 || res.headers.get('X-Arcdex-Served-By')) return res
    } catch (e) {
      // A caller's own timeout or abort is final; only an unreachable engine falls back.
      if (init.signal?.aborted) throw e
    }
  }
  return fetch(path, init)
}
