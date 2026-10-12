// Every coin listed on Arc, live (moved out of the Markets page on 2026-10-12, when the Trenches replaced it): the
// launchpad lists and GeckoTerminal's, the market engine's launches, ticks, most active coins and Argus curves, every
// buy and sell from Arc's WebSocket (a flash on its coin), holder counts from ARCDEX's index, and each coin's safety
// (the engine's scan, else its market data). The listing rules stay as the owner set them (lib/safety.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isEstablishedCoin, isLaunchpadCoin } from '../../../api/_launchpads'
import type { ActiveToken, BondingCoin, CoinSafety, LaunchInfo } from '../../../api/_marketProtocol'
import { headBlock } from '../../../api/_arcLogs'
import type { ArcToken } from '../api/radardex'
import { getAllLaunchpadTokensAsArcTokens, LAUNCHPAD_ADDRESS } from '../api/launchpad'
import { subscribeMarketPulse } from '../api/marketPulse'
import { getArgusTokens } from '../api/argus'
import { cachedArgusMarket, getArgusMarket, argusPoolToArcToken } from '../api/argusMarket'
import { curveRowToArcToken, getCurveMarket } from '../api/curveMarket'
import { engineApiUrl, engineEnabled, getNewTokens, marketStream, useEngineStatus } from '../api/marketStream'
import { getHolderScans } from '../api/social'
import { useCoinSafety } from '../api/coinSafety'
import { curateTokens } from './curate'
import { tokenRisk, type Risk } from './risk'
import { arcStage, arcStageInput } from './coinStage'
import { arcSafety, isListable, isRugged, meetsStandard, type SafetyView } from './safety'
import { markDupes, type DupInfo } from './dupes'
import { COIN_LC } from './coin'

const QUOTE_SYMBOL: Record<string, string> = {
  '0x3600000000000000000000000000000000000000': 'USDC', '0x0000000000000000000000000000000000000000': 'USDC',
  '0xece5ca8bf9220718e5727754026757512212cb3c': 'ARGUS', '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC', '0x93ffd195481e8c08eb25a158689e4d9e61313111': 'WETH',
}
const NATIVE_USDC = '0x0000000000000000000000000000000000000000'
const QUOTE_BY_SYMBOL: Record<string, string> = {
  USDC: '0x3600000000000000000000000000000000000000', ARGUS: '0xece5ca8bf9220718e5727754026757512212cb3c',
}

/** A live trade's flash on its coin: which side, and a counter whose parity alternates the CSS animation so
 * back-to-back trades each restart it. */
export interface Flash { side: 'buy' | 'sell'; n: number }

/** A launch the market engine just detected, as a row: before its first trade. */
export function launchToArcToken(l: LaunchInfo): ArcToken {
  return {
    address: l.token, symbol: l.symbol, name: l.name, decimals: l.decimals, logoUrl: l.image ?? '',
    price: l.priceUsd ?? 0, priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, volume24h: 0, marketCap: l.marketCapUsd ?? 0, liquidity: 0,
    ageMs: Math.max(0, Date.now() - l.timestamp), createdAt: l.timestamp, launchpad: l.launchpad === 'ARGUS' ? 'Argus' : l.launchpad,
    poolAddress: l.pool ?? '', txCount24h: 0, holderCount: 0, buys24h: 0, sells24h: 0, verified: false, graduated: false,
    bondingProgress: null, spark: [], deployer: l.creator ?? undefined, quoteSymbol: (l.quote && QUOTE_SYMBOL[l.quote]) || '',
    quoteAddress: l.quote ?? undefined,
  }
}

/** A coin trading now (GET /v1/tokens/active) that the list doesn't carry yet: its launch, with its live stats. */
function activeToArcToken(a: ActiveToken): ArcToken | null {
  if (!a.meta) return null
  const s = a.stats
  return {
    ...launchToArcToken(a.meta),
    price: s.priceUsd ?? 0, priceChange5m: s.chg.m5 ?? 0, priceChange1h: s.chg.h1 ?? 0, priceChange24h: s.chg.h24 ?? 0,
    volume24h: s.vol24, marketCap: s.marketCapUsd ?? 0, liquidity: s.liquidityUsd ?? 0,
    txCount24h: s.trades24, buys24h: s.buys24, sells24h: s.sells24,
  }
}

