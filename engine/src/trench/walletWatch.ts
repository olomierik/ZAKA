// The wallet tracker (api/_trenchProtocol.ts, "the wallet tracker"): every trade the Trenches' books read on Arc,
// Robinhood Chain, Solana and BNB Chain passes through here, and a trade by a wallet someone follows is pushed to that
// wallet's topic at once and kept. Nothing is kept for wallets nobody follows: a wallet's trades are kept from the
// first time it's watched (a subscription, or a look at its page) until a day without anyone watching it.

import { tradeTopic, walletTopic, type TrenchChain, type WalletTradeWire } from '../../../api/_trenchProtocol'
import type { FeedTrade } from './book'

/** Trades kept per watched wallet, and how long one is kept after nobody watches it. */
export const WATCH = { keep: 100, idleMs: 24 * 3_600_000, maxWallets: 5_000 } as const

interface Watched { trades: WalletTradeWire[]; touched: number }

export interface WalletWatchOpts {
  /** Whether anyone is subscribed to a topic. */
  wants: (topic: string) => boolean
  publish: (topic: string, d: WalletTradeWire) => void
}

const round2 = (n: number) => Math.round(n * 100) / 100

export class WalletWatch {
  private watched = new Map<string, Watched>()
  constructor(private o: WalletWatchOpts) {}

  /** A trade from a chain's book, with its coin's name as the book knows it. */
  record(chain: TrenchChain, t: FeedTrade, meta: { symbol: string; image: string | null; mcap: number } | null, now = Date.now()) {
    if (!t.wallet) return
    const topic = tradeTopic(chain, t.wallet)
    const live = this.o.wants(topic)
    let w = this.watched.get(topic)
    if (!w && !live) return
    if (!w) { w = { trades: [], touched: now }; this.watched.set(topic, w); this.trim(now) }
    if (live) w.touched = now
    const d: WalletTradeWire = {
      c: chain, w: t.wallet, t: t.token, s: meta?.symbol || t.meta?.symbol || '', i: meta?.image ?? t.meta?.image ?? null,
      side: t.side === 'buy' ? 'B' : 'S', u: round2(t.usd), n: t.tokens, ts: t.ts, m: Math.round(t.mcapUsd ?? meta?.mcap ?? 0),
    }
    w.trades.push(d)
    if (w.trades.length > WATCH.keep) w.trades.splice(0, w.trades.length - WATCH.keep)
    if (live) this.o.publish(topic, d)
  }

  /** A wallet's kept trades, newest first; starts keeping them if nobody had yet. Null for an address that's neither. */
  view(address: string, now = Date.now()): WalletTradeWire[] | null {
    const topic = walletTopic(address)
    if (!topic) return null
    let w = this.watched.get(topic)
    if (!w) { w = { trades: [], touched: now }; this.watched.set(topic, w); this.trim(now) }
    w.touched = now
    return [...w.trades].reverse()
  }

  size() { return this.watched.size }

  /** Drops wallets nobody watched for a day, then the longest-idle ones past the cap. */
  private trim(now: number) {
    for (const [k, w] of this.watched) if (now - w.touched > WATCH.idleMs && !this.o.wants(k)) this.watched.delete(k)
    if (this.watched.size <= WATCH.maxWallets) return
    const idle = [...this.watched.entries()].filter(([k]) => !this.o.wants(k)).sort((a, b) => a[1].touched - b[1].touched)
    for (const [k] of idle.slice(0, this.watched.size - WATCH.maxWallets)) this.watched.delete(k)
  }
}
