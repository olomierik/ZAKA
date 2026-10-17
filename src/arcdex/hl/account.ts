// A Hyperliquid account as the pages show it: what it's worth, what it can trade with, its positions on every listed
// dex, its open orders, its outcome (prediction) holdings and its recent fills. Everything is the venue's own answer;
// nothing is estimated except the value of outcome holdings at their mid prices, which is labelled.
//
// Reads, within Hyperliquid's per-IP budget (1,200 weight a minute): balances and positions (clearinghouseState per
// dex and spotClearinghouseState, weight 2 each) every 4 seconds while the page is visible; open orders (weight 20
// per dex) when the account's order stream says something changed, and every 30 seconds; fills from the fills stream.

import { useCallback, useEffect, useRef, useState } from 'react'
import { hlInfo, hlSubscribe } from './client'
import { HL_DEXES, dexOf } from './markets'
import type { HlMode } from './access'

export interface HlPosition {
  coin: string
  dex: string
  /** Signed size: positive long, negative short. */
  szi: number
  entryPx: number
  positionValue: number
  unrealizedPnl: number
  returnOnEquity: number
  liquidationPx: number | null
  marginUsed: number
  leverage: { type: 'cross' | 'isolated'; value: number }
  cumFunding: number | null
}

export interface HlOpenOrder {
  coin: string
  oid: number
  cloid: string | null
  side: 'B' | 'A'
  limitPx: number
  sz: number
  origSz: number
  timestamp: number
  reduceOnly: boolean
  isTrigger: boolean
  triggerPx: number | null
  orderType: string
  isPositionTpsl: boolean
}

export interface HlFill {
  coin: string
  px: number
  sz: number
  side: 'B' | 'A'
  time: number
  dir: string
  closedPnl: number
  fee: number
  builderFee: number
  oid: number
  tid: number
  hash: string
}

export interface HlOutcomeHolding {
  outcome: number
  side: 0 | 1
  coin: string
  size: number
  entryNtl: number
}

export interface HlAccountState {
  user: string
  mode: HlMode | null
  /** The account's total value: every dex's equity, and the spot USDC (once, in a unified account). */
  accountValue: number
  /** USDC free to open new positions with, on the core dex (a unified account's single balance). */
  available: number
  /** What can be withdrawn now. */
  withdrawable: number
  perDex: Record<string, { accountValue: number; withdrawable: number; marginUsed: number }>
  spotUsdc: { total: number; hold: number }
  positions: HlPosition[]
  orders: HlOpenOrder[]
  outcomes: HlOutcomeHolding[]
  fetchedAt: number
}

interface ClearinghouseState {
  marginSummary: { accountValue: string; totalMarginUsed: string }
  withdrawable: string
  assetPositions: { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; returnOnEquity: string; liquidationPx: string | null; marginUsed: string; leverage: { type: 'cross' | 'isolated'; value: number }; cumFunding?: { sinceOpen: string } } }[]
}
interface SpotState { balances: { coin: string; token: number; total: string; hold: string; entryNtl: string }[] }
interface RawOrder { coin: string; oid: number; cloid?: string | null; side: 'B' | 'A'; limitPx: string; sz: string; origSz: string; timestamp: number; reduceOnly: boolean; isTrigger: boolean; triggerPx: string; orderType: string; isPositionTpsl: boolean }

const unifiedModes = new Set<HlMode | null>(['unifiedAccount', 'portfolioMargin'])

export function positionsFrom(dex: string, s: ClearinghouseState): HlPosition[] {
  return (s.assetPositions ?? []).map(({ position: p }) => ({
    coin: p.coin, dex: dex || dexOf(p.coin), szi: Number(p.szi), entryPx: Number(p.entryPx), positionValue: Number(p.positionValue),
    unrealizedPnl: Number(p.unrealizedPnl), returnOnEquity: Number(p.returnOnEquity),
    liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx), marginUsed: Number(p.marginUsed),
    leverage: p.leverage, cumFunding: p.cumFunding ? Number(p.cumFunding.sinceOpen) : null,
  })).filter(p => p.szi !== 0)
}

