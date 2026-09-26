// ARCDEX social layer — client side.
//
// Reads go straight to Supabase with the public anon key (every arcdex_*
// table is public-read). Writes go through /api/social with a session
// token obtained by signing a message with the trading wallet (see
// api/_session.ts). If the tables don't exist yet, reads return empty so
// the UI shows "no data yet" instead of breaking.

import { createPostgrest, type PostgrestClient } from '../lib/postgrest'
import type { Trader } from '../lib/identity'

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let sb: PostgrestClient | null = null
function client(): PostgrestClient | null {
  if (!URL || !KEY) return null
  if (!sb) sb = createPostgrest(URL, KEY)
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
  banner_url?: string | null
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

// ── holder index (public read; /api/holders keeps it) ─────────────────

export interface HolderScan { token: string; holders: number; scanned_to: number }

/** Each token's indexed holder count and the last block it covers. */
export async function getHolderScans(tokens: string[]): Promise<HolderScan[]> {
  const c = client()
  if (!c || tokens.length === 0) return []
  const out: HolderScan[] = []
  for (let i = 0; i < tokens.length; i += 100) {
    const { data, error } = await c.from('arcdex_holder_scans').select('token,holders,scanned_to').in('token', tokens.slice(i, i + 100).map(lc))
    if (error) throw new Error(error.message)
    for (const r of data ?? []) out.push({ token: String(r.token), holders: num(r.holders), scanned_to: num(r.scanned_to) })
  }
  return out
}

/** Indexed balances (raw units) of some wallets for one token; absent = none. */
export async function getIndexedBalances(token: string, holders: string[]): Promise<Map<string, bigint>> {
  const c = client()
  const m = new Map<string, bigint>()
  if (!c || holders.length === 0) return m
  for (let i = 0; i < holders.length; i += 60) {
    const { data, error } = await c.from('arcdex_holder_balances').select('holder,balance::text').eq('token', lc(token)).in('holder', holders.slice(i, i + 60).map(lc))
    if (error) throw new Error(error.message)
    for (const r of data ?? []) m.set(String(r.holder), BigInt(String(r.balance)))
  }
  return m
}

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

export interface ReferralPayout { tx_hash: string; log_index: number; user_address: string; token: string; amount: number; block_time: string }
export interface ReferredUser { user_address: string; block_time: string }

/** Every referral payout to this referrer, newest first (router ReferralPaid events). */
export async function getReferralPayouts(referrer: string, limit = 100): Promise<ReferralPayout[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.from('arcdex_referral_payouts').select('tx_hash, log_index, user_address, token, amount, block_time')
    .eq('referrer', lc(referrer)).order('block_time', { ascending: false }).limit(limit)
  return ((data ?? []) as ReferralPayout[]).map(r => ({ ...r, amount: num(r.amount) }))
}

/** Wallets bound to this referrer on-chain, newest first. */
export async function getReferredUsers(referrer: string, limit = 200): Promise<ReferredUser[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.from('arcdex_referrals').select('user_address, block_time').eq('referrer', lc(referrer)).order('block_time', { ascending: false }).limit(limit)
  return (data ?? []) as ReferredUser[]
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

/** POSTs JSON to one of ARCDEX's signed-in endpoints as `trader`. */
function authedPost<T>(trader: Trader, url: string, body: Record<string, unknown>): Promise<T> {
  return authedRequest<T>(trader, url, JSON.stringify(body), 'application/json')
}

/** POSTs to one of ARCDEX's signed-in endpoints as `trader`, signing in
 * first if needed (and once more if the server rejects the token). */
export async function authedRequest<T>(trader: Trader, url: string, body: BodyInit, contentType: string): Promise<T> {
  if (!trader.address) throw new Error('Connect or unlock a wallet first')
  let token = storedSession(trader.address) ?? (await signIn(trader))
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
      body,
    })
    const j = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (res.status === 401 && attempt === 0) {
      try { localStorage.removeItem(SESSION_KEY(trader.address)) } catch { /* ignore */ }
      token = await signIn(trader)
      continue
    }
    if (!res.ok) throw new Error(j.error ?? 'Request failed')
    return j
  }
  throw new Error('Sign-in failed')
}

/** Performs a social write as `trader`, signing in first if needed. */
export async function socialWrite<T = unknown>(trader: Trader, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const j = await authedPost<T>(trader, '/api/social', { action, ...payload })
  if (action === 'profile' && trader.address) invalidateProfile(trader.address)
  return j
}

// ── account: sign out everywhere, support ─────────────────────────────

/** Invalidates every ARCDEX session for this wallet on every device
 * (including this one — the next write signs in again). */
export async function signOutEverywhere(trader: Trader): Promise<void> {
  await socialWrite(trader, 'session.revoke_all')
  if (trader.address) try { localStorage.removeItem(SESSION_KEY(trader.address)) } catch { /* ignore */ }
}

