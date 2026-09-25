// ARCDEX's own launchpad (contracts/ArcLaunchpad.sol) — a bonding curve,
// so its trades never touch a DEX pool: they come from its Trade events.
//
// ── Blockchain specifics ────────────────────────────────────────────────
//   TokenLaunched(address indexed token, address indexed creator,
//                 string name, string symbol, string metadataURI, uint256 creatorTaxBps)
//   Trade(address indexed token, address indexed trader, bool isBuy,
//         uint256 usdcAmount, uint256 tokenAmount, uint256 totalFee,
//         uint256 rUsdcAfter, uint256 rTokenAfter)
// Price = vUsdc / vToken, and the curve moves virtual and real reserves in
// lockstep: vUsdc = INITIAL_VIRTUAL_USDC + rUsdc, vToken = rToken +
// VIRTUAL_TOKEN_OFFSET — so the price after each trade follows from the
// real reserves in the event.

import { keccak256, toHex } from 'viem'
import type { RawLog } from '../../../api/_arcLogs'
import { USDC, topicAddress, word } from '../../../api/_arcSwaps'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import { abiString, cleanText, type LaunchpadAdapter } from './adapter'

export const ARC_LAUNCHPAD = '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67'
export const TOKEN_LAUNCHED = keccak256(toHex('TokenLaunched(address,address,string,string,string,uint256)'))
export const CURVE_TRADE = keccak256(toHex('Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)'))
const INITIAL_VIRTUAL_USDC = 8_000_000_000n // $8,000 (6 decimals)
const VIRTUAL_TOKEN_OFFSET = 200_000_000n * 10n ** 18n

/** Curve price in USD per whole token after a trade. */
export function curvePrice(rUsdc: bigint, rToken: bigint): number {
  return Number(INITIAL_VIRTUAL_USDC + rUsdc) / 1e6 / (Number(rToken + VIRTUAL_TOKEN_OFFSET) / 1e18)
}

export class ArcLaunchpadAdapter implements LaunchpadAdapter {
  readonly name = 'ARCDEX'

  filters() { return [{ address: ARC_LAUNCHPAD, topics: [[TOKEN_LAUNCHED, CURVE_TRADE]] }] }

  matches(l: RawLog) { return l.address.toLowerCase() === ARC_LAUNCHPAD && (l.topics[0] === TOKEN_LAUNCHED || l.topics[0] === CURVE_TRADE) }

  async parseLaunch(l: RawLog): Promise<LaunchInfo | null> {
    if (l.topics[0] !== TOKEN_LAUNCHED || l.topics.length < 3) return null
    const token = topicAddress(l.topics[1])
    if (!isAddress(token)) return null
    return {
      token,
      name: cleanText(abiString(l.data, 0) ?? '') || 'Unknown',
      symbol: cleanText(abiString(l.data, 1) ?? '', 24) || '???',
      decimals: 18,
      creator: topicAddress(l.topics[2]),
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool: ARC_LAUNCHPAD,
      quote: USDC,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      image: null,
    }
  }

  async parseTrade(l: RawLog): Promise<Trade | null> {
    if (l.topics[0] !== CURVE_TRADE || l.topics.length < 3 || l.data.length < 2 + 64 * 6) return null
    const token = topicAddress(l.topics[1])
    const trader = topicAddress(l.topics[2])
    const isBuy = BigInt('0x' + word(l.data, 0)) !== 0n
    const usdc = Number(BigInt('0x' + word(l.data, 1))) / 1e6
    const tokens = Number(BigInt('0x' + word(l.data, 2))) / 1e18
    const rUsdc = BigInt('0x' + word(l.data, 4))
    const rToken = BigInt('0x' + word(l.data, 5))
    const price = curvePrice(rUsdc, rToken)
    if (!(tokens > 0) || !Number.isFinite(price) || price <= 0) return null
    const logIndex = parseInt(l.logIndex, 16)
    const txHash = l.transactionHash.toLowerCase()
    return {
      tradeId: `${txHash}:${logIndex}`,
      chain: 'ARC',
      token,
      pair: `${token}/${USDC}`,
      pool: ARC_LAUNCHPAD,
      quote: USDC,
      side: isBuy ? 'BUY' : 'SELL',
      baseAmount: tokens,
      quoteAmount: usdc,
      tokenAmount: tokens,
      price,
      priceUsd: price,
      usdValue: usdc,
      wallet: isAddress(trader) ? trader : null,
      txHash,
      blockNumber: parseInt(l.blockNumber, 16),
      logIndex,
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      dex: 'arc-launchpad',
      launchpad: this.name,
      liquidity: Number(rUsdc) / 1e6,
    }
  }
}
