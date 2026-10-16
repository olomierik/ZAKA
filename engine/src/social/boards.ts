// Leaderboards and trader profiles from the verified trade book (book.ts, pnl.ts), with the wash-trade filter
// (wash.ts). Worked out from memory at most every 30 seconds per board, and whenever the book grows.

import { BOARD_MIN, PNL_METHOD, SOCIAL_PERIODS, type LeaderRowV, type SocialBoard, type SocialPeriod, type SocialStats, type SocialTrader, type WashFlag } from '../../../api/_socialProtocol'
import { historyOf, periodStart, positionsOf, statsOf, walk, type BookTrade } from './pnl'
import { washFlags } from './wash'

export interface BookView {
  version: number
  all(): BookTrade[]
  of(trader: string): BookTrade[]
  traders(): string[]
  scannedTo(): Promise<number>
  checkedTo(): Promise<number>
}

const CACHE_MS = 30_000
const micro = (s: string) => BigInt(s.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1'))

export class SocialBoards {
  private flagCache: { version: number; at: number; flags: Map<string, WashFlag> } | null = null
  private boardCache = new Map<SocialPeriod, { version: number; at: number; ranked: LeaderRowV[]; excluded: SocialBoard['excluded']; thin: number }>()

  constructor(private book: BookView) {}

  /** The wash-trade flags over the last 30 days, worked out again when the book grows (or after 30 s). */
  flags(now = Date.now()): Map<string, WashFlag> {
    const c = this.flagCache
    if (c && c.version === this.book.version && now - c.at < CACHE_MS) return c.flags
    const flags = washFlags(this.book.all(), now)
    this.flagCache = { version: this.book.version, at: now, flags }
    return flags
  }

  private ranked(period: SocialPeriod, now: number) {
    const c = this.boardCache.get(period)
    if (c && c.version === this.book.version && now - c.at < CACHE_MS) return c
    const since = periodStart(period, now)
    const flags = this.flags(now)
    const rows: { trader: string; stats: SocialStats }[] = []
    const excluded: SocialBoard['excluded'] = []
    let thin = 0
    for (const trader of this.book.traders()) {
      const trades = this.book.of(trader)
      if (!trades.some(t => t.at >= since)) continue
      const stats = statsOf(trades, since)
      if (stats.trades < BOARD_MIN.trades || stats.counted < BOARD_MIN.sells) { thin++; continue }
      const f = flags.get(trader)
      if (f) { excluded.push({ trader, reasons: f.reasons, realized: stats.realized }); continue }
      rows.push({ trader, stats })
    }
    rows.sort((a, b) => {
      const d = micro(b.stats.realized) - micro(a.stats.realized)
      if (d !== 0n) return d > 0n ? 1 : -1
      const v = micro(b.stats.volume) - micro(a.stats.volume)
      return v > 0n ? 1 : v < 0n ? -1 : a.trader < b.trader ? -1 : 1
    })
    const out = { version: this.book.version, at: now, ranked: rows.map((r, i) => ({ rank: i + 1, ...r })), excluded, thin }
    this.boardCache.set(period, out)
    return out
  }

  async board(period: SocialPeriod, limit = 100, now = Date.now()): Promise<SocialBoard> {
    const r = this.ranked(period, now)
    return {
      at: now, period, method: PNL_METHOD, scannedTo: await this.book.scannedTo(), checkedTo: await this.book.checkedTo(),
      rows: r.ranked.slice(0, Math.max(1, Math.min(500, limit))), excluded: r.excluded.slice(0, 100), thin: r.thin,
    }
  }

  /** The board's ranks of some wallets (for the site's other boards), and the flagged ones among them. */
  rankOf(trader: string, period: SocialPeriod, now = Date.now()): number | null {
    const r = this.ranked(period, now).ranked.find(x => x.trader === trader)
    return r ? r.rank : null
  }

  async trader(address: string, now = Date.now()): Promise<SocialTrader> {
    const trader = address.toLowerCase()
    const trades = this.book.of(trader)
    const walked = walk(trades)
    const periods = Object.fromEntries(SOCIAL_PERIODS.map(p => [p, statsOf(trades, periodStart(p, now), walked)])) as Record<SocialPeriod, SocialStats>
    const ranks = Object.fromEntries(SOCIAL_PERIODS.map(p => [p, this.rankOf(trader, p, now)])) as Record<SocialPeriod, number | null>
    return {
      at: now, trader, method: PNL_METHOD, scannedTo: await this.book.scannedTo(), checkedTo: await this.book.checkedTo(),
      periods, ranks, wash: this.flags(now).get(trader) ?? null,
      history: historyOf(walked), positions: positionsOf(walked).slice(0, 200), tradeCount: trades.length,
    }
  }
}
