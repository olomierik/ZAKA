// Offline test of the dedicated Arc endpoint and its fallback (lib/rpc.ts,
// api/arcRpc.ts): used first when set, set aside when it throttles, refuses
// or drops, and a revert is still an answer. fetch and WebSocket are stubbed.
// Run: bun scripts/test-fast-rpc.ts

// Bun's import.meta.env is process.env: set before the modules load.
process.env.VITE_ARC_RPC_URL = 'https://fast.test/token/'
process.env.VITE_ARC_WSS_URL = 'wss://fast.test/token/'

const PUBLIC = 'https://rpc.mainnet.arc.io'
type Answer = { status?: number; body: unknown }
let answers: Record<string, (method: string) => Answer> = {}
let hits: string[] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const host = url.startsWith('https://fast.test') ? 'fast' : url.startsWith(PUBLIC) ? 'public' : 'blockdaemon'
  const req = JSON.parse(String(init?.body)) as { id: number; method: string }
  hits.push(`${host}:${req.method}`)
  const a = (answers[host] ?? (() => ({ body: { result: '0x10' } })))(req.method)
  const body = a.status && a.status >= 400 ? String(a.body) : JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(a.body as object) })
  return new Response(body, { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const rpc = await import('../src/arcdex/lib/rpc')
/** A second, independent copy of a module (its own bench state). */
const fresh = <T>(path: string): Promise<T> => import(path) as Promise<T>
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const chain = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [PUBLIC] } } }
const transport = rpc.arcReadTransport()({ chain: chain as never, retryCount: 0 })
const ask = (method = 'eth_blockNumber') => transport.request({ method, params: [] } as never)

console.log('reads')
ok(rpc.FAST_RPC === 'https://fast.test/token/' && rpc.FAST_WS === 'wss://fast.test/token/', 'the endpoint comes from VITE_ARC_RPC_URL / VITE_ARC_WSS_URL')
hits = []
ok(await ask() === '0x10' && hits.join() === 'fast:eth_blockNumber', 'a read goes to the dedicated endpoint first')

answers = { fast: () => ({ status: 429, body: 'Too Many Requests' }) }
hits = []
ok(await ask() === '0x10' && hits.join() === 'fast:eth_blockNumber,public:eth_blockNumber', 'throttled (429): the same read is answered by the public RPC, no retries on the busy one')
hits = []
await ask()
ok(hits.join() === 'public:eth_blockNumber', '… and the next reads skip it while it cools off')
ok(!rpc.fastUp(), '… (benched)')

console.log('why it steps aside')
ok(rpc.benchFor({ name: 'HttpRequestError', status: 429 }) === 60_000, '429: a minute')
ok(rpc.benchFor({ name: 'HttpRequestError', status: 403 }) === 600_000 && rpc.benchFor({ status: 401 }) === 600_000 && rpc.benchFor({ status: 402 }) === 600_000, 'refused or out of credits (401/402/403): ten minutes')
ok(rpc.benchFor({ name: 'HttpRequestError', status: 503 }) === 30_000 && rpc.benchFor({ name: 'TimeoutError' }) === 30_000 && rpc.benchFor({ name: 'HttpRequestError' }) === 30_000, 'down, timing out or unreachable: 30s')
ok(rpc.benchFor({ name: 'RpcRequestError', code: -32005, message: 'limit exceeded' }) === 60_000, 'a JSON-RPC "limit exceeded" (-32005): a minute')
ok(rpc.benchFor({ name: 'RpcError', code: 429, message: 'rate limited' }) === 60_000, "the log helper's rate-limit error (code 429): a minute")
ok(rpc.benchFor({ name: 'RpcRequestError', code: 3, message: 'execution reverted: slippage limit' }) === 0, 'a revert is an answer, even one that mentions a limit: not benched')

console.log('reverts')
{
  // The first copy is benched now; a second copy starts clean.
  const rpc2 = await fresh<typeof rpc>('../src/arcdex/lib/rpc.ts?fresh')
  const t2 = rpc2.arcReadTransport()({ chain: chain as never, retryCount: 0 })
  answers = { fast: () => ({ body: { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } } }) }
  hits = []
  let threw = false
  try { await t2.request({ method: 'eth_call', params: [{}, 'latest'] } as never) } catch (e) { threw = /revert/i.test((e as Error).message) }
  ok(threw && hits.join() === 'fast:eth_call', 'a revert from the dedicated endpoint is returned as is, not asked again elsewhere')
  ok(rpc2.fastUp(), '… and does not bench it')
  answers = { fast: () => ({ status: 403, body: 'Forbidden: referrer not allowed' }) }
  hits = []
  ok(await t2.request({ method: 'eth_blockNumber', params: [] } as never) === '0x10' && hits.join() === 'fast:eth_blockNumber,public:eth_blockNumber', 'a page it refuses (403, e.g. a preview URL) still gets its answer from the public RPC')
  ok(!rpc2.fastUp(), '… and stops asking it')
}

console.log('sockets')
type Listener = (ev: { data?: unknown }) => void
const sockets: FakeSocket[] = []
class FakeSocket {
  url: string
  listeners: Record<string, Listener[]> = {}
  onclose: Listener | null = null
  closed = false
  constructor(url: string) { this.url = url; sockets.push(this) }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn) }
  emit(type: string, ev: { data?: unknown } = {}) { for (const fn of this.listeners[type] ?? []) fn(ev) }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.onclose?.({}) }
  send() {}
}
;(globalThis as Record<string, unknown>).WebSocket = FakeSocket
const ws = await import('../src/arcdex/api/arcRpc')
const s1 = ws.openArcSocket() as unknown as FakeSocket
ok(s1.url === 'wss://fast.test/token/', 'feeds open the dedicated socket first')
s1.emit('open'); s1.emit('message', { data: '{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x1","result":{}}}' })
ok(!s1.closed, 'events keep flowing on it')
s1.emit('message', { data: '{"jsonrpc":"2.0","id":1,"error":{"code":-32007,"message":"credits exhausted"}}' })
ok(s1.closed, 'an error answer to its subscription closes it (the feed reconnects)')
const s2 = ws.openArcSocket() as unknown as FakeSocket
ok(s2.url === 'wss://rpc.mainnet.arc.io', '… onto the public socket')

// A fresh copy of the module (bench cleared), for a refused connection.
const wsB = await fresh<typeof ws>('../src/arcdex/api/arcRpc.ts?fresh')
const s3 = wsB.openArcSocket() as unknown as FakeSocket
s3.close() // refused before it ever opened (limit, credits, referrer)
ok((wsB.openArcSocket() as unknown as FakeSocket).url === 'wss://rpc.mainnet.arc.io', 'a refused connection: the next one is public')
const wsC = await fresh<typeof ws>('../src/arcdex/api/arcRpc.ts?fresh2')
const s4 = wsC.openArcSocket() as unknown as FakeSocket
s4.emit('open'); s4.close() // dropped after working
ok((wsC.openArcSocket() as unknown as FakeSocket).url === 'wss://fast.test/token/', 'a socket that worked and dropped reconnects to the dedicated one')

console.log('ALL FAST RPC CHECKS PASSED')
