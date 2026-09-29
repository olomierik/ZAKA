// Peach (GeckoTerminal "peach"): the second-largest Arc venue by volume on
// 2026-09-30 ($840k in 24h). Each launch gets its own curve contract, priced
// in the USDC ERC-20; a coin that graduates moves to a Uniswap v4 pool (read
// like any other). Peach publishes no ABI: the events below were decoded
// from mainnet on 2026-09-30 against each transaction's token and USDC
// transfers (14 trades, 77 launches).
//
//   Launched  0x091220c7…  from the launcher 0x7e46…9dc1
//     topics: token, the coin's curve, creator
//     data:   quote (USDC), 0, 1e10, the v4 pool id it graduates to, …
//   Trade     0xeab3e828…  from each coin's curve
//     topics: token, recipient
//     data:   w0 trader, w2 1 = buy / 0 = sell, w3 tokens (18 decimals),
//             w4 USDC before fees, w5 USDC after fees, w6 the 1% fee (6 decimals)
//
// A curve counts when a launch named it (quoted in USDC), or when its code is
// Peach's curve template byte for byte and it was deployed with USDC as its
// quote (engine/src/intel/templateData.ts), for one launched before the
// engine's window.

import type { RawLog } from '../../../api/_arcLogs'
import { USDC, topicAddress } from '../../../api/_arcSwaps'
import type { CurveTrade } from '../../../api/_curves'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { field, matchesTemplate } from '../intel/templates'
import { TEMPLATES } from '../intel/templateData'
import { metrics } from '../metrics'
import { cleanText, tokenMeta, type AdapterContext, type LaunchpadAdapter } from './adapter'
import { CurveBook, curveTradeOf } from './curveBook'

export const PEACH_LAUNCHER = '0x7e462d220b6b0a4c55b205b613133dc1c1cc9dc1'
export const PEACH_LAUNCHED = '0x091220c7b93dbf022367afb0756ee792b7be2ca40436aa65722f233607784d62'
export const PEACH_TRADE = '0xeab3e828d2fd17855f356495b10e91df9ddf7d934563edb3895cab88239f3596'

const w = (data: string, i: number) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'))

/** A Peach curve trade → the shared curve-trade shape; null if malformed. */
export function decodePeachTrade(l: Pick<RawLog, 'topics' | 'data'>): CurveTrade | null {
  if (l.topics[0] !== PEACH_TRADE || l.topics.length < 3 || l.data.length < 2 + 64 * 7) return null
  const isBuy = w(l.data, 2)
  if (isBuy > 1n) return null
  const tokens = Number(w(l.data, 3)) / 1e18
  const gross = Number(w(l.data, 4)) / 1e6, net = Number(w(l.data, 5)) / 1e6, fee = Number(w(l.data, 6)) / 1e6
  if (!(tokens > 0) || !(gross > 0)) return null
  const buy = isBuy === 1n
  return {
    kind: buy ? 'buy' : 'sell',
    trader: topicAddress(l.topics[2]),
    tokenAmount: tokens,
    // Paid in, fees included (buy); received, after fees (sell).
    usdc: buy ? gross : net,
    // The curve's price, the 1% fee aside (a buy's other fees, if any, are not in the event).
    price: (buy ? gross - fee : gross) / tokens,
    reserveUsdc: null,
  }
}

/** A Peach curve quoted in USDC (its code is the template, and the quote it
 * was deployed with is USDC); null otherwise. Curves quoted in other tokens
 * (cirBTC, …) report amounts in that token: left out. */
export async function verifyPeachCurve(rpc: Rpc, curve: string, token: string): Promise<{ token: string } | null> {
  const t = TEMPLATES['Peach curve']
  const code = await rpc.call<string>('eth_getCode', [curve, 'latest'])
  return t && matchesTemplate(code, t) && field(code, t, 'quote') === USDC && isAddress(token) ? { token } : null
}

export class PeachAdapter implements LaunchpadAdapter {
  readonly name = 'Peach'
  readonly curves = new CurveBook<{ token: string }>()

  filters() {
    return [
      { address: PEACH_LAUNCHER, topics: [PEACH_LAUNCHED] },
      // Every coin's curve is its own contract: any address, checked against the template.
      { topics: [PEACH_TRADE] },
    ]
  }

  matches(l: RawLog) {
    return (l.topics[0] === PEACH_LAUNCHED && l.address.toLowerCase() === PEACH_LAUNCHER) || l.topics[0] === PEACH_TRADE
  }

  async parseLaunch(l: RawLog, ctx: AdapterContext): Promise<LaunchInfo | null> {
    if (l.topics[0] !== PEACH_LAUNCHED || l.address.toLowerCase() !== PEACH_LAUNCHER || l.topics.length < 4) return null
    const token = topicAddress(l.topics[1]), curve = topicAddress(l.topics[2]), creator = topicAddress(l.topics[3])
    const quote = ('0x' + (l.data.slice(2, 66) || '').slice(24)).toLowerCase()
    if (!isAddress(token) || !isAddress(curve) || quote !== USDC) return null
    this.curves.add(curve, { token })
    const meta = await tokenMeta(ctx.rpc, token)
    metrics.inc('launches_peach')
    return {
      token,
      name: cleanText(meta.name ?? '') || 'Unknown',
      symbol: cleanText(meta.symbol ?? '', 24) || '???',
      decimals: meta.decimals ?? 18,
      creator: isAddress(creator) ? creator : null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool: curve,
      quote: USDC,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      image: null,
    }
  }

  async parseTrade(l: RawLog, ctx: AdapterContext): Promise<Trade | null> {
    if (l.topics[0] !== PEACH_TRADE) return null
    const d = decodePeachTrade(l)
    if (!d) return null
    const curve = l.address.toLowerCase(), token = topicAddress(l.topics[1])
    const c = await this.curves.resolve(curve, x => verifyPeachCurve(ctx.rpc, x, token))
    if (!c || c.token !== token) return null
    return curveTradeOf(l, d, c.token, curve, 'peach-curve', this.name, ctx, USDC)
  }
}
