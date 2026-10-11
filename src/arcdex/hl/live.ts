// Live Hyperliquid market data for the pages, from its WebSocket (one shared socket, client.ts): mids for every
// listed dex (and the outcome markets), a coin's live numbers, its order book and trades, what an account can trade
// a coin with, and candles that move with every trade. The market list itself (asset ids, size decimals, leverage)
// comes from the REST API every 30 seconds, shared by every component that asks, and is kept in the browser so a
// returning visitor's list paints at once.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle } from '../lib/candles'
import type { ChartResolution, ChartSource } from '../components/PriceChart'
import { hlInfo, hlSubscribe, onHlSocket } from './client'
import { HL_DEXES, loadOutcomes, loadPerpMarkets, type HlMarket, type OutcomeGroup } from './markets'

// ── the market list ──────────────────────────────────────────────────────

const LIST_KEY = 'arcdex:hl-markets:v1'
const LIST_MS = 30_000

interface ListStore { data: HlMarket[] | null; at: number; error: string | null; loading: Promise<void> | null }
const list: ListStore = { data: null, at: 0, error: null, loading: null }
const listListeners = new Set<() => void>()

try {
  const raw = localStorage.getItem(LIST_KEY)
  if (raw) {
    const c = JSON.parse(raw) as { at: number; data: HlMarket[] }
    // A day-old list still has the right assets; its prices are replaced by the live mids at once.
    if (Date.now() - c.at < 86_400_000 && Array.isArray(c.data) && c.data.length) list.data = c.data
  }
} catch { /* storage blocked */ }

function refreshList(): Promise<void> {
  if (list.loading) return list.loading
  list.loading = loadPerpMarkets()
    .then(d => {
      if (d.length) {
        list.data = d; list.at = Date.now(); list.error = null
        try { localStorage.setItem(LIST_KEY, JSON.stringify({ at: list.at, data: d })) } catch { /* full or blocked */ }
      } else if (!list.data) list.error = 'Hyperliquid didn’t answer'
    })
    .catch(e => { list.error = String((e as Error).message ?? e) })
    .finally(() => { list.loading = null; for (const f of listListeners) f() })
  return list.loading
}

/** Every listed perp market (core, xyz, io), refreshed every 30 seconds while a page shows it. */
export function useHlMarkets(): { markets: HlMarket[] | null; error: string | null } {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump(x => x + 1)
    listListeners.add(f)
    if (Date.now() - list.at > LIST_MS) void refreshList()
    const id = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - list.at > LIST_MS) void refreshList() }, 5_000)
    return () => { listListeners.delete(f); clearInterval(id) }
  }, [])
  return { markets: list.data, error: list.data ? null : list.error }
}

// ── mids ─────────────────────────────────────────────────────────────────

/** Every mid price Hyperliquid streams, by coin: perps ("BTC", "xyz:TSLA"), outcome sides ("#1230") and spot ("@107"). */
const mids: Record<string, number> = {}
const midListeners = new Set<() => void>()
let midSubs: (() => void)[] | null = null
let midFlush: ReturnType<typeof setTimeout> | null = null

function startMids() {
  if (midSubs) return
  midSubs = HL_DEXES.map(dex => hlSubscribe(dex ? { type: 'allMids', dex } : { type: 'allMids' }, data => {
    const m = (data as { mids?: Record<string, string> }).mids
    if (!m) return
    for (const k in m) { const v = Number(m[k]); if (v > 0) mids[k] = v }
    // Many updates a second: the pages redraw at most four times a second.
    if (!midFlush) midFlush = setTimeout(() => { midFlush = null; for (const f of midListeners) f() }, 250)
  }))
}
function stopMids() {
  if (!midSubs || midListeners.size) return
  for (const off of midSubs) off()
  midSubs = null
}

/** The live mids (a shared object that changes in place; the hook re-renders when it does). */
export function useHlMids(): Readonly<Record<string, number>> {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump(x => x + 1)
    midListeners.add(f)
    startMids()
    return () => { midListeners.delete(f); setTimeout(stopMids, 2_000) }
  }, [])
  return mids
}

/** Whether the socket is up, for a LIVE badge. */
export function useHlSocketUp(): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => onHlSocket(setUp), [])
  return up
}

// ── one coin ─────────────────────────────────────────────────────────────

export interface AssetCtx { funding: number; openInterest: number; markPx: number; midPx: number | null; oraclePx: number; prevDayPx: number; dayNtlVlm: number; premium: number | null }

