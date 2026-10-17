// Placing, cancelling and changing leverage on Hyperliquid, with the venue's own answer for each order.
//
// Every order carries a client order id (cloid). An action is never re-sent: if the answer is lost (a dropped
// connection, a timeout), each order is looked up by its cloid (info orderStatus) and reported as the venue has it,
// never assumed filled. A refused agent (an external wallet's approval was revoked or replaced) is forgotten, and the
// page asks to enable trading again.

import { HlError, HL_MAINNET, hlExchange, hlInfo } from './client'
import { BUILDER, forgetAgent, nextNonce, type HlAccess, type HlAccessStatus } from './access'
import { signL1 } from './signing'
import { ASSET, cancelAction, marketPrice, newCloid, orderAction, orderWire, roundPrice, roundSize, updateLeverageAction, type Builder, type Grouping, type OrderRequest } from './wire'
import type { HlMarket } from './markets'
import { assertTradingOn } from '../lib/tradeSwitch'

export type OrderOutcome =
  | { kind: 'filled'; cloid: string; oid: number; totalSz: number; avgPx: number }
  | { kind: 'resting'; cloid: string; oid: number }
  | { kind: 'waiting'; cloid: string }
  | { kind: 'error'; cloid: string; message: string }
  | { kind: 'unknown'; cloid: string; message: string }

type RawStatus = string | { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string }

export function readStatus(s: RawStatus, cloid: string): OrderOutcome {
  if (typeof s === 'string') return s === 'waitingForFill' || s === 'waitingForTrigger' ? { kind: 'waiting', cloid } : { kind: 'error', cloid, message: s }
  if (s.filled) return { kind: 'filled', cloid, oid: s.filled.oid, totalSz: Number(s.filled.totalSz), avgPx: Number(s.filled.avgPx) }
  if (s.resting) return { kind: 'resting', cloid, oid: s.resting.oid }
  return { kind: 'error', cloid, message: s.error ?? 'refused' }
}

/** The venue's record of an order by its client id, after an answer was lost. */
export async function lookUp(user: string, cloid: string): Promise<OrderOutcome> {
  for (let i = 0; i < 4; i++) {
    const r = await hlInfo<{ status: string; order?: { status: string; order: { oid: number; origSz: string; sz: string; limitPx: string } } }>({ type: 'orderStatus', user, oid: cloid }).catch(() => null)
    if (r?.status === 'order' && r.order) {
      const st = r.order.status
      const o = r.order.order
      if (st === 'filled') return { kind: 'filled', cloid, oid: o.oid, totalSz: Number(o.origSz), avgPx: Number(o.limitPx) }
      if (st === 'open' || st === 'triggered') return { kind: 'resting', cloid, oid: o.oid }
      return { kind: 'error', cloid, message: st }
    }
    if (r?.status === 'unknownOid' && i >= 2) return { kind: 'error', cloid, message: 'not placed' }
    await new Promise(res => setTimeout(res, 800))
  }
  return { kind: 'unknown', cloid, message: 'Hyperliquid did not confirm this order: check your open orders before trying again.' }
}

function agentRefused(a: HlAccess, e: unknown): boolean {
  if (a.kind !== 'external' || !(e instanceof HlError)) return false
  if (/does not exist/i.test(e.message)) { forgetAgent(a.user); return true }
  return false
}

export class NeedsEnable extends Error {}

async function sendL1<T>(a: HlAccess, action: Parameters<typeof signL1>[1]): Promise<T> {
  if (!a.l1) throw new NeedsEnable('Enable trading first')
  const nonce = nextNonce()
  const signature = await signL1(a.l1, action, nonce, HL_MAINNET)
  try {
    return await hlExchange<T>({ action, nonce, signature })
  } catch (e) {
    if (agentRefused(a, e)) throw new NeedsEnable('Your trading approval is no longer active: enable trading again.')
    throw e
  }
}

export async function placeOrders(a: HlAccess, orders: OrderRequest[], opts: { builder?: Builder | null; grouping?: Grouping } = {}): Promise<OrderOutcome[]> {
  // The trade switch (lib/tradeSwitch.ts) stops new positions; closing one (reduce-only) always goes through.
  if (orders.some(o => !o.reduceOnly)) await assertTradingOn('hyperliquid')
  const withIds = orders.map(o => ({ ...o, cloid: o.cloid ?? newCloid() }))
  const action = orderAction(withIds.map(orderWire), opts.builder ?? null, opts.grouping ?? 'na')
  let resp: { type: string; data?: { statuses: RawStatus[] } }
  try {
    resp = await sendL1(a, action)
  } catch (e) {
    if (e instanceof NeedsEnable || e instanceof HlError) throw e
    // The answer was lost on the way back: ask the venue what became of each order.
    return Promise.all(withIds.map(o => lookUp(a.user, o.cloid!)))
  }
  const statuses = resp.data?.statuses ?? []
  return withIds.map((o, i) => (statuses[i] !== undefined ? readStatus(statuses[i], o.cloid!) : { kind: 'unknown' as const, cloid: o.cloid!, message: 'no status' }))
}

export async function cancelOrders(a: HlAccess, cancels: { asset: number; oid: number }[]): Promise<(true | string)[]> {
  const resp = await sendL1<{ data?: { statuses: (string | { error: string })[] } }>(a, cancelAction(cancels))
  return (resp.data?.statuses ?? []).map(s => (s === 'success' ? true : typeof s === 'string' ? s : s.error))
}

