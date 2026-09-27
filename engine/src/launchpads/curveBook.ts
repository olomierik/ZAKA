// What the Mercuri and SolonPad adapters share. Each launch on those
// launchpads gets its own bonding-curve contract, so their trades can't be
// streamed from one address: the stream takes every Buy/Sell-shaped event
// on the chain, and a curve's events count only once its launchpad's
// factory names it (api/_curves.ts). Curves come from launch events, or are
// checked on the first trade seen (one launched before the engine's window).

import { RpcError, type RawLog } from '../../../api/_arcLogs'
import { NATIVE } from '../../../api/_arcSwaps'
import type { CurveTrade } from '../../../api/_curves'
import type { Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { metrics } from '../metrics'
import type { AdapterContext } from './adapter'

/** Verified curves, and contracts known not to be one. A check that the
 * chain couldn't answer is retried at the next trade, never remembered. */
export class CurveBook<T> {
  private known = new Map<string, T>()
  private notCurves = new Set<string>()
  private checking = new Map<string, Promise<T | null>>()

  add(curve: string, info: T) { this.known.set(curve.toLowerCase(), info) }
  get(curve: string): T | undefined { return this.known.get(curve.toLowerCase()) }
  get size() { return this.known.size }

  /** The curve's info, verifying it (once, however many trades ask at once) if it's new. */
  resolve(curve: string, verify: (curve: string) => Promise<T | null>): Promise<T | null> {
    const c = curve.toLowerCase()
    const hit = this.known.get(c)
    if (hit) return Promise.resolve(hit)
    if (this.notCurves.has(c)) return Promise.resolve(null)
    let p = this.checking.get(c)
    if (!p) {
      p = verify(c).then(info => {
        if (info) this.known.set(c, info)
        else {
          this.notCurves.add(c)
          if (this.notCurves.size > 20_000) this.notCurves.delete(this.notCurves.values().next().value as string)
        }
        return info
      }, () => { metrics.inc('curve_check_errors'); return null }).finally(() => this.checking.delete(c))
      this.checking.set(c, p)
    }
    return p
  }
}

/** A revert (or no code) is a definite answer; anything else is the network. */
export class NotACurve extends Error {}

/** eth_call returning the raw result; a revert or an empty result throws NotACurve. */
export async function readCall(rpc: Rpc, to: string, data: string): Promise<string> {
  let r: string
  try { r = await rpc.call<string>('eth_call', [{ to, data }, 'latest']) } catch (e) {
    // HttpRpc rethrows a call's own error (a revert) at once; throttling and timeouts are the network.
    if (e instanceof RpcError && e.code !== 429 && !/rate|limit|timeout|unavailable|busy/i.test(e.message)) throw new NotACurve(e.message)
    throw e
  }
  if (!r || r === '0x' || r.length < 66) throw new NotACurve('no result')
  return r
}

export const wordAt = (r: string, i: number) => BigInt('0x' + r.slice(2 + i * 64, 2 + (i + 1) * 64))
export const addressAt = (r: string, i: number) => ('0x' + r.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)).toLowerCase()
export const padAddress = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** Runs a verification, turning a definite "not a curve" into null. */
export async function checked<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try { return await fn() } catch (e) { if (e instanceof NotACurve) return null; throw e }
}

/** A curve trade in the engine's shape. The wallet is the transaction's
 * sender when known (a router in between names itself in the event), else
 * the trader the event names. */
export async function curveTradeOf(l: RawLog, d: CurveTrade, token: string, curve: string, dex: string, launchpad: string, ctx: AdapterContext): Promise<Trade> {
  const logIndex = parseInt(l.logIndex, 16)
  const txHash = l.transactionHash.toLowerCase()
  const sender = ctx.sender ? await Promise.race([ctx.sender(txHash).catch(() => null), new Promise<null>(r => setTimeout(() => r(null), 1_500))]) : null
  const wallet = sender ?? d.trader
  return {
    tradeId: `${txHash}:${logIndex}`,
    chain: 'ARC',
    token,
    pair: `${token}/${NATIVE}`,
    pool: curve,
    quote: NATIVE,
    side: d.kind === 'buy' ? 'BUY' : 'SELL',
    baseAmount: d.tokenAmount,
    quoteAmount: d.usdc,
    tokenAmount: d.tokenAmount,
    price: d.price,
    // Native USDC is the dollar.
    priceUsd: d.price,
    usdValue: d.usdc,
    wallet: isAddress(wallet) ? wallet : null,
    txHash,
    blockNumber: parseInt(l.blockNumber, 16),
    logIndex,
    timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
    dex,
    launchpad,
    liquidity: d.reserveUsdc,
  }
}
