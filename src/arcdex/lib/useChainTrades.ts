// A coin page's trades, read from the chain as they land (2026-10-05, after Robinhood Chain's page:
// pages/RobinhoodTokenPage.tsx), with GeckoTerminal's trades for what the chain read doesn't reach
// (older trades, or a pool whose swaps can't be read there). Used by the Solana and BNB Chain coin
// pages, each with its own reader (api/solSwaps.ts, api/bscSwaps.ts).
//
// The chain's swaps come first: they move the price, the chart's last candle (`ticks`) and pop on the
// chart. GeckoTerminal is asked every 60s while the chain feeds the page, and every few seconds (with its
// new trades marked live) when it doesn't.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TradeRow } from '../components/TokenSocialTabs'
import type { Tick } from './candles'

/** One swap read from the chain. */
export interface ChainSwap {
  /** Unique per swap (a transaction can hold several). */
  id: string
  txHash: string
  /** ms. */
  time: number
  kind: 'buy' | 'sell'
  tokenAmount: number
  quoteAmount: number
  /** The coin's price in the quote. */
  price: number
  /** Who traded, when the swap itself says (a curve's event, a Solana transaction's signer). */
  maker?: string | null
  /** Arrived after the page opened. */
  live?: boolean
}

/** A pool's swaps on the chain: what's there now, then each new one. */
export interface ChainFeed<C = unknown> {
  /** Changes when the pool (or how it's read) changes: the feed starts over. */
  key: string
  load: () => Promise<{ swaps: ChainSwap[]; cursor: C }>
  /** Calls `onSwaps` with each batch of new swaps; returns a stop function. */
  watch: (cursor: C, known: string[], onSwaps: (swaps: ChainSwap[]) => void) => () => void
}

export type ChainRow = TradeRow & { id: string; priceUsd: number; fromChain?: boolean }

interface Options {
  feed: ChainFeed<any> | null
  /** The pool GeckoTerminal is asked about ('' for none). */
  gtKey: string
  gtLoad: (() => Promise<TradeRow[]>) | null
  /** Dollars per unit of the pool's quote; null: derived once from GeckoTerminal's price. */
  quoteUsd: number | null
  /** GeckoTerminal's price of the coin. */
  gtPrice: number
  /** Makers the swap didn't name, looked up (a transaction's sender). */
  makerOf?: (txHash: string) => string | null
  resolveMakers?: (txHashes: string[], onFound: () => void) => void
  /** How often GeckoTerminal is asked when the chain doesn't feed the page. */
  gtFastMs?: number
  /** Transaction hashes compared as: lower case on EVM chains, as they are on Solana. */
  norm?: (tx: string) => string
}

const lower = (s: string) => s.toLowerCase()

