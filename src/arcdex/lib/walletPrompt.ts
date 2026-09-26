// "Confirm in your wallet app" — shown while a WalletConnect wallet on a
// phone has a request waiting. A web page can't open the wallet app by
// itself after the fact (browsers only follow app links on a tap), so the
// prompt gives the user a button that does.

import { useSyncExternalStore } from 'react'

export interface WalletPrompt { walletName: string; href: string | null }

let current: WalletPrompt | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

export function showWalletPrompt(p: WalletPrompt) { current = p; emit() }
export function hideWalletPrompt() { current = null; emit() }

export function useWalletPrompt(): WalletPrompt | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => current)
}
