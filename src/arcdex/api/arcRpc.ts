// ── Arc RPC WebSocket — real-time Swap event streaming ───────────────
// Arc is EVM-compatible. We subscribe to `eth_subscribe` logs for the
// Uniswap V3 Swap event signature. This is the same method DexScreener
// and launchpads use to get sub-second trade data directly from the chain.
//
// Swap(address indexed sender, address indexed recipient,
//      int256 amount0, int256 amount1,
//      uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
// topic0: 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67

export const ARC_RPC_WS  = 'wss://rpc.mainnet.arc.io'
export const SWAP_TOPIC  = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
export const ARC_EXPLORER = 'https://explorer.arc.io'

export interface LiveTrade {
  txHash:        string
  pairAddress:   string
  kind:          'buy' | 'sell'
  amount0:       bigint   // raw int256
  amount1:       bigint
  volumeUsd:     number   // estimated from amount * price (filled in by UI)
  blockNumber:   number
  timestamp:     number   // Date.now() at receipt
  walletAddress: string   // tx sender (from eth_getTransactionByHash)
}

type LogEvent = {
  address: string
  topics:  string[]
  data:    string
  transactionHash: string
  blockNumber: string
}

type TradeCallback = (trade: LiveTrade) => void

let ws:           WebSocket | null = null
let subId:        string | null    = null
let callbacks:    Map<string, Set<TradeCallback>> = new Map() // pairAddress → Set<cb>
let globalCbs:    Set<TradeCallback>              = new Set()
let pendingId:    number = 1
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// ── connect / reconnect ───────────────────────────────────────────────
function connect() {
  if (ws && ws.readyState < 2) return  // CONNECTING or OPEN

  ws = new WebSocket(ARC_RPC_WS)

  ws.onopen = () => {
    console.log('[ArcRPC] connected')
    subscribe()
  }

  ws.onmessage = async (evt: MessageEvent) => {
    const msg: { id?: number; method?: string; params?: { subscription: string; result: LogEvent }; result?: string } =
      JSON.parse(evt.data as string)

    // subscription confirmation
    if (msg.id === 1 && msg.result) {
      subId = msg.result
      return
    }

    // incoming log
    if (msg.method === 'eth_subscription' && msg.params?.result) {
      const log = msg.params.result
      if (log.topics[0]?.toLowerCase() !== SWAP_TOPIC) return

      const pairAddress = log.address.toLowerCase()

      // decode Swap data
      // amount0 and amount1 are the first two int256 in data (32 bytes each)
      const data = log.data.slice(2)   // strip 0x
      const amount0 = BigInt.asIntN(256, BigInt('0x' + data.slice(0, 64)))
      const amount1 = BigInt.asIntN(256, BigInt('0x' + data.slice(64, 128)))

      // `kind`/`volumeUsd` can't be determined from the raw log alone:
      // token0 vs token1 is assigned by address sort order, not by which
      // side is the quote (USDC) token, and that varies per pool. Callers
      // that know the pair's quoteToken/baseToken addresses should use
      // `deriveTradeInfo` below instead of trusting these placeholders.
      const kind: 'buy' | 'sell' = 'buy'

      const trade: LiveTrade = {
        txHash:       log.transactionHash,
        pairAddress,
        kind,
        amount0,
        amount1,
        volumeUsd:    0,  // UI fills this in from current price
        blockNumber:  parseInt(log.blockNumber, 16),
        timestamp:    Date.now(),
        walletAddress: log.topics[1] ? '0x' + log.topics[1].slice(26) : '',
      }

      // dispatch to pair-specific + global listeners
      const pairCbs = callbacks.get(pairAddress)
      if (pairCbs) pairCbs.forEach(cb => cb(trade))
      globalCbs.forEach(cb => cb(trade))
    }
  }

  ws.onerror = () => {
    console.warn('[ArcRPC] ws error — will reconnect')
    ws?.close()
  }

  ws.onclose = () => {
    subId = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 2000)
  }
}

function subscribe() {
  if (!ws || ws.readyState !== 1) return
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_subscribe',
    params: ['logs', { topics: [SWAP_TOPIC] }],
  }))
}

// ── public API ────────────────────────────────────────────────────────

/** Start the WebSocket (idempotent). */
export function startRpc() {
  connect()
}

/** Subscribe to ALL swap events on Arc (shown as card popups on the terminal). */
export function subscribeAll(cb: TradeCallback): () => void {
  startRpc()
  globalCbs.add(cb)
  return () => { globalCbs.delete(cb) }
}

/** Subscribe to swap events for a specific pair address (token page). */
export function subscribePair(pairAddress: string, cb: TradeCallback): () => void {
  startRpc()
  const addr = pairAddress.toLowerCase()
  if (!callbacks.has(addr)) callbacks.set(addr, new Set())
  callbacks.get(addr)!.add(cb)
  return () => {
    callbacks.get(addr)?.delete(cb)
    if (callbacks.get(addr)?.size === 0) callbacks.delete(addr)
  }
}

/** Estimate USD volume straight from the quote-token leg (USDC, 6dp). */
export function estimateUsd(quoteAmount: bigint): number {
  const abs = quoteAmount < 0n ? -quoteAmount : quoteAmount
  return Number(abs) / 1e6
}

/** Correctly resolves kind ('buy'/'sell') and USD volume for a raw trade,
 * given whether the pool's quote (USDC) token is token0 or token1 — that
 * ordering is by contract address, not semantics, so it varies per pool
 * and must come from known pair metadata (DexScreener/GeckoTerminal),
 * not guessed. */
export function deriveTradeInfo(trade: LiveTrade, quoteIsToken0: boolean): { kind: 'buy' | 'sell'; usd: number } {
  const quoteAmount = quoteIsToken0 ? trade.amount0 : trade.amount1
  // quoteAmount > 0 → USDC flowing IN to the pool → trader paid USDC → buy.
  const kind: 'buy' | 'sell' = quoteAmount > 0n ? 'buy' : 'sell'
  return { kind, usd: estimateUsd(quoteAmount) }
}

// generate unique ids for pending requests
export function nextId() { return ++pendingId }
