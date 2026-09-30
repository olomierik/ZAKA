// What each kind of signal makes at live speed (2026-09-30, owner: "the live
// bots are making losses: read the logs, find out the reason").
//
// The reason: a live bot's buy lands about 2.5s after its signal and a sale
// about 2s after its trigger, and snipes make their move in those seconds.
// Paper filled at once, so paper showed wins live bots couldn't get. Replayed
// on the coins' real trades, the last 40 signals averaged −5.6% a trade at
// instant fills and −3.7% at live speed (snipes: +16% and −1.3%); five live
// trades on two signals (BAGEY, ASTONKA) all lost.
//
// So every signal is replayed on its coin's real trades, bought and sold at
// live speed (trading/paper.ts LIVE_SPEED, the same exits a new bot trades
// with), and live bots trade a kind of signal only while its last replays make
// money: 10 or more, averaging at least +0.5% a trade after costs. Until then
// its signals go to paper bots only, which keep measuring it; live trading
// resumes by itself when one qualifies. Nothing here promises a profit: it
// keeps real money out of what is losing at the speed real money trades.

import { LIVE_SPEED, onPrice, openPosition, type Strategy, type StrategyParams } from '../trading/paper'

export const LIVE_GATE = {
  /** Replays counted: the last this many of a kind, within this many days. */
  window: 20,
  days: 7,
  /** Live bots trade a kind with at least this many replays, averaging at least this return a trade. */
  minTrades: 10,
  minAvgReturn: 0.005,
}

export interface Tick { ts: number; price: number }

export interface Replay {
  /** The return of a buy at live speed, after costs (0.05 = +5%); null: not bought (the price moved too far first). */
  ret: number | null
  reason: string
  /** Whether it's settled: an exit happened, or the longest hold passed. */
  final: boolean
}

/** Replays a signal on its coin's trades (oldest first) at live speed. */
export function replayAtLiveSpeed(rows: Tick[], o: { at: number; price: number; roundTripPct: number | null; exits: StrategyParams; now: number; speed?: typeof LIVE_SPEED }): Replay {
  const speed = o.speed ?? LIVE_SPEED
  const entry = rows.find(r => r.ts >= o.at + speed.entryMs && r.price > 0)
  if (!entry) return { ret: null, reason: 'no trade yet to buy at', final: o.now - o.at > 10 * 60_000 }
  if (Math.abs(entry.price / o.price - 1) > speed.maxDrift) return { ret: null, reason: 'skipped: the price moved over 5% first', final: true }
  const pos = openPosition({ id: 'replay', strategy: 'snipe', token: '', symbol: '', launchpad: '', signalId: '', price: entry.price, cost: (o.roundTripPct ?? 4) / 200, now: entry.ts, params: { ...o.exits, sizeUsd: 100 } })
  pos.exits = o.exits
  for (const r of rows) {
    if (r.ts <= entry.ts) continue
    onPrice(pos, r.price, r.ts, o.exits, speed.exitMs)
    if (pos.status === 'closed') break
  }
  if (pos.status === 'closed') return { ret: (pos.pnlUsd ?? 0) / pos.sizeUsd, reason: pos.exitReason ?? 'closed', final: true }
  // Still open: settled once its longest hold has passed, at the last price.
  const last = rows[rows.length - 1]
  const held = o.now - entry.ts
  const value = pos.remaining * last.price * (1 - pos.cost)
  const sold = pos.fills.filter(f => f.reason !== 'entry').reduce((sum, f) => sum + f.usd, 0)
  const ret = (sold + value - pos.sizeUsd) / pos.sizeUsd
  return { ret, reason: 'open', final: held >= (o.exits.maxHoldMin ?? 60) * 60_000 }
}

export interface ReplayResult { signalId: string; key: string; at: number; ret: number }

/** Each kind's replays (`${rule}/${strategy}`), and whether live bots may trade it. */
export class LiveSpeedBook {
  private results = new Map<string, ReplayResult>()
  /** Signals looked at and found not bought (moved too far first): not counted, not asked again. */
  private skipped = new Set<string>()

  has(signalId: string) { return this.results.has(signalId) || this.skipped.has(signalId) }
  add(r: ReplayResult) { this.results.set(r.signalId, r) }
  skip(signalId: string) { this.skipped.add(signalId) }

  record(key: string, now = Date.now()): LiveSpeedRecord {
    const list = [...this.results.values()].filter(r => r.key === key && now - r.at <= LIVE_GATE.days * 86_400_000).sort((a, b) => a.at - b.at).slice(-LIVE_GATE.window)
    const n = list.length
    const wins = list.filter(r => r.ret > 0).length
    const avg = n ? list.reduce((s, r) => s + r.ret, 0) / n : null
    return { key, trades: n, wins, winRate: n ? wins / n : null, avgReturn: avg, ok: n >= LIVE_GATE.minTrades && (avg ?? 0) >= LIVE_GATE.minAvgReturn }
  }

  keys() { return [...new Set([...this.results.values()].map(r => r.key))].sort() }
  get size() { return this.results.size }
}

export interface LiveSpeedRecord { key: string; trades: number; wins: number; winRate: number | null; avgReturn: number | null; ok: boolean }

export const liveKey = (rule: string | null | undefined, strategy: Strategy) => `${rule ?? strategy}/${strategy}`