/** An Argus coin on its curve (GET /v1/bonding) that the list doesn't carry. */
function bondingToArcToken(b: BondingCoin): ArcToken {
  return {
    address: b.token, symbol: b.symbol, name: b.name, decimals: 18, logoUrl: b.image ?? '',
    price: b.priceUsd, priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, volume24h: b.volume24h, marketCap: b.marketCapUsd,
    liquidity: b.liquidityUsd ?? 0, ageMs: Math.max(0, Date.now() - b.createdAt), createdAt: b.createdAt, launchpad: 'Argus', poolAddress: b.pool,
    txCount24h: b.buys24h + b.sells24h, holderCount: 0, buys24h: b.buys24h, sells24h: b.sells24h, verified: false,
    graduated: false, bondingProgress: b.progress, spark: [], deployer: b.creator ?? undefined, quoteSymbol: 'USDC',
  }
}

/** Listed on Arc: a launchpad's coin, or an established coin from any DEX. */
const listedArc = (t: ArcToken) => isLaunchpadCoin(t.launchpad)
  || isEstablishedCoin({ symbol: t.symbol, liquidityUsd: t.liquidity, ageMs: t.ageMs, marketCapUsd: t.marketCap, txns24h: t.txCount24h })

/** Trades in the last 15 minutes from which a coin wears the 🔥. */
const HOT_TRADES = 5

export interface ArcMarket {
  tokens: ArcToken[]
  loading: boolean
  /** The engine's socket is up (live launches and ticks). */
  live: boolean
  flash: Map<string, Flash>
  /** Trades seen on Arc in the last minute. */
  perMin: number
  hotOf: (t: ArcToken) => number | undefined
  activityOf: (t: ArcToken) => number
  safetyOf: (t: ArcToken) => SafetyView
  scanOf: (t: ArcToken) => CoinSafety | null | undefined
  riskOf: (t: ArcToken) => Risk
  isOfficial: (t: ArcToken) => boolean
  /** $15K or more of market cap and not rugged ($ARCDEX always). */
  listable: (t: ArcToken) => boolean
  /** Rugged: the creator sold most, down 90%+ in a day, or a pool drained under $500. */
  rugged: (t: ArcToken) => boolean
  /** The listing standard: no Danger, and pool coins with $2K of liquidity and 20 holders. */
  passes: (t: ArcToken) => boolean
  dupes: Map<string, DupInfo>
}

