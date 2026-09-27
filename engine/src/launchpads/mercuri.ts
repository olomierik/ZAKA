// Mercuri (launch.mercuri.finance). Each launch gets its own bonding curve,
// priced in native USDC, until it sells out and the coin graduates to a
// Uniswap v4 pool (whose swaps the trade parser reads like any other).
// Launches come from the factory's TokenCreated; trades from each curve's
// own Buy/Sell events. Events and addresses: api/_curves.ts.
//
//   TokenCreated data: deployer, name, symbol, metadataURI (offsets),
//     configHash, then LaunchConfig inline: virtualUsdc (word 5),
//     virtualTokens (word 6), curveSupply, poolSupply, launchFee,
//     maxInitialBuyTokens, tradeFeeBps, creator/referrer shares, snipe tax.
//   Price = (virtualUsdc + realUsdc) / (virtualTokens − sold), both 18 decimals.

import type { RawLog } from '../../../api/_arcLogs'
import { NATIVE, topicAddress, word } from '../../../api/_arcSwaps'
import { MERCURI_BUY, MERCURI_FACTORY, MERCURI_SELL, MERCURI_TOKEN_CREATED, SEL, decodeCurveTrade } from '../../../api/_curves'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { metrics } from '../metrics'
import { abiString, cleanText, type AdapterContext, type LaunchpadAdapter } from './adapter'
import { CurveBook, addressAt, checked, curveTradeOf, padAddress, readCall, wordAt } from './curveBook'

export interface MercuriCurve { token: string; virtual: { usdc: bigint; tokens: bigint } }

/** A curve the factory names, with its virtual reserves; null if it isn't one. */
export function verifyMercuriCurve(rpc: Rpc, curve: string): Promise<MercuriCurve | null> {
  return checked(async () => {
    // The curve names its token, and the factory must name the curve back.
    const token = addressAt(await readCall(rpc, curve, SEL.token), 0)
    if (!isAddress(token) || addressAt(await readCall(rpc, MERCURI_FACTORY, SEL.curveOf + padAddress(token)), 0) !== curve) return null
    const [u, t] = await Promise.all([readCall(rpc, curve, SEL.virtualUsdc), readCall(rpc, curve, SEL.virtualTokens)])
    const virtual = { usdc: wordAt(u, 0), tokens: wordAt(t, 0) }
    return virtual.usdc > 0n && virtual.tokens > 0n ? { token, virtual } : null
  })
}

export class MercuriAdapter implements LaunchpadAdapter {
  readonly name = 'Mercuri'
  readonly curves = new CurveBook<MercuriCurve>()

  filters() {
    return [
      { address: MERCURI_FACTORY, topics: [MERCURI_TOKEN_CREATED] },
      // Every curve is its own contract: any address, checked against the factory.
      { topics: [[MERCURI_BUY, MERCURI_SELL]] },
    ]
  }

  matches(l: RawLog) {
    const t0 = l.topics[0]
    return (t0 === MERCURI_TOKEN_CREATED && l.address.toLowerCase() === MERCURI_FACTORY) || t0 === MERCURI_BUY || t0 === MERCURI_SELL
  }

  parseLaunch(l: RawLog): Promise<LaunchInfo | null> {
    return Promise.resolve(this.launchOf(l))
  }

  /** The launch a TokenCreated log announces: the event carries all of it, no chain reads. */
  private launchOf(l: RawLog): LaunchInfo | null {
    if (l.topics[0] !== MERCURI_TOKEN_CREATED || l.address.toLowerCase() !== MERCURI_FACTORY || l.topics.length < 4 || l.data.length < 2 + 64 * 16) return null
    const token = topicAddress(l.topics[1]), curve = topicAddress(l.topics[2]), creator = topicAddress(l.topics[3])
    const virtual = { usdc: BigInt('0x' + word(l.data, 5)), tokens: BigInt('0x' + word(l.data, 6)) }
    if (!isAddress(token) || !isAddress(curve) || virtual.usdc === 0n || virtual.tokens === 0n) return null
    this.curves.add(curve, { token, virtual })
    // The opening price, before any trade.
    const priceUsd = Number(virtual.usdc) / Number(virtual.tokens)
    metrics.inc('launches_mercuri')
    return {
      token,
      name: cleanText(abiString(l.data, 1) ?? '') || 'Unknown',
      symbol: cleanText(abiString(l.data, 2) ?? '', 24) || '???',
      decimals: 18,
      creator: isAddress(creator) && creator !== NATIVE ? creator : null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool: curve,
      quote: NATIVE,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      image: null,
      priceUsd,
    }
  }

  async parseTrade(l: RawLog, ctx: AdapterContext): Promise<Trade | null> {
    if (l.topics[0] !== MERCURI_BUY && l.topics[0] !== MERCURI_SELL) return null
    const curve = l.address.toLowerCase()
    const c = await this.curves.resolve(curve, x => verifyMercuriCurve(ctx.rpc, x))
    if (!c) return null
    const d = decodeCurveTrade(l, 'Mercuri', c.virtual)
    return d ? curveTradeOf(l, d, c.token, curve, 'mercuri-curve', this.name, ctx) : null
  }
}
