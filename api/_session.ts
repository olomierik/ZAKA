// Wallet sign-in sessions (server-only; underscore = not a Vercel route).
//
// A user proves they control an address by signing a short, human-readable
// message with that wallet (no gas, no transaction). /api/session checks
// the signature and returns a token: base64url(payload).base64url(HMAC).
// The token is bound to that one address and expires; it lets the browser
// make social writes (profile, follow, thesis, like) without asking the
// wallet to sign every single action.
//
// ARCDEX_SESSION_SECRET is a random server secret set in Vercel env.

declare const process: { env: Record<string, string | undefined> }

const SECRET = process.env.ARCDEX_SESSION_SECRET
export const sessionReady = Boolean(SECRET && SECRET.length >= 32)

const TOKEN_TTL_S = 30 * 24 * 3600
export const SIGN_IN_MAX_AGE_MS = 10 * 60 * 1000

const enc = new TextEncoder()
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

async function hmacKey() {
  return crypto.subtle.importKey('raw', enc.encode(SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function issueToken(address: string): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S
  const payload = b64url(enc.encode(JSON.stringify({ a: address.toLowerCase(), exp: expiresAt })))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload))
  return { token: `${payload}.${b64url(sig)}`, expiresAt }
}

/** The address a valid, unexpired token was issued to, else null. */
export async function verifyToken(token: string | null | undefined): Promise<string | null> {
  if (!sessionReady || !token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig), enc.encode(payload))
    if (!ok) return null
    const { a, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { a: string; exp: number }
    if (typeof a !== 'string' || !/^0x[0-9a-f]{40}$/.test(a) || exp < Date.now() / 1000) return null
    return a
  } catch {
    return null
  }
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

/** The exact message the client asks the wallet to sign. Kept identical
 * on both sides (src/arcdex/api/social.ts builds the same text). */
export function signInMessage(address: string, issuedAt: string, nonce: string): string {
  return [
    'Sign in to ARCDEX (arcdex.online)',
    '',
    'This only proves you own this wallet. It is not a transaction and costs nothing.',
    '',
    `Wallet: ${address.toLowerCase()}`,
    `Issued: ${issuedAt}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}
