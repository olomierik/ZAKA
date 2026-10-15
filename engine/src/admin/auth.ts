// Admin sign-in (the build pack's Phase 4; 04: "nonce + domain + expiry (EIP-4361 style), short-lived session,
// allowlist from env, hardware-wallet signer, audit log").
//
//   POST /v1/admin/auth/nonce    {address}           → the exact message to sign (EIP-4361), built here, never by the page
//   POST /v1/admin/auth/verify   {nonce, signature}  → a session token (Authorization: Bearer …), ADMIN_SESSION_TTL_MINUTES
//   POST /v1/admin/auth/logout                       → ends this session
//   POST /v1/admin/auth/logout-all                   → ends every admin session (the runbook's "freeze admin sessions")
//
// Replay: a nonce is kept with the message it was issued for and is removed on its first use, whether the signature
// checks out or not; it expires 5 minutes after it's issued. Domain: the message names the site the request came from
// (its Origin, which must be one of the engine's allowed origins), and verify must come from the same site.
// Allowlist: ADMIN_EVM_ADDRESSES (else the owner's wallet). The signature is checked for ordinary wallets and contract
// wallets (ERC-1271 / 6492). Sessions live in memory as hashes of their tokens: a restart signs every admin out.
// Logins, logouts and refusals are logged; logins and logouts go in the append-only audit log with IP and device.

import { createHash, randomBytes } from 'node:crypto'
import { isAddress, isHex, type Address, type Hex } from 'viem'
import type { AuditStore } from '../site/tradeSwitch'
import { errMsg, log } from '../log'

export const ADMIN_AUTH = {
  nonceTtlMs: 5 * 60_000,
  maxPending: 500,
  maxSessions: 50,
  /** Nonces one IP may ask for in a minute. */
  noncesPerIpMinute: 10,
  chainId: 5042,
}

export interface AdminSession { address: Address; issuedAt: number; expiresAt: number; ip: string; ua: string }
interface Pending { address: Address; message: string; origin: string; expiresAt: number }

export type SignedBy = (address: Address, message: string, signature: Hex) => Promise<boolean>

export interface AdminAuthOptions {
  /** Lowercase admin addresses (cfg.admins). */
  admins: readonly string[]
  /** Sites a sign-in may come from (cfg.allowedOrigins). */
  origins: readonly string[]
  ttlMinutes: number
  signedBy: SignedBy
  audit: AuditStore
  alert?: (text: string) => void
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max)

/** The message an admin signs, EIP-4361's layout. */
export function adminSignInMessage(p: { origin: string; address: string; nonce: string; issuedAt: number; expiresAt: number; chainId?: number }): string {
  const host = new URL(p.origin).host
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    p.address,
    '',
    'Sign in to the ARCDEX admin panel. This signature only signs you in: it sends nothing and approves nothing.',
    '',
    `URI: ${p.origin}/admin`,
    'Version: 1',
    `Chain ID: ${p.chainId ?? ADMIN_AUTH.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date(p.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(p.expiresAt).toISOString()}`,
  ].join('\n')
}

export class AdminAuth {
  private pending = new Map<string, Pending>()
  private sessions = new Map<string, AdminSession>()
  private perIp = new Map<string, { minute: number; n: number }>()
  readonly ttlMs: number

  constructor(private o: AdminAuthOptions) {
    this.ttlMs = Math.max(5, Math.min(240, o.ttlMinutes || 30)) * 60_000
  }

  get configured() { return this.o.admins.length > 0 }
  isAdmin(address: string) { return this.o.admins.includes(address.toLowerCase()) }

  /** A nonce and the message to sign, or why not. */
  nonce(body: unknown, origin: string | null, ip: string, now = Date.now()): { nonce: string; message: string; expiresAt: number } | { status: number; error: string } {
    if (!this.configured) return { status: 503, error: 'no admin wallet is configured on the engine (ADMIN_EVM_ADDRESSES or BOT_OWNER_ADDRESS)' }
    if (!origin || !this.o.origins.includes(origin)) return { status: 403, error: 'sign in from the site itself' }
    const address = (body as { address?: unknown } | null)?.address
    if (typeof address !== 'string' || !isAddress(address)) return { status: 400, error: '"address" must be a wallet address' }
    const minute = Math.floor(now / 60_000)
    const seen = this.perIp.get(ip)
    const n = seen && seen.minute === minute ? seen.n : 0
    if (n >= ADMIN_AUTH.noncesPerIpMinute) return { status: 429, error: 'too many sign-in attempts; wait a minute' }
    if (this.perIp.size > 10_000) this.perIp.clear()
    this.perIp.set(ip, { minute, n: n + 1 })
    this.prune(now)
    if (this.pending.size >= ADMIN_AUTH.maxPending) return { status: 429, error: 'too many sign-ins waiting; try again shortly' }
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = now + ADMIN_AUTH.nonceTtlMs
    const message = adminSignInMessage({ origin, address, nonce, issuedAt: now, expiresAt })
    this.pending.set(nonce, { address: address as Address, message, origin, expiresAt })
    return { nonce, message, expiresAt }
  }

