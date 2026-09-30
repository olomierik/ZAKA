// Accounts for Autotrade bots (owner's request, 2026-09-30): sign up with an
// email and a 4-character passcode; sign in from any device to reach your
// bots, which keep running on the engine with every device switched off;
// forgot the passcode → a new one is emailed (Resend, bot/mailer.ts).
//
// A 4-character passcode is short, so the engine does the guarding:
//   - it's stored as scrypt(passcode, salt), never in the clear
//   - 5 wrong tries lock the account for 15 minutes (30, 60… after that);
//     an IP gets 30 wrong tries an hour, 5 sign-ups and 5 resets
//   - letters and digits, upper and lower case: 14.8M passcodes, so guessing
//     one through the lockouts would take decades
//   - a reset emails a new passcode and signs out every device; it's
//     rate-limited per email, and says the same whether or not the email
//     has an account
//   - money leaving a live bot's wallet also needs a code sent to the
//     (verified) email, bound to that amount and address (challenge()), so
//     a guessed passcode alone can't move funds
//
// Sessions are signed tokens (userId.issuedAt.hmac), good for 30 days; a
// reset, a passcode change or "sign out everywhere" voids every older one.

import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { log } from '../log'
import { codeMail, logMailError, type Mailer } from './mailer'

export interface User {
  id: string
  email: string
  /** scrypt(passcode, salt), hex. */
  passHash: string
  salt: string
  createdAt: number
  verified: boolean
  failed: number
  lockedUntil: number | null
  lastResetAt: number | null
  /** Sessions issued before this are void. */
  sessionsAfter: number
  /** Wallets linked by signature: their $ARCD counts toward the account's tier (bot/tiers.ts). */
  wallets?: { address: string; at: number }[]
  /** A tier the owner granted (a subscription paid some other way), until a time. */
  grant?: { tier: 'free' | 't1' | 't2' | 't3'; until: number } | null
}

/** A wallet links to one account at a time, and an account links at most this many. */
export const MAX_WALLETS = 5

export interface UserStore {
  users(): Promise<User[]>
  saveUser(u: User): void
}

export const AUTH = {
  passcode: /^[A-Za-z0-9]{4}$/,
  maxFails: 5,
  lockMin: 15,
  sessionDays: 30,
  codeMin: 30,
  withdrawCodeMin: 10,
  codeAttempts: 5,
  resetEveryMin: 5,
  codeEverySec: 60,
  perIpHour: { fails: 30, signups: 5, resets: 5 },
}
const DUMMY_SALT = '00'.repeat(16)
/** Emailed passcodes leave out look-alikes (0/O, 1/I/l). */
const RESET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'

export type AuthResult = { user: User; token: string } | { error: string; status: number }

