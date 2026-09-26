// "Balances may have changed": sent when one of this app's transactions
// confirms (lib/receipts.ts), so every cash and coin balance on screen
// refreshes at once instead of on its next poll, 8–15s later.

const EVENT = 'arcdex:balances'

export function notifyBalances(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(EVENT))
  // Once more a moment later: Arc's load-balanced RPC can answer the first
  // read from a node that's a block behind.
  setTimeout(() => window.dispatchEvent(new Event(EVENT)), 1_200)
}

/** Calls `cb` whenever balances may have changed. Returns the unsubscribe. */
export function onBalances(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