export type SupportCategory = 'trade' | 'deposit' | 'withdraw' | 'account' | 'bug' | 'idea' | 'other'
export async function sendSupport(trader: Trader, t: { category: SupportCategory; message: string; contact?: string; tx_hash?: string }): Promise<number | null> {
  const r = await socialWrite<{ ticket: number | null }>(trader, 'support', { ...t, page: location.pathname + location.search })
  return r.ticket
}

// ── card deposits (Circle Onramp) ─────────────────────────────────────

export async function onrampStatus(): Promise<{ enabled: boolean; sandbox: boolean }> {
  const r = await fetch('/api/onramp').catch(() => null)
  if (!r?.ok) return { enabled: false, sandbox: false }
  return r.json() as Promise<{ enabled: boolean; sandbox: boolean }>
}

/** A 30-minute widget session delivering USDC on Arc to `trader`. */
export function startCardDeposit(trader: Trader): Promise<{ session: unknown; widgetBaseUrl: string }> {
  return authedPost(trader, '/api/onramp', {})
}

// ── points (seasonal) ─────────────────────────────────────────────────

export interface PointsRow { trader: string; trade_pts: number; referral_pts: number; day_pts: number; social_pts: number; active_days: number; total: number; rank: number }
export interface Season { n: number; start: Date; end: Date }

// Rolling 30-day seasons from Season 1 (2026-09-25 00:00 UTC).
const SEASON_1 = Date.UTC(2026, 8, 25)
const SEASON_MS = 30 * 86_400_000
export function season(n: number): Season {
  return { n, start: new Date(SEASON_1 + (n - 1) * SEASON_MS), end: new Date(SEASON_1 + n * SEASON_MS) }
}
export function currentSeason(): Season {
  return season(Math.max(1, Math.floor((Date.now() - SEASON_1) / SEASON_MS) + 1))
}

const pointsNums = (r: PointsRow) => nums(r, ['trade_pts', 'referral_pts', 'day_pts', 'social_pts', 'active_days', 'total', 'rank'])
export async function getPoints(s: Season, limit = 100): Promise<PointsRow[]> {
  return (await rpc<PointsRow>('arcdex_points', { p_since: s.start.toISOString(), p_until: s.end.toISOString(), p_limit: limit })).map(pointsNums)
}
export async function getPointsOf(address: string, s: Season): Promise<PointsRow | null> {
  const r = (await rpc<PointsRow>('arcdex_points_of', { p_trader: lc(address), p_since: s.start.toISOString(), p_until: s.end.toISOString() }))[0]
  return r ? pointsNums(r) : null
}

// ── v2: holders, most held, stats, history, feed events, clans ───────

export interface HolderRow extends PositionRow { trader: string; first_buy: string | null }
export interface MostHeldRow { token: string; holders: number; invested_usdc: number }
export interface TraderStats { realized_pnl: number; volume_usdc: number; trades: number; avg_hold_seconds: number | null; first_trade: string | null }
export interface PnlPoint { t: string; pnl: number; cumulative: number }
export interface ClosedPosition { trader: string; token: string; bought_usdc: number; sold_usdc: number; pnl: number; closed_at: string }
export interface MultiBuy { token: string; buyers: number; usdc: number; traders: string[]; last_buy: string }
export interface Clan { id: string; slug: string; name: string; motto: string | null; avatar_url: string | null; banner_url: string | null; owner: string; created_at: string }
export interface ClanRank { clan_id: string; slug: string; name: string; avatar_url: string | null; members: number; realized_pnl: number; volume_usdc: number }
export interface ClanMember { member: string; role: 'owner' | 'member'; joined_at: string; realized_pnl: number; volume_usdc: number }
export interface ClanHolding { token: string; members: number; holders: string[]; bought_usdc: number; bought_tok: number; sold_usdc: number; sold_tok: number }
export interface TransferNote { tx_hash: string; sender: string; recipient: string; amount: number; note: string | null; created_at: string }

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.rpc(fn, args)
  return ((Array.isArray(data) ? data : data ? [data] : []) as T[])
}
const nums = <T extends object>(r: T, keys: (keyof T)[]): T => {
  const o = { ...r } as Record<string, unknown>
  for (const k of keys) if (o[k as string] != null) o[k as string] = Number(o[k as string])
  return o as T
}
export const periodSince = since

export async function getTokenHolders(token: string): Promise<HolderRow[]> {
  return (await rpc<HolderRow>('arcdex_token_holders', { p_token: lc(token), p_limit: 300 }))
    .map(r => nums(r, ['bought_usdc', 'bought_tok', 'sold_usdc', 'sold_tok', 'trades']))
}

