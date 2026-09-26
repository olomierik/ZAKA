// "How long ago", counting up live: seconds up to 60, then minutes, hours,
// days, months and years (12s, 5m, 3h, 2d, 4mo, 1y). Every trade age on the
// page ticks off one shared 1-second clock, so a list of a hundred trades
// is one timer, and only the age cells re-render.

import { useSyncExternalStore } from 'react'

export function agoShort(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.max(1, Math.floor(d / 30.44))
  if (mo < 12) return `${mo}mo`
  return `${Math.max(1, Math.floor(d / 365.25))}y`
}

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const subs = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => { now = Date.now(); subs.forEach(f => f()) }, 1000)
  }
  return () => {
    subs.delete(cb)
    if (!subs.size && timer) { clearInterval(timer); timer = null }
  }
}

// Before the clock runs (first render), a value that only changes once a second.
const snapshot = () => (timer ? now : (now = Math.floor(Date.now() / 1000) * 1000))

/** The current time, updated every second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
