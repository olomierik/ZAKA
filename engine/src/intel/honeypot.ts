// Can a holder sell? The honeypot probe (contracts/test/sim/HoneypotProbe.sol)
// buys a little of the coin through its real pool and hook, passes it to a
// fresh address, and sells it from there — all inside one eth_call with the
// probe's code and some USDC injected by a state override. Nothing is sent.
//
// Verdicts:
//   ok           bought, moved and sold; the round trip's cost is measured
//   honeypot     bought, but the transfer or the sale reverted
//   untradeable  the pool wouldn't sell to the probe at all (a hook that only
//                allows its own router), or had nothing to sell (no liquidity
//                yet): not proof of a honeypot, but not a coin to trade either
//   unknown      the chain couldn't answer

import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { ARGUS, NATIVE, USDC } from '../../../api/_arcSwaps'
import type { Rpc } from '../chain/http'
import type { PoolInfo } from '../dex/pools'
import { PROBE_ABI, PROBE_RUNTIME } from './probeBuild'

export const PROBE_ADDRESS = '0x00000000000000000000000000000000000ba5e0'
/** ARGUS-quoted coins route through ARCDEX's usual ARGUS/USDC v4 pool. */
const ARGUS_USDC_KEY = { currency0: USDC, currency1: ARGUS, fee: 9850, tickSpacing: 99, hooks: NATIVE } as const

export type HoneypotVerdict = 'ok' | 'honeypot' | 'untradeable' | 'unknown'

export interface HoneypotResult {
  verdict: HoneypotVerdict
  /** Share of the bought tokens lost before they reached the buyer (a tax in the token). */
  buyTaxPct: number | null
  /** Share lost passing them to another wallet. */
  transferTaxPct: number | null
  /** What a buy and immediate sale cost, as a share of the USDC put in: pool fees, hook taxes, token taxes, price impact. */
  roundTripLossPct: number | null
  /** The revert's data, when a step failed. */
  error: string | null
}

interface ProbeResult { bought: boolean; swapOut: bigint; received: bigint; transferred: boolean; sellerReceived: bigint; sold: boolean; soldFor: bigint; error: `0x${string}` }

/** Result of a probe (exported for tests). */
export function interpret(r: ProbeResult, amountIn: bigint): HoneypotResult {
  const pct = (lost: bigint, of: bigint) => (of > 0n ? Number(((of - lost) * 10_000n) / of) / 100 : null)
  const err = r.error && r.error !== '0x' ? r.error : null
  // Didn't trade, or traded into nothing (a pool with no liquidity yet): nothing to judge.
  if (!r.bought || r.swapOut === 0n || r.received === 0n) {
    return { verdict: 'untradeable', buyTaxPct: null, transferTaxPct: null, roundTripLossPct: null, error: err ?? (r.bought ? 'no liquidity: the buy returned nothing' : null) }
  }
  const buyTaxPct = pct(r.received, r.swapOut)
  if (!r.transferred || r.sellerReceived === 0n) return { verdict: 'honeypot', buyTaxPct, transferTaxPct: 100, roundTripLossPct: 100, error: err }
  const transferTaxPct = pct(r.sellerReceived, r.received)
  if (!r.sold) return { verdict: 'honeypot', buyTaxPct, transferTaxPct, roundTripLossPct: 100, error: err }
  return { verdict: 'ok', buyTaxPct, transferTaxPct, roundTripLossPct: pct(r.soldFor, amountIn), error: null }
}

/** Probe a coin's pool with `usd` dollars (1 by default). `overrides` adds
 * state overrides (tests: replacing a coin's code with a known honeypot). */
export async function probeHoneypot(rpc: Rpc, pool: PoolInfo, usd = 1, overrides: Record<string, object> = {}): Promise<HoneypotResult> {
  const unknown = (error: string): HoneypotResult => ({ verdict: 'unknown', buyTaxPct: null, transferTaxPct: null, roundTripLossPct: null, error })
  let data: `0x${string}`, amountIn: bigint
  if (pool.dex === 'uniswap-v4') {
    const key = { currency0: pool.currency0 as `0x${string}`, currency1: pool.currency1 as `0x${string}`, fee: pool.fee, tickSpacing: pool.tickSpacing ?? 0, hooks: (pool.hooks ?? NATIVE) as `0x${string}` }
    // Paid in USDC: native (18 decimals) or the ERC-20 (6), through ARGUS/USDC for an ARGUS-quoted coin.
    const quote = pool.quote === ARGUS ? USDC : pool.quote
    if (quote !== USDC && quote !== NATIVE) return unknown(`quoted in ${pool.quote}, not USDC`)
    amountIn = BigInt(Math.round(usd * 1e6)) * (quote === NATIVE ? 10n ** 12n : 1n)
    const path = pool.quote === ARGUS ? [ARGUS_USDC_KEY, key] : [key]
    data = encodeFunctionData({ abi: PROBE_ABI, functionName: 'probeV4', args: [path as never, pool.base as `0x${string}`, quote as `0x${string}`, amountIn] })
  } else {
    if (pool.quote !== USDC) return unknown(`v3 pool quoted in ${pool.quote}, not USDC`)
    amountIn = BigInt(Math.round(usd * 1e6))
    data = encodeFunctionData({ abi: PROBE_ABI, functionName: 'probeV3', args: [pool.base as `0x${string}`, USDC, pool.fee, amountIn] })
  }
  let raw: `0x${string}`
  try {
    raw = await rpc.call<`0x${string}`>('eth_call', [
      { to: PROBE_ADDRESS, data, gas: '0x1c9c380' },
      'latest',
      // Arc's native balance is its USDC: 1,000 USDC for the probe (18 decimals).
      { ...overrides, [PROBE_ADDRESS]: { code: PROBE_RUNTIME, balance: '0x3635c9adc5dea00000' } },
    ], 15_000)
  } catch (e) { return unknown(e instanceof Error ? e.message : String(e)) }
  const r = decodeFunctionResult({ abi: PROBE_ABI, functionName: pool.dex === 'uniswap-v4' ? 'probeV4' : 'probeV3', data: raw }) as unknown as ProbeResult
  return interpret(r, amountIn)
}
