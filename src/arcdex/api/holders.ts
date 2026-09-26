// True holder counts from ARCDEX's own on-chain index (/api/holders).
// A token's first count is built in slices of a few seconds, so while it's
// incomplete this polls quickly (each call advances it); once complete it
// refreshes every 30s — each refresh only scans the blocks since the last.

import { useEffect, useRef, useState } from 'react'
import { RECENT_RPC, hex, rpcCall, type RawLog } from '../../../api/_arcLogs'
import { TRANSFER, deltasOf } from '../../../api/_holdersCore'
import { getHolderScans, getIndexedBalances, type HolderScan } from './social'

export interface ChainHolder {
  address: string
  balance: number
  pct: number | null
  /** 'pool' = Uniswap v4 PoolManager (the liquidity), 'burn' = 0x…dEaD */
  tag: 'pool' | 'burn' | null
}

export interface ChainHolders {
  holders: number
  top10Pct: number | null
  top: ChainHolder[]
  complete: boolean
  progress: number
  /** Last block the index covers. */
  scannedTo?: number
}

export function useChainHolders(token: string, createdAt: string | null | undefined): ChainHolders | null {
  const [data, setData] = useState<ChainHolders | null>(null)
  const hint = useRef<string | null | undefined>(createdAt)
  hint.current = createdAt

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    setData(null)
    const run = async () => {
      let next = 30_000
      try {
        const q = new URLSearchParams({ token: token.toLowerCase() })
        const created = hint.current ? Math.floor(Date.parse(hint.current) / 1000) : NaN
        if (Number.isFinite(created)) q.set('created', String(created))
        const res = await fetch(`/api/holders?${q}`)
        // 503: index not set up · 422: token not indexed — fall back to
        // GeckoTerminal's numbers for the rest of this visit.
        if (res.status === 503 || res.status === 422 || res.status === 400) return
        if (res.ok) {
          const d = (await res.json()) as ChainHolders
          if (alive) setData(d)
          if (!d.complete) next = 1_500
        } else next = 10_000
      } catch { next = 10_000 }
      // Background tabs refresh half as often.
      if (alive) timer = setTimeout(() => void run(), document.hidden ? next * 2 : next)
    }
    void run()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [token])

  return data
}

// ── live count ───────────────────────────────────────────────────────
// The index moves when /api/holders is asked (every 30s from a coin page,
// and its answer is CDN-cached), so between refreshes the count would sit
// still while wallets buy in and sell out. This adds the Transfers since the
// index's last block: each wallet they touch is looked up in the index — a
// wallet going from nothing to a balance is a new holder (+1), one selling
// everything is one fewer (−1).

export interface LiveDeps {
  scans: (tokens: string[]) => Promise<HolderScan[]>
  balances: (token: string, holders: string[]) => Promise<Map<string, bigint>>
  logs: (token: string, fromBlock: number) => Promise<RawLog[]>
}

const transferLogsSince = (token: string, fromBlock: number) =>
  rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ address: token.toLowerCase(), topics: [TRANSFER], fromBlock: hex(fromBlock), toBlock: 'latest' }], 8_000)

const defaultDeps: LiveDeps = { scans: getHolderScans, balances: getIndexedBalances, logs: transferLogsSince }

/** Wallet balances as of the index's block, reused until the index moves. */
export interface LiveCache { scannedTo: number; balances: Map<string, bigint> }

/** The live count; 'moved' when the index advanced mid-read (ask again);
 * null when the token isn't indexed (or there's no index). */
export async function liveHolderCount(token: string, cache: LiveCache, deps: LiveDeps = defaultDeps): Promise<number | 'moved' | null> {
  const t = token.toLowerCase()
  const s1 = (await deps.scans([t]))[0]
  if (!s1) return null
  if (cache.scannedTo !== s1.scanned_to) { cache.scannedTo = s1.scanned_to; cache.balances.clear() }
  const deltas = deltasOf(await deps.logs(t, s1.scanned_to + 1))
  const need = [...deltas.keys()].filter(a => !cache.balances.has(a))
  if (need.length) {
    const got = await deps.balances(t, need)
    // The balances table only changes together with scanned_to: the same
    // block before and after means these balances match the count.
    const s2 = (await deps.scans([t]))[0]
    if (!s2 || s2.scanned_to !== s1.scanned_to) return 'moved'
    for (const a of need) cache.balances.set(a, got.get(a) ?? 0n)
  }
  let n = s1.holders
  for (const [a, v] of deltas) {
    const before = cache.balances.get(a) ?? 0n
    const after = before + v
    if (before <= 0n && after > 0n) n++
    else if (before > 0n && after <= 0n) n--
  }
  return n
}

/** A token's holder count, live (see above). `enabled` once the index has
 * the token complete; `poke` (the newest trade's id) re-checks a moment
 * after each trade lands. Null until known. */
export function useLiveHolderCount(token: string, enabled: boolean, poke?: string | null): number | null {
  const [count, setCount] = useState<number | null>(null)
  const soon = useRef<(() => void) | null>(null)
  useEffect(() => {
    setCount(null)
    if (!enabled) return
    let alive = true
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cache: LiveCache = { scannedTo: -1, balances: new Map() }
    const schedule = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(), ms) }
    const run = async () => {
      if (!alive || running) return
      running = true
      let next = 6_000
      try {
        const r = await liveHolderCount(token, cache)
        if (r === 'moved') next = 1_000
        else if (r === null) next = 60_000
        else if (alive) setCount(r)
      } catch { next = 20_000 }
      running = false
      if (alive) schedule(document.hidden ? next * 3 : next)
    }
    soon.current = () => schedule(1_500)
    void run()
    return () => { alive = false; soon.current = null; if (timer) clearTimeout(timer) }
  }, [token, enabled])
  useEffect(() => { if (poke) soon.current?.() }, [poke])
  return count
}
