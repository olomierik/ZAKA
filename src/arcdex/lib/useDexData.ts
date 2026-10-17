// The Trenches' rows with DexScreener's numbers and links (lib/dexData.ts), refreshed every 10 seconds while the tab is
// visible, for the coins the lanes show.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TChain } from './chains'
import type { TrenchCoin } from './trenches'
import { dsCoins, type DsCoin } from './dexData'

export const DS_REFRESH_MS = 10_000
/** A launch this young keeps the engine's own numbers (its feed is ahead of any indexer). */
const ENGINE_FIRST_MS = 10 * 60_000

export function useDsCoins(chain: TChain, addresses: string[]): Map<string, DsCoin | null> {
  const [map, setMap] = useState<Map<string, DsCoin | null>>(new Map())
  const want = useRef(addresses)
  want.current = addresses
  const sig = addresses.slice(0, 400).join(',')
  useEffect(() => {
    let live = true
    const read = () => {
      if (document.hidden || !want.current.length) return
      void dsCoins(chain, want.current.slice(0, 400)).then(m => { if (live && m.size) setMap(prev => new Map([...prev, ...m])) })
    }
    read()
    const id = setInterval(read, DS_REFRESH_MS)
    return () => { live = false; clearInterval(id) }
  // Re-read when the set of coins shown changes; the interval keeps them fresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, sig])
  useEffect(() => setMap(new Map()), [chain])
  return map
}

/** A row with DexScreener's coin: links and picture always (when the row has none), the last hour's numbers, and its
 * market numbers except on Arc (the engine reads every Arc swap itself) and for launches under 10 minutes old. */
export function withDs(c: TrenchCoin, d: DsCoin | null | undefined, now = Date.now()): TrenchCoin {
  if (!d) return c
  const own = c.chain === 'arc' || (c.createdAt > 0 && now - c.createdAt < ENGINE_FIRST_MS)
  const out: TrenchCoin = {
    ...c,
    image: c.image ?? d.image,
    twitter: c.twitter ?? d.twitter,
    website: c.website ?? d.website,
    telegram: c.telegram ?? d.telegram,
    hour: c.hour ?? (d.buys1h + d.sells1h > 0 || d.volume1h > 0 ? { vol: d.volume1h, buys: d.buys1h, sells: d.sells1h } : null),
  }
  if (own) return out
  return {
    ...out,
    marketCap: d.marketCap > 0 ? d.marketCap : c.marketCap,
    liquidity: d.liquidity > 0 ? d.liquidity : c.liquidity,
    volume24h: d.volume24h > 0 ? d.volume24h : c.volume24h,
    buys24h: d.buys24h + d.sells24h > 0 ? d.buys24h : c.buys24h,
    sells24h: d.buys24h + d.sells24h > 0 ? d.sells24h : c.sells24h,
    change1h: d.change1h || c.change1h,
    change24h: d.change24h || c.change24h,
  }
}

/** The addresses the lanes show, for useDsCoins. */
export function useShownAddresses(lanes: TrenchCoin[][]): string[] {
  return useMemo(() => [...new Set(lanes.flatMap(l => l.slice(0, 60).map(c => c.address)))], [lanes])
}