export async function setLeverage(a: HlAccess, asset: number, isCross: boolean, leverage: number): Promise<void> {
  await sendL1(a, updateLeverageAction(asset, isCross, Math.max(1, Math.round(leverage))))
}

// ── building orders from what the trader chose ───────────────────────────

/** How far a market order may fill from the mid (Hyperliquid's own UI uses 8% by default; ARCDEX is stricter). */
export const DEFAULT_SLIPPAGE = 0.03
/** Hyperliquid refuses an order worth under $10. */
export const MIN_ORDER_USD = 10

export interface PerpOrderInput {
  market: HlMarket
  isBuy: boolean
  /** Order value in dollars (notional, leverage included). */
  usd: number
  kind: 'market' | 'limit'
  limitPx?: number
  postOnly?: boolean
  reduceOnly?: boolean
  slippage?: number
  /** Take-profit and stop-loss prices, attached to the order (Hyperliquid's normalTpsl grouping). */
  tp?: number | null
  sl?: number | null
  mid: number
}

export function buildPerpOrders(i: PerpOrderInput): { orders: OrderRequest[]; grouping: Grouping; px: number; sz: number } {
  const m = i.market
  const slip = i.slippage ?? DEFAULT_SLIPPAGE
  const px = i.kind === 'market'
    ? marketPrice(i.mid, i.isBuy, slip, m.szDecimals, true)
    : roundPrice(i.limitPx ?? i.mid, m.szDecimals, true)
  const refPx = i.kind === 'market' ? i.mid : px
  const sz = roundSize(i.usd / refPx, m.szDecimals)
  const orders: OrderRequest[] = [{
    asset: m.asset, isBuy: i.isBuy, px, sz, reduceOnly: !!i.reduceOnly,
    type: { limit: { tif: i.kind === 'market' ? 'Ioc' : i.postOnly ? 'Alo' : 'Gtc' } },
  }]
  // A take-profit or stop-loss closes the position: the opposite side, reduce-only, a market order once triggered,
  // its limit set past the trigger by the slippage so it fills.
  const trigger = (tpsl: 'tp' | 'sl', at: number): OrderRequest => {
    const triggerPx = roundPrice(at, m.szDecimals, true)
    return {
      asset: m.asset, isBuy: !i.isBuy, sz, reduceOnly: true,
      px: marketPrice(triggerPx, !i.isBuy, Math.max(slip, 0.05), m.szDecimals, true),
      type: { trigger: { triggerPx, isMarket: true, tpsl } },
    }
  }
  if (i.tp) orders.push(trigger('tp', i.tp))
  if (i.sl) orders.push(trigger('sl', i.sl))
  return { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na', px, sz }
}

/** The liquidation price Hyperliquid would set for a fresh isolated position (maintenance margin is half the initial
 * margin at max leverage: Hyperliquid's own rule). An estimate, shown as one; the venue's own value replaces it. */
export function estLiquidation(entry: number, isLong: boolean, leverage: number, maxLeverage: number): number | null {
  if (!(entry > 0) || !(leverage > 0)) return null
  const mm = 1 / (2 * maxLeverage)
  const im = 1 / leverage
  const move = (im - mm) / (1 - (isLong ? mm : -mm))
  const px = isLong ? entry * (1 - move) : entry * (1 + move)
  return px > 0 ? px : null
}

/** ARCDEX's builder fee on a perp order, when the builder can receive it and the user approved it. */
export function perpBuilder(s: Pick<HlAccessStatus, 'builderReady' | 'approvedF'> | null): Builder | null {
  return s && s.builderReady && s.approvedF >= BUILDER.perpF ? { b: BUILDER.address, f: BUILDER.perpF } : null
}

/** On outcome markets builder fees apply to sells only (Hyperliquid's spot rule). */
export function outcomeBuilder(s: Pick<HlAccessStatus, 'builderReady' | 'approvedF'> | null, isBuy: boolean): Builder | null {
  return !isBuy && s && s.builderReady && s.approvedF >= BUILDER.outcomeF ? { b: BUILDER.address, f: BUILDER.outcomeF } : null
}

export interface OutcomeOrderInput { outcome: number; side: 0 | 1; isBuy: boolean; usd?: number; contracts?: number; px: number; kind: 'market' | 'limit'; slippage?: number }

/** An order on one side of an outcome market: whole contracts, at most 5 significant figures, between 0 and 1. */
export function buildOutcomeOrder(i: OutcomeOrderInput): OrderRequest {
  const slip = i.slippage ?? 0.02
  const raw = i.kind === 'market' ? i.px + (i.isBuy ? slip : -slip) : i.px
  const px = Math.min(0.99999, Math.max(0.00001, roundPrice(raw, 0, false, i.kind === 'market' ? (i.isBuy ? 'buy' : 'sell') : undefined)))
  const sz = Math.floor(i.contracts ?? (i.usd ?? 0) / Math.max(i.px, 0.00001))
  return { asset: ASSET.outcome(i.outcome, i.side), isBuy: i.isBuy, px, sz, reduceOnly: false, type: { limit: { tif: i.kind === 'market' ? 'Ioc' : 'Gtc' } } }
}