/** A perp's live numbers: funding, open interest, mark, oracle, 24h volume. */
export function useAssetCtx(coin: string | null): AssetCtx | null {
  const [ctx, setCtx] = useState<AssetCtx | null>(null)
  useEffect(() => {
    setCtx(null)
    if (!coin) return
    return hlSubscribe({ type: 'activeAssetCtx', coin }, data => {
      const c = (data as { coin?: string; ctx?: Record<string, string | null> })
      if (c.coin !== coin || !c.ctx) return
      const x = c.ctx
      setCtx({
        funding: Number(x.funding ?? 0), openInterest: Number(x.openInterest ?? 0), markPx: Number(x.markPx ?? 0),
        midPx: x.midPx == null ? null : Number(x.midPx), oraclePx: Number(x.oraclePx ?? 0), prevDayPx: Number(x.prevDayPx ?? 0),
        dayNtlVlm: Number(x.dayNtlVlm ?? 0), premium: x.premium == null ? null : Number(x.premium),
      })
    })
  }, [coin])
  return ctx
}

export interface BookLevel { px: number; sz: number; n: number }
export interface Book { bids: BookLevel[]; asks: BookLevel[]; time: number }

/** The order book, 20 levels a side; `sigFigs` groups prices (null: every tick). */
export function useL2Book(coin: string | null, sigFigs: number | null): Book | null {
  const [book, setBook] = useState<Book | null>(null)
  useEffect(() => {
    setBook(null)
    if (!coin) return
    const sub: Record<string, unknown> = { type: 'l2Book', coin }
    if (sigFigs) sub.nSigFigs = sigFigs
    let last = 0
    let pending: Book | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = hlSubscribe(sub, data => {
      const d = data as { coin?: string; time?: number; levels?: { px: string; sz: string; n: number }[][] }
      if (d.coin !== coin || !d.levels) return
      const conv = (l: { px: string; sz: string; n: number }[]) => l.map(x => ({ px: Number(x.px), sz: Number(x.sz), n: x.n }))
      pending = { bids: conv(d.levels[0] ?? []), asks: conv(d.levels[1] ?? []), time: d.time ?? Date.now() }
      // At most ten redraws a second.
      const wait = Math.max(0, 100 - (Date.now() - last))
      if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); setBook(pending) }, wait)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [coin, sigFigs])
  return book
}

export interface HlTrade { tid: number; coin: string; side: 'B' | 'A'; px: number; sz: number; time: number; hash: string; live: boolean }

/** A coin's latest trades, newest first. The first batch is history; later ones are marked live. */
export function useHlTrades(coin: string | null, keep = 80): HlTrade[] | null {
  const [trades, setTrades] = useState<HlTrade[] | null>(null)
  useEffect(() => {
    setTrades(null)
    if (!coin) return
    let first = true
    return hlSubscribe({ type: 'trades', coin }, data => {
      const arr = (Array.isArray(data) ? data : []) as { coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; hash: string; tid: number }[]
      const mine = arr.filter(t => t.coin === coin)
      const live = !first
      first = false
      const conv = mine.map(t => ({ tid: t.tid, coin: t.coin, side: t.side, px: Number(t.px), sz: Number(t.sz), time: t.time, hash: t.hash, live }))
      setTrades(prev => {
        const seen = new Set<number>()
        return [...conv, ...(prev ?? [])].filter(t => (seen.has(t.tid) ? false : (seen.add(t.tid), true))).sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, keep)
      })
    })
  }, [coin, keep])
  return trades
}

export interface AssetData { leverage: { type: 'cross' | 'isolated'; value: number }; maxTradeSzs: [number, number]; availableToTrade: [number, number]; markPx: number }

/** What an account can trade a coin with: its leverage setting, and the most it can buy or sell now. */
export function useAssetData(user: string | null, coin: string | null): AssetData | null {
  const [d, setD] = useState<AssetData | null>(null)
  useEffect(() => {
    setD(null)
    if (!user || !coin) return
    return hlSubscribe({ type: 'activeAssetData', user, coin }, data => {
      const x = data as { coin?: string; leverage?: { type: 'cross' | 'isolated'; value: number }; maxTradeSzs?: string[]; availableToTrade?: string[]; markPx?: string }
      if (x.coin !== coin || !x.leverage) return
      setD({
        leverage: x.leverage,
        maxTradeSzs: [Number(x.maxTradeSzs?.[0] ?? 0), Number(x.maxTradeSzs?.[1] ?? 0)],
        availableToTrade: [Number(x.availableToTrade?.[0] ?? 0), Number(x.availableToTrade?.[1] ?? 0)],
        markPx: Number(x.markPx ?? 0),
      })
    })
  }, [user, coin])
  return d
}

