// What the owner's analytics count (engine/src/analytics.ts, /admin → Analytics): a wallet in use on the site, and every
// trade the site makes, on any chain. Fire and forget: a report that doesn't reach the engine never holds up a trade.
// The engine checks each trade on its own chain before counting it (the transaction succeeded, from this wallet), so a
// report is a pointer, not a claim. Nothing else about the visitor is sent.

import { engineApiUrl } from '../api/marketStream'

export type SigninKind = 'privy' | 'wallet' | 'trading' | 'solana'
export type TradeChain = 'arc' | 'robinhood' | 'solana' | 'bnb' | 'base' | 'arbitrum' | 'ethereum' | 'hyperliquid' | 'starknet'

export interface TradeReport {
  chain: TradeChain
  /** How it was traded: arc-router, arc-ur, arc-curve, launchpad, relay, across, jupiter, four, hyperliquid, avnu, copy… */
  venue: string
  side: 'buy' | 'sell'
  address: string
  /** The trade's size in dollars. */
  usd: number
  /** ARCDEX's fee on it, in dollars (0 where there is none). */
  feeUsd: number
  coin: string
  /** The transaction (a Solana signature, a Hyperliquid order id). */
  tx: string
}

function post(path: string, body: unknown) {
  if (!engineApiUrl || typeof window === 'undefined') return
  // text/plain keeps it a simple request: no preflight.
  void fetch(`${engineApiUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), keepalive: true }).catch(() => {})
}

const signedIn = new Set<string>()
/** A wallet in use on the site: once per wallet and page load. */
export function reportSignin(address: string | null | undefined, kind: SigninKind) {
  if (!address || signedIn.has(address)) return
  signedIn.add(address)
  post('/v1/analytics/signin', { address, kind })
}

/** A trade that went through. Sizes that aren't a positive number aren't sent. */
export function reportTrade(t: TradeReport) {
  if (!t.address || !t.tx || !(t.usd > 0) || !Number.isFinite(t.usd)) return
  post('/v1/analytics/trade', { ...t, feeUsd: Number.isFinite(t.feeUsd) && t.feeUsd > 0 ? t.feeUsd : 0 })
}

/** A chain id as analytics names it (null for one it doesn't count). */
export function chainOfId(id: number): TradeChain | null {
  return ({ 5042: 'arc', 56: 'bnb', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum', 1: 'ethereum' } as Record<number, TradeChain>)[id] ?? null
}
