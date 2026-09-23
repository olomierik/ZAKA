// Arc mainnet WebSocket RPC — live swap event subscription
// Subscribes to Uniswap V3 Swap events and calls back on each new log

export interface RawSwapLog {
  address:          string
  transactionHash:  string
  blockNumber:      string
  data:             string
  topics:           string[]
}

// Uniswap V3 Swap topic0
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// Arc mainnet WebSocket RPC
const WS_URL = 'wss://rpc.mainnet.arc.io'

type Callback = (log: RawSwapLog) => void

let ws: WebSocket | null = null
let callbacks: Callback[] = []
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let subId: string | null = null

function connect() {
  try {
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      // Subscribe to Uniswap V3 Swap events across all pools
      ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['logs', { topics: [SWAP_TOPIC] }],
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.id === 1 && msg.result) {
          subId = msg.result
          return
        }
        if (msg.method === 'eth_subscription' && msg.params?.result) {
          const log = msg.params.result as RawSwapLog
          callbacks.forEach(cb => cb(log))
        }
      } catch { /* ignore malformed */ }
    }

    ws.onerror = () => { ws?.close() }

    ws.onclose = () => {
      ws = null
      subId = null
      if (callbacks.length > 0) {
        reconnectTimer = setTimeout(connect, 5000)
      }
    }
  } catch {
    reconnectTimer = setTimeout(connect, 8000)
  }
}

export function subscribeToSwaps(cb: Callback): () => void {
  callbacks.push(cb)
  if (!ws || ws.readyState > 1) {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    connect()
  }
  return () => {
    callbacks = callbacks.filter(c => c !== cb)
    if (callbacks.length === 0) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      ws = null
    }
  }
}
