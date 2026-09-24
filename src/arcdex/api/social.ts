// ARCDEX social layer — client side.
//
// Reads go straight to Supabase with the public anon key (every arcdex_*
// table is public-read). Writes go through /api/social with a session
// token obtained by signing a message with the trading wallet (see
// api/_session.ts). If the tables don't exist yet, reads return empty so
// the UI shows "no data yet" instead of breaking.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Trader } from '../lib/identity'

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let sb: SupabaseClient | null = null
function client(): SupabaseClient | null {
  if (!URL || !KEY) return null
  if (!sb) sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  return sb
}

// ── types ─────────────────────────────────────────────────────────────

export interface Profile {
  address: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  x_handle: string | null
  created_at?: string
}

export interface Thesis {
  id: number
  author: string
  token: string
  body: string
  position_usd: number | null
  created_at: string
  likes: number
}

export interface IndexedTrade {
  tx_hash: string
  log_index: number
  block_time: string
  trader: string
  token: string
  side: 'buy' | 'sell'
  usdc: number
  token_amount: string
  fee_usdc: number
}

export interface LeaderRow { trader: string; volume_usdc: number; realized_pnl: number; trades: number; coins: number }
export interface PositionRow { token: string; bought_usdc: number; bought_tok: number; sold_usdc: number; sold_tok: number; trades: number; last_trade: string }
export interface ReferralStats { referred_users: number; earned_usdc: number; payouts: number }

export type Period = '24h' | '7d' | '30d' | 'all'
const since = (p: Period) =>
  p === 'all' ? '1970-01-01T00:00:00Z' : new Date(Date.now() - { '24h': 1, '7d': 7, '30d': 30 }[p] * 86_400_000).toISOString()

const lc = (a: string) => a.toLowerCase()
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))

// ── profiles ──────────────────────────────────────────────────────────

const profileCache = new Map<string, { p: Profile | null; at: number }>()

/** Profiles for many addresses at once (for avatars in tables/feeds). */
export async function getProfiles(addresses: string[]): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>()
  const want = [...new Set(addresses.map(lc))]
  const missing: string[] = []
  for (const a of want) {
    const c = profileCache.get(a)
    if (c && Date.now() - c.at < 60_000) { if (c.p) out.set(a, c.p) }
    else missing.push(a)
  }
  const c = client()
  if (c && missing.length) {
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100)
      const { data } = await c.from('arcdex_profiles').select('*').in('address', chunk)
      const found = new Map((data ?? []).map(p => [p.address as string, p as Profile]))
      for (const a of chunk) {
        const p = found.get(a) ?? null
        profileCache.set(a, { p, at: Date.now() })
        if (p) out.set(a, p)
      }
    }
  }
  return out
}

export async function getProfile(address: string): Promise<Profile | null> {
  return (await getProfiles([address])).get(lc(address)) ?? null
}

export async function getProfileByUsername(username: string): Promise<Profile | null> {
  const c = client()
  if (!c) return null
  const { data } = await c.from('arcdex_profiles').select('*').eq('username', username.toLowerCase().replace(/^@/, '')).maybeSingle()
  return (data as Profile | null) ?? null
}

export async function searchProfiles(q: string, limit = 8): Promise<Profile[]> {
  const c = client()
  const s = q.trim().toLowerCase().replace(/^@/, '')
  if (!c || s.length < 2 || !/^[a-z0-9_]+$/.test(s)) return []
  const { data } = await c.from('arcdex_profiles').select('*').ilike('username', `${s}%`).limit(limit)
  return (data ?? []) as Profile[]
}

export function invalidateProfile(address: string) { profileCache.delete(lc(address)) }

// ── follows ───────────────────────────────────────────────────────────

export async function getFollowStats(address: string): Promise<{ followers: number; following: number }> {
  const c = client()
  if (!c) return { followers: 0, following: 0 }
  const a = lc(address)
  const [f1, f2] = await Promise.all([
    c.from('arcdex_follows').select('*', { count: 'exact', head: true }).eq('following', a),
    c.from('arcdex_follows').select('*', { count: 'exact', head: true }).eq('follower', a),
  ])
  return { followers: f1.count ?? 0, following: f2.count ?? 0 }
}

export async function getFollowing(address: string): Promise<string[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.from('arcdex_follows').select('following').eq('follower', lc(address)).limit(1000)
  return (data ?? []).map(r => r.following as string)
}

// ── theses ────────────────────────────────────────────────────────────

export async function getTheses(opts: { token?: string; authors?: string[]; limit?: number } = {}): Promise<Thesis[]> {
  const c = client()
  if (!c) return []
  let q = c.from('arcdex_theses_v').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 50)
  if (opts.token) q = q.eq('token', lc(opts.token))
  if (opts.authors) {
    if (opts.authors.length === 0) return []
    q = q.in('author', opts.authors.map(lc))
  }
  const { data } = await q
  return (data ?? []).map(t => ({ ...(t as Thesis), likes: num(t.likes), position_usd: t.position_usd == null ? null : num(t.position_usd) }))
}

