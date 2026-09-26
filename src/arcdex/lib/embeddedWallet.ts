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
//
// Optional second factor (2FA): a passkey (Windows Hello, Touch ID / Face
// ID, Android, or a hardware security key). With it on, the AES key is
// derived from BOTH the passcode and a secret only the passkey can produce
// (WebAuthn PRF extension) — a stolen passcode alone, or the browser's
// storage alone, can't decrypt the wallet.

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createWalletClient, parseTransaction, type Hex, type NonceManager, type Transport } from 'viem'
import { getTransactionCount } from 'viem/actions'
import { arc } from '../wagmi'
import { arcTransport } from './rpc'

// ── nonces ─────────────────────────────────────────────────────────────
// After an approval confirms, the trade that follows is signed at once —
// and a load-balanced RPC node one block behind still reports the old
// transaction count. Signed with the approval's nonce, the trade is either
// rejected ("nonce too low") or, worse, accepted by that node and never
// mined. So a trading-wallet nonce is at least one past the last one this
// tab broadcast. (viem's own nonceManager can't catch this when that nonce
// was 0 — a new wallet's first approval — and it counts nonces whose
// broadcast failed, which would leave a gap.)

/** Highest nonce broadcast per wallet and chain, this tab. */
const broadcast = new Map<string, number>()
const nonceKey = (address: string, chainId: number) => `${address.toLowerCase()}:${chainId}`

const walletNonces: NonceManager = {
  async consume({ address, chainId, client }) {
    const fetched = await getTransactionCount(client, { address, blockTag: 'pending' })
    const sent = broadcast.get(nonceKey(address, chainId))
    return sent !== undefined && fetched <= sent ? sent + 1 : fetched
  },
  async get(p) { return this.consume(p) },
  increment() {},
  reset() {},
}

/** Wraps the trading wallet's transport: every transaction it broadcasts
 * is recorded, for the nonce of the next one. */
export function recordBroadcasts(inner: Transport): Transport {
  return (opts => {
    const t = inner(opts)
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      const res = await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options)
      if (args.method === 'eth_sendRawTransaction' && unlockedAccount) {
        try {
          const tx = parseTransaction((args.params as [Hex])[0])
          if (typeof tx.nonce === 'number' && typeof tx.chainId === 'number') {
            const k = nonceKey(unlockedAccount.address, tx.chainId)
            broadcast.set(k, Math.max(broadcast.get(k) ?? -1, tx.nonce))
          }
        } catch { /* not a transaction this wallet signed */ }
      }
      return res
    }) as typeof t.request
    return { ...t, request }
  }) as Transport
}

const account = (pk: Hex) => privateKeyToAccount(pk, { nonceManager: walletNonces })

const STORAGE_KEY = 'arcdex.embeddedWallet.v1'
const PBKDF2_ITERATIONS = 250_000

interface EncryptedBlob {
  v: 1 | 2       // 2 = passcode + passkey
  salt: string   // base64
  iv: string     // base64
  ciphertext: string // base64 — encrypts the raw 32-byte private key
  passkey?: { id: string; prfSalt: string } // v2: credential id (base64url) + PRF input (base64)
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
const b64url = (buf: ArrayBuffer) => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))

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

/** v2 key: HKDF over (PBKDF2(passcode) ‖ passkey PRF output). */
async function deriveKeyWithPasskey(passcode: string, salt: Uint8Array, prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits'])
  const pass = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 256))
  const ikm = new Uint8Array(pass.length + prf.byteLength)
  ikm.set(pass); ikm.set(new Uint8Array(prf), pass.length)
  const hk = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new TextEncoder().encode('arcdex-wallet-passkey-v2') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

async function encryptPrivateKey(privateKey: Hex, passcode: string, passkey?: { id: string; prfSalt: string; prf: ArrayBuffer }): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = passkey ? await deriveKeyWithPasskey(passcode, salt, passkey.prf) : await deriveKey(passcode, salt)
  const plaintext = new TextEncoder().encode(privateKey)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext)
  const blob: EncryptedBlob = { v: passkey ? 2 : 1, salt: toB64(salt.buffer), iv: toB64(iv.buffer), ciphertext: toB64(ciphertext) }
  if (passkey) blob.passkey = { id: passkey.id, prfSalt: passkey.prfSalt }
  return blob
}

/** Decrypts with the passcode — and, for a v2 wallet, asks for the passkey first. */
async function decryptPrivateKey(blob: EncryptedBlob, passcode: string): Promise<Hex> {
  const salt = fromB64(blob.salt)
  const iv = fromB64(blob.iv)
  const key = blob.v === 2 && blob.passkey
    ? await deriveKeyWithPasskey(passcode, salt, await passkeySecret(blob.passkey.id, fromB64(blob.passkey.prfSalt)))
    : await deriveKey(passcode, salt)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, fromB64(blob.ciphertext) as BufferSource)
  } catch {
    throw new Error('Wrong passcode')
  }
  return new TextDecoder().decode(plaintext) as Hex
}

// ── passkey (WebAuthn PRF) ─────────────────────────────────────────────
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }

