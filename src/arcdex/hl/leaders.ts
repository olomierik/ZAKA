// Hyperliquid's top traders (the engine's /api/hlleaders, from Hyperliquid's own leaderboard), and any account's
// track record from Hyperliquid's API (its value and P&L over time, positions and fills: public venue data).

import { siteFetch } from '../api/siteFetch'
import type { HlLeaders, HlWindow } from '../../../api/hlleaders'
import { hlInfo } from './client'

export type { HlLeaders, HlLeader, HlWindow } from '../../../api/hlleaders'

let cache: { at: number; data: HlLeaders } | null = null

/** The leaderboard, at most a minute old here (the engine refreshes it every 10 minutes). */
export async function loadLeaders(): Promise<HlLeaders> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data
  const r = await siteFetch('/api/hlleaders')
  if (!r.ok) throw new Error(`leaderboard ${r.status}`)
  const data = (await r.json()) as HlLeaders
  if (!Array.isArray(data.rows)) throw new Error('leaderboard unreadable')
  cache = { at: Date.now(), data }
  return data
}

/** Hyperliquid's own history for an account: per window, its value and P&L over time (ms, USD). */
export interface HlHistory { value: [number, number][]; pnl: [number, number][]; volume: number }
type RawPortfolio = [string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][]; vlm?: string }][]

export async function loadHistory(user: string): Promise<Partial<Record<HlWindow, HlHistory>>> {
  const raw = await hlInfo<RawPortfolio>({ type: 'portfolio', user })
  const out: Partial<Record<HlWindow, HlHistory>> = {}
  for (const [name, h] of raw ?? []) {
    // Hyperliquid also returns perp-only windows ("perpDay", …); the totals are the plain names.
    if (name !== 'day' && name !== 'week' && name !== 'month' && name !== 'allTime') continue
    out[name] = {
      value: (h.accountValueHistory ?? []).map(([t, v]) => [t, Number(v)] as [number, number]),
      pnl: (h.pnlHistory ?? []).map(([t, v]) => [t, Number(v)] as [number, number]),
      volume: Number(h.vlm ?? 0),
    }
  }
  return out
}

export interface HlTraderFill { coin: string; px: number; sz: number; side: 'B' | 'A'; time: number; dir: string; closedPnl: number; hash: string; tid: number }

/** An account's latest fills (Hyperliquid keeps its newest 2,000), newest first. */
export async function loadFills(user: string, limit = 60): Promise<HlTraderFill[]> {
  const raw = await hlInfo<Record<string, unknown>[]>({ type: 'userFills', user, aggregateByTime: true })
  return (raw ?? []).map(f => ({
    coin: String(f.coin), px: Number(f.px), sz: Number(f.sz), side: f.side as 'B' | 'A', time: Number(f.time), dir: String(f.dir ?? ''),
    closedPnl: Number(f.closedPnl ?? 0), hash: String(f.hash ?? ''), tid: Number(f.tid),
  })).sort((a, b) => b.time - a.time).slice(0, limit)
}
