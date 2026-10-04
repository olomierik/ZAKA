// The visitor's country (ISO 3166 code), from the site's edge (netlify/edge-functions/geo.ts).
// Unknown (local dev, an outage, a blocked request) is null, and callers treat it as not allowed.

let pending: Promise<string | null> | null = null

export function visitorCountry(): Promise<string | null> {
  if (!pending) {
    pending = fetch('/geo', { cache: 'no-store' })
      .then(r => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j: { country?: unknown } | null) => (typeof j?.country === 'string' && /^[A-Z]{2}$/.test(j.country) ? j.country : null))
      .catch(() => null)
    // A failed lookup is asked again next time.
    void pending.then(c => { if (!c) pending = null })
  }
  // Local dev has no edge: a country can be set for trying the gate (?geo=XX, or localStorage arcdex:dev-geo).
  if (import.meta.env.DEV) {
    const dev = new URLSearchParams(location.search).get('geo') ?? safeGet('arcdex:dev-geo')
    if (dev && /^[A-Z]{2}$/.test(dev)) return Promise.resolve(dev)
  }
  return pending
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
