// Robinhood Chain's launches, read from the chain (2026-10-17). Before, new coins there reached the Trenches only from the
// list (GeckoTerminal, read about every 6 minutes), so the New lane showed coins 5-16 minutes old while GMGN showed them
// at 46 seconds (docs/COMPETITORS-2026-10-17.md). Traced on mainnet the same day:
//
//   Pons      its launcher 0x7ed5…ec7e emits one event per launch: the coin, its bonding curve and its creator (topics),
//             and the ETH at which the curve graduates (data word 2; 4.2 ETH). About 25 launches an hour. Each curve then
//             logs every buy (ETH in, coins out) and sale (coins in, ETH out), its trader in topic 2.
//   Clanker   a Uniswap v4 pool initialized with Clanker's hook 0x48b8…e8cc (17 of 17 seen were minted in the same
//             transaction).
//   Bankr     a v4 pool with Bankr's hook 0x4e34…a544 (488 seen in 16 hours; Bankr launches through smart accounts, so
//             the transaction goes to the ERC-4337 entry point and the coin may be minted a transaction earlier).
// Other launchpads keep arriving from the list as before. Only these are read, so the lanes keep the owner's rule:
// launchpad coins only.

import { decodeAbiParameters, type Hex } from 'viem'
import { V4_INITIALIZE, word } from '../../../api/_arcSwaps'
import { NATIVE, USDG, WETH } from '../../../api/_rhCore'
import type { RawLog } from './bsc'

export const PONS_LAUNCHER = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
export const PONS_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
export const PONS_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'
export const PONS_SELL = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'

/** v4 hooks that only one launchpad's pools use. */
export const HOOD_HOOKS: Record<string, string> = {
  '0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc': 'Clanker',
  '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544': 'Bankr',
}

const addr = (w: string | undefined) => `0x${(w ?? '').slice(-40)}`.toLowerCase()
const big = (data: string, i: number) => { try { return BigInt(`0x${word(data, i) || '0'}`) } catch { return 0n } }
const e18 = (v: bigint) => Number(v) / 1e18

export interface PonsLaunch { token: string; curve: string; creator: string; thresholdEth: number }
export function decodePonsLaunch(l: RawLog): PonsLaunch | null {
  if (l.removed || l.address.toLowerCase() !== PONS_LAUNCHER || l.topics[0]?.toLowerCase() !== PONS_LAUNCH || l.topics.length < 4) return null
  const thresholdEth = l.data && l.data.length >= 2 + 64 * 3 ? e18(big(l.data, 2)) : 0
  return { token: addr(l.topics[1]), curve: addr(l.topics[2]), creator: addr(l.topics[3]), thresholdEth: thresholdEth > 0 ? thresholdEth : 4.2 }
}

/** A Pons curve's buy or sale: coins and ETH (both 18 decimals), the trader. */
export function decodePonsTrade(l: RawLog): { buy: boolean; trader: string; eth: number; tokens: number; price: number } | null {
  const t = l.topics[0]?.toLowerCase()
  if (l.removed || (t !== PONS_BUY && t !== PONS_SELL) || l.topics.length < 3 || !l.data || l.data.length < 2 + 64 * 2) return null
  const buy = t === PONS_BUY
  const eth = e18(big(l.data, buy ? 0 : 1)), tokens = e18(big(l.data, buy ? 1 : 0))
  return eth > 0 && tokens > 0 ? { buy, trader: addr(l.topics[2]), eth, tokens, price: eth / tokens } : null
}

export interface HoodInit { poolId: string; coin: string; quote: string; hooks: string; launchpad: string; coinIs0: boolean; sqrtPriceX96: bigint }
/** A v4 pool a known launchpad opened for a new coin against ETH, WETH or USDG; null for anything else. */
export function decodeHoodInit(l: RawLog): HoodInit | null {
  if (l.removed || l.topics[0]?.toLowerCase() !== V4_INITIALIZE || l.topics.length < 4 || !l.data || l.data.length < 2 + 64 * 4) return null
  const hooks = addr(word(l.data, 2))
  const launchpad = HOOD_HOOKS[hooks]
  if (!launchpad) return null
  const c0 = addr(l.topics[2]), c1 = addr(l.topics[3])
  const quotes = new Set([NATIVE, WETH, USDG])
  const coinIs0 = !quotes.has(c0) && quotes.has(c1)
  if (!coinIs0 && !(quotes.has(c0) && !quotes.has(c1))) return null
  return { poolId: l.topics[1].toLowerCase(), coin: coinIs0 ? c0 : c1, quote: coinIs0 ? c1 : c0, hooks, launchpad, coinIs0, sqrtPriceX96: big(l.data, 3) }
}

/** The coin's opening price in its quote, from the pool's starting price (both 18 decimals, USDG 6). */
export function initPrice(i: HoodInit, coinDecimals = 18): number {
  const quoteDecimals = i.quote === USDG ? 6 : 18
  const p = (Number(i.sqrtPriceX96) / 2 ** 96) ** 2 // token1 per token0, raw units
  if (!(p > 0)) return 0
  const raw = i.coinIs0 ? p : 1 / p // quote per coin, raw
  return raw * 10 ** (coinDecimals - quoteDecimals)
}

export const ERC20_SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd' } as const
export function decodeString(hex: string | null | undefined): string {
  if (!hex || hex === '0x') return ''
  try { return String(decodeAbiParameters([{ type: 'string' }], hex as Hex)[0]) } catch {
    // Some old tokens answer bytes32.
    try { return Buffer.from(hex.slice(2, 66), 'hex').toString('utf8').replace(/\0+$/, '') } catch { return '' }
  }
}
export const decodeUint = (hex: string | null | undefined) => { try { return hex && hex !== '0x' ? BigInt(hex) : 0n } catch { return 0n } }
/** Names and symbols as the lanes show them: printable, short. */
export const cleanName = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max)