function passkeyError(e: unknown): Error {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return new Error('Passkey check was cancelled or timed out')
  if (name === 'InvalidStateError') return new Error('This passkey is already registered')
  return e instanceof Error ? e : new Error('Passkey error')
}

/** The passkey's PRF output for this salt — needs the user's fingerprint/face/PIN. */
async function passkeySecret(id: string, prfSalt: Uint8Array): Promise<ArrayBuffer> {
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64url(id) as BufferSource }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (e) { throw passkeyError(e) }
  const out = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first
  if (!out) throw new Error('Your passkey could not unlock the wallet')
  return out
}

/** Whether this browser can protect the wallet with a passkey. 'maybe'
 * = can't tell until the user tries (older browsers don't report it). */
export async function passkeySupport(): Promise<'yes' | 'maybe' | 'no'> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) return 'no'
  const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities?.().catch(() => undefined)
  if (!caps) return 'maybe'
  return caps['extension:prf'] === false ? 'no' : caps['extension:prf'] ? 'yes' : 'maybe'
}

function storedBlob(): EncryptedBlob {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No wallet found — create one first')
  return JSON.parse(raw) as EncryptedBlob
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

/** True when unlocking needs a passkey as well as the passcode. */
export function hasPasskey(): boolean {
  try { return storedBlob().v === 2 } catch { return false }
}

/** Generate a brand-new wallet, encrypt it with `passcode`, persist it, and unlock it. */
export async function createWallet(passcode: string): Promise<`0x${string}`> {
  if (passcode.length < 6) throw new Error('Passcode must be at least 6 characters')
  const pk = generatePrivateKey()
  const blob = await encryptPrivateKey(pk, passcode)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  unlockedPrivateKey = pk
  unlockedAccount = account(pk)
  changed()
  return unlockedAccount.address
}

/** Encrypt and persist an externally-supplied key (import flow). */
export async function importPrivateKey(privateKey: string, passcode: string): Promise<`0x${string}`> {
  if (passcode.length < 6) throw new Error('Passcode must be at least 6 characters')
  const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex
  const imported = account(pk) // throws if malformed
  const blob = await encryptPrivateKey(pk, passcode)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  unlockedPrivateKey = pk
  unlockedAccount = imported
  changed()
  return imported.address
}

/** Decrypt the stored wallet into memory for this tab session (asks for
 * the passkey too when 2FA is on). */
export async function unlock(passcode: string): Promise<`0x${string}`> {
  const pk = await decryptPrivateKey(storedBlob(), passcode)
  unlockedPrivateKey = pk
  unlockedAccount = account(pk)
  changed()
  return unlockedAccount.address
}

/** Clear the decrypted key from memory. The encrypted blob stays on disk. */
export function lock(): void {
  unlockedPrivateKey = null
  unlockedAccount = null
  changed()
}

/** Re-enter passcode (and passkey, if on) to reveal the raw key for export/backup. Never logged. */
export async function exportPrivateKey(passcode: string): Promise<Hex> {
  return decryptPrivateKey(storedBlob(), passcode)
}

/** Turn on passkey 2FA: after this, unlocking needs the passcode AND the passkey. */
export async function enablePasskey(passcode: string): Promise<void> {
  const blob = storedBlob()
  if (blob.v === 2) throw new Error('Passkey protection is already on')
  const pk = await decryptPrivateKey(blob, passcode)
  const address = privateKeyToAccount(pk).address
  const prfSalt = crypto.getRandomValues(new Uint8Array(32))
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'ARCDEX' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'ARCDEX trading wallet ' + address.slice(0, 6) + '…' + address.slice(-4), displayName: 'ARCDEX trading wallet' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (e) { throw passkeyError(e) }
  if (!cred) throw new Error('No passkey was created')
  const ext = cred.getClientExtensionResults() as PrfResults
  if (!ext.prf?.enabled) throw new Error("This passkey can't protect a wallet (no PRF support). Try Windows Hello, iCloud Keychain, Google Password Manager or a recent security key.")
  const id = b64url(cred.rawId)
  // Some authenticators return the PRF output at creation; others only on use.
  const prf = ext.prf.results?.first ?? await passkeySecret(id, prfSalt)
  const next = await encryptPrivateKey(pk, passcode, { id, prfSalt: toB64(prfSalt.buffer), prf })
  // Prove the new blob opens before replacing the old one.
  const check = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(next.iv) as BufferSource },
    await deriveKeyWithPasskey(passcode, fromB64(next.salt), prf),
    fromB64(next.ciphertext) as BufferSource,
  )
  if (new TextDecoder().decode(check) !== pk) throw new Error('Passkey setup check failed — nothing was changed')
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  changed()
}

/** Turn passkey 2FA off (needs the passcode and the passkey one last time). */
export async function disablePasskey(passcode: string): Promise<void> {
  const blob = storedBlob()
  if (blob.v !== 2) return
  const pk = await decryptPrivateKey(blob, passcode)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(await encryptPrivateKey(pk, passcode)))
  changed()
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
  return createWalletClient({ account: unlockedAccount, chain: arc, transport: recordBroadcasts(arcTransport()) })
}
