// The social layer's reads from the market engine (engine/src/social; the build pack's Phase 6): verified PnL boards
// and profiles from ARCDEX's own router trades on Arc, the wash-trade flags, comments, and what's hidden by moderation.
// Writes (comments, reports, mutes) go through api/social.ts, which signs in with the wallet first.
// Every read returns null (or an empty answer) when the engine can't be reached, so pages fall back to what they had.

import type { CommentV, ModerationState, SocialBoard, SocialPeriod, SocialTrader, WashFlag } from '../../../api/_socialProtocol'
import { engineApiUrl } from './marketStream'

async function get<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  if (!engineApiUrl) return null
  try {
    const r = await fetch(`${engineApiUrl}${path}`, { signal: signal ?? AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    return await r.json() as T
  } catch { return null }
}

/** The verified leaderboard for a period (wash-trade flagged wallets left out and listed). */
export function getVerifiedBoard(period: SocialPeriod, limit = 100): Promise<SocialBoard | null> {
  return get<SocialBoard>(`/v1/social/board?period=${period}&limit=${limit}`)
}

const traderCache = new Map<string, { at: number; p: Promise<SocialTrader | null> }>()
/** A wallet's verified numbers for every period, its ranks, PnL chart, coins and wash-trade flag (one request for every
 * part of a page that asks within 10 seconds). */
export function getVerifiedTrader(address: string): Promise<SocialTrader | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Promise.resolve(null)
  const a = address.toLowerCase()
  const hit = traderCache.get(a)
  if (hit && Date.now() - hit.at < 10_000) return hit.p
  if (traderCache.size > 200) traderCache.clear()
  const p = get<SocialTrader>(`/v1/social/trader/${a}`)
  traderCache.set(a, { at: Date.now(), p })
  return p
}

let flagsCache: { at: number; flags: Map<string, WashFlag> } | null = null
let flagsBusy: Promise<Map<string, WashFlag>> | null = null
/** Every wallet the wash-trade filter flags (read at most every minute). Empty when the engine can't be reached. */
export function getWashFlags(): Promise<Map<string, WashFlag>> {
  if (flagsCache && Date.now() - flagsCache.at < 60_000) return Promise.resolve(flagsCache.flags)
  if (flagsBusy) return flagsBusy
  flagsBusy = get<{ flags: WashFlag[] }>('/v1/social/flags').then(r => {
    const flags = new Map((r?.flags ?? []).map(f => [f.trader, f]))
    if (r) flagsCache = { at: Date.now(), flags }
    return flags
  }).finally(() => { flagsBusy = null })
  return flagsBusy
}

let modCache: { at: number; state: ModerationState } | null = null
let modBusy: Promise<ModerationState> | null = null
const EMPTY: ModerationState = { theses: [], banned: [] }
/** Theses hidden by reports or an admin, and banned wallets (read at most every 30 seconds). */
export function getModeration(): Promise<ModerationState> {
  if (modCache && Date.now() - modCache.at < 30_000) return Promise.resolve(modCache.state)
  if (modBusy) return modBusy
  // Short: every list of theses waits for it. An engine that doesn't answer leaves the last state (or none) for 30s.
  modBusy = get<ModerationState>('/v1/social/moderation', AbortSignal.timeout(3_000)).then(r => {
    const state = r ?? modCache?.state ?? EMPTY
    modCache = { at: Date.now(), state }
    return state
  }).finally(() => { modBusy = null })
  return modBusy
}
/** Reads the moderation state again on the next ask (after a report that may have hidden something). */
export function forgetModeration() { modCache = null }

/** A thesis's or a coin's comments, oldest first; null when they can't be read. */
export async function getComments(target: string): Promise<CommentV[] | null> {
  return (await get<{ comments: CommentV[] }>(`/v1/social/comments?target=${encodeURIComponent(target)}`))?.comments ?? null
}

/** How many comments each target has. */
export async function getCommentCounts(targets: string[]): Promise<Record<string, number>> {
  if (!targets.length) return {}
  return (await get<{ counts: Record<string, number> }>(`/v1/social/counts?targets=${targets.slice(0, 200).map(encodeURIComponent).join(',')}`))?.counts ?? {}
}

/** Whether the engine serves the social layer at all (an engine without it answers 404/503). */
export const socialAvailable = () => !!engineApiUrl