export async function getMyLikes(me: string, ids: number[]): Promise<Set<number>> {
  const c = client()
  if (!c || ids.length === 0) return new Set()
  const { data } = await c.from('arcdex_thesis_likes').select('thesis_id').eq('liker', lc(me)).in('thesis_id', ids)
  return new Set((data ?? []).map(r => Number(r.thesis_id)))
}

// ── indexed trades, leaderboard, positions, referrals ─────────────────

export async function getLeaderboard(period: Period, limit = 100): Promise<LeaderRow[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.rpc('arcdex_leaderboard', { p_since: since(period), p_limit: limit })
  return ((data ?? []) as LeaderRow[]).map(r => ({ ...r, volume_usdc: num(r.volume_usdc), realized_pnl: num(r.realized_pnl), trades: num(r.trades), coins: num(r.coins) }))
}

export async function getTraderPositions(address: string): Promise<PositionRow[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.rpc('arcdex_trader_positions', { p_trader: lc(address) })
  return ((data ?? []) as PositionRow[]).map(r => ({ ...r, bought_usdc: num(r.bought_usdc), bought_tok: num(r.bought_tok), sold_usdc: num(r.sold_usdc), sold_tok: num(r.sold_tok), trades: num(r.trades) }))
}

export async function getTrades(opts: { trader?: string; traders?: string[]; token?: string; limit?: number } = {}): Promise<IndexedTrade[]> {
  const c = client()
  if (!c) return []
  let q = c.from('arcdex_trades').select('*').order('block_time', { ascending: false }).limit(opts.limit ?? 50)
  if (opts.trader) q = q.eq('trader', lc(opts.trader))
  if (opts.traders) {
    if (opts.traders.length === 0) return []
    q = q.in('trader', opts.traders.map(lc))
  }
  if (opts.token) q = q.eq('token', lc(opts.token))
  const { data } = await q
  return ((data ?? []) as IndexedTrade[]).map(t => ({ ...t, usdc: num(t.usdc), fee_usdc: num(t.fee_usdc) }))
}

export async function getReferralStats(address: string): Promise<ReferralStats> {
  const c = client()
  if (!c) return { referred_users: 0, earned_usdc: 0, payouts: 0 }
  const { data } = await c.rpc('arcdex_referral_stats', { p_referrer: lc(address) })
  const r = (Array.isArray(data) ? data[0] : data) as ReferralStats | undefined
  return { referred_users: num(r?.referred_users), earned_usdc: num(r?.earned_usdc), payouts: num(r?.payouts) }
}

let lastIndexCall = 0
/** Nudge the server to pull the latest router events into Supabase. Cheap
 * and idempotent; throttled here and on the server. */
export function triggerIndex(force = false) {
  if (!force && Date.now() - lastIndexCall < 30_000) return
  lastIndexCall = Date.now()
  void fetch('/api/index-trades').catch(() => {})
}

// ── sign-in + writes ──────────────────────────────────────────────────

const SESSION_KEY = (a: string) => `arcdex:session:${lc(a)}`

/** Same text the server rebuilds in api/_session.ts — must match exactly. */
function signInMessage(address: string, issuedAt: string, nonce: string): string {
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

function storedSession(address: string): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY(address))
    if (!raw) return null
    const s = JSON.parse(raw) as { token: string; expiresAt: number }
    return s.expiresAt * 1000 > Date.now() + 60_000 ? s.token : null
  } catch {
    return null
  }
}

export function isSignedIn(address: string | null): boolean {
  return !!address && storedSession(address) !== null
}

export async function signIn(trader: Trader): Promise<string> {
  if (!trader.address) throw new Error('Connect or unlock a wallet first')
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(8, '0')
  const issuedAt = new Date().toISOString()
  const signature = await trader.signMessage(signInMessage(trader.address, issuedAt, nonce))
  const res = await fetch('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: trader.address, issuedAt, nonce, signature }),
  })
  const j = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string }
  if (!res.ok || !j.token) throw new Error(j.error ?? 'Sign-in failed')
  try { localStorage.setItem(SESSION_KEY(trader.address), JSON.stringify({ token: j.token, expiresAt: j.expiresAt })) } catch { /* private mode */ }
  return j.token
}

/** Performs a social write as `trader`, signing in first if needed. */
export async function socialWrite<T = unknown>(trader: Trader, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!trader.address) throw new Error('Connect or unlock a wallet first')
  let token = storedSession(trader.address) ?? (await signIn(trader))
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    })
    const j = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (res.status === 401 && attempt === 0) {
      try { localStorage.removeItem(SESSION_KEY(trader.address)) } catch { /* ignore */ }
      token = await signIn(trader)
      continue
    }
    if (!res.ok) throw new Error(j.error ?? 'Request failed')
    if (action === 'profile') invalidateProfile(trader.address)
    return j
  }
  throw new Error('Sign-in failed')
}
