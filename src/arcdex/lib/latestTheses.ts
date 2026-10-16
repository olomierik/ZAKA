// The newest thesis on each coin, for the Trenches rows (owner, 2026-10-16: fomo's best features; fomo shows a "Latest
// thesis" on every coin of its list). One shared read of the newest theses every 60 seconds while a page shows them;
// theses hidden by moderation and banned wallets' are already left out (api/social.ts getTheses), and the caller leaves
// out muted wallets.

import { useEffect, useState } from 'react'
import { getTheses, type Thesis } from '../api/social'

export interface LatestThesis { body: string; author: string; at: number }

let cache: Map<string, LatestThesis> = new Map()
let at = 0
let inflight: Promise<void> | null = null
const listeners = new Set<(m: Map<string, LatestThesis>) => void>()

/** Newest thesis per coin (lower-case address) out of the newest `limit` theses. */
export function latestByToken(theses: Pick<Thesis, 'token' | 'body' | 'author' | 'created_at'>[]): Map<string, LatestThesis> {
  const out = new Map<string, LatestThesis>()
  for (const t of theses) {
    const k = String(t.token ?? '').toLowerCase()
    const when = Date.parse(t.created_at)
    const prev = out.get(k)
    if (!k || (prev && prev.at >= when)) continue
    out.set(k, { body: String(t.body ?? '').replace(/\s+/g, ' ').trim(), author: String(t.author ?? '').toLowerCase(), at: when })
  }
  return out
}

function refresh(): Promise<void> {
  if (inflight) return inflight
  inflight = getTheses({ limit: 300 })
    .then(list => { cache = latestByToken(list); at = Date.now(); for (const f of listeners) f(cache) })
    .catch(() => {})
    .finally(() => { inflight = null })
  return inflight
}

/** The newest thesis per coin, read every 60 seconds while mounted. */
export function useLatestTheses(): Map<string, LatestThesis> {
  const [m, setM] = useState(cache)
  useEffect(() => {
    listeners.add(setM)
    if (Date.now() - at > 60_000) void refresh()
    const id = setInterval(() => { if (!document.hidden) void refresh() }, 60_000)
    return () => { listeners.delete(setM); clearInterval(id) }
  }, [])
  return m
}
