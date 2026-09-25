// Argus launch detection (argus.world), straight from its Portal contracts.
//
// ── Blockchain specifics (measured on Arc mainnet, 2026-09-25) ───────────
// Argus has 8 Portal contracts; only two still launch tokens:
//   Portal 7  0xB021…97Da  ~3,000 launches/day. One launch tx emits five
//             Portal events; the one used here is
//               0x1d891723… (address indexed token, address indexed creator,
//                            string name, string symbol, bytes32 poolId,
//                            string ×4 metadata)
//             so name, symbol and pool come straight from the event.
//   Portal 8  0xeed7…5D93  ~125 launches/day.
//               Launched(address indexed token, address indexed creator,
//                        address hook, address escrow, address locker,
//                        uint256 positionId, int24 tickStart, int24 tickBond)
//               LaunchMetadata(address indexed token, string imageURI, …)
//             Name/symbol are read from the token itself.
// Portals 1–6 emitted nothing in the last ~1M blocks; their tokens still
// trade and are picked up as ordinary v4/v3 swaps.
// Every launch tx also initializes the token's Uniswap v4 pool; the
// PoolManager Initialize log in the receipt gives the PoolId and both
// currencies, which registers the pool before its first trade.

import type { RawLog } from '../../../api/_arcLogs'
import { POOL_MANAGER, V4_INITIALIZE, topicAddress, word } from '../../../api/_arcSwaps'
import type { LaunchInfo } from '../../../api/_marketProtocol'
import { isAddress } from '../../../api/_marketProtocol'
import { metrics } from '../metrics'
import { abiString, cleanImage, cleanText, tokenMeta, type AdapterContext, type LaunchpadAdapter } from './adapter'

export const PORTAL7 = '0xb021be536808f551b31789422fd28a6c9c6e97da'
export const PORTAL8 = '0xeed7559b8a6abf64427dc41cb5cc6400109c5d93'
export const P7_LAUNCH = '0x1d8917231579f8ce39407f0d616f36f357b07329b0ce5164d0754ac15145ce0a'
export const P8_LAUNCHED = '0xc32e25061af0b7f7d77b7fb015333ecb0004127b71abbda4d7ba4c18bcd497f3'
export const P8_METADATA = '0x81757bd4a3f7375c9021d3bd561d1a8075d765544734931f26896acacda7ccdc'

interface Receipt { logs: RawLog[]; from?: string }

export class ArgusAdapter implements LaunchpadAdapter {
  readonly name = 'ARGUS'

  filters() {
    return [{ address: [PORTAL7, PORTAL8], topics: [[P7_LAUNCH, P8_LAUNCHED]] }]
  }

  matches(l: RawLog) {
    const a = l.address.toLowerCase()
    return (a === PORTAL7 && l.topics[0] === P7_LAUNCH) || (a === PORTAL8 && l.topics[0] === P8_LAUNCHED)
  }

  async parseLaunch(l: RawLog, ctx: AdapterContext): Promise<LaunchInfo | null> {
    if (!this.matches(l) || l.topics.length < 3) return null
    const portal = l.address.toLowerCase() === PORTAL7 ? 7 : 8
    const token = topicAddress(l.topics[1])
    const creator = topicAddress(l.topics[2])
    if (!isAddress(token)) return null

    // The launch tx's receipt: the pool's Initialize (and, on Portal 8, the
    // metadata). Fetched in parallel with the token's own name/symbol.
    const [receipt, meta] = await Promise.all([
      ctx.rpc.call<Receipt>('eth_getTransactionReceipt', [l.transactionHash]).catch(() => null),
      portal === 8 ? tokenMeta(ctx.rpc, token) : Promise.resolve(null),
    ])

    let name: string | null = null, symbol: string | null = null, poolFromEvent: string | null = null
    if (portal === 7) {
      name = abiString(l.data, 0)
      symbol = abiString(l.data, 1)
      const w = word(l.data, 2)
      if (/^[0-9a-f]{64}$/i.test(w)) poolFromEvent = '0x' + w.toLowerCase()
    } else {
      name = meta?.name ?? null
      symbol = meta?.symbol ?? null
    }

    // Register the pool from its Initialize log (the one that pairs this token).
    let pool: string | null = null, quote: string | null = null
    for (const rl of receipt?.logs ?? []) {
      if (rl.address.toLowerCase() !== POOL_MANAGER || rl.topics[0] !== V4_INITIALIZE) continue
      if (topicAddress(rl.topics[2]) !== token && topicAddress(rl.topics[3]) !== token) continue
      const info = await ctx.pools.fromInitialize({ ...rl, blockTimestamp: rl.blockTimestamp ?? l.blockTimestamp })
      pool = rl.topics[1].toLowerCase()
      quote = info?.quote ?? null
      break
    }
    if (!pool && poolFromEvent) pool = poolFromEvent

    let image: string | null = null
    if (portal === 8) {
      const m = receipt?.logs.find(rl => rl.address.toLowerCase() === PORTAL8 && rl.topics[0] === P8_METADATA && topicAddress(rl.topics[1] ?? '') === token)
      if (m) image = cleanImage(abiString(m.data, 0))
    }

    const decimals = meta?.decimals ?? (await ctx.pools.tokenDecimals(token)) ?? 18
    if (!name && !symbol) {
      // Fall back to the token itself before giving up on the labels.
      const m2 = portal === 7 ? await tokenMeta(ctx.rpc, token) : null
      name = m2?.name ?? null
      symbol = m2?.symbol ?? null
    }
    metrics.inc(`launches_argus_p${portal}`)
    return {
      token,
      name: cleanText(name ?? '') || 'Unknown',
      symbol: cleanText(symbol ?? '', 24) || '???',
      decimals,
      creator: isAddress(creator) && creator !== '0x0000000000000000000000000000000000000000' ? creator : null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: parseInt(l.blockNumber, 16),
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool,
      quote,
      launchpad: this.name,
      chain: 'ARC',
      status: 'LIVE',
      portal,
      image,
    }
  }
}
