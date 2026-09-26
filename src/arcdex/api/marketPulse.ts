// Every buy and sell on Arc as its block lands: the Terminal's live pulse.
//
// One WebSocket to Arc with up to three log subscriptions: Uniswap v4 swaps
// (every pool, through the PoolManager: that's where Argus coins trade),
// Uniswap v3 swaps in the listed v3 pools only (not every stablecoin pair's
// arbitrage) and ArcLaunchpad trades. A swap is matched to its coin by pool, and its side
// comes from the pool's token deltas, decoded the same way as on the coin
// pages and in the market engine (api/_arcSwaps.ts). Swaps in pools the
// page doesn't list are dropped.

import { NATIVE, POOL_MANAGER, USDC, V3_SWAP, V4_SWAP, decodeSwapLog, topicAddress, word } from '../../../api/_arcSwaps'
import { CURVE_TRADE } from '../../../api/_launchpadCore'
import type { RawLog } from '../../../api/_arcLogs'
import { ARC_RPC_WS } from './arcRpc'

export interface Pulse {
  token: string
  side: 'buy' | 'sell'
  /** The trade's size in USD, when its quote is USDC. */
  usd: number | null
  /** txHash:logIndex */
  id: string
}

export interface PulseLookup {
  /** The coin and quote token of a listed pool (v4 PoolId or v3 address, lowercase). */
  pool: (pool: string) => { token: string; quote: string } | undefined
  /** Whether this launchpad coin is listed. */
  curve: (token: string) => boolean
}

type Kind = 'v4' | 'v3' | 'curve'

const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'
const quoteDecimals = (q: string) => (q === USDC || q === EURC ? 6 : 18)

/** Decodes one log into a pulse, if it's a listed coin's trade. */
export function pulseOf(kind: Kind, log: RawLog, lookup: PulseLookup): Pulse | null {
  if (log.removed) return null
  const id = `${log.transactionHash.toLowerCase()}:${parseInt(log.logIndex, 16)}`
  if (kind === 'curve') {
    // Trade(token, trader, isBuy, usdcAmount, tokenAmount, fee, rUsdcAfter, rTokenAfter)
    if (!log.topics[1] || log.data.length < 2 + 64 * 2) return null
    const token = topicAddress(log.topics[1])
    if (!lookup.curve(token)) return null
    const buy = BigInt('0x' + word(log.data, 0)) !== 0n
    return { token, side: buy ? 'buy' : 'sell', usd: Number(BigInt('0x' + word(log.data, 1))) / 1e6, id }
  }
  const pool = kind === 'v4' ? (log.topics[1] ?? '').toLowerCase() : log.address.toLowerCase()
  const meta = lookup.pool(pool)
  if (!meta) return null
  const token = meta.token.toLowerCase(), quote = meta.quote.toLowerCase()
  const d = decodeSwapLog(log, { v4: kind === 'v4', baseIs0: token < quote, baseDecimals: 18, quoteDecimals: quoteDecimals(quote) })
  if (!d) return null
  return { token, side: d.side === 'BUY' ? 'buy' : 'sell', usd: quote === USDC || quote === NATIVE ? d.quoteAmount : null, id }
}

/** Streams listed coins' trades to `onPulse`. Reconnects on its own;
 * returns the unsubscribe. `launchpad`: the ArcLaunchpad address ('' = none);
 * `v3Pools`: the listed v3 pool addresses. */
export function subscribeMarketPulse(launchpad: string, lookup: PulseLookup, onPulse: (p: Pulse) => void, v3Pools: string[] = []): () => void {
  const subs: [number, Kind, object][] = [[1, 'v4', { address: POOL_MANAGER, topics: [V4_SWAP] }]]
  if (v3Pools.length) subs.push([2, 'v3', { address: v3Pools, topics: [V3_SWAP] }])
  if (/^0x[0-9a-fA-F]{40}$/.test(launchpad)) subs.push([3, 'curve', { address: launchpad, topics: [CURVE_TRADE] }])
  const kindOfRequest = new Map(subs.map(([id, kind]) => [id, kind]))

  let ws: WebSocket | null = null
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let backoff = 1_000
  const kindOfSub = new Map<string, Kind>()
  const seen = new Set<string>()

  const connect = () => {
    if (closed) return
    kindOfSub.clear()
    const sock = new WebSocket(ARC_RPC_WS)
    ws = sock
    sock.onopen = () => {
      backoff = 1_000
      for (const [id, , filter] of subs) sock.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', filter] }))
    }
    sock.onmessage = ev => {
      type Msg = { id?: number; result?: unknown; method?: string; params?: { subscription?: string; result?: RawLog } }
      let m: Msg
      try { m = JSON.parse(String(ev.data)) as Msg } catch { return }
      if (typeof m.id === 'number' && typeof m.result === 'string') {
        const kind = kindOfRequest.get(m.id)
        if (kind) kindOfSub.set(m.result, kind)
        return
      }
      const log = m.method === 'eth_subscription' ? m.params?.result : undefined
      const kind = m.params?.subscription ? kindOfSub.get(m.params.subscription) : undefined
      if (!log || !kind) return
      let p: Pulse | null = null
      try { p = pulseOf(kind, log, lookup) } catch { return }
      if (!p || seen.has(p.id)) return
      if (seen.size > 5_000) seen.clear()
      seen.add(p.id)
      onPulse(p)
    }
    sock.onclose = () => {
      if (closed || ws !== sock) return
      ws = null
      retry = setTimeout(connect, backoff)
      backoff = Math.min(15_000, backoff * 2)
    }
    sock.onerror = () => sock.close()
  }

  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    ws?.close()
    ws = null
  }
}