  /** A session for a signed nonce, or why not. The nonce is spent either way. */
  async verify(body: unknown, origin: string | null, ip: string, ua: string | null, now = Date.now()): Promise<{ token: string; address: Address; expiresAt: number } | { status: number; error: string }> {
    const b = (body ?? {}) as { nonce?: unknown; signature?: unknown }
    if (typeof b.nonce !== 'string' || typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return { status: 400, error: 'expected {nonce, signature}' }
    const p = this.pending.get(b.nonce)
    this.pending.delete(b.nonce)
    const refuse = (status: number, error: string, address?: string) => {
      log.warn('admin sign-in refused', { why: error, address, ip })
      return { status, error }
    }
    if (!p) return refuse(401, 'this sign-in request was already used or never issued; start again')
    if (now > p.expiresAt) return refuse(401, 'this sign-in request expired; start again', p.address)
    if (origin !== p.origin) return refuse(403, 'sign in from the same site that asked', p.address)
    if (!this.isAdmin(p.address)) return refuse(403, 'this wallet is not an admin', p.address)
    let ok = false
    try { ok = await this.o.signedBy(p.address, p.message, b.signature as Hex) } catch (e) { log.warn('admin sign-in: signature not checked', { error: errMsg(e) }) }
    if (!ok) return refuse(401, 'the signature does not match this wallet', p.address)
    const token = randomBytes(32).toString('base64url')
    const s: AdminSession = { address: p.address, issuedAt: now, expiresAt: now + this.ttlMs, ip: clean(ip, 64), ua: clean(ua, 200) }
    this.prune(now)
    if (this.sessions.size >= ADMIN_AUTH.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((x, y) => x[1].issuedAt - y[1].issuedAt)[0]
      if (oldest) this.sessions.delete(oldest[0])
    }
    this.sessions.set(sha(token), s)
    await this.o.audit.appendAudit({ at: now, actor: p.address.toLowerCase(), action: 'admin.login', detail: { ip: s.ip, device: s.ua, expiresAt: s.expiresAt } })
      .catch(e => log.error('admin sign-in: not audited', { error: errMsg(e) }))
    log.info('admin signed in', { address: p.address, ip })
    this.o.alert?.(`ARCDEX admin sign-in: ${p.address} from ${s.ip} (${s.ua.slice(0, 80) || 'unknown device'})`)
    return { token, address: p.address, expiresAt: s.expiresAt }
  }

  /** The session an Authorization header names, if it's live and its wallet is still an admin. */
  session(authorization: string | null, now = Date.now()): AdminSession | null {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '')
    if (!m) return null
    const key = sha(m[1])
    const s = this.sessions.get(key)
    if (!s) return null
    if (now > s.expiresAt || !this.isAdmin(s.address)) { this.sessions.delete(key); return null }
    return s
  }

  async logout(authorization: string | null, now = Date.now()): Promise<boolean> {
    const s = this.session(authorization, now)
    if (!s) return false
    this.sessions.delete(sha(/^Bearer (.+)$/.exec(authorization!)![1]))
    await this.o.audit.appendAudit({ at: now, actor: s.address.toLowerCase(), action: 'admin.logout', detail: {} }).catch(e => log.error('admin logout: not audited', { error: errMsg(e) }))
    return true
  }

  /** Ends every admin session (an admin's request, or a suspected compromise). */
  async logoutAll(by: Address, now = Date.now()): Promise<number> {
    const n = this.sessions.size
    this.sessions.clear()
    await this.o.audit.appendAudit({ at: now, actor: by.toLowerCase(), action: 'admin.logout-all', detail: { sessions: n } }).catch(e => log.error('admin logout-all: not audited', { error: errMsg(e) }))
    this.o.alert?.(`ARCDEX: every admin session was ended by ${by}`)
    return n
  }

  /** Live admin sessions (for the overview; no tokens). */
  active(now = Date.now()) {
    this.prune(now)
    return [...this.sessions.values()].map(s => ({ address: s.address, issuedAt: s.issuedAt, expiresAt: s.expiresAt, ip: s.ip, device: s.ua }))
  }

  private prune(now: number) {
    for (const [k, p] of this.pending) if (now > p.expiresAt) this.pending.delete(k)
    for (const [k, s] of this.sessions) if (now > s.expiresAt) this.sessions.delete(k)
  }
}
