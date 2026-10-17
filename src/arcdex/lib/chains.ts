// The terminal's chains (2026-10-12, motion.gift's layout): the chain picked in the top bar's network menu and the
// Trenches chips, kept in this browser. (Each chain's nodes: lib/rpcSettings.ts.)

import { useSyncExternalStore } from 'react'

export type TChain = 'arc' | 'hood' | 'sol' | 'bnb'

export interface ChainInfo {
  id: TChain
  /** The chip's label (motion's: HOOD, SOL, BNB). */
  short: string
  name: string
  /** The gas coin's ticker, and Hyperliquid's coin for its price (null: a dollar). */
  native: string
  nativeHl: string | null
  /** What a quick buy is counted in, and its default. */
  quote: 'USDC' | 'SOL' | 'BNB'
  quickDefault: number
  explorer: string
  /** A token's page on the explorer. */
  tokenUrl: (address: string) => string
}

export const CHAINS: Record<TChain, ChainInfo> = {
  arc: {
    id: 'arc', short: 'ARC', name: 'Arc', native: 'USDC', nativeHl: null, quote: 'USDC', quickDefault: 5,
    explorer: 'https://explorer.arc.io', tokenUrl: a => `https://explorer.arc.io/address/${a}`,
  },
  hood: {
    id: 'hood', short: 'HOOD', name: 'Robinhood Chain', native: 'ETH', nativeHl: 'ETH', quote: 'USDC', quickDefault: 5,
    explorer: 'https://robinhoodchain.blockscout.com', tokenUrl: a => `https://robinhoodchain.blockscout.com/token/${a}`,
  },
  sol: {
    id: 'sol', short: 'SOL', name: 'Solana', native: 'SOL', nativeHl: 'SOL', quote: 'SOL', quickDefault: 0.05,
    explorer: 'https://solscan.io', tokenUrl: a => `https://solscan.io/token/${a}`,
  },
  bnb: {
    id: 'bnb', short: 'BNB', name: 'BNB Chain', native: 'BNB', nativeHl: 'BNB', quote: 'BNB', quickDefault: 0.01,
    explorer: 'https://bscscan.com', tokenUrl: a => `https://bscscan.com/token/${a}`,
  },
}
export const CHAIN_LIST: TChain[] = ['arc', 'hood', 'sol', 'bnb']

// ── the chain picked ─────────────────────────────────────────────────────

const KEY = 'arcdex:chain'
const EVENT = 'arcdex:chain'
const isChain = (v: unknown): v is TChain => v === 'arc' || v === 'hood' || v === 'sol' || v === 'bnb'

function read(): TChain {
  try { const v = localStorage.getItem(KEY); return isChain(v) ? v : 'arc' } catch { return 'arc' }
}
let current: TChain = read()

export const getChain = () => current
export function setChain(c: TChain) {
  if (c === current) return
  current = c
  try { localStorage.setItem(KEY, c) } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVENT))
}
function subscribe(f: () => void) {
  window.addEventListener(EVENT, f)
  return () => window.removeEventListener(EVENT, f)
}
export function useChain(): TChain {
  return useSyncExternalStore(subscribe, getChain, () => 'arc')
}
