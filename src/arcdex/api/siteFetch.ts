// The site's read functions (/api/argus, /api/gecko, /api/holders,
// /api/launchpad, /api/radar, /api/dex) are served by the market engine
// (engine/src/site/siteApi.ts) since 2026-10-02, when Vercel paused
// arcsense.site for the CPU these used there. This calls the engine first and
// the same path on the site (Vercel) only when the engine can't be reached
// (down, or an engine without these routes yet): the engine's answers,
// errors included, are final, so a throttled upstream never sends every
// visitor back to Vercel.

import { engineApiUrl } from './marketStream'

/** Engines older than the site functions answer 404 with no X-Arcdex-Served-By: those fall back too. */
export async function siteFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
