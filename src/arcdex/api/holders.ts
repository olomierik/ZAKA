// True holder counts from ARCDEX's own on-chain index (/api/holders).
// A token's first count is built in slices of a few seconds, so while it's
// incomplete this polls quickly (each call advances it); once complete it
// refreshes every 30s — each refresh only scans the blocks since the last.

import { useEffect, useRef, useState } from 'react'

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