export function useArcMarket(): ArcMarket {
  const [tokens, setTokens] = useState<ArcToken[]>([])
  const [loading, setLoading] = useState(true)

  const argusSeen = useRef(new Map<string, { t: ArcToken; seen: number }>())
  const oursRef = useRef<ArcToken[]>([])
  const curvesRef = useRef<ArcToken[]>([])
  const launchesRef = useRef(new Map<string, LaunchInfo>())
  const activeRef = useRef(new Map<string, ActiveToken>())
  const bondingRef = useRef(new Map<string, BondingCoin>())
  const liveTradesRef = useRef(new Map<string, number>())
  const rankRef = useRef(new Map<string, number>())
  const [, setRankTick] = useState(0)
  const takeRank = useCallback(() => {
    const m = new Map<string, number>()
    for (const [k, a] of activeRef.current) m.set(k, a.score)
    for (const [k, n] of liveTradesRef.current) m.set(k, (m.get(k) ?? 0) + 2 * n)
    rankRef.current = m
    setRankTick(x => x + 1)
  }, [])
  useEffect(() => { const id = setInterval(() => { if (!document.hidden) takeRank() }, 5_000); return () => clearInterval(id) }, [takeRank])
  const ticksRef = useRef(new Map<string, [number | null, number | null, number, number | null, number]>())
  const engineStatus = useEngineStatus()

  const publish = useCallback((fresh: ArcToken[]) => {
    const withTick = (t: ArcToken): ArcToken => {
      const k = ticksRef.current.get(t.address.toLowerCase())
      if (!k) return t
      const [price, chg24, vol, mc, trades] = k
      return {
        ...t,
        price: price ?? t.price,
        priceChange24h: chg24 ?? t.priceChange24h,
        volume24h: Math.max(vol, t.volume24h),
        marketCap: mc ?? (price && t.price && t.marketCap ? t.marketCap * (price / t.price) : t.marketCap),
        txCount24h: Math.max(trades, t.txCount24h),
      }
    }
    // Merge, don't replace: a throttled refresh comes back short; coins keep their last row for 10 minutes.
    const now = Date.now()
    const seen = argusSeen.current
    for (const t of fresh) seen.set(t.address.toLowerCase(), { t, seen: now })
    for (const [k, v] of seen) if (now - v.seen > 10 * 60_000) seen.delete(k)
    const listed = new Set([...oursRef.current.map(t => t.address.toLowerCase()), ...seen.keys()])
    const curves = curvesRef.current.filter(t => !listed.has(t.address))
    for (const t of curves) listed.add(t.address)
    const launched = [...launchesRef.current.values()].filter(l => !listed.has(l.token)).map(launchToArcToken)
    for (const t of launched) listed.add(t.address.toLowerCase())
    const busy = [...activeRef.current.values()].filter(a => !listed.has(a.token)).map(activeToArcToken).filter((t): t is ArcToken => t !== null)
    for (const t of busy) listed.add(t.address.toLowerCase())
    const onCurve = [...bondingRef.current.values()].filter(b => !listed.has(b.token)).map(bondingToArcToken)
    // The engine's reading of an Argus curve is the freshest: it sets the progress of the rows the list already has.
    const withCurve = (t: ArcToken): ArcToken => {
      const b = bondingRef.current.get(t.address.toLowerCase())
      return b && !t.graduated ? { ...t, graduated: false, bondingProgress: b.progress } : t
    }
    const data = [...oursRef.current, ...[...seen.values()].map(v => v.t), ...curves, ...launched, ...busy, ...onCurve].filter(listedArc).map(withCurve).map(withTick)
    setTokens(data)
    if (data.length > 0) setLoading(false)
  }, [])

  const load = useCallback(async () => {
    const argus = getArgusMarket(more => publish(more.map(argusPoolToArcToken)))
      .then(pools => pools.map(argusPoolToArcToken))
      .catch(() => getArgusTokens().catch(() => [] as ArcToken[]))
      .then(fresh => publish(fresh))
    const ours = getAllLaunchpadTokensAsArcTokens()
      .then(t => { oursRef.current = t; publish([]) })
      .catch(() => {})
    const curves = getCurveMarket()
      .then(rows => { const now = Date.now(); curvesRef.current = rows.map(r => curveRowToArcToken(r, now)); publish([]) })
      .catch(() => {})
    await Promise.all([argus, ours, curves])
    setLoading(false)
  }, [publish])

  useEffect(() => { const c = cachedArgusMarket(); if (c) publish(c.map(argusPoolToArcToken)) }, [publish])
  useEffect(() => { void load() }, [load])
  const engineLive = engineEnabled && engineStatus === 'open'
  useEffect(() => {
    const iv = setInterval(() => { if (!document.hidden) void load() }, engineLive ? 60_000 : 15_000)
    return () => clearInterval(iv)
  }, [load, engineLive])

  // ── every buy and sell on Arc flashes its coin (api/marketPulse.ts) ──
  const [flash, setFlash] = useState<Map<string, Flash>>(new Map())
  const [perMin, setPerMin] = useState(0)
  const pulseBuf = useRef<{ token: string; side: 'buy' | 'sell' }[]>([])
  const pulseTimes = useRef<number[]>([])
  const lastPulse = useRef(new Map<string, number>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countPerMin = useCallback(() => {
    const cutoff = Date.now() - 60_000
    pulseTimes.current = pulseTimes.current.filter(t => t > cutoff)
    setPerMin(pulseTimes.current.length)
  }, [])
  const pulse = useCallback((p: { token: string; side: 'buy' | 'sell' }) => {
    const now = Date.now()
    lastPulse.current.set(p.token, now)
    liveTradesRef.current.set(p.token, (liveTradesRef.current.get(p.token) ?? 0) + 1)
    pulseTimes.current.push(now)
    pulseBuf.current.push(p)
    if (flushTimer.current) return
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      const batch = pulseBuf.current
      pulseBuf.current = []
      countPerMin()
      if (document.hidden) return
      setFlash(prev => {
        const next = new Map(prev)
        for (const x of batch) next.set(x.token, { side: x.side, n: (next.get(x.token)?.n ?? 0) + 1 })
        return next
      })
    }, 150)
  }, [countPerMin])
  useEffect(() => {
    const id = setInterval(countPerMin, 5_000)
    return () => { clearInterval(id); if (flushTimer.current) clearTimeout(flushTimer.current) }
  }, [countPerMin])
  const poolsRef = useRef(new Map<string, { token: string; quote: string }>())
  const curveRef = useRef(new Set<string>())
  useEffect(() => {
    const pools = new Map<string, { token: string; quote: string }>()
    const curve = new Set<string>()
    for (const t of tokens) {
      if (t.launchpad === 'ARCDEX') curve.add(t.address.toLowerCase())
      const quote = t.quoteAddress || QUOTE_BY_SYMBOL[t.quoteSymbol]
      if (t.poolAddress && quote) pools.set(t.poolAddress.toLowerCase(), { token: t.address.toLowerCase(), quote: quote.toLowerCase() })
    }
    poolsRef.current = pools
    curveRef.current = curve
  }, [tokens])
  const v3Pools = useMemo(() => [...new Set(tokens.filter(t => /^0x[0-9a-fA-F]{40}$/.test(t.poolAddress) && t.quoteAddress?.toLowerCase() !== NATIVE_USDC).map(t => t.poolAddress.toLowerCase()))].sort().join(','), [tokens])
  useEffect(() => subscribeMarketPulse(LAUNCHPAD_ADDRESS, {
    pool: id => poolsRef.current.get(id),
    curve: token => curveRef.current.has(token),
  }, pulse, v3Pools ? v3Pools.split(',') : []), [pulse, v3Pools])

  // ── the market engine: launches the moment they're detected, prices and volumes with every tick ──
  useEffect(() => {
    if (!engineEnabled) return
    void getNewTokens(100).then(ls => { for (const l of ls) launchesRef.current.set(l.token, l); publish([]) }).catch(() => {})
    const offNew = marketStream.subscribe({ channel: 'new_tokens' }, m => {
      if (m.t !== 'NEW_TOKEN') return
      launchesRef.current.set(m.d.token, m.d)
      if (launchesRef.current.size > 500) launchesRef.current.delete(launchesRef.current.keys().next().value as string)
      publish([])
    })
    const offTicks = marketStream.subscribe({ channel: 'market' }, m => {
      if (m.t !== 'TICKS') return
      for (const [token, price, chg, vol, mc, trades] of m.d) {
        const prev = ticksRef.current.get(token)
        ticksRef.current.set(token, [price, chg, vol, mc, trades])
        // A trade the chain feed didn't show: flash it from the engine's count.
        if (prev && trades > prev[4] && Date.now() - (lastPulse.current.get(token) ?? 0) > 3_000)
          pulse({ token, side: price !== null && prev[0] !== null && price < prev[0] ? 'sell' : 'buy' })
      }
      publish([])
    })
    return () => { offNew(); offTicks() }
  }, [publish, pulse])

  useEffect(() => {
    if (!engineEnabled || !engineApiUrl) return
    let alive = true
    const get = () => void fetch(`${engineApiUrl}/v1/tokens/active?limit=150`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { tokens?: ActiveToken[] } | null) => {
        if (!alive || !j?.tokens) return
        activeRef.current = new Map(j.tokens.map(a => [a.token.toLowerCase(), a]))
        liveTradesRef.current = new Map()
        takeRank()
        publish([])
      }).catch(() => {})
    get()
    const id = setInterval(() => { if (!document.hidden) get() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [publish, takeRank])

  useEffect(() => {
    if (!engineEnabled || !engineApiUrl) return
    let alive = true
    const get = () => void fetch(`${engineApiUrl}/v1/bonding?limit=400`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { coins?: BondingCoin[] } | null) => {
        if (!alive || !j?.coins) return
        bondingRef.current = new Map(j.coins.map(b => [b.token.toLowerCase(), b]))
        publish([])
      }).catch(() => {})
    get()
    const id = setInterval(() => { if (!document.hidden) get() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [publish])

  // ── holder counts from ARCDEX's own index, for coins counted within the last two days ──
  const tokensRef = useRef(tokens)
  useEffect(() => { tokensRef.current = tokens }, [tokens])
  const [indexedHolders, setIndexedHolders] = useState<Map<string, number>>(new Map())
  const haveTokens = tokens.length > 0
  useEffect(() => {
    if (!haveTokens) return
    let alive = true
    const get = async () => {
      try {
        const [scans, head] = await Promise.all([getHolderScans(tokensRef.current.map(t => t.address)), headBlock()])
        const fresh = new Map(scans.filter(r => r.holders > 0 && r.scanned_to >= head - 172_800).map(r => [r.token, r.holders]))
        if (alive) setIndexedHolders(fresh)
      } catch { /* no index: holders stay unknown */ }
    }
    void get()
    const soon = setTimeout(() => void get(), 10_000)
    const id = setInterval(() => { if (!document.hidden) void get() }, 30_000)
    return () => { alive = false; clearTimeout(soon); clearInterval(id) }
  }, [haveTokens])
  const withHolders = useMemo(() => indexedHolders.size
    ? tokens.map(t => { const h = indexedHolders.get(t.address.toLowerCase()); return h ? { ...t, holderCount: h } : t })
    : tokens, [tokens, indexedHolders])

  // ── safety: the engine's scan of the coins worth asking about, else market data ──
  const askTokens = useMemo(() => {
    const young = withHolders.filter(t => { const st = arcStage(t); return st === 'new' || st === 'near' || st === 'bonding' }).sort((a, b) => a.ageMs - b.ageMs).slice(0, 120)
    const busy = [...withHolders].sort((a, b) => b.volume24h - a.volume24h).slice(0, 150)
    const grads = withHolders.filter(t => arcStage(t) === 'graduated').sort((a, b) => a.ageMs - b.ageMs).slice(0, 40)
    return [...new Set([COIN_LC, ...[...young, ...busy, ...grads].map(t => t.address.toLowerCase())])]
  }, [withHolders])
  const asked = useMemo(() => new Set(askTokens), [askTokens])
  const chainSafety = useCoinSafety(askTokens)
  const scanOf = useCallback((t: ArcToken): CoinSafety | null | undefined => { const k = t.address.toLowerCase(); return asked.has(k) ? chainSafety.get(k) : null }, [asked, chainSafety])
  const isOfficial = useCallback((t: ArcToken) => t.address.toLowerCase() === COIN_LC, [])
  const rugged = useCallback((t: ArcToken) => isRugged({ change24h: t.priceChange24h, liquidityUsd: t.liquidity, onCurve: arcStageInput(t).onCurve, chain: scanOf(t) }), [scanOf])
  const listable = useCallback((t: ArcToken) => isListable({ official: isOfficial(t), marketCapUsd: t.marketCap, rugged: rugged(t) }), [isOfficial, rugged])

  // Same-ticker coins: the risk of a later one is scored higher, and the earliest launched is the OG.
  const curation = useMemo(() => curateTokens(withHolders), [withHolders])
  const riskBy = useMemo(() => {
    const m = new Map<string, Risk>()
    for (const g of curation.groups) {
      m.set(g.primary.address, tokenRisk(g.primary))
      for (const d of g.duplicates) m.set(d.address, tokenRisk(d, { sameTicker: true }))
    }
    return m
  }, [curation])
  const riskOf = useCallback((t: ArcToken) => riskBy.get(t.address) ?? tokenRisk(t), [riskBy])
  const dupes = useMemo(() => markDupes(withHolders.filter(listable), {
    key: t => t.address, symbol: t => t.symbol, launchedAt: t => (t.ageMs > 0 ? Date.now() - t.ageMs : 0),
    creator: t => t.deployer ?? chainSafety.get(t.address.toLowerCase())?.creator ?? null,
  }), [withHolders, listable, chainSafety])

  const safetyOf = useCallback((t: ArcToken): SafetyView => arcSafety(t, riskOf(t), scanOf(t), arcStageInput(t).onCurve), [riskOf, scanOf])
  const passes = useCallback((t: ArcToken) => isOfficial(t) || meetsStandard({
    level: safetyOf(t).level, stage: arcStage(t), onCurve: arcStageInput(t).onCurve, liquidityUsd: t.liquidity, holders: t.holderCount > 0 ? t.holderCount : null,
  }), [isOfficial, safetyOf])

  const activityOf = useCallback((t: ArcToken) => rankRef.current.get(t.address.toLowerCase()) ?? 0, [])
  const hotOf = useCallback((t: ArcToken) => {
    const k = t.address.toLowerCase()
    const n = (activeRef.current.get(k)?.trades15m ?? 0) + (liveTradesRef.current.get(k) ?? 0)
    return n >= HOT_TRADES ? n : undefined
  }, [])

  return { tokens: withHolders, loading, live: engineLive, flash, perMin, hotOf, activityOf, safetyOf, scanOf, riskOf, isOfficial, listable, rugged, passes, dupes }
}
