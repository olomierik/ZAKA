// The admin panel's sign-in on the site (engine/src/admin/auth.ts). The engine builds the message (EIP-4361: this site,
// the wallet, a single-use nonce, an expiry); the page refuses to sign one that names another site, then trades the
// signature for a short session. The session token is kept in this tab only (sessionStorage) and sent as
// Authorization: Bearer, never in a cookie, so other sites can't use it.

import { useSyncExternalStore } from 'react'
import { engineApiUrl } from '../api/marketStream'

export interface AdminSessionInfo { token: string; address: `0x${string}`; expiresAt: number }

const KEY = 'arcdex:admin-session'
const listeners = new Set<() => void>()

function read(): AdminSessionInfo | null {
  try {
    const j = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as AdminSessionInfo | null
    return j && j.expiresAt > Date.now() ? j : null
  } catch { return null }
}
let current: AdminSessionInfo | null = read()

function set(s: AdminSessionInfo | null) {
  current = s
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY) } catch { /* this page only */ }
  if (s) rememberAdmin(s.address)
  for (const f of listeners) f()
}

// Wallets that signed in as admins in this browser: the menus show them an Admin link (owner, 2026-10-17: "I can't see
// admin features"). Only a link: /admin itself still asks for the wallet's signature, and the engine decides who's admin.
const ADMINS_KEY = 'arcdex:admin-wallets'
function knownAdmins(): string[] {
  try { const a = JSON.parse(localStorage.getItem(ADMINS_KEY) ?? '[]') as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
let admins = knownAdmins()
function rememberAdmin(address: string) {
  const a = address.toLowerCase()
  if (admins.includes(a)) return
  admins = [...admins, a].slice(-5)
  try { localStorage.setItem(ADMINS_KEY, JSON.stringify(admins)) } catch { /* this page only */ }
}
/** Whether `address` has signed in as an admin in this browser (or is signed in now). */
export function isKnownAdmin(address: string | null | undefined): boolean {
  return !!address && (admins.includes(address.toLowerCase()) || current?.address.toLowerCase() === address.toLowerCase())
}

export function adminSession(): AdminSessionInfo | null {
  if (current && current.expiresAt <= Date.now()) set(null)
  return current
}

export function useAdminSession(): AdminSessionInfo | null {
  return useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f) } }, adminSession, adminSession)
}

/** Whether `message` is a sign-in for this site and this wallet (the page never signs one for another site). */
export function signInMessageProblem(message: string, address: string, host = location.host): string | null {
  const lines = message.split('\n')
  if (lines[0] !== `${host} wants you to sign in with your Ethereum account:`) return 'the engine asked to sign in to another site'
  if ((lines[1] ?? '').toLowerCase() !== address.toLowerCase()) return 'the engine asked to sign for another wallet'
  if (!/\nNonce: [0-9a-f]{16,}\n/.test(message) || !/\nExpiration Time: /.test(message)) return 'the sign-in message has no nonce or expiry'
  return null
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(`${engineApiUrl}${path}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(j?.error ?? `the engine answered ${r.status}`)
  return j as T
}

/** Signs in `address` with `sign` (the wallet's personal_sign). */
export async function adminSignIn(address: `0x${string}`, sign: (message: string) => Promise<`0x${string}`>): Promise<AdminSessionInfo> {
  if (!engineApiUrl) throw new Error('the engine isn’t configured on this build')
  const n = await post<{ nonce: string; message: string }>('/v1/admin/auth/nonce', { address })
  const bad = signInMessageProblem(n.message, address)
  if (bad) throw new Error(bad)
  const signature = await sign(n.message)
  const s = await post<AdminSessionInfo>('/v1/admin/auth/verify', { nonce: n.nonce, signature })
  set(s)
  return s
}

export async function adminSignOut(all = false) {
  const s = current
  set(null)
  if (s) await post(all ? '/v1/admin/auth/logout-all' : '/v1/admin/auth/logout', {}, s.token).catch(() => {})
}

/** An admin request; a refused session (401) signs this tab out. */
export async function adminFetch<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const s = adminSession()
  if (!s) throw new Error('sign in as an admin first')
  if (init.method === 'POST') {
    try { return await post<T>(path, init.body ?? {}, s.token) } catch (e) {
      if (e instanceof Error && /sign in as an admin/.test(e.message)) set(null)
      throw e
    }
  }
  const r = await fetch(`${engineApiUrl}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${s.token}` } })
  if (r.status === 401) { set(null); throw new Error('your admin session ended; sign in again') }
  const j = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(j?.error ?? `the engine answered ${r.status}`)
  return j as T
}
