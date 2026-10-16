// Wallets the signed-in wallet muted (engine/src/social/moderation.ts): their theses, comments and feed items are hidden
// for it. Kept on the engine (the same on every device), with a copy in this browser so the page hides them at once.

import { useEffect, useSyncExternalStore } from 'react'
import { getMyView, setMute } from '../api/social'
import type { Trader } from './identity'

let owner: string | null = null
let muted: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const KEY = (a: string) => `arcdex:mutes:${a}`

function publish(next: Iterable<string>) {
  muted = new Set([...next].map(a => a.toLowerCase()))
  if (owner) try { localStorage.setItem(KEY(owner), JSON.stringify([...muted])) } catch { /* storage blocked: kept for this visit */ }
  for (const l of listeners) l()
}

/** Loads the wallet's mutes (this browser's copy at once, then the engine's when it's signed in). */
function useOwner(address: string | null) {
  useEffect(() => {
    const a = address?.toLowerCase() ?? null
    if (a === owner) return
    owner = a
    let local: string[] = []
    if (a) try { local = JSON.parse(localStorage.getItem(KEY(a)) ?? '[]') as string[] } catch { local = [] }
    publish(Array.isArray(local) ? local.filter(x => typeof x === 'string') : [])
    if (a) void getMyView(a).then(v => { if (v && owner === a) publish(v.mutes) })
  }, [address])
}

/** The wallets `trader` muted, and a way to mute or unmute one (signs in first if needed). */
export function useMutes(trader: Trader) {
  useOwner(trader.address)
  const set = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => muted, () => muted)
  return {
    muted: set,
    isMuted: (address: string | null | undefined) => !!address && set.has(address.toLowerCase()),
    async toggle(address: string) {
      const a = address.toLowerCase()
      const on = !muted.has(a)
      const before = muted
      publish(on ? [...muted, a] : [...muted].filter(x => x !== a))
      try { publish((await setMute(trader, a, on)).mutes) } catch (e) { publish(before); throw e }
    },
  }
}
