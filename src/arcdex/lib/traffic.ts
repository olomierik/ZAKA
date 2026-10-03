// The site's traffic counter (engine/src/traffic.ts): every open page of
// arcsense.site, the landing and the app, beats every 30 seconds while it's
// visible, with a random id this browser keeps (localStorage; no cookie, and
// nothing else about the visitor is sent). Each beat answers with the counts:
// online now, visitors today and ever.

export interface TrafficCounts { online: number; today: number; total: number }

const KEY = 'arcdex:visitor'
const BEAT_MS = 30_000
const ID = /^[A-Za-z0-9-]{16,64}$/

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

/** This browser's visitor id; a fresh one per page load where storage is blocked. */
function visitorId(): string {
  try {
    const have = localStorage.getItem(KEY)
    if (have && ID.test(have)) return have
    const id = newId()
    localStorage.setItem(KEY, id)
    return id
  } catch { return newId() }
}

const listeners = new Set<(c: TrafficCounts) => void>()
let last: TrafficCounts | null = null
let started = false

/** Starts this page's heartbeat (once per page). `engine`: the market engine's REST base; nothing without one. */
export function startTraffic(engine: string) {
  if (started || !engine || typeof window === 'undefined') return
  started = true
  const id = visitorId()
  const beat = () => {
    if (document.visibilityState !== 'visible') return
    // text/plain keeps it a simple request: no preflight.
    fetch(`${engine}/v1/traffic/beat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id }), keepalive: true })
      .then(r => (r.ok ? (r.json() as Promise<TrafficCounts>) : null))
      .then(c => {
        if (!c || typeof c.online !== 'number') return
        last = { online: c.online, today: c.today, total: c.total }
        for (const f of listeners) f(last)
      })
      .catch(() => { /* the engine is unreachable: no counts, nothing else changes */ })
  }
  beat()
  setInterval(beat, BEAT_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat() })
}

/** The counts as they arrive (at once if some already have). Returns the unsubscribe. */
export function onTraffic(f: (c: TrafficCounts) => void): () => void {
  listeners.add(f)
  if (last) f(last)
  return () => { listeners.delete(f) }
}