const scrypt = (pass: string, salt: string) => new Promise<Buffer>((ok, no) => scryptCb(pass, Buffer.from(salt, 'hex'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function normEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return e.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(e) ? e : null
}

export class Users {
  private byId = new Map<string, User>()
  private byEmail = new Map<string, string>()
  private hits = new Map<string, number[]>()
  /** Pending codes: `${userId}:${purpose}` → the code's hash, what it confirms, when it expires, tries left. */
  private codes = new Map<string, { hash: string; payload: string; expires: number; tries: number; sentAt: number }>()
  private secret: Buffer

  constructor(private o: { store: UserStore; mailer: Mailer; secret: string }) {
    this.secret = createHash('sha256').update(`arcdex-bot-sessions:${o.secret}`).digest()
  }

  get mailEnabled() { return this.o.mailer.enabled }
  get count() { return this.byId.size }

  async load() {
    for (const u of await this.o.store.users()) { this.byId.set(u.id, u); this.byEmail.set(u.email, u.id) }
    log.info('bot accounts loaded', { users: this.byId.size, email: this.o.mailer.enabled })
  }


  async signup(emailRaw: unknown, passcode: unknown, ip: string, now = Date.now()): Promise<AuthResult> {
    const email = normEmail(emailRaw)
    if (!email) return { error: 'enter a valid email address', status: 400 }
    if (typeof passcode !== 'string' || !AUTH.passcode.test(passcode)) return { error: 'the passcode is 4 letters or digits', status: 400 }
    if (this.byEmail.has(email)) return { error: 'an account with this email already exists: sign in, or reset the passcode', status: 409 }
    if (!this.take(`signup:${ip}`, AUTH.perIpHour.signups, now)) return { error: 'too many sign-ups from here; try again later', status: 429 }
    const salt = randomBytes(16).toString('hex')
    const u: User = { id: randomBytes(12).toString('hex'), email, passHash: (await scrypt(passcode, salt)).toString('hex'), salt, createdAt: now, verified: false, failed: 0, lockedUntil: null, lastResetAt: null, sessionsAfter: 0 }
    this.byId.set(u.id, u); this.byEmail.set(email, u.id)
    this.o.store.saveUser(u)
    if (this.o.mailer.enabled) void this.sendVerify(u, now).catch(e => logMailError('verification', e))
    return { user: u, token: this.token(u, now) }
  }

  async login(emailRaw: unknown, passcode: unknown, ip: string, now = Date.now()): Promise<AuthResult> {
    const email = normEmail(emailRaw)
    if (this.spent(`fail:${ip}`, AUTH.perIpHour.fails, now)) return { error: 'too many wrong tries from here; try again in an hour', status: 429 }
    const u = email ? this.byEmailOf(email) : null
    if (u?.lockedUntil && u.lockedUntil > now) return { error: `too many wrong passcodes: try again in ${Math.ceil((u.lockedUntil - now) / 60_000)} min, or reset it`, status: 429 }
    // An unknown email costs the same hashing as a known one, so timing doesn't tell which emails have accounts.
    const hash = await scrypt(typeof passcode === 'string' ? passcode : '', u?.salt ?? DUMMY_SALT)
    const ok = !!u && typeof passcode === 'string' && AUTH.passcode.test(passcode) && timingSafeEqual(hash, Buffer.from(u.passHash, 'hex'))
    if (!ok || !u) {
      this.take(`fail:${ip}`, Infinity, now)
      if (u) {
        u.failed++
        if (u.failed % AUTH.maxFails === 0) u.lockedUntil = now + Math.min(86_400_000, AUTH.lockMin * 60_000 * 2 ** (u.failed / AUTH.maxFails - 1))
        this.o.store.saveUser(u)
      }
      return { error: 'wrong email or passcode', status: 401 }
    }
    if (u.failed || u.lockedUntil) { u.failed = 0; u.lockedUntil = null; this.o.store.saveUser(u) }
    return { user: u, token: this.token(u, now) }
  }

  /** The signed-in user behind a session token, or null. */
  userOf(token: string | null | undefined, now = Date.now()): User | null {
    const m = token && /^([0-9a-f]{24})\.(\d{10,14})\.([A-Za-z0-9_-]{43})$/.exec(token)
    if (!m) return null
    const issued = Number(m[2])
    if (now - issued > AUTH.sessionDays * 86_400_000 || issued > now + 60_000) return null
    const want = Buffer.from(this.sign(`${m[1]}.${m[2]}`)), got = Buffer.from(m[3])
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    const u = this.byId.get(m[1])
    return u && issued >= u.sessionsAfter ? u : null
  }

  /** A new passcode, emailed; every device signed out. Answers the same whether or not the email has an account. */
  async forgot(emailRaw: unknown, ip: string, now = Date.now()): Promise<{ ok: true } | { error: string; status: number }> {
    if (!this.o.mailer.enabled) return { error: 'passcode resets need email, which isn\'t set up yet', status: 503 }
    const email = normEmail(emailRaw)
    if (!email) return { error: 'enter a valid email address', status: 400 }
    if (!this.take(`reset:${ip}`, AUTH.perIpHour.resets, now)) return { error: 'too many resets from here; try again later', status: 429 }
    const u = this.byEmailOf(email)
    if (!u || (u.lastResetAt && now - u.lastResetAt < AUTH.resetEveryMin * 60_000)) return { ok: true }
    const passcode = Array.from({ length: 4 }, () => RESET_ALPHABET[randomInt(RESET_ALPHABET.length)]).join('')
    const salt = randomBytes(16).toString('hex')
    const hash = (await scrypt(passcode, salt)).toString('hex')
    try {
      await this.o.mailer.send(codeMail(u.email, 'Your new ARCDEX passcode', 'Here is your new Autotrade passcode (upper and lower case matter). Every device was signed out; sign in again with it.', passcode, 'Didn\'t ask for this? Your bots are safe: sign in with this passcode and change it.'))
    } catch (e) { logMailError('reset', e); return { error: 'the email could not be sent; try again in a minute', status: 502 } }
    // Only now that it's on its way: the new passcode takes over.
    Object.assign(u, { passHash: hash, salt, lastResetAt: now, failed: 0, lockedUntil: null, sessionsAfter: now })
    this.o.store.saveUser(u)
    return { ok: true }
  }

  async changePasscode(u: User, current: unknown, next: unknown, now = Date.now()): Promise<AuthResult> {
    if (typeof next !== 'string' || !AUTH.passcode.test(next)) return { error: 'the new passcode is 4 letters or digits', status: 400 }
    const ok = typeof current === 'string' && AUTH.passcode.test(current) && timingSafeEqual(await scrypt(current, u.salt), Buffer.from(u.passHash, 'hex'))
    if (!ok) return { error: 'the current passcode is wrong', status: 401 }
    const salt = randomBytes(16).toString('hex')
    Object.assign(u, { passHash: (await scrypt(next, salt)).toString('hex'), salt, sessionsAfter: now })
    this.o.store.saveUser(u)
    return { user: u, token: this.token(u, now) }
  }

  /** The account's passcode, checked as at sign-in: wrong tries count toward the same lockout. Null when it's right. */
  async checkPasscode(u: User, passcode: unknown, now = Date.now()): Promise<string | null> {
    if (u.lockedUntil && u.lockedUntil > now) return `too many wrong passcodes: try again in ${Math.ceil((u.lockedUntil - now) / 60_000)} min`
    const ok = typeof passcode === 'string' && AUTH.passcode.test(passcode) && timingSafeEqual(await scrypt(passcode, u.salt), Buffer.from(u.passHash, 'hex'))
    if (!ok) {
      u.failed++
      if (u.failed % AUTH.maxFails === 0) u.lockedUntil = now + Math.min(86_400_000, AUTH.lockMin * 60_000 * 2 ** (u.failed / AUTH.maxFails - 1))
      this.o.store.saveUser(u)
      return 'wrong passcode'
    }
    if (u.failed || u.lockedUntil) { u.failed = 0; u.lockedUntil = null; this.o.store.saveUser(u) }
    return null
  }

  signOutEverywhere(u: User, now = Date.now()) { u.sessionsAfter = now + 1; this.o.store.saveUser(u) }

  /** Emails a code confirming the address. */
  async sendVerify(u: User, now = Date.now()): Promise<string | null> {
    if (u.verified) return 'this email is already verified'
    return this.challenge(u, 'verify', u.email, 'Confirm your ARCDEX email', 'Enter this code in Autotrade to confirm your email. It keeps working for 30 minutes.', 'Confirming lets you reset a forgotten passcode and trade live.', AUTH.codeMin, now)
  }

  verify(u: User, code: unknown, now = Date.now()): string | null {
    const r = this.confirm(u, 'verify', code, now)
    if (typeof r !== 'string' || r !== u.email) return typeof r === 'object' ? r.error : 'that code is for another address'
    u.verified = true
    this.o.store.saveUser(u)
    return null
  }

  /**
   * Emails a 6-digit code that confirms one thing (`purpose`, e.g. a
   * withdrawal) with exactly this `payload`. Returns why not, or null.
   */
  async challenge(u: User, purpose: string, payload: string, subject: string, intro: string, outro: string, minutes = AUTH.withdrawCodeMin, now = Date.now()): Promise<string | null> {
    if (!this.o.mailer.enabled) return 'email isn\'t set up on this engine yet'
    const key = `${u.id}:${purpose}`
    const prev = this.codes.get(key)
    if (prev && now - prev.sentAt < AUTH.codeEverySec * 1_000) return 'a code was just sent; wait a minute before asking again'
    const code = String(randomInt(1_000_000)).padStart(6, '0')
    try { await this.o.mailer.send(codeMail(u.email, subject, intro, code, outro)) } catch (e) { logMailError(purpose, e); return 'the email could not be sent; try again in a minute' }
    this.codes.set(key, { hash: sha(`${key}:${code}`), payload, expires: now + minutes * 60_000, tries: AUTH.codeAttempts, sentAt: now })
    return null
  }

  /** The payload a code confirms (and the code is used up), or why not. */
  confirm(u: User, purpose: string, code: unknown, now = Date.now()): string | { error: string } {
    const key = `${u.id}:${purpose}`
    const c = this.codes.get(key)
    if (!c || c.expires < now) { this.codes.delete(key); return { error: 'no code is waiting (or it expired): ask for a new one' } }
    if (typeof code !== 'string' || sha(`${key}:${code.trim()}`) !== c.hash) {
      if (--c.tries <= 0) this.codes.delete(key)
      return { error: c.tries > 0 ? `wrong code (${c.tries} tries left)` : 'wrong code: ask for a new one' }
    }
    this.codes.delete(key)
    return c.payload
  }

  view(u: User) { return { email: u.email, verified: u.verified, createdAt: u.createdAt } }

  /** Every linked wallet (their $ARCD is read every 10 minutes). */
  linkedWallets(): string[] { const out: string[] = []; for (const u of this.byId.values()) for (const w of u.wallets ?? []) out.push(w.address); return out }

  /** A signed-in account by its id (a bot's owner). */
  get(id: string | null | undefined): User | null { return id ? this.byId.get(id) ?? null : null }
  byEmailOf(emailRaw: unknown): User | null { const e = normEmail(emailRaw); const id = e ? this.byEmail.get(e) : undefined; return id ? this.byId.get(id) ?? null : null }

  /** Links a wallet (its signature already checked); why not, or null. A wallet counts for one account only. */
  linkWallet(u: User, address: string, now = Date.now()): string | null {
    const a = address.toLowerCase()
    for (const other of this.byId.values()) if (other.id !== u.id && other.wallets?.some(w => w.address === a)) return 'this wallet is linked to another account: unlink it there first'
    const list = u.wallets ?? []
    if (list.some(w => w.address === a)) return null
    if (list.length >= MAX_WALLETS) return `an account links at most ${MAX_WALLETS} wallets`
    u.wallets = [...list, { address: a, at: now }]
    this.o.store.saveUser(u)
    return null
  }
  unlinkWallet(u: User, address: string) {
    u.wallets = (u.wallets ?? []).filter(w => w.address !== address.toLowerCase())
    this.o.store.saveUser(u)
  }

  /** The owner's grant: a tier for `days` (0 takes it back). */
  grantTier(email: unknown, tier: 'free' | 't1' | 't2' | 't3', days: number, now = Date.now()): User | string {
    const u = this.byEmailOf(email)
    if (!u) return 'no account has that email'
    u.grant = days > 0 ? { tier, until: now + days * 86_400_000 } : null
    this.o.store.saveUser(u)
    log.info('tier granted', { user: u.id, tier: u.grant?.tier ?? null, days })
    return u
  }

  private token(u: User, now: number) { const body = `${u.id}.${now}`; return `${body}.${this.sign(body)}` }
  private sign(body: string) { return createHmac('sha256', this.secret).update(body).digest('base64url') }

  /** Counts one hit for `key`; false if the hour's `max` was already reached. */
  private take(key: string, max: number, now: number) {
    const list = (this.hits.get(key) ?? []).filter(t => now - t < 3_600_000)
    if (list.length >= max) { this.hits.set(key, list); return false }
    list.push(now); this.hits.set(key, list)
    if (this.hits.size > 50_000) this.hits.clear()
    return true
  }
  private spent(key: string, max: number, now: number) { return (this.hits.get(key) ?? []).filter(t => now - t < 3_600_000).length >= max }
}
