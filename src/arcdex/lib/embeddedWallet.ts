// ── Embedded trading wallet ───────────────────────────────────────────
// A self-custody burner wallet generated and encrypted entirely in the
// browser — the same pattern used by terminal-style DEX front-ends
// (Photon, BullX, Trojan, etc.) for one-click trading without a wallet
// popup on every trade.
//
// The private key NEVER leaves this browser and is NEVER sent anywhere:
// it's generated locally, immediately encrypted with a key derived from
// the user's passcode (PBKDF2 → AES-GCM), and only the ciphertext is
// persisted (localStorage). The decrypted key lives only in memory for
// the current tab session and is cleared on lock/reload. This module has
// no network calls of its own.
//
// This is infrastructure for ARCDEX's own end users to self-custody a
// hot wallet for fast trading — not a place to store meaningful funds
// long-term. The UI must say so.

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createWalletClient, http, type Hex } from 'viem'
import { arc } from '../wagmi'

const STORAGE_KEY = 'arcdex.embeddedWallet.v1'
const PBKDF2_ITERATIONS = 250_000

interface EncryptedBlob {
  v: 1
  salt: string   // base64
  iv: string     // base64
  ciphertext: string // base64 — encrypts the raw 32-byte private key
}

let unlockedAccount: PrivateKeyAccount | null = null
let unlockedPrivateKey: Hex | null = null

// ── encoding helpers ───────────────────────────────────────────────────
function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}
function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

// ── key derivation ─────────────────────────────────────────────────────
async function deriveKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptPrivateKey(privateKey: Hex, passcode: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passcode, salt)
  const plaintext = new TextEncoder().encode(privateKey)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext)
  return { v: 1, salt: toB64(salt.buffer), iv: toB64(iv.buffer), ciphertext: toB64(ciphertext) }
}

async function decryptPrivateKey(blob: EncryptedBlob, passcode: string): Promise<Hex> {
  const salt = fromB64(blob.salt)
  const iv = fromB64(blob.iv)
  const key = await deriveKey(passcode, salt)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, fromB64(blob.ciphertext) as BufferSource)
  return new TextDecoder().decode(plaintext) as Hex
}

// ── public API ────────────────────────────────────────────────────────

/** Fired on window whenever the wallet is created, imported, unlocked,
 * locked or deleted, so UI that depends on it (identity, one-tap trading)
 * can re-read isUnlocked()/currentAddress(). */
export const WALLET_EVENT = 'arcdex:embedded-wallet'
const changed = () => { try { window.dispatchEvent(new Event(WALLET_EVENT)) } catch { /* non-browser */ } }

export function hasStoredWallet(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
}

export function isUnlocked(): boolean { return unlockedAccount !== null }

export function currentAddress(): `0x${string}` | null { return unlockedAccount?.address ?? null }

/** Generate a brand-new wallet, encrypt it with `passcode`, persist it, and unlock it. */
export async function createWallet(passcode: string): Promise<`0x${string}`> {
  if (passcode.length < 6) throw new Error('Passcode must be at least 6 characters')
  const pk = generatePrivateKey()
  const blob = await encryptPrivateKey(pk, passcode)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  unlockedPrivateKey = pk
  unlockedAccount = privateKeyToAccount(pk)
  changed()
  return unlockedAccount.address
}

/** Encrypt and persist an externally-supplied key (import flow). */
export async function importPrivateKey(privateKey: string, passcode: string): Promise<`0x${string}`> {
  if (passcode.length < 6) throw new Error('Passcode must be at least 6 characters')
  const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex
  const account = privateKeyToAccount(pk) // throws if malformed
  const blob = await encryptPrivateKey(pk, passcode)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  unlockedPrivateKey = pk
  unlockedAccount = account
  changed()
  return account.address
}

/** Decrypt the stored wallet into memory for this tab session. */
export async function unlock(passcode: string): Promise<`0x${string}`> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No wallet found — create one first')
  const blob = JSON.parse(raw) as EncryptedBlob
  let pk: Hex
  try {
    pk = await decryptPrivateKey(blob, passcode)
  } catch {
    throw new Error('Wrong passcode')
  }
  unlockedPrivateKey = pk
  unlockedAccount = privateKeyToAccount(pk)
  changed()
  return unlockedAccount.address
}

/** Clear the decrypted key from memory. The encrypted blob stays on disk. */
export function lock(): void {
  unlockedPrivateKey = null
  unlockedAccount = null
  changed()
}

/** Re-enter passcode to reveal the raw key for export/backup. Never logged. */
export async function exportPrivateKey(passcode: string): Promise<Hex> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No wallet found')
  const blob = JSON.parse(raw) as EncryptedBlob
  try {
    return await decryptPrivateKey(blob, passcode)
  } catch {
    throw new Error('Wrong passcode')
  }
}

/** Permanently deletes the stored wallet from this browser. Cannot be undone. */
export function deleteWallet(): void {
  localStorage.removeItem(STORAGE_KEY)
  lock()
}

/** A viem wallet client for the unlocked embedded account — signs and sends
 * directly, no external wallet popup. Throws if locked. */
export function getEmbeddedWalletClient() {
  if (!unlockedAccount || !unlockedPrivateKey) throw new Error('Wallet is locked')
  return createWalletClient({ account: unlockedAccount, chain: arc, transport: http(arc.rpcUrls.default.http[0]) })
}