export function ordersFrom(list: RawOrder[]): HlOpenOrder[] {
  return list.map(o => ({
    coin: o.coin, oid: o.oid, cloid: o.cloid ?? null, side: o.side, limitPx: Number(o.limitPx), sz: Number(o.sz), origSz: Number(o.origSz),
    timestamp: o.timestamp, reduceOnly: o.reduceOnly, isTrigger: o.isTrigger, triggerPx: o.isTrigger ? Number(o.triggerPx) : null,
    orderType: o.orderType, isPositionTpsl: o.isPositionTpsl,
  }))
}

/** Outcome tokens in the spot balances: "+<encoding>" (encoding = 10 × outcome + side). */
export function outcomeHoldings(spot: SpotState | null): HlOutcomeHolding[] {
  const out: HlOutcomeHolding[] = []
  for (const b of spot?.balances ?? []) {
    const m = /^\+(\d+)$/.exec(b.coin)
    if (!m || Number(b.total) === 0) continue
    const enc = Number(m[1])
    out.push({ outcome: Math.floor(enc / 10), side: (enc % 10) as 0 | 1, coin: `#${enc}`, size: Number(b.total), entryNtl: Number(b.entryNtl) })
  }
  return out
}

export function summarize(user: string, mode: HlMode | null, states: Record<string, ClearinghouseState | null>, spot: SpotState | null, orders: HlOpenOrder[]): HlAccountState {
  const perDex: HlAccountState['perDex'] = {}
  for (const d of HL_DEXES) {
    const s = states[d]
    perDex[d] = { accountValue: Number(s?.marginSummary.accountValue ?? 0), withdrawable: Number(s?.withdrawable ?? 0), marginUsed: Number(s?.marginSummary.totalMarginUsed ?? 0) }
  }
  const usdc = spot?.balances.find(b => b.coin === 'USDC')
  const spotUsdc = { total: Number(usdc?.total ?? 0), hold: Number(usdc?.hold ?? 0) }
  const unified = unifiedModes.has(mode)
  const dexValue = Object.values(perDex).reduce((s, d) => s + d.accountValue, 0)
  // A unified account keeps its USDC, margin included, in the spot balance: its equity is that plus every position's
  // unrealized PnL. A standard account's is each dex's own value plus whatever USDC sits in spot.
  const accountValue = unified ? spotUsdc.total + positionsPnl(states) : dexValue + spotUsdc.total
  const available = unified ? Math.max(0, spotUsdc.total - spotUsdc.hold) : perDex[''].withdrawable
  const withdrawable = unified ? Math.max(0, spotUsdc.total - spotUsdc.hold) : perDex[''].withdrawable
  const positions = HL_DEXES.flatMap(d => (states[d] ? positionsFrom(d, states[d]!) : []))
  return { user, mode, accountValue, available, withdrawable, perDex, spotUsdc, positions, orders, outcomes: outcomeHoldings(spot), fetchedAt: Date.now() }
}

function positionsPnl(states: Record<string, ClearinghouseState | null>): number {
  let pnl = 0
  for (const s of Object.values(states)) for (const { position: p } of s?.assetPositions ?? []) pnl += Number(p.unrealizedPnl)
  return pnl
}

async function loadBalances(user: string) {
  const [spot, ...dexStates] = await Promise.all([
    hlInfo<SpotState>({ type: 'spotClearinghouseState', user }).catch(() => null),
    ...HL_DEXES.map(d => hlInfo<ClearinghouseState>(d ? { type: 'clearinghouseState', user, dex: d } : { type: 'clearinghouseState', user }).catch(() => null)),
  ])
  const states: Record<string, ClearinghouseState | null> = {}
  HL_DEXES.forEach((d, i) => { states[d] = dexStates[i] })
  return { spot, states }
}

