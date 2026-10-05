// Solana wallets on ARCDEX (owner, 2026-10-04: "trading wallet + Phantom"):
//   • the trading wallet's own Solana address, derived from its key (embeddedWallet.ts `solanaSeed`): one passcode,
//     one-tap trades, no pop-ups. It exists only while the trading wallet is unlocked.
//   • a Solana wallet app: Phantom, Solflare or Backpack (their injected providers), which confirms every trade.
// Buying a Solana coin needs only a Solana address to deliver to (it's signed on Arc); selling is signed by the
// wallet holding the coin.

import { useEffect, useState } from 'react'
import type { VersionedTransaction } from '@solana/web3.js'
import { base58 } from '../../../api/_solCore'
import { accountOwner, isUnlocked, lock, solanaSeed, WALLET_EVENT } from './embeddedWallet'

export type SolSigner = 'trading' | 'external'

interface InjectedProvider {
  isPhantom?: boolean; isSolflare?: boolean; isBackpack?: boolean
  publicKey?: { toString(): string } | null
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>
  disconnect(): Promise<void>
  signTransaction<T>(tx: T): Promise<T>
  /** Phantom answers { signature }; Solflare and Backpack the bytes, or { signature } too. */
  signMessage?(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<Uint8Array | { signature: Uint8Array }>
  on?(event: string, cb: (...a: unknown[]) => void): void
}

interface SolWindow { phantom?: { solana?: InjectedProvider }; solflare?: InjectedProvider; backpack?: { solana?: InjectedProvider } }

/** The Solana wallet apps this browser has, by name. */
export function solanaProviders(): { name: string; provider: InjectedProvider }[] {
  if (typeof window === 'undefined') return []
  const w = window as unknown as SolWindow
  const out: { name: string; provider: InjectedProvider }[] = []
  if (w.phantom?.solana?.isPhantom) out.push({ name: 'Phantom', provider: w.phantom.solana })
  if (w.solflare?.isSolflare) out.push({ name: 'Solflare', provider: w.solflare })
  if (w.backpack?.solana) out.push({ name: 'Backpack', provider: w.backpack.solana })
  return out
}

// ── state ────────────────────────────────────────────────────────────────

const EVENT = 'arcdex:solana-wallet'
const PICK_KEY = 'arcdex:sol-wallet'
let tradingAddress: string | null = null
/** Which Solana wallet trades when both are there (the trade forms and the wallet bar share it). */
let picked: SolSigner | null = null
export function pickSolSigner(who: SolSigner) { picked = who; tell() }
let external: { name: string; address: string; provider: InjectedProvider } | null = null
const tell = () => { try { window.dispatchEvent(new Event(EVENT)) } catch { /* non-browser */ } }

/** The trading wallet's Solana address (null while it's locked). */
async function refreshTrading() {
  // ed25519 is loaded only when there's a key to derive from, so the app's first load doesn't carry it.
  // A Solana wallet's own ARCDEX account has no derived Solana address: the wallet itself trades there.
  const next = isUnlocked() && !accountOwner() ? base58((await import('@noble/curves/ed25519')).ed25519.getPublicKey(await solanaSeed())) : null
  if (next !== tradingAddress) { tradingAddress = next; tell() }
}

if (typeof window !== 'undefined') {
  window.addEventListener(WALLET_EVENT, () => { void refreshTrading().catch(() => { tradingAddress = null; tell() }) })
  void refreshTrading().catch(() => {})
  // The wallet app picked before: reconnected only if it already trusts this site (no pop-up).
  setTimeout(() => {
    let name: string | null = null
    try { name = localStorage.getItem(PICK_KEY) } catch { /* blocked */ }
    const p = name ? solanaProviders().find(x => x.name === name) : undefined
    if (p) void connectSolanaWallet(p.name, true).catch(() => {})
  }, 400)
}

/** Connects a Solana wallet app (`silent`: only if it already trusts this site). */
export async function connectSolanaWallet(name: string, silent = false): Promise<string> {
  const p = solanaProviders().find(x => x.name === name)
  if (!p) throw new Error(`${name} isn't installed in this browser`)
  const res = await p.provider.connect(silent ? { onlyIfTrusted: true } : undefined)
  const key = (res && 'publicKey' in res ? res.publicKey : undefined) ?? p.provider.publicKey
  const address = key?.toString()
  if (!address) throw new Error(`${name} didn't share an address`)
  external = { name, address, provider: p.provider }
  // An ARCDEX account open for another Solana wallet closes: it's that wallet's, not this one's.
  if (accountOwner() && accountOwner() !== address) lock()
  try { localStorage.setItem(PICK_KEY, name) } catch { /* blocked */ }
  p.provider.on?.('accountChanged', (k: unknown) => {
    const a = (k as { toString(): string } | null)?.toString()
    if (external?.provider === p.provider) { external = a ? { ...external, address: a } : null; tell() }
    // Another wallet in the app: the ARCDEX account of the one before closes.
    if (accountOwner() && accountOwner() !== a) lock()
  })
  p.provider.on?.('disconnect', () => {
    if (external?.provider === p.provider) { external = null; tell() }
    if (accountOwner()) lock()
  })
  tell()
  return address
}

/** Where to get Phantom: on a phone, this page opened inside Phantom's own browser (which has the wallet); else its site. */
export function phantomLink(): string {
  if (typeof window === 'undefined') return 'https://phantom.app'
  if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'https://phantom.app/download'
  return `https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}?ref=${encodeURIComponent(window.location.origin)}`
}

export async function disconnectSolanaWallet(): Promise<void> {
  const e = external
  external = null
  // Its ARCDEX account closes with it.
  if (accountOwner()) lock()
  try { localStorage.removeItem(PICK_KEY) } catch { /* blocked */ }
  tell()
  await e?.provider.disconnect().catch(() => {})
}

export interface SolanaWallets {
  /** The trading wallet's Solana address, while it's unlocked. */
  trading: string | null
  /** The connected Solana wallet app. */
  external: { name: string; address: string } | null
  /** Wallet apps installed in this browser. */
  available: string[]
  /** The wallet picked to trade with, when both are there. */
  picked: SolSigner | null
}

export function useSolanaWallets(): SolanaWallets {
  const read = (): SolanaWallets => ({ trading: tradingAddress, external: external && { name: external.name, address: external.address }, available: solanaProviders().map(p => p.name), picked })
  const [s, set] = useState(read)
  useEffect(() => {
    const on = () => set(read())
    window.addEventListener(EVENT, on)
    window.addEventListener(WALLET_EVENT, on)
    on()
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener(WALLET_EVENT, on) }
  }, [])
  return s
}