export function useChainTrades(o: Options): { rows: ChainRow[]; ticks: Tick[]; chainOn: boolean; tradesLoaded: boolean; chainPrice: number } {
  const norm = o.norm ?? lower
  const [swaps, setSwaps] = useState<ChainSwap[] | null>(null)
  const [chainState, setChainState] = useState<'idle' | 'loading' | 'live' | 'off'>('idle')
  const [gtRows, setGtRows] = useState<TradeRow[]>([])
  const [gtLoaded, setGtLoaded] = useState(false)
  const [makersFound, setMakersFound] = useState(0)
  const feedRef = useRef(o.feed)
  feedRef.current = o.feed

  // The chain: what's there, then every new swap.
  const feedKey = o.feed?.key ?? ''
  useEffect(() => {
    setSwaps(null)
    const feed = feedRef.current
    if (!feed) { setChainState('idle'); return }
    let live = true
    let stop: (() => void) | null = null
    setChainState('loading')
    feed.load().then(({ swaps: first, cursor }) => {
      if (!live) return
      setSwaps(first)
      setChainState('live')
      stop = feed.watch(cursor, first.map(s => s.id), fresh => {
        if (live) setSwaps(prev => [...fresh, ...(prev ?? [])].slice(0, 3_000))
      })
    }).catch(() => { if (live) setChainState('off') })
    return () => { live = false; stop?.() }
  }, [feedKey])

  // GeckoTerminal: older trades and their makers; every few seconds when the chain can't be read.
  const chainOn = chainState === 'live' && (swaps?.length ?? 0) > 0
  const seen = useRef<Set<string> | null>(null)
  const gtLoadRef = useRef(o.gtLoad)
  gtLoadRef.current = o.gtLoad
  useEffect(() => {
    if (!o.gtKey || !gtLoadRef.current) { setGtLoaded(true); return }
    let live = true
    seen.current = null
    setGtRows([]); setGtLoaded(false)
    const load = () => (gtLoadRef.current ?? (() => Promise.resolve([] as TradeRow[])))().then(list => {
      if (!live) return
      const before = seen.current
      seen.current = new Set(list.map(r => r.txHash + r.kind))
      setGtRows(prev => {
        // Keep the live flag on trades that already popped.
        const wasLive = new Set(prev.filter(r => r.live).map(r => r.txHash + r.kind))
        return list.map(r => ({ ...r, live: wasLive.has(r.txHash + r.kind) || (before !== null && !before.has(r.txHash + r.kind)) }))
      })
    }).catch(() => {}).finally(() => { if (live) setGtLoaded(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, chainOn ? 60_000 : o.gtFastMs ?? 4_000)
    return () => { live = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.gtKey, chainOn])

  // The quote in dollars: as given, else GeckoTerminal's price over the chain's, once per pool.
  const lastPrice = swaps?.[0]?.price ?? 0
  const derived = useRef<{ key: string; usd: number } | null>(null)
  if (!o.quoteUsd && lastPrice > 0 && o.gtPrice > 0 && derived.current?.key !== feedKey) derived.current = { key: feedKey, usd: o.gtPrice / lastPrice }
  const qUsd = o.quoteUsd ?? (derived.current?.key === feedKey ? derived.current.usd : null)

  // One list: the chain's swaps, then GeckoTerminal's trades the chain didn't read.
  const rows: ChainRow[] = useMemo(() => {
    const gtMaker = new Map(gtRows.filter(r => r.maker).map(r => [norm(r.txHash), r.maker!]))
    const chain: ChainRow[] = (swaps ?? []).map(s => ({
      id: s.id, txHash: s.txHash, kind: s.kind, tokenAmount: s.tokenAmount, timestamp: s.time, live: !!s.live, fromChain: true,
      maker: s.maker ?? o.makerOf?.(s.txHash) ?? gtMaker.get(norm(s.txHash)) ?? null,
      usd: qUsd ? s.quoteAmount * qUsd : 0,
      priceUsd: qUsd ? s.price * qUsd : 0,
    }))
    const onChain = new Set(chain.map(r => norm(r.txHash)))
    const oldest = chain.length ? Math.min(...chain.map(r => r.timestamp)) : Infinity
    const rest: ChainRow[] = gtRows
      .filter(r => !onChain.has(norm(r.txHash)) && (!chainOn || r.timestamp < oldest))
      .map((r, i) => ({ ...r, id: `${r.txHash}:gt:${r.kind}:${i}`, priceUsd: r.tokenAmount > 0 ? r.usd / r.tokenAmount : 0 }))
    return [...chain, ...rest].sort((a, b) => b.timestamp - a.timestamp)
    // makersFound re-reads the makers found since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swaps, gtRows, qUsd, chainOn, makersFound])

  // Who made the newest swaps the chain read without naming them.
  const resolveRef = useRef(o.resolveMakers)
  resolveRef.current = o.resolveMakers
  useEffect(() => {
    const need = rows.slice(0, 40).filter(r => !r.maker && r.fromChain).map(r => r.txHash)
    if (need.length && resolveRef.current) resolveRef.current(need, () => setMakersFound(n => n + 1))
  }, [rows])

  // The chart's live end: every swap the chain read, else GeckoTerminal's new ones.
  const ticks: Tick[] = useMemo(() => rows
    .filter(r => r.priceUsd > 0 && (chainOn ? r.fromChain : r.live))
    .map(r => ({ time: r.timestamp, priceUsd: r.priceUsd, usd: r.usd })), [rows, chainOn])

  const chainPrice = chainOn && rows[0]?.fromChain ? rows[0].priceUsd : 0
  const tradesLoaded = gtLoaded || chainState === 'live' || chainState === 'off'
  return { rows, ticks, chainOn, tradesLoaded, chainPrice }
}
