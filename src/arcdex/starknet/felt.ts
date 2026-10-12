// Starknet's numbers: felts (field elements below 2^251 + …, written as hex), function selectors, and u256 values,
// which Cairo passes as two felts (low 128 bits, then high).

import { keccak256, toHex } from 'viem'

const MASK_250 = (1n << 250n) - 1n
const U128 = 1n << 128n

/** A function or event name's selector: Starknet's keccak, the low 250 bits of keccak-256 of the name. */
export const selector = (name: string): string => `0x${(BigInt(keccak256(toHex(name))) & MASK_250).toString(16)}`

/** Selectors used here, computed once (checked against their well-known values in scripts/test-starknet.ts). */
export const SEL = {
  transfer: selector('transfer'),
  approve: selector('approve'),
  balanceOf: selector('balanceOf'),
  Transfer: selector('Transfer'),
  multiRouteSwap: selector('multi_route_swap'),
}

/** A felt as a bigint; anything that isn't one is null. */
export function felt(x: unknown): bigint | null {
  if (typeof x === 'bigint') return x >= 0n ? x : null
  if (typeof x === 'number') return Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null
  if (typeof x !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(x.trim())) return null
  return BigInt(x.trim())
}

/** Two addresses (or felts) are the same whatever their padding or case. */
export const sameFelt = (a: unknown, b: unknown) => { const x = felt(a), y = felt(b); return x !== null && y !== null && x === y }

/** An address in its canonical form: 0x and 64 hex digits. */
export const padAddress = (a: string) => `0x${(felt(a) ?? 0n).toString(16).padStart(64, '0')}`
export const isAddress = (a: string) => { const f = felt(a); return f !== null && f > 0n && f < (1n << 251n) }

export const toFelt = (n: bigint) => `0x${n.toString(16)}`
/** A u256 as Cairo passes it: [low, high]. */
export const u256 = (n: bigint): [string, string] => [toFelt(n % U128), toFelt(n / U128)]
/** A u256 from its two felts; null if either isn't a felt or low is out of range. */
export function fromU256(low: unknown, high: unknown): bigint | null {
  const l = felt(low), h = felt(high)
  if (l === null || h === null || l >= U128 || h >= U128) return null
  return h * U128 + l
}

/** A token amount from its smallest units, for display. */
export function units(n: bigint, decimals: number): number {
  return Number(n) / 10 ** decimals
}
/** A typed amount in a token's smallest units ("1.5" with 18 decimals → 1500000000000000000n); null when not a number. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const t = s.trim()
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
}
