// Launches on any launchpad that opens its coin's Uniswap v4 pool in the
// launch transaction, found from the pool's Initialize alone: the coin had
// no code the block before, so this transaction created it. The launchpad
// is named from the contract the transaction was sent to; one nobody has
// listed yet still counts, as "Other", with that contract in `entry`.
//
// Measured on Arc mainnet 2026-09-30 (engine/scripts/discover-launchpads.ts,
// three launches each): Aka.fun, o1, Minara and Long.supply create the coin
// and initialize its pool in one transaction, sent to the contracts below.
// Argus, ARCDEX's launchpad, Mercuri and SolonPad have their own adapters,
// which report more (name from the event, image, portal); their launches
// are left to them, and an adapter's report replaces a generic one
// (MarketEngine.onLaunch).

import type { RawLog } from '../../../api/_arcLogs'
import { MERCURI_FACTORY, SOLONPAD_FACTORY } from '../../../api/_curves'
import type { LaunchInfo } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { PoolInfo } from '../dex/pools'
import { metrics } from '../metrics'
import { cleanText, tokenMeta } from './adapter'
import { ARC_LAUNCHPAD } from './arcLaunchpad'
import { PORTAL7, PORTAL8 } from './argus'

/** Launch transactions' destination → launchpad (names as in api/_launchpads.ts). */
export const LAUNCH_ENTRY: Record<string, string> = {
  '0x7898dd4bd730677ea0cbe6eeceb2545d6a262b7b': 'Aka.fun',
  '0xee3e862efde6dcd6df5648af0e2731b9d1df4605': 'o1',
  '0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6': 'Minara',
  '0x0e78df41c5cdbd913532d92bb4d7d037605424e1': 'Long.supply',
}

/** Launchpads whose own adapter reports their launches. */
export const ADAPTER_ENTRY = new Set([PORTAL7, PORTAL8, ARC_LAUNCHPAD, MERCURI_FACTORY, SOLONPAD_FACTORY])

const hex = (n: number) => '0x' + n.toString(16)

export class V4LaunchDetector {
  constructor(private rpc: Rpc, private known: (token: string) => boolean) {}

  /** A v4 Initialize (already registered as `pool`) → a launch, or null. */
  async detect(l: RawLog, pool: PoolInfo): Promise<LaunchInfo | null> {
    if (pool.dex !== 'uniswap-v4' || this.known(pool.base)) return null
    const block = parseInt(l.blockNumber, 16)
    // Created in this block? (An error means we can't tell: not a launch.)
    const before = await this.rpc.call<string>('eth_getCode', [pool.base, hex(block - 1)]).catch(() => null)
    if (before !== '0x') return null
    const tx = await this.rpc.call<{ from?: string; to?: string | null } | null>('eth_getTransactionByHash', [l.transactionHash]).catch(() => null)
    const to = tx?.to?.toLowerCase() ?? null
    if (!tx || !to || ADAPTER_ENTRY.has(to)) return null
    const meta = await tokenMeta(this.rpc, pool.base)
    const launchpad = LAUNCH_ENTRY[to] ?? 'Other'
    metrics.inc(`launches_v4_${launchpad === 'Other' ? 'other' : 'known'}`)
    return {
      token: pool.base,
      name: cleanText(meta.name ?? '') || 'Unknown',
      symbol: cleanText(meta.symbol ?? '', 24) || '???',
      decimals: meta.decimals ?? pool.baseDecimals,
      creator: tx.from?.toLowerCase() ?? null,
      txHash: l.transactionHash.toLowerCase(),
      blockNumber: block,
      timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(),
      pool: pool.pool,
      quote: pool.quote,
      launchpad,
      chain: 'ARC',
      status: 'LIVE',
      entry: to,
      generic: true,
    }
  }
}
