// The engine's safety scan for the coins a page shows (GET /v1/safety?tokens=…, engine/src/bot/boardSafety.ts), every
// 20 seconds while the tab is visible: coins not scanned yet come back as scanned on a later ask. An answer of null is a
// coin the engine doesn't track; with the engine unreachable, every coin is null, and the site rates it from its market
// data alone (lib/safety.ts).

import { useEffect, useMemo, useState } from 'react'
import type { CoinSafety } from '../../../api/_marketProtocol'
import { engineApiUrl } from './marketStream'

const EVERY_MS = 20_000
/** Coins one request asks for (the engine's BOARD.maxTokens). */
const CHUNK = 120

async function ask(tokens: string[]): Promise<Record<string, CoinSafety | null> | null> {
  if (!engineApiUrl || !tokens.length) return null
  const out: Record<string, CoinSafety | null> = {}
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const res = await fetch(`${engineApiUrl}/v1/safety?tokens=${tokens.slice(i, i + CHUNK).join(',')}`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    Object.assign(out, ((await res.json()) as { safety?: Record<string, CoinSafety | null> }).safety ?? {})
  }
  return out
}

/** token (lower case) → its scan: undefined until the first answer, null when the engine can't say. */
export function useCoinSafety(tokens: string[]): Map<string, CoinSafety | null> {
  const key = useMemo(() => [...new Set(tokens.map(t => t.toLowerCase()))].sort().join(','), [tokens])
  const [map, setMap] = useState<Map<string, CoinSafety | null>>(new Map())
  useEffect(() => {
    const list = key ? key.split(',') : []
    if (!list.length) return
    let live = true
    const load = () => ask(list).then(r => {
      if (!live) return
      setMap(prev => {
        const next = new Map(prev)
        // Unreachable: what it said before stands; a coin it never answered for is rated from its market data.
        for (const t of list) next.set(t, r ? r[t] ?? null : next.has(t) ? next.get(t)! : null)
        return next
      })
    }).catch(() => { if (live) setMap(prev => { const next = new Map(prev); for (const t of list) if (!next.has(t)) next.set(t, null); return next }) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, EVERY_MS)
    return () => { live = false; clearInterval(id) }
  }, [key])
  return map
}
