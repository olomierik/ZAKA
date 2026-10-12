// Offline test of the RPC settings (src/arcdex/lib/rpcSettings.ts, 2026-10-12): which nodes can be added, the order
// reads use them in, a node that throttles or fails stepping aside for the next one (viem reads and plain JSON-RPC),
// a revert answered once and never retried elsewhere, and the speed test. fetch, localStorage and window are stubbed.
// Run: bun scripts/test-rpc-settings.ts

// Bun's import.meta.env is process.env (with the repo's .env): a stand-in for ARCDEX's dedicated Arc node.
process.env.VITE_ARC_RPC_URL = 'https://fast.test/token/'

const store = new Map<string, string>()
// A node saved before the rules (plain http) is dropped on load; a good one is kept.
store.set('arcdex:rpc:v1', JSON.stringify({ own: { bnb: ['http://bsc.example.com', 'https://bnb-mainnet.g.alchemy.com/v2/key'] }, primary: {} }))
const g = globalThis as unknown as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = new EventTarget()

type Answer = { status?: number; body?: unknown; fail?: boolean }
let answers: Record<string, (method: string) => Answer> = {}
let hits: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(String(input)).host
  const req = JSON.parse(String(init?.body)) as { id: number; method: string }
  hits.push(`${host}:${req.method}`)
  const a = (answers[host] ?? (() => ({ body: { result: '0x10' } })))(req.method)
  if (a.fail) throw new TypeError('fetch failed')
  const body = a.status && a.status >= 400 ? 'busy' : JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(a.body as object) })
  return new Response(body, { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const rs = await import('../src/arcdex/lib/rpcSettings')
const { createPublicClient } = await import('viem')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const hosts = (chain: 'arc' | 'hood' | 'sol' | 'bnb') => rs.endpoints(chain).map(e => rs.hostOf(e.url))

console.log('which nodes can be added')
ok(rs.nodeProblem('not a link') === 'Not a link', 'not a link')
ok(rs.nodeProblem('http://eth-mainnet.g.alchemy.com/v2/k') === 'The node must use HTTPS', 'plain http is refused')
ok(rs.nodeProblem('https://my-node.example.com') === 'Only nodes from known providers can be added', 'an unknown host is refused')
ok(rs.nodeProblem('https://alchemy.com.evil.io/v2/k') !== null && rs.nodeProblem('https://evilalchemy.com/rpc') !== null, 'a look-alike host is refused (suffixes match whole labels)')
ok(rs.nodeProblem('https://eth-mainnet.g.alchemy.com/v2/k') === null && rs.nodeProblem('https://mainnet.helius-rpc.com/?api-key=k') === null, 'known providers are taken (Alchemy, Helius)')

console.log('the order reads use')
ok(hosts('bnb').join() === 'bnb-mainnet.g.alchemy.com,bsc-rpc.publicnode.com,bsc-dataseed.bnbchain.org', 'a saved node is kept and goes first; one saved over plain http is dropped on load')
ok(hosts('hood').join() === 'rpc.mainnet.chain.robinhood.com,robinhood-rpc.publicnode.com' && rs.isDefaultOrder('hood'), 'the defaults otherwise (Robinhood Chain: its own RPC first)')
ok(hosts('arc').slice(0, 3).join() === 'fast.test,rpc.blockdaemon.mainnet.arc.io,rpc.mainnet.arc.io' && rs.endpoints('arc')[0].kind === 'arcdex', 'Arc: the dedicated node, Blockdaemon, then the public RPC')
rs.setPrimary('hood', 'https://robinhood-rpc.publicnode.com')
ok(hosts('hood').join() === 'robinhood-rpc.publicnode.com,rpc.mainnet.chain.robinhood.com' && !rs.isDefaultOrder('hood'), 'Use first moves a node to the front')
ok(JSON.parse(store.get('arcdex:rpc:v1')!).primary.hood === 'https://robinhood-rpc.publicnode.com', '… and is remembered in this browser')
rs.resetRpc('hood')
ok(hosts('hood')[0] === 'rpc.mainnet.chain.robinhood.com' && rs.isDefaultOrder('hood'), 'Reset to defaults')
ok(rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a') === null && hosts('sol')[0] === 'mainnet.helius-rpc.com', 'an own node goes first')
ok(rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a') === null && rs.endpoints('sol').length === 2, 'the same node twice is kept once')
ok(rs.addNode('sol', 'https://solana-mainnet.g.alchemy.com/v2/b') === null && rs.addNode('sol', 'https://solana.drpc.org') === 'Two nodes at most: remove one first', 'two own nodes at most')
ok(rs.addNode('sol', 'http://solana.example.com') === 'The node must use HTTPS', 'an added node is checked too')
rs.setPrimary('sol', 'https://solana-mainnet.g.alchemy.com/v2/b')
rs.removeNode('sol', 'https://solana-mainnet.g.alchemy.com/v2/b')
ok(hosts('sol').join() === 'mainnet.helius-rpc.com,solana-rpc.publicnode.com' && JSON.parse(store.get('arcdex:rpc:v1')!).primary.sol === null, 'removing the node in front clears its place')
let heard = 0
const off = (() => { const f = () => { heard++ }; (g.window as EventTarget).addEventListener('arcdex:rpc', f); return () => (g.window as EventTarget).removeEventListener('arcdex:rpc', f) })()
rs.resetRpc('sol')
off()
ok(heard === 1 && hosts('sol').join() === 'solana-rpc.publicnode.com', 'a change is announced (the settings re-render)')

console.log('plain JSON-RPC (Solana)')
rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a')
answers = { 'mainnet.helius-rpc.com': () => ({ status: 429 }) }
hits = []
ok(await rs.rpcRequest<string>('sol', 'getSlot') === '0x10' && hits.join() === 'mainnet.helius-rpc.com:getSlot,solana-rpc.publicnode.com:getSlot', 'throttled (429): the next node answers the same call')
hits = []
await rs.rpcRequest('sol', 'getSlot')
ok(hits.join() === 'solana-rpc.publicnode.com:getSlot', '… and the throttled one is skipped while it cools off')
answers = { 'solana-rpc.publicnode.com': () => ({ body: { error: { code: -32002, message: 'Transaction simulation failed' } } }) }
hits = []
let err: unknown = null
try { await rs.rpcRequest('sol', 'simulateTransaction') } catch (e) { err = e }
ok((err as { code?: number })?.code === -32002 && hits.length === 1, 'an error answer (a failed simulation) is thrown at once, never asked of another node')
rs.resetRpc('sol')

console.log('viem reads (Arc, Robinhood Chain, BNB Chain)')
answers = { 'rpc.mainnet.chain.robinhood.com': () => ({ status: 503 }) }
const client = createPublicClient({ transport: rs.readTransport('hood') })
hits = []
ok(await client.getBlockNumber({ cacheTime: 0 }) === 16n && hits.join() === 'rpc.mainnet.chain.robinhood.com:eth_blockNumber,robinhood-rpc.publicnode.com:eth_blockNumber', 'down (503): the next node answers the same read')
hits = []
await client.getBlockNumber({ cacheTime: 0 })
ok(hits.join() === 'robinhood-rpc.publicnode.com:eth_blockNumber', '… and the next reads skip the one that failed')
answers = { 'bnb-mainnet.g.alchemy.com': () => ({ fail: true }), 'bsc-rpc.publicnode.com': () => ({ fail: true }) }
const bnb = createPublicClient({ transport: rs.readTransport('bnb') })
hits = []
ok(await bnb.getBlockNumber({ cacheTime: 0 }) === 16n && hits.join() === 'bnb-mainnet.g.alchemy.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-dataseed.bnbchain.org:eth_blockNumber', 'unreachable: the saved node, then PublicNode, then BNB Chain’s own, in order')
answers = { 'fast.test': () => ({ body: { error: { code: 3, message: 'execution reverted: Slippage', data: '0x08c379a0' } } }) }
const arc = createPublicClient({ transport: rs.readTransport('arc') })
hits = []
err = null
try { await arc.request({ method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest'] } as never) } catch (e) { err = e }
ok(err !== null && hits.join() === 'fast.test:eth_call', 'a revert is an answer: thrown, never asked of another node')
answers = { 'fast.test': () => ({ status: 429 }) }
hits = []
ok(await arc.getBlockNumber({ cacheTime: 0 }) === 16n && hits.join() === 'fast.test:eth_blockNumber,rpc.blockdaemon.mainnet.arc.io:eth_blockNumber', 'the dedicated node throttled: Blockdaemon answers the same read')
const { fastUp } = await import('../src/arcdex/lib/rpc')
hits = []
await arc.getBlockNumber({ cacheTime: 0 })
ok(!fastUp() && hits.join() === 'rpc.blockdaemon.mainnet.arc.io:eth_blockNumber', '… and it sits out by its own rules (lib/rpc.ts benchFast)')
answers = {}
hits = []
await rs.headOf('arc')
ok(!hits.some(h => h.startsWith('fast.test')), 'the status line never polls the dedicated node (it is paid by the call)')

console.log('the speed test')
hits = []
const speed = await rs.measureNode('bnb', 'https://bsc-rpc.publicnode.com')
ok(speed.head === 16 && speed.latencyMs >= 0 && speed.callMs >= 0 && hits.join() === 'bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_getBalance', 'three head reads and one balance read, from that node only')
answers = { 'solana-rpc.publicnode.com': m => ({ body: { result: m === 'getSlot' ? 412_000_000 : { value: 1 } } }) }
ok((await rs.measureNode('sol', 'https://solana-rpc.publicnode.com')).head === 412_000_000, 'Solana: its slot')
answers = {}
ok((await rs.headOf('hood')).node === 'PublicNode', 'the status line reads the first node that answers (the failed one is still cooling off)')

console.log('\nall RPC settings checks passed')
