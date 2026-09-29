// Faze (GeckoTerminal "faze", $147k in 24h on 2026-09-30): one contract is
// both the launcher and every coin's bonding curve; a coin that graduates
// moves to a Uniswap v4 pool (read like any other). Event and function
// names are in the public signature database; the fields below were
// checked on mainnet against each trade's own USDC and token transfers.
//
//   Launched(address indexed token, address indexed creator, config, name, symbol, uri)
//   Bought(address indexed token, address indexed buyer,
//          quoteIn (fees included), fee, tokensOut, quoteReserveAfter, tokenReserveAfter)
//   Sold(address indexed token, address indexed seller,
//        tokensIn, fee, quoteOut (after the fee), quoteReserveAfter, tokenReserveAfter)
//   getCoin(token) → word 0 creator, word 3 quote (0 = native USDC), …
//
// A coin can be quoted in native USDC or in another token Faze approved
// (its own FAZE token, for one): only native-USDC coins are indexed, since
// the others' amounts aren't dollars.

import type { RawLog } from '../../../api/_arcLogs'
import { NATIVE, topicAddress } from '../../../api/_arcSwaps'
import type { CurveTrade } from '../../../api/_curves'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { metrics } from '../metrics'
import { cleanText, tokenMeta, type AdapterContext, type LaunchpadAdapter } from './adapter'
import { CurveBook, addressAt, checked, curveTradeOf, padAddress, readCall } from './curveBook'

export const FAZE = '0x6a62919ccbf0c19e0c4e084f986b582b4492dda4'
export const FAZE_LAUNCHED = '0xac320ff805a1bd9194660602c2ad1ec5198a9c9ebf5539e8ffc8faae8b5a6574'
export const FAZE_BOUGHT = '0x8a5254432535d4192429d2cc163283a57784eac274295fcda17cc659c1ee414c'
export const FAZE_SOLD = '0x156f189818933420824a33bbb00381f62b4acd509c93f9e45e90de784e594b73'
const GET_COIN = '0x0929841a'

const w = (data: string, i: number) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'))

/** Faze's own record of `token`: its quote and creator; null if it isn't Faze's coin. */
export function fazeCoin(rpc: Rpc, token: string): Promise<{ quote: string; creator: string } | null> {
  return checked(async () => {
    const r = await readCall(rpc, FAZE, GET_COIN + padAddress(token))
    if (r.length < 2 + 64 * 4) return null
    const creator = addressAt(r, 0), quote = addressAt(r, 3)
    return creator !== NATIVE ? { quote, creator } : null
  })
}

export function decodeFazeTrade(l: Pick<RawLog, 'topics' | 'data'>): CurveTrade | null {
  const buy = l.topics[0] === FAZE_BOUGHT
  if ((!buy && l.topics[0] !== FAZE_SOLD) || l.topics.length < 3 || l.data.length < 2 + 64 * 5) return null
  const e18 = (i: number) => Number(w(l.data, i)) / 1e18
  const tokens = buy ? e18(2) : e18(0), fee = e18(1), usdc = buy ? e18(0) : e18(2)
  if (!(tokens > 0) || !(usdc > 0)) return null
  return {
    kind: buy ? 'buy' : 'sell',
    trader: topicAddress(l.topics[2]),
    tokenAmount: tokens,
    usdc,
    // The curve's price, fee aside.
    price: (buy ? usdc - fee : usdc + fee) / tokens,
    reserveUsdc: e18(3),
  }
}

export class FazeAdapter implements LaunchpadAdapter {
  readonly name = 'Faze'
  /** Coins by token (the curve is Faze's contract itself); null = not a native-USDC coin. */
  readonly coins = new CurveBook<{ token: string }>()

  filters() { return [{ address: FAZE, topics: [[FAZE_LAUNCHED, FAZE_BOUGHT, FAZE_SOLD]] }] }

  matches(l: RawLog) {
    const t = l.topics[0]
    return l.address.toLowerCase() === FAZE && (t === FAZE_LAUNCHED || t === FAZE_BOUGHT || t === FAZE_SOLD)
  }

  private nativeCoin(rpc: Rpc, token: string) {
    return this.coins.resolve(token, async t => ((await fazeCoin(rpc, t))?.quote === NATIVE ? { token: t } : null))
  }

  async parseLaunch(l: RawLog, ctx: AdapterContext): Promise<LaunchInfo | null> {
    if (l.topics[0] !== FAZE_LAUNCHED || l.address.toLowerCase() !== FAZE || l.topics.length < 3) return null
    const token = topicAddress(l.topics[1]), creator = topicAddress(l.topics[2])
    if (!isAddress(token) || !(await this.nativeCoin(ctx.rpc, token))) return null
    const meta = await tokenMeta(ctx.rpc, token)
    metrics.inc('launches_faze')
    return {
      token,
      name: cleanText(meta.name ?? '') || 'Unknown',
      symbol: cleanText(meta.symbol ?? '', 24) || '???',
      decimals: meta.decimals ?? 18,
      creator: isAddress(creator) ? creator : null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      // One contract trades every coin: each coin is its own "pool" (prices are kept per pool).
      pool: token,
      quote: NATIVE,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      image: null,
    }
  }

  async parseTrade(l: RawLog, ctx: AdapterContext): Promise<Trade | null> {
    if (l.address.toLowerCase() !== FAZE) return null
    const d = decodeFazeTrade(l)
    if (!d) return null
    const token = topicAddress(l.topics[1])
    if (!(await this.nativeCoin(ctx.rpc, token))) return null
    // Every Faze coin trades on the one contract: each coin is its own "pool".
    return curveTradeOf(l, d, token, token, 'faze-curve', this.name, ctx)
  }
}