export async function loadOpenOrders(user: string): Promise<HlOpenOrder[]> {
  const lists = await Promise.all(HL_DEXES.map(d => hlInfo<RawOrder[]>(d ? { type: 'frontendOpenOrders', user, dex: d } : { type: 'frontendOpenOrders', user }).catch(() => [] as RawOrder[])))
  return ordersFrom(lists.flat()).sort((a, b) => b.timestamp - a.timestamp)
}

export async function loadAccount(user: string): Promise<HlAccountState> {
  const [mode, bal, orders] = await Promise.all([
    hlInfo<HlMode>({ type: 'userAbstraction', user }).catch(() => null),
    loadBalances(user),
    loadOpenOrders(user),
  ])
  return summarize(user, mode, bal.states, bal.spot, orders)
}

/** The account, kept up to date while the page is open. `refresh()` reads it again at once (after an order). */
export function useHlAccount(user: string | null): { state: HlAccountState | null; loading: boolean; error: string | null; refresh: () => void; fills: HlFill[] } {
  const [state, setState] = useState<HlAccountState | null>(null)
  const [fills, setFills] = useState<HlFill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modeRef = useRef<HlMode | null>(null)
  const ordersRef = useRef<HlOpenOrder[]>([])
  const tick = useRef(0)

  const refreshBalances = useCallback(async (u: string) => {
    const bal = await loadBalances(u)
    setState(summarize(u, modeRef.current, bal.states, bal.spot, ordersRef.current))
  }, [])
  const refreshOrders = useCallback(async (u: string) => {
    ordersRef.current = await loadOpenOrders(u)
    setState(s => (s && s.user === u ? { ...s, orders: ordersRef.current } : s))
  }, [])

  const refresh = useCallback(() => {
    if (!user) return
    tick.current++
    void loadAccount(user).then(s => { modeRef.current = s.mode; ordersRef.current = s.orders; setState(s); setError(null) }).catch(e => setError(String((e as Error).message ?? e)))
  }, [user])

  useEffect(() => {
    setState(null); setFills([]); setError(null)
    if (!user) return
    let alive = true
    setLoading(true)
    void loadAccount(user)
      .then(s => { if (alive) { modeRef.current = s.mode; ordersRef.current = s.orders; setState(s) } })
      .catch(e => { if (alive) setError(String((e as Error).message ?? e)) })
      .finally(() => { if (alive) setLoading(false) })
    const bal = setInterval(() => { if (document.visibilityState === 'visible') void refreshBalances(user).catch(() => {}) }, 4_000)
    const ord = setInterval(() => { if (document.visibilityState === 'visible') void refreshOrders(user).catch(() => {}) }, 30_000)
    let pending: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (pending) return
      pending = setTimeout(() => { pending = null; void refreshOrders(user).catch(() => {}); void refreshBalances(user).catch(() => {}) }, 300)
    }
    const offOrders = hlSubscribe({ type: 'orderUpdates', user }, () => soon())
    const offFills = hlSubscribe({ type: 'userFills', user }, data => {
      const d = data as { isSnapshot?: boolean; fills?: Record<string, unknown>[] }
      const list = (d.fills ?? []).map(f => ({
        coin: String(f.coin), px: Number(f.px), sz: Number(f.sz), side: f.side as 'B' | 'A', time: Number(f.time), dir: String(f.dir ?? ''),
        closedPnl: Number(f.closedPnl ?? 0), fee: Number(f.fee ?? 0), builderFee: Number(f.builderFee ?? 0), oid: Number(f.oid), tid: Number(f.tid), hash: String(f.hash ?? ''),
      }))
      setFills(prev => {
        const merged = d.isSnapshot ? list : [...list, ...prev]
        const seen = new Set<number>()
        return merged.filter(f => (seen.has(f.tid) ? false : (seen.add(f.tid), true))).sort((a, b) => b.time - a.time).slice(0, 300)
      })
      if (!d.isSnapshot) soon()
    })
    return () => { alive = false; clearInterval(bal); clearInterval(ord); if (pending) clearTimeout(pending); offOrders(); offFills() }
  }, [user, refreshBalances, refreshOrders])

  return { state, loading, error, refresh, fills }
}
