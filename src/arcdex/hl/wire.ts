// Hyperliquid order wires and the rounding rules prices and sizes must follow. The field order is the SDK's
// (order_request_to_order_wire, order_type_to_wire, order_wires_to_order_action): the signature is over the msgpack
// of these objects, so a field out of place makes a signature the venue rejects.
//
// Rounding (Hyperliquid's tick and lot rules, as the SDK's _slippage_price applies them):
// - size: at most szDecimals decimals (each market's own);
// - price: at most 5 significant figures, and at most (6 for perps, 8 for spot and outcomes) − szDecimals decimals;
//   an integer price is always allowed.

import { floatToWire } from './signing'

export type Tif = 'Alo' | 'Ioc' | 'Gtc'
export type OrderType =
  | { limit: { tif: Tif } }
  | { trigger: { triggerPx: number; isMarket: boolean; tpsl: 'tp' | 'sl' } }

export interface OrderRequest {
  asset: number
  isBuy: boolean
  px: number
  sz: number
  reduceOnly: boolean
  type: OrderType
  /** A client order id: 16 bytes as 0x + 32 hex. */
  cloid?: string
}

export interface OrderWire {
  a: number; b: boolean; p: string; s: string; r: boolean
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } }
  c?: string
}

export type Grouping = 'na' | 'normalTpsl' | 'positionTpsl'
export interface Builder { b: string; f: number }

export function orderWire(o: OrderRequest): OrderWire {
  const t: OrderWire['t'] = 'limit' in o.type
    ? { limit: { tif: o.type.limit.tif } }
    : { trigger: { isMarket: o.type.trigger.isMarket, triggerPx: floatToWire(o.type.trigger.triggerPx), tpsl: o.type.trigger.tpsl } }
  const w: OrderWire = { a: o.asset, b: o.isBuy, p: floatToWire(o.px), s: floatToWire(o.sz), r: o.reduceOnly, t }
  if (o.cloid) {
    if (!/^0x[0-9a-f]{32}$/.test(o.cloid)) throw new Error('cloid must be 0x + 32 lowercase hex')
    w.c = o.cloid
  }
  return w
}

export function orderAction(orders: OrderWire[], builder?: Builder | null, grouping: Grouping = 'na') {
  const action: { type: 'order'; orders: OrderWire[]; grouping: Grouping; builder?: Builder } = { type: 'order', orders, grouping }
  if (builder) action.builder = { b: builder.b.toLowerCase(), f: builder.f }
  return action
}

export function cancelAction(cancels: { asset: number; oid: number }[]) {
  return { type: 'cancel' as const, cancels: cancels.map(c => ({ a: c.asset, o: c.oid })) }
}

export function updateLeverageAction(asset: number, isCross: boolean, leverage: number) {
  return { type: 'updateLeverage' as const, asset, isCross, leverage }
}

/** Asset ids from Hyperliquid's asset-ids page. */
export const ASSET = {
  /** A builder-deployed (HIP-3) perp: 100000 + dex index (its place in perpDexs) × 10000 + its index in that dex's meta. */
  hip3: (dexIndex: number, index: number) => 100_000 + dexIndex * 10_000 + index,
  spot: (index: number) => 10_000 + index,
  /** An outcome side (HIP-4): 100000000 + 10 × outcome + side (0 or 1). */
  outcome: (outcome: number, side: 0 | 1) => 100_000_000 + 10 * outcome + side,
  isPerp: (asset: number) => asset < 10_000 || (asset >= 100_000 && asset < 100_000_000),
}

/** The coin name an outcome side trades as: "#<encoding>". */
export const outcomeCoin = (outcome: number, side: 0 | 1) => `#${10 * outcome + side}`

function decimalsOf(x: number): number {
  const s = String(x)
  if (s.includes('e-')) return Number(s.split('e-')[1])
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** A size rounded down to the market's lot (never more than the user asked for). */
export function roundSize(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals
  return Math.floor(sz * f + 1e-9) / f
}

/** A price on the venue's grid: 5 significant figures and the market's decimal limit (integers always pass). Buys
 * round up and sells down when `side` is given (so a marketable limit stays marketable); otherwise to nearest. */
export function roundPrice(px: number, szDecimals: number, perp: boolean, side?: 'buy' | 'sell'): number {
  if (!(px > 0)) return 0
  const maxDec = Math.max(0, (perp ? 6 : 8) - szDecimals)
  if (Number.isInteger(px) && side === undefined) return px
  const mag = Math.floor(Math.log10(px))
  const sigDec = Math.max(0, 4 - mag) // decimals that keep 5 significant figures
  const dec = Math.min(maxDec, sigDec)
  const f = 10 ** dec
  const raw = px * f
  const r = side === 'buy' ? Math.ceil(raw - 1e-9) : side === 'sell' ? Math.floor(raw + 1e-9) : Math.round(raw)
  return Number((r / f).toFixed(dec))
}

/** True when a price is already on the grid (for checking a user's limit price). */
export function onGrid(px: number, szDecimals: number, perp: boolean): boolean {
  if (Number.isInteger(px)) return true
  const maxDec = Math.max(0, (perp ? 6 : 8) - szDecimals)
  if (decimalsOf(px) > maxDec) return false
  const digits = String(px).replace('.', '').replace(/^0+/, '')
  return digits.length <= 5
}

/** A market order as Hyperliquid's own UI sends it: an IOC limit at the mid ± slippage, on the grid. */
export function marketPrice(mid: number, isBuy: boolean, slippage: number, szDecimals: number, perp: boolean): number {
  return roundPrice(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals, perp, isBuy ? 'buy' : 'sell')
}

/** A fresh client order id (16 random bytes). */
export function newCloid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}