/** The account's fee rates (taker and maker), Hyperliquid's own answer; its base rates until it answers. */
export function useUserFees(user: string | null): { taker: number; maker: number } {
  const [f, setF] = useState({ taker: 0.00045, maker: 0.00015 })
  useEffect(() => {
    if (!user) return
    let alive = true
    hlInfo<{ userCrossRate?: string; userAddRate?: string }>({ type: 'userFees', user })
      .then(r => { if (alive && r?.userCrossRate) setF({ taker: Number(r.userCrossRate), maker: Number(r.userAddRate ?? 0.00015) }) })
      .catch(() => {})
    return () => { alive = false }
  }, [user])
  return f
}

// ── candles ──────────────────────────────────────────────────────────────

const HL_INTERVAL: Partial<Record<ChartResolution, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' }
const RES_MS: Partial<Record<ChartResolution, number>> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14_400e3, '1d': 86_400e3 }
export const HL_RESOLUTIONS: ChartResolution[] = ['1m', '5m', '15m', '1h', '4h', '1d']

interface RawCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }
const toCandle = (c: RawCandle): Candle => {
  const close = Number(c.c)
  return { time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close, volume: Number(c.v) * close }
}

/** A coin's candles for the chart: 500 bars of history once per timeframe, then the venue's own candle stream, so
 * the last bar moves with every trade. The chart polls `load` every second; it costs nothing (no request). */
export function useHlCandles(coin: string | null): ChartSource | undefined {
  const state = useRef<{ key: string; bars: Map<number, Candle>; off: (() => void) | null; loading: Promise<void> | null }>({ key: '', bars: new Map(), off: null, loading: null })
  useEffect(() => () => { state.current.off?.(); state.current.off = null }, [])
  return useMemo<ChartSource | undefined>(() => {
    if (!coin) return undefined
    const s = state.current
    return {
      id: `hl:${coin}`,
      refreshMs: 1_000,
      resolutions: HL_RESOLUTIONS,
      volume: true,
      load: async res => {
        const interval = HL_INTERVAL[res]
        if (!interval) return []
        const key = `${coin}|${interval}`
        if (s.key !== key) {
          s.off?.()
          s.key = key
          s.bars = new Map()
          const bars = s.bars
          s.off = hlSubscribe({ type: 'candle', coin, interval }, data => {
            const c = data as RawCandle
            if (c.s !== coin || c.i !== interval) return
            const x = toCandle(c)
            bars.set(x.time, x)
          })
          const end = Date.now()
          s.loading = hlInfo<RawCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime: end - 500 * (RES_MS[res] ?? 60e3), endTime: end } })
            .then(list => { for (const c of list) { const x = toCandle(c); if (!bars.has(x.time)) bars.set(x.time, x) } })
            .catch(() => {})
            .finally(() => { if (s.key === key) s.loading = null })
        }
        if (s.loading) await s.loading
        return [...s.bars.values()].sort((a, b) => a.time - b.time)
      },
    }
  }, [coin])
}

// ── outcome (prediction) markets ─────────────────────────────────────────

const OUT_KEY = 'arcdex:hl-outcomes:v1'
const OUT_MS = 60_000
const outcomes: { data: OutcomeGroup[] | null; at: number; error: string | null; loading: Promise<void> | null } = { data: null, at: 0, error: null, loading: null }
const outListeners = new Set<() => void>()
try {
  const raw = localStorage.getItem(OUT_KEY)
  if (raw) {
    const c = JSON.parse(raw) as { at: number; data: OutcomeGroup[] }
    if (Date.now() - c.at < 30 * 60_000 && Array.isArray(c.data)) outcomes.data = c.data
  }
} catch { /* storage blocked */ }

function refreshOutcomes(): Promise<void> {
  if (outcomes.loading) return outcomes.loading
  outcomes.loading = loadOutcomes()
    .then(d => {
      outcomes.data = d; outcomes.at = Date.now(); outcomes.error = null
      try { localStorage.setItem(OUT_KEY, JSON.stringify({ at: outcomes.at, data: d })) } catch { /* full or blocked */ }
    })
    .catch(e => { outcomes.error = String((e as Error).message ?? e) })
    .finally(() => { outcomes.loading = null; for (const f of outListeners) f() })
  return outcomes.loading
}

/** Every open outcome market, grouped by question, refreshed every minute while a page shows it. */
export function useHlOutcomes(): { groups: OutcomeGroup[] | null; error: string | null } {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump(x => x + 1)
    outListeners.add(f)
    if (Date.now() - outcomes.at > OUT_MS) void refreshOutcomes()
    const id = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - outcomes.at > OUT_MS) void refreshOutcomes() }, 10_000)
    return () => { outListeners.delete(f); clearInterval(id) }
  }, [])
  return { groups: outcomes.data, error: outcomes.data ? null : outcomes.error }
}
