// ── Live swaps for one Argus pool, pushed over Arc's WebSocket RPC ─────
// GeckoTerminal is the source of truth for trade history (it has makers and
// USD values), but it lags by seconds. This pushes each swap the moment its
// block lands, so the token page moves in real time; GeckoTerminal's rows
// replace these by tx hash on its next refresh.
//
// v4: every pool's swaps come from the one PoolManager, with the PoolId as
//     topic1 — one filtered subscription per pool.
// v3: the pool contract itself emits Swap.
// The two use opposite sign conventions (v4 swapper-oriented, v3
// pool-oriented), so the buy/sell decode branches on pool kind.

import { ARC_RPC_WS } from './arcRpc'

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

export interface LiveSwap {
  txHash: string
  kind: 'buy' | 'sell'
  tokenAmount: number // whole tokens
  quoteAmount: number // whole quote units (USDC or ARGUS)
  blockNumber: number
  receivedAt: number
}

function signedWord(hex: string): bigint {
  return BigInt.asIntN(256, BigInt('0x' + hex))
}

/** @param tokenIsCurrency0 whether the launch token sorts first in the pair */
export function subscribePoolSwaps(
  pool: string,
  tokenIsCurrency0: boolean,
  quoteDecimals: number,
  onSwap: (s: LiveSwap) => void,
): () => void {
  const isV4 = pool.length === 66
  const filter = isV4
    ? { address: POOL_MANAGER, topics: [V4_SWAP, pool.toLowerCase()] }
    : { address: pool.toLowerCase(), topics: [V3_SWAP] }

  let ws: WebSocket | null = null
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    ws = new WebSocket(ARC_RPC_WS)
    ws.onopen = () => ws?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', filter] }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as { method?: string; params?: { result?: { data: string; transactionHash: string; blockNumber: string } } }
      const log = msg.method === 'eth_subscription' ? msg.params?.result : undefined
      if (!log) return
      const data = log.data.slice(2)
      const a0 = signedWord(data.slice(0, 64))
      const a1 = signedWord(data.slice(64, 128))
      const tokenLeg = tokenIsCurrency0 ? a0 : a1
      const quoteLeg = tokenIsCurrency0 ? a1 : a0
      // v4: positive token leg = the swapper received tokens = buy.
      // v3: positive token leg = the pool received tokens = sell.
      const buy = isV4 ? tokenLeg > 0n : tokenLeg < 0n
      const abs = (x: bigint) => (x < 0n ? -x : x)
      onSwap({
        txHash: log.transactionHash,
        kind: buy ? 'buy' : 'sell',
        tokenAmount: Number(abs(tokenLeg)) / 1e18,
        quoteAmount: Number(abs(quoteLeg)) / 10 ** quoteDecimals,
        blockNumber: parseInt(log.blockNumber, 16),
        receivedAt: Date.now(),
      })
    }
    ws.onclose = () => { if (!closed) retry = setTimeout(connect, 2000) }
    ws.onerror = () => ws?.close()
  }

  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    ws?.close()
  }
}
