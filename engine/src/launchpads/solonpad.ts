// SolonPad's curve mode (a Pons V2 port, solonpad.fun). Each curve launch
// gets its own bonding curve until 10,000 USDC is raised and the coin
// migrates to a native-USDC Uniswap v4 pool (read like any other). Only
// curves quoted in native USDC are indexed; ones quoted in another ERC-20
// (tokenized stocks) are left out. Events and addresses: api/_curves.ts.
//
//   TokenLaunched data: pairToken (0 = native USDC), launchConfigId, graduationThreshold.
//   getLaunchedToken(token) returns a static struct, inline: token (word 0),
//     curve (1), …, pairToken (4), …, exists (14).
//   The trades carry no reserves: each is priced at what it paid on the
//   curve, fees and taxes aside.

import type { RawLog } from '../../../api/_arcLogs'
import { NATIVE, topicAddress, word } from '../../../api/_arcSwaps'
import { SEL, SOLONPAD_FACTORY, SOLON_BUY, SOLON_SELL, SOLON_TOKEN_LAUNCHED, decodeCurveTrade } from '../../../api/_curves'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { metrics } from '../metrics'
import { cleanText, tokenMeta, type AdapterContext, type LaunchpadAdapter } from './adapter'
import { CurveBook, addressAt, checked, curveTradeOf, padAddress, readCall, wordAt } from './curveBook'

export interface SolonCurve { token: string }

/** A native-USDC curve the factory names; null if it isn't one. */
export function verifySolonCurve(rpc: Rpc, curve: string): Promise<SolonCurve | null> {
  return checked(async () => {
    const token = addressAt(await readCall(rpc, curve, SEL.token), 0)
    if (!isAddress(token)) return null
    const r = await readCall(rpc, SOLONPAD_FACTORY, SEL.getLaunchedToken + padAddress(token))
    if (r.length < 2 + 64 * 15) return null
    const named = addressAt(r, 1), pair = addressAt(r, 4), exists = wordAt(r, 14) === 1n
    return exists && named === curve && pair === NATIVE ? { token } : null
  })
}

export class SolonPadAdapter implements LaunchpadAdapter {
  readonly name = 'SolonPad'
  readonly curves = new CurveBook<SolonCurve>()

  filters() {
    return [
      { address: SOLONPAD_FACTORY, topics: [SOLON_TOKEN_LAUNCHED] },
      // Every curve is its own contract: any address, checked against the factory.
      { topics: [[SOLON_BUY, SOLON_SELL]] },
    ]
  }

  matches(l: RawLog) {
    const t0 = l.topics[0]
    return (t0 === SOLON_TOKEN_LAUNCHED && l.address.toLowerCase() === SOLONPAD_FACTORY) || t0 === SOLON_BUY || t0 === SOLON_SELL
  }

  async parseLaunch(l: RawLog, ctx: AdapterContext): Promise<LaunchInfo | null> {
    if (l.topics[0] !== SOLON_TOKEN_LAUNCHED || l.address.toLowerCase() !== SOLONPAD_FACTORY || l.topics.length < 4 || l.data.length < 2 + 64 * 3) return null
    const token = topicAddress(l.topics[1]), curve = topicAddress(l.topics[2]), deployer = topicAddress(l.topics[3])
    // Quoted in another ERC-20 (a tokenized stock): not indexed here.
    if (!isAddress(token) || !isAddress(curve) || ('0x' + word(l.data, 0).slice(24)).toLowerCase() !== NATIVE) return null
    this.curves.add(curve, { token })
    // Name and symbol from the token; the opening price from the curve's reserves.
    const [meta, reserves] = await Promise.all([
      tokenMeta(ctx.rpc, token),
      readCall(ctx.rpc, curve, SEL.getReserves).catch(() => null),
    ])
    const q = reserves ? wordAt(reserves, 0) : 0n, t = reserves ? wordAt(reserves, 1) : 0n
    metrics.inc('launches_solonpad')
    return {
      token,
      name: cleanText(meta.name ?? '') || 'Unknown',
      symbol: cleanText(meta.symbol ?? '', 24) || '???',
      decimals: meta.decimals ?? 18,
      creator: isAddress(deployer) && deployer !== NATIVE ? deployer : null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool: curve,
      quote: NATIVE,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      image: null,
      priceUsd: q > 0n && t > 0n ? Number(q) / Number(t) : null,
    }
  }

  async parseTrade(l: RawLog, ctx: AdapterContext): Promise<Trade | null> {
    if (l.topics[0] !== SOLON_BUY && l.topics[0] !== SOLON_SELL) return null
    const curve = l.address.toLowerCase()
    const c = await this.curves.resolve(curve, x => verifySolonCurve(ctx.rpc, x))
    if (!c) return null
    const d = decodeCurveTrade(l, 'SolonPad')
    return d ? curveTradeOf(l, d, c.token, curve, 'solonpad-curve', this.name, ctx) : null
  }
}
