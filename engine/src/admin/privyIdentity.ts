// Admins by email (owner, 2026-10-17: "allow the user with email … to be admin"): someone signed in with Privy whose
// email is on the admin list signs in to /admin with one of that account's own wallets.
//
// The page sends Privy's identity token (a JWT Privy signs, ES256) with the usual signed sign-in message. The engine:
//   • checks the token against Privy's published keys for ARCDEX's own app (PRIVY_APP_ID, Privy's public app id),
//     its issuer, audience and expiry;
//   • reads the account's linked accounts from it: the email (email login, Google, Apple) must be an admin email, and the
//     wallet that signed the sign-in message must be one of the account's own wallets.
// So a token alone can't sign in (it needs the wallet's signature), and a wallet alone can't (it needs the email).
//
// Admin emails: ADMIN_EMAILS on Railway (comma-separated), and the owner's, kept here only as a SHA-256 hash (the repo
// is public). Identity tokens must be switched on in Privy's dashboard ("Return user data in an identity token").

import { createHash } from 'node:crypto'
import { errMsg, log } from '../log'

/** ARCDEX's Privy app (a public id: the site's pages carry it). */
export const DEFAULT_PRIVY_APP_ID = 'cmvac094l010r0gjyoqr36ooe'
/** The owner's email, hashed (SHA-256 of the lowercase address). */
const OWNER_EMAIL_HASHES = ['81fd388ced02b13b2b76674c44c49b4c0a605184e2ad62f2ffa3e6eaf79cad32']

export const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

export interface PrivyIdentity { userId: string; emails: string[]; wallets: string[] }

type Jwk = JsonWebKey & { kid?: string }
type Fetcher = (url: string) => Promise<Response>

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export interface PrivyIdentityOptions {
  appId: string
  /** Plain admin emails (ADMIN_EMAILS). */
  emails: readonly string[]
  /** Hashes of admin emails besides those; the owner's by default. */
  emailHashes?: readonly string[]
  fetcher?: Fetcher
  jwksTtlMs?: number
}

export class PrivyIdentityCheck {
  private keys: Jwk[] = []
  private keysAt = 0
  private hashes: Set<string>
  constructor(private o: PrivyIdentityOptions) {
    this.hashes = new Set([...(o.emailHashes ?? OWNER_EMAIL_HASHES), ...o.emails.map(emailHash)])
  }

  get configured() { return /^[a-z0-9]{16,40}$/.test(this.o.appId) && this.hashes.size > 0 }
  isAdminEmail(email: string) { return this.hashes.has(emailHash(email)) }

  private async jwks(now: number, force = false): Promise<Jwk[]> {
    if (!force && this.keys.length && now - this.keysAt < (this.o.jwksTtlMs ?? 3_600_000)) return this.keys
    const r = await (this.o.fetcher ?? fetch)(`https://auth.privy.io/api/v1/apps/${this.o.appId}/jwks.json`)
    if (!r.ok) throw new Error(`Privy's keys: HTTP ${r.status}`)
    const j = await r.json() as { keys?: Jwk[] }
    this.keys = (j.keys ?? []).filter(k => k.kty === 'EC' && k.crv === 'P-256')
    this.keysAt = now
    return this.keys
  }

  /** The account a valid identity token describes, or null. */
  async identity(token: string, now = Date.now()): Promise<PrivyIdentity | null> {
    if (typeof token !== 'string' || token.length > 16_000) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    let header: { alg?: string; kid?: string }, claims: Record<string, unknown>
    try { header = JSON.parse(b64(parts[0]).toString()); claims = JSON.parse(b64(parts[1]).toString()) } catch { return null }
    if (header.alg !== 'ES256') return null
    const exp = Number(claims.exp), iat = Number(claims.iat ?? 0)
    if (!Number.isFinite(exp) || exp * 1000 < now || iat * 1000 > now + 120_000) return null
    if (claims.iss !== 'privy.io') return null
    const aud = claims.aud
    if (!(aud === this.o.appId || (Array.isArray(aud) && aud.includes(this.o.appId)))) return null
    const verifyWith = async (keys: Jwk[]) => {
      for (const k of keys.filter(k => !header.kid || k.kid === header.kid)) {
        try {
          const key = await crypto.subtle.importKey('jwk', { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
          if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return true
        } catch { /* a key that isn't usable: try the next */ }
      }
      return false
    }
    let ok = false
    try {
      ok = await verifyWith(await this.jwks(now))
      if (!ok && header.kid && !this.keys.some(k => k.kid === header.kid)) ok = await verifyWith(await this.jwks(now, true))
    } catch (e) { log.warn('admin by email: Privy keys not read', { error: errMsg(e) }); return null }
    if (!ok) return null
    let linked: unknown = claims.linked_accounts
    if (typeof linked === 'string') { try { linked = JSON.parse(linked) } catch { linked = [] } }
    const emails: string[] = [], wallets: string[] = []
    for (const a of Array.isArray(linked) ? linked as Record<string, unknown>[] : []) {
      const type = String(a.type ?? '')
      if (type === 'email' && typeof a.address === 'string') emails.push(a.address.toLowerCase())
      if ((type === 'google_oauth' || type === 'apple_oauth') && typeof a.email === 'string') emails.push(a.email.toLowerCase())
      if ((type === 'wallet' || type === 'smart_wallet') && typeof a.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.address)) wallets.push(a.address.toLowerCase())
    }
    return { userId: String(claims.sub ?? ''), emails, wallets }
  }

  /** The admin email an identity token proves for `address`, or why not. */
  async adminEmailFor(token: string, address: string, now = Date.now()): Promise<{ email: string } | { error: string }> {
    const id = await this.identity(token, now)
    if (!id) return { error: 'Privy sign-in could not be checked; sign in with Privy again' }
    const email = id.emails.find(e => this.isAdminEmail(e))
    if (!email) return { error: 'this Privy account’s email is not an admin email' }
    if (!id.wallets.includes(address.toLowerCase())) return { error: 'sign with a wallet of the same Privy account' }
    return { email }
  }
}

/** ADMIN_EMAILS, comma-separated; malformed entries left out. */
export function adminEmails(list: string | undefined): string[] {
  return [...new Set((list ?? '').split(',').map(e => e.trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))]
}
