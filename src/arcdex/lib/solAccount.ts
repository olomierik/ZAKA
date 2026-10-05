// The ARCDEX account of a Solana wallet (2026-10-05, owner: "Solana wallets connect, transact, swap and bridge; buy other
// chains' coins with SOL and USDC on Solana"; asked, the owner chose an account from the Solana wallet over a passcode
// wallet).
//
// A Solana wallet can't sign on Arc, BNB Chain or Robinhood Chain, so the coins a Solana user buys there are held by an
// EVM account of theirs: its key is derived from the wallet's signature of one fixed message (HKDF-SHA256 over the
// signature). Ed25519 signatures are deterministic, so the same wallet always gets the same account, on any device, with
// nothing stored but the open account in this tab (sessionStorage, cleared when the tab closes). dYdX derived its keys
// from a wallet signature the same way.
//
// The signature is the account's key: anyone who gets the wallet to sign this exact message has the account. The
// message names the site and says so, and it's only ever asked for here.

import { t as T } from './i18n'

export const SOL_ACCOUNT_VERSION = 1

/** What the Solana wallet signs to open its ARCDEX account. */
export function solAccountMessage(solAddress: string): string {
  return [
    'ARCDEX account',
    '',
    'Sign to open your ARCDEX account. It holds the coins you buy with this wallet on Arc, BNB Chain and Robinhood Chain.',
    '',
    'This signature is your account’s key. Only sign it on arcsense.site.',
    '',
    `Wallet: ${solAddress}`,
    `Version: ${SOL_ACCOUNT_VERSION}`,
  ].join('\n')
}

/** secp256k1's group order: a key must be below it (and not 0). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** The account's EVM private key from the wallet's signature (HKDF-SHA256, salt "arcdex"). */
export async function deriveAccountKey(signature: Uint8Array): Promise<`0x${string}`> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(signature), 'HKDF', false, ['deriveBits'])
  for (let i = 0; i < 8; i++) {
    const info = `arcdex:solana-account:secp256k1:v${SOL_ACCOUNT_VERSION}${i ? `:${i}` : ''}`
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('arcdex'), info: new TextEncoder().encode(info) }, key, 256))
    const hex = Array.from(bits, b => b.toString(16).padStart(2, '0')).join('')
    const n = BigInt('0x' + hex)
    if (n > 0n && n < N) return `0x${hex}`
  }
  throw new Error('No key could be derived')
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** A base58 Solana address as its 32 bytes. */
export function base58Decode(s: string): Uint8Array {
  let n = 0n
  for (const c of s) {
    const v = ALPHABET.indexOf(c)
    if (v < 0) throw new Error('Not a base58 address')
    n = n * 58n + BigInt(v)
  }
  const out: number[] = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const c of s) { if (c === '1') out.unshift(0); else break }
  return Uint8Array.from(out)
}

/** Opens the connected Solana wallet's ARCDEX account: the wallet signs the message (one pop-up), the signature is
 * checked against the wallet's own key, and the account is opened in this tab. Returns its EVM address. */
export async function openSolAccount(): Promise<`0x${string}`> {
  const { signSolanaMessage, signerAddress } = await import('./solanaWallet')
  const sol = signerAddress('external')
  if (!sol) throw new Error(T('Connect a Solana wallet first'))
  const msg = new TextEncoder().encode(solAccountMessage(sol))
  const sig = await signSolanaMessage(msg)
  const { ed25519 } = await import('@noble/curves/ed25519')
  if (sig.length !== 64 || !ed25519.verify(sig, msg, base58Decode(sol))) throw new Error(T('The wallet’s signature didn’t check out: try again'))
  const pk = await deriveAccountKey(sig)
  const { openAccountKey } = await import('./embeddedWallet')
  return openAccountKey(pk, sol)
}
