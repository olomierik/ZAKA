// Starknet wallets (Argent X, Braavos, and any wallet that injects a `window.starknet_*` object), through the Starknet
// wallet API (github.com/starknet-io/types-js, src/wallet-api: wallet_requestAccounts, wallet_requestChainId,
// wallet_switchStarknetChain, wallet_addInvokeTransaction). The wallet signs; ARCDEX never sees a key.

import { useCallback, useEffect, useState } from 'react'
import { SN, type SnNetwork } from './net'
import { sameFelt } from './felt'
import type { AvnuCall } from './avnu'

export interface SnWallet {
  id: string
  name: string
  icon: string | { dark: string; light: string }
  request: (call: { type: string; params?: unknown }) => Promise<unknown>
  on?: (event: 'accountsChanged' | 'networkChanged', handler: (...a: unknown[]) => void) => void
  off?: (event: 'accountsChanged' | 'networkChanged', handler: (...a: unknown[]) => void) => void
}

export const iconOf = (w: SnWallet) => (typeof w.icon === 'string' ? w.icon : w.icon?.dark ?? '')

/** Where to get a wallet when none is installed. */
export const INSTALL = [
  { name: 'Ready (Argent X)', url: 'https://www.ready.co' },
  { name: 'Braavos', url: 'https://braavos.app/download-braavos-wallet/' },
]

/** The Starknet wallets this browser has: every `window.starknet*` object that speaks the wallet API. */
export function detectWallets(): SnWallet[] {
  if (typeof window === 'undefined') return []
  const out: SnWallet[] = []
  const seen = new Set<string>()
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!key.startsWith('starknet')) continue
    let o: unknown
    try { o = (window as unknown as Record<string, unknown>)[key] } catch { continue }
    const w = o as Partial<SnWallet> | null
    if (!w || typeof w !== 'object' || typeof w.request !== 'function' || typeof w.id !== 'string' || !w.id || seen.has(w.id)) continue
    seen.add(w.id)
    out.push(w as SnWallet)
  }
  return out
}

export class SnWalletError extends Error {}

/** The network a wallet's chain id means, or null for one ARCDEX doesn't use. */
export const networkOf = (chainId: unknown): SnNetwork | null => (sameFelt(chainId, SN.mainnet.chainId) ? 'mainnet' : sameFelt(chainId, SN.sepolia.chainId) ? 'sepolia' : null)

export async function connectWallet(w: SnWallet, silent = false): Promise<{ address: string; chainId: string }> {
  const accounts = (await w.request({ type: 'wallet_requestAccounts', params: silent ? { silent_mode: true } : {} })) as string[] | undefined
  const address = Array.isArray(accounts) ? accounts[0] : undefined
  if (!address) throw new SnWalletError('The wallet didn’t share an account.')
  const chainId = String(await w.request({ type: 'wallet_requestChainId' }))
  return { address, chainId }
}

/** Asks the wallet to move to a network; resolves once it says it has. */
export async function switchNetwork(w: SnWallet, net: SnNetwork): Promise<void> {
  const ok = await w.request({ type: 'wallet_switchStarknetChain', params: { chainId: SN[net].chainId } })
  if (ok === false) throw new SnWalletError('The wallet didn’t switch networks.')
  const now = await w.request({ type: 'wallet_requestChainId' })
  if (networkOf(now) !== net) throw new SnWalletError(`The wallet is still on another network (${String(now)}).`)
}

/** Has the wallet sign and send calls; the transaction hash comes back. */
export async function invoke(w: SnWallet, calls: AvnuCall[]): Promise<string> {
  const r = (await w.request({
    type: 'wallet_addInvokeTransaction',
    params: { calls: calls.map(c => ({ contract_address: c.contractAddress, entry_point: c.entrypoint, calldata: c.calldata })) },
  })) as { transaction_hash?: string } | undefined
  if (!r?.transaction_hash) throw new SnWalletError('The wallet didn’t return a transaction.')
  return r.transaction_hash
}

const LAST_KEY = 'arcdex:sn-wallet'

export interface SnSession { wallet: SnWallet; address: string; chainId: string; network: SnNetwork | null }

/** The connected Starknet wallet: reconnects the last one silently, follows account and network changes. */
export function useSnWallet() {
  const [wallets, setWallets] = useState<SnWallet[]>(() => detectWallets())
  const [session, setSession] = useState<SnSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Extensions can inject after the page loads: look again for a few seconds.
  useEffect(() => {
    let n = 0
    const id = setInterval(() => { setWallets(prev => { const now = detectWallets(); return now.length === prev.length ? prev : now }); if (++n >= 6) clearInterval(id) }, 500)
    return () => clearInterval(id)
  }, [])

  const connect = useCallback(async (w: SnWallet, silent = false) => {
    setError(null)
    try {
      const { address, chainId } = await connectWallet(w, silent)
      setSession({ wallet: w, address, chainId, network: networkOf(chainId) })
      try { localStorage.setItem(LAST_KEY, w.id) } catch { /* storage blocked */ }
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // The last wallet used, without a prompt.
  useEffect(() => {
    if (session) return
    let last: string | null = null
    try { last = localStorage.getItem(LAST_KEY) } catch { /* storage blocked */ }
    const w = last ? wallets.find(x => x.id === last) : undefined
    if (w) void connect(w, true)
  }, [wallets, session, connect])

  useEffect(() => {
    const w = session?.wallet
    if (!w?.on) return
    const onAccounts = (a: unknown) => {
      const address = Array.isArray(a) ? (a[0] as string | undefined) : undefined
      setSession(s => (s && address ? { ...s, address } : address ? s : null))
    }
    const onNetwork = (c: unknown) => { if (c) setSession(s => (s ? { ...s, chainId: String(c), network: networkOf(c) } : s)) }
    w.on('accountsChanged', onAccounts)
    w.on('networkChanged', onNetwork)
    return () => { w.off?.('accountsChanged', onAccounts); w.off?.('networkChanged', onNetwork) }
  }, [session?.wallet])

  const disconnect = useCallback(() => {
    setSession(null)
    try { localStorage.removeItem(LAST_KEY) } catch { /* storage blocked */ }
  }, [])

  /** Re-reads the wallet's network (after a switch). */
  const refresh = useCallback(async () => {
    const w = session?.wallet
    if (!w) return
    try {
      const chainId = String(await w.request({ type: 'wallet_requestChainId' }))
      setSession(s => (s ? { ...s, chainId, network: networkOf(chainId) } : s))
    } catch { /* keep what we had */ }
  }, [session?.wallet])

  return { wallets, session, error, connect, disconnect, refresh }
}