export async function getMostHeld(limit = 50): Promise<MostHeldRow[]> {
  return (await rpc<MostHeldRow>('arcdex_most_held', { p_limit: limit })).map(r => nums(r, ['holders', 'invested_usdc']))
}

export async function getTraderStats(address: string, period: Period = 'all'): Promise<TraderStats> {
  const r = (await rpc<TraderStats>('arcdex_trader_stats', { p_trader: lc(address), p_since: since(period) }))[0]
  return r ? nums(r, ['realized_pnl', 'volume_usdc', 'trades', 'avg_hold_seconds']) : { realized_pnl: 0, volume_usdc: 0, trades: 0, avg_hold_seconds: null, first_trade: null }
}

export async function getPnlHistory(address: string): Promise<PnlPoint[]> {
  return (await rpc<PnlPoint>('arcdex_pnl_history', { p_trader: lc(address) })).map(r => nums(r, ['pnl', 'cumulative']))
}

export async function getClosedPositions(sinceIso: string, limit = 50): Promise<ClosedPosition[]> {
  return (await rpc<ClosedPosition>('arcdex_closed_positions', { p_since: sinceIso, p_limit: limit })).map(r => nums(r, ['bought_usdc', 'sold_usdc', 'pnl']))
}

export async function getMultiBuys(sinceIso: string, min = 3): Promise<MultiBuy[]> {
  return (await rpc<MultiBuy>('arcdex_multi_buys', { p_since: sinceIso, p_min: min })).map(r => nums(r, ['buyers', 'usdc']))
}

export async function getNewProfiles(limit = 20): Promise<Profile[]> {
  const c = client()
  if (!c) return []
  const { data } = await c.from('arcdex_profiles').select('*').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []) as Profile[]
}

export async function getMutuals(me: string, them: string): Promise<string[]> {
  const c = client()
  if (!c) return []
  const [mine, theirs] = await Promise.all([
    c.from('arcdex_follows').select('following').eq('follower', lc(me)).limit(1000),
    c.from('arcdex_follows').select('follower').eq('following', lc(them)).limit(1000),
  ])
  const iFollow = new Set((mine.data ?? []).map(r => r.following as string))
  return (theirs.data ?? []).map(r => r.follower as string).filter(a => iFollow.has(a))
}

export async function getClanLeaderboard(period: Period, limit = 50): Promise<ClanRank[]> {
  return (await rpc<ClanRank>('arcdex_clan_leaderboard', { p_since: since(period), p_limit: limit })).map(r => nums(r, ['members', 'realized_pnl', 'volume_usdc']))
}

export async function getClan(slugOrId: string): Promise<Clan | null> {
  const c = client()
  if (!c) return null
  const col = /^[0-9a-f-]{36}$/.test(slugOrId) ? 'id' : 'slug'
  const { data } = await c.from('arcdex_clans').select('*').eq(col, slugOrId.toLowerCase()).maybeSingle()
  return (data as Clan | null) ?? null
}

export async function getClanOf(address: string): Promise<{ clan: Clan; role: string } | null> {
  const c = client()
  if (!c) return null
  const { data } = await c.from('arcdex_clan_members').select('role, arcdex_clans(*)').eq('member', lc(address)).maybeSingle()
  const row = data as { role: string; arcdex_clans: Clan | null } | null
  return row?.arcdex_clans ? { clan: row.arcdex_clans, role: row.role } : null
}

export async function getClanMembers(clanId: string, period: Period): Promise<ClanMember[]> {
  return (await rpc<ClanMember>('arcdex_clan_members_pnl', { p_clan: clanId, p_since: since(period) })).map(r => nums(r, ['realized_pnl', 'volume_usdc']))
}

export async function getClanHoldings(clanId: string): Promise<ClanHolding[]> {
  return (await rpc<ClanHolding>('arcdex_clan_holdings', { p_clan: clanId })).map(r => nums(r, ['members', 'bought_usdc', 'bought_tok', 'sold_usdc', 'sold_tok']))
}

export async function searchClans(q: string, limit = 6): Promise<Clan[]> {
  const c = client()
  const s = q.trim()
  if (!c || s.length < 2) return []
  const { data } = await c.from('arcdex_clans').select('*').ilike('name', `%${s.replace(/[%_]/g, '')}%`).limit(limit)
  return (data ?? []) as Clan[]
}

export async function getTransferNotes(address: string, limit = 50): Promise<TransferNote[]> {
  const c = client()
  if (!c) return []
  const a = lc(address)
  const { data } = await c.from('arcdex_transfer_notes').select('*').or(`sender.eq.${a},recipient.eq.${a}`).order('created_at', { ascending: false }).limit(limit)
  return ((data ?? []) as TransferNote[]).map(t => ({ ...t, amount: Number(t.amount) }))
}
