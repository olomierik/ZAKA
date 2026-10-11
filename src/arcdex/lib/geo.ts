// The visitor's country (ISO 3166 code) and, where the edge knows it, their state or province, from the site's edge
// (netlify/edge-functions/geo.ts). Unknown (local dev, an outage, a blocked request) is null, and callers treat it as
// not allowed.

interface Where { country: string | null; subdivision: string | null }

let pending: Promise<Where> | null = null

function where(): Promise<Where> {
  if (!pending) {
    pending = fetch('/geo', { cache: 'no-store' })
      .then(r => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j: { country?: unknown; subdivision?: unknown } | null) => ({
        country: typeof j?.country === 'string' && /^[A-Z]{2}$/.test(j.country) ? j.country : null,
        subdivision: typeof j?.subdivision === 'string' && /^[A-Z0-9]{1,3}$/.test(j.subdivision) ? j.subdivision : null,
      }))
      .catch(() => ({ country: null, subdivision: null }))
    // A failed lookup is asked again next time.
    void pending.then(w => { if (!w.country) pending = null })
  }
  // Local dev has no edge: a country can be set for trying the gates (?geo=XX or ?geo=XX-YY, or localStorage arcdex:dev-geo).
  if (import.meta.env.DEV) {
    const dev = new URLSearchParams(location.search).get('geo') ?? safeGet('arcdex:dev-geo')
    const m = dev ? /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/.exec(dev) : null
    if (m) return Promise.resolve({ country: m[1], subdivision: m[2] ?? null })
  }
  return pending
}

export function visitorCountry(): Promise<string | null> {
  return where().then(w => w.country)
}

export function visitorWhere(): Promise<Where> {
  return where()
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
