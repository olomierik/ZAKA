// The Trenches' live feed from the market engine (api/_trenchProtocol.ts; engine/src/trench): a chain's launches
// within seconds, each followed coin's trades once a second (the rows' flashes and amount pops, their price, market
// cap and progress), and the smart-money view (the coins smart wallets are buying now, their latest trades).
// One subscription per chain on the shared socket (marketStream.ts), with GET /v1/trench/<chain> for what came before.
// Without the engine it stays empty, and the lanes run on their lists as before.

import { useEffect, useRef, useState } from 'react'
import type { SmartTradeWire, TrenchChain, TrenchCoinWire, TrenchSmartView, TrenchSnapshot } from '../../../api/_trenchProtocol'
import { engineApiUrl, engineEnabled, marketStream } from './marketStream'

/** A coin's latest from the feed: its price, market cap and progress, and what it traded since the page opened. */
export interface LiveTick { p: number; m: number; g: number | null; b: number; x: number; bu: number; xu: number; at: number }
/** The last trade's flash on a coin: its side, a counter whose parity restarts the animation, and its dollars. */
export interface LiveFlash { side: 'buy' | 'sell'; n: number; usd: number | null }

export interface TrenchFeed {
  /** The engine answered (and the socket is open). */
  on: boolean
  live: boolean
  perMin: number
  launches: TrenchCoinWire[]
  ticks: Map<string, LiveTick>
  flash: Map<string, LiveFlash>
  smart: TrenchSmartView | null
  /** Smart wallets' trades that came in since the last snapshot, newest first. */
  smartLive: SmartTradeWire[]
}

const EMPTY: TrenchFeed = { on: false, live: false, perMin: 0, launches: [], ticks: new Map(), flash: new Map(), smart: null, smartLive: [] }
const MAX_LAUNCHES = 400

/** EVM addresses are compared in lower case; Solana's base58 keeps its case. */
export const keyOf = (chain: TrenchChain, a: string) => (chain === 'sol' ? a : a.toLowerCase())

async function snapshot(chain: TrenchChain): Promise<TrenchSnapshot | null> {
  if (!engineApiUrl) return null
  const r = await fetch(`${engineApiUrl}/v1/trench/${chain}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
  return r?.ok ? ((await r.json()) as TrenchSnapshot) : null
}

export function useTrenchFeed(chain: TrenchChain): TrenchFeed {
  const [state, setState] = useState<TrenchFeed>(EMPTY)
  const ref = useRef<TrenchFeed>(EMPTY)
  const dirty = useRef(false)

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    const cur = { ...EMPTY, ticks: new Map<string, LiveTick>(), flash: new Map<string, LiveFlash>(), launches: [] as TrenchCoinWire[], smartLive: [] as SmartTradeWire[] }
    ref.current = cur
    setState(cur)
    const touch = () => { dirty.current = true }
    // Renders at most every 400 ms, however busy the chain.
    const paint = setInterval(() => {
      if (!dirty.current || !alive || document.hidden) return
      dirty.current = false
      setState({ ...ref.current, ticks: new Map(ref.current.ticks), flash: new Map(ref.current.flash), launches: [...ref.current.launches], smartLive: [...ref.current.smartLive] })
    }, 400)

    const load = async () => {
      const s = await snapshot(chain)
      if (!alive || !s) return
      const f = ref.current
      // The engine's numbers replace the page's for coins it lists; launches it no longer keeps stay until they age out.
      const fresh = new Map(s.launches.map(l => [keyOf(chain, l.a), l]))
      f.launches = [...s.launches, ...f.launches.filter(l => !fresh.has(keyOf(chain, l.a)))].sort((a, b) => b.c - a.c).slice(0, MAX_LAUNCHES)
      f.smart = s.smart
      f.smartLive = f.smartLive.filter(t => t.ts > (s.smart.trades[0]?.ts ?? 0))
      f.live = s.live
      f.perMin = s.perMin
      f.on = true
      touch()
    }
    void load()
    const reload = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    let soon: ReturnType<typeof setTimeout> | null = null

    const off = marketStream.subscribe({ channel: `trench_${chain}` }, m => {
      const f = ref.current
      if (m.t === 'TLAUNCH') {
        const k = keyOf(chain, m.d.a)
        f.launches = [m.d, ...f.launches.filter(l => keyOf(chain, l.a) !== k)].slice(0, MAX_LAUNCHES)
        f.live = true
      } else if (m.t === 'TTICKS') {
        const now = Date.now()
        const launched = new Map(f.launches.map(l => [keyOf(chain, l.a), l]))
        for (const [token, b, x, bu, xu, p, mc, g, big] of m.d) {
          const k = keyOf(chain, token)
          const l = launched.get(k)
          if (l) {
            // A coin launched while watching: its own numbers move with each second's trades.
            Object.assign(l, { p: p || l.p, m: mc || l.m, g: g >= 0 ? g : l.g, b: l.b + b, x: l.x + x, v: l.v + bu + xu })
            if (!l.o && p) l.o = p
            if (g >= 100) l.gr = true
          }
          const prev = f.ticks.get(k)
          f.ticks.set(k, { p: p || prev?.p || 0, m: mc || prev?.m || 0, g: g >= 0 ? g : prev?.g ?? null, b: (prev?.b ?? 0) + b, x: (prev?.x ?? 0) + x, bu: (prev?.bu ?? 0) + bu, xu: (prev?.xu ?? 0) + xu, at: now })
          const side: 'buy' | 'sell' = big < 0 || (big === 0 && x > b) ? 'sell' : 'buy'
          f.flash.set(k, { side, n: (f.flash.get(k)?.n ?? 0) + 1, usd: Math.abs(big) || null })
        }
        f.live = true
      } else if (m.t === 'TSMART') {
        f.smartLive = [m.d, ...f.smartLive].slice(0, 60)
        // The "buying now" view is the engine's: ask again shortly after a smart trade.
        if (!soon) soon = setTimeout(() => { soon = null; void load() }, 2_500)
      } else if (m.t === 'TMETA') {
        const k = keyOf(chain, m.d.a)
        f.launches = f.launches.map(l => (keyOf(chain, l.a) === k ? { ...l, i: m.d.i } : l))
      } else return
      touch()
    })
    return () => { alive = false; off(); clearInterval(paint); clearInterval(reload); if (soon) clearTimeout(soon) }
  }, [chain])

  return state
}