/** The address a signer trades from. */
export const signerAddress = (who: SolSigner): string | null => (who === 'trading' ? tradingAddress : external?.address ?? null)

/** The connected Solana wallet app signs a message (its owner confirms in the app). */
export async function signSolanaMessage(message: Uint8Array): Promise<Uint8Array> {
  if (!external) throw new Error('Connect a Solana wallet first')
  if (!external.provider.signMessage) throw new Error(`${external.name} can't sign messages`)
  const res = await external.provider.signMessage(message, 'utf8')
  const sig = res instanceof Uint8Array ? res : res?.signature
  if (!(sig instanceof Uint8Array) && !Array.isArray(sig)) throw new Error(`${external.name} didn't sign`)
  return Uint8Array.from(sig as ArrayLike<number>)
}

/** Signs a transaction as `who`: the trading wallet signs here; a wallet app asks its owner. */
export async function signSolana(who: SolSigner, tx: VersionedTransaction): Promise<VersionedTransaction> {
  if (who === 'trading') {
    const { Keypair } = await import('@solana/web3.js')
    const kp = Keypair.fromSeed(await solanaSeed())
    if (kp.publicKey.toBase58() !== tradingAddress) throw new Error('The trading wallet changed: try again')
    tx.sign([kp])
    return tx
  }
  if (!external) throw new Error('Connect a Solana wallet first')
  return external.provider.signTransaction(tx)
}
