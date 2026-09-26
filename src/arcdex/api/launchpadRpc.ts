// ── ArcLaunchpad live trade feed — real-time buy/sell, DexScreener-style ──
// ArcLaunchpad emits its own `Trade` event (not the Uniswap-style Swap
// event arcRpc.ts listens for), so it needs its own WS subscription.
// Unlike external-pool trades, every field here is already unambiguous —
// `isBuy`, `usdcAmount`, `tokenAmount` are named, not inferred from
// token0/token1 ordering — so no separate "which side is quote" step.

import { ARC_RPC_WS } from './arcRpc'
import { spotPrice } from '../../../api/_launchpadCore'

// keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)")
// Computed via viem's toEventSelector and cross-checked against a second,
// independent keccak256(utf8Bytes) path — not hand-derived.
const TRADE_TOPIC = '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3'

export interface LaunchpadLiveTrade {
  token:        string
  trader:       string
  isBuy:        boolean
  usdcAmount:   number   // whole USDC (6dp already applied)
  tokenAmount:  number   // whole tokens (18dp already applied)
  txHash:       string
  blockNumber:  number
  timestamp:    number
  /** Curve price after this trade (USD per token), from its reserves. */
  priceAfter:   number
  /** USDC on the curve after this trade (whole USDC): its progress to graduation. */
  rUsdcAfter:   number
}

type LogEvent = {
  address: string
  topics:  string[]
  data:    string
  transactionHash: string
  blockNumber: string
}

type Callback = (trade: LaunchpadLiveTrade) => void

let ws: WebSocket | null = null
let launchpadAddress: string | null = null
let callbacks: Set<Callback> = new Set()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function connect() {
  if (!launchpadAddress) return
  if (ws && ws.readyState < 2) return // CONNECTING or OPEN

  ws = new WebSocket(ARC_RPC_WS)

  ws.onopen = () => {
    ws?.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
      params: ['logs', { address: launchpadAddress, topics: [TRADE_TOPIC] }],
    }))
  }

  ws.onmessage = (evt: MessageEvent) => {
    const msg: { method?: string; params?: { result: LogEvent } } = JSON.parse(evt.data as string)
    if (msg.method !== 'eth_subscription' || !msg.params?.result) return
    const log = msg.params.result
    if (log.topics[0]?.toLowerCase() !== TRADE_TOPIC) return

    const token  = '0x' + log.topics[1].slice(26)
    const trader = '0x' + log.topics[2].slice(26)

    // data = [isBuy(bool,32b)] [usdcAmount(32b)] [tokenAmount(32b)] [totalFee] [rUsdcAfter] [rTokenAfter]
    const data = log.data.slice(2)
    const word = (i: number) => BigInt('0x' + data.slice(i * 64, i * 64 + 64))
    const isBuy = word(0) === 1n
    const usdcAmount = Number(word(1)) / 1e6
    const tokenAmount = Number(word(2)) / 1e18
    const priceAfter = spotPrice(word(4), word(5))

    const trade: LaunchpadLiveTrade = {
      token, trader, isBuy, usdcAmount, tokenAmount, priceAfter, rUsdcAfter: Number(word(4)) / 1e6,
      txHash: log.transactionHash,
      blockNumber: parseInt(log.blockNumber, 16),
      timestamp: Date.now(),
    }
    callbacks.forEach(cb => cb(trade))
  }

  ws.onerror = () => { ws?.close() }
  ws.onclose = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 2000)
  }
}

/** Subscribe to every buy/sell across all ArcLaunchpad tokens in real time. */
export function subscribeLaunchpadTrades(address: string, cb: Callback): () => void {
  launchpadAddress = address.toLowerCase()
  connect()
  callbacks.add(cb)
  return () => { callbacks.delete(cb) }
}
