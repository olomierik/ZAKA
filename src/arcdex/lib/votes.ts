// Community sentiment on each coin, as DexScreener shows it (engine/src/votes.ts, 2026-10-06): 🚀 🔥 💩 🚩.
// The visitor is the random id the traffic counter already keeps in this browser (lib/traffic.ts); this browser also
// remembers its own vote on each coin, to light it up.

import { engineApiUrl } from '../api/marketStream'
import { visitorId } from './traffic'

export const VOTE_KINDS = ['rocket', 'fire', 'poop', 'flag'] as const
export type VoteKind = (typeof VOTE_KINDS)[number]
export type VoteCounts = Record<VoteKind, number>
export type VoteChain = 'arc' | 'solana' | 'bsc' | 'robinhood'

const MINE = 'arcdex:votes'
const KEEP = 300

const keyOf = (chain: VoteChain, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`

function readMine(): Record<string, VoteKind> {
  try { return JSON.parse(localStorage.getItem(MINE) ?? '{}') as Record<string, VoteKind> } catch { return {} }
}

/** This browser's vote on the coin, if it has one. */
export function myVote(chain: VoteChain, address: string): VoteKind | null {
  const v = readMine()[keyOf(chain, address)]
  return (VOTE_KINDS as readonly string[]).includes(v) ? v : null
}

function saveMine(chain: VoteChain, address: string, vote: VoteKind | null) {
  try {
    const all = readMine()
    const k = keyOf(chain, address)
    delete all[k]
    if (vote) all[k] = vote
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[old]
    localStorage.setItem(MINE, JSON.stringify(all))
  } catch { /* storage blocked: the vote still counts, it just isn't lit up next time */ }
}

export const votesAvailable = () => !!engineApiUrl

/** The coin's counts; null when the engine can't be reached. */
export async function getVotes(chain: VoteChain, address: string, signal?: AbortSignal): Promise<VoteCounts | null> {
  if (!engineApiUrl) return null
  try {
    const r = await fetch(`${engineApiUrl}/v1/votes?chain=${chain}&address=${encodeURIComponent(address)}`, { signal })
    if (!r.ok) return null
    return ((await r.json()) as { counts: VoteCounts }).counts
  } catch { return null }
}

/** Votes (or, with null, takes this browser's vote back). The counts after it; throws with the engine's reason. */
export async function castVote(chain: VoteChain, address: string, vote: VoteKind | null): Promise<VoteCounts> {
  if (!engineApiUrl) throw new Error('unavailable')
  // text/plain keeps it a simple request: no preflight.
  const r = await fetch(`${engineApiUrl}/v1/votes`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ chain, address, id: visitorId(), vote }),
  })
  const body = await r.json().catch(() => null) as { counts?: VoteCounts; error?: string } | null
  if (!r.ok || !body?.counts) throw new Error(body?.error ?? `HTTP ${r.status}`)
  saveMine(chain, address, vote)
  return body.counts
}

/** The counts as they'd be after switching from `from` to `to` (shown at once, before the engine answers). */
export function applyVote(counts: VoteCounts, from: VoteKind | null, to: VoteKind | null): VoteCounts {
  const next = { ...counts }
  if (from) next[from] = Math.max(0, next[from] - 1)
  if (to) next[to] += 1
  return next
}

/** Share of the votes that are 🚀 or 🔥, 0–100; null with no votes. */
export function bullishPct(c: VoteCounts): number | null {
  const total = c.rocket + c.fire + c.poop + c.flag
  return total ? Math.round(((c.rocket + c.fire) / total) * 100) : null
}
