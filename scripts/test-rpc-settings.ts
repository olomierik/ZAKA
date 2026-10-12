// Offline test of the RPC settings (src/arcdex/lib/rpcSettings.ts, 2026-10-12): which nodes can be added, the order
// reads use them in (measured fastest first, pinned, own), ARCDEX's Alchemy node through the site (only the methods it
// serves, stepping aside until its key is set), a node that throttles or fails stepping aside for the next one (viem
// reads and plain JSON-RPC), a revert answered once and never retried elsewhere, the speed test, and the edge function
// that holds the Alchemy key (netlify/edge-functions/rpc.ts). fetch, localStorage and window are stubbed.
// Run: bun scripts/test-rpc-settings.ts

// Bun's import.meta.env is process.env (with the repo's .env): a stand-in for ARCDEX's dedicated Arc node, and Alchemy
// on as in production.
process.env.VITE_ARC_RPC_URL = 'https://fast.test/token/'
process.env.VITE_ALCHEMY = 'on'

const store = new Map<string, string>()
// A node saved before the rules (plain http) is dropped on load; a good one is kept.
store.set('arcdex:rpc:v1', JSON.stringify({ own: { bnb: ['http://bsc.example.com', 'https://bnb-mainnet.g.alchemy.com/v2/key'] }, primary: {} }))
const g = globalThis as unknown as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = new EventTarget()

type Answer = { status?: number; body?: unknown; fail?: boolean; delay?: number; headers?: Record<string, string> }
let answers: Record<string, (method: string) => Answer> = {}
let hits: string[] = []
let seen: { url: string; headers: Headers }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const host = new URL(url).host
  const req = JSON.parse(String(init?.body)) as { id: number; method: string }
  hits.push(`${host}:${req.method}`)
  seen.push({ url, headers: new Headers(init?.headers) })
  const a = (answers[host] ?? (() => ({ body: { result: '0x10' } })))(req.method)
  if (a.delay) await new Promise(r => setTimeout(r, a.delay))
  if (a.fail) throw new TypeError('fetch failed')
  const body = a.status && a.status >= 400 ? 'busy' : JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(a.body as object) })
  return new Response(body, { status: a.status ?? 200, headers: { 'Content-Type': 'application/json', ...(a.headers ?? {}) } })
}) as typeof fetch

const rs = await import('../src/arcdex/lib/rpcSettings')
const edge = await import('../netlify/edge-functions/rpc')
const { createPublicClient } = await import('viem')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const hosts = (chain: 'arc' | 'hood' | 'sol' | 'bnb') => rs.endpoints(chain).map(e => rs.hostOf(e.url))
const SITE = 'arcsense.site'

console.log('which nodes can be added')
ok(rs.nodeProblem('not a link') === 'Not a link', 'not a link')
ok(rs.nodeProblem('http://eth-mainnet.g.alchemy.com/v2/k') === 'The node must use HTTPS', 'plain http is refused')
ok(rs.nodeProblem('https://my-node.example.com') === 'Only nodes from known providers can be added', 'an unknown host is refused')
ok(rs.nodeProblem('https://alchemy.com.evil.io/v2/k') !== null && rs.nodeProblem('https://evilalchemy.com/rpc') !== null, 'a look-alike host is refused (suffixes match whole labels)')
ok(rs.nodeProblem('https://eth-mainnet.g.alchemy.com/v2/k') === null && rs.nodeProblem('https://mainnet.helius-rpc.com/?api-key=k') === null, 'known providers are taken (Alchemy, Helius)')

console.log('the order reads use (nothing measured yet)')
ok(hosts('bnb').join() === `bnb-mainnet.g.alchemy.com,bsc-rpc.publicnode.com,bsc-dataseed.bnbchain.org,${SITE}`, 'a saved node is kept and goes first; one saved over plain http is dropped on load')
ok(hosts('hood').join() === `rpc.mainnet.chain.robinhood.com,robinhood-rpc.publicnode.com,${SITE}` && rs.isDefaultOrder('hood'), 'the defaults otherwise (Robinhood Chain: its own RPC first), ARCDEX’s Alchemy node last until it has answered')
ok(hosts('arc').slice(0, 3).join() === 'fast.test,rpc.blockdaemon.mainnet.arc.io,rpc.mainnet.arc.io' && rs.endpoints('arc')[0].kind === 'arcdex', 'Arc: the dedicated node, Blockdaemon, then the public RPC')
ok(rs.endpoints('sol').slice(-1)[0].url === `https://${SITE}/rpc/sol` && rs.endpoints('sol').slice(-1)[0].kind === 'alchemy', 'every chain has ARCDEX’s Alchemy node, through the site’s /rpc/<chain>')
rs.setPrimary('hood', 'https://robinhood-rpc.publicnode.com')
ok(hosts('hood').join() === `robinhood-rpc.publicnode.com,rpc.mainnet.chain.robinhood.com,${SITE}` && !rs.isDefaultOrder('hood'), 'Use first moves a node to the front')
ok(JSON.parse(store.get('arcdex:rpc:v1')!).primary.hood === 'https://robinhood-rpc.publicnode.com', '… and is remembered in this browser')
rs.resetRpc('hood')
ok(hosts('hood')[0] === 'rpc.mainnet.chain.robinhood.com' && rs.isDefaultOrder('hood'), 'Reset to defaults')
ok(rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a') === null && hosts('sol')[0] === 'mainnet.helius-rpc.com', 'an own node goes first')
ok(rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a') === null && rs.endpoints('sol').length === 3, 'the same node twice is kept once')
ok(rs.addNode('sol', 'https://solana-mainnet.g.alchemy.com/v2/b') === null && rs.addNode('sol', 'https://solana.drpc.org') === 'Two nodes at most: remove one first', 'two own nodes at most')
ok(rs.addNode('sol', 'http://solana.example.com') === 'The node must use HTTPS', 'an added node is checked too')
rs.setPrimary('sol', 'https://solana-mainnet.g.alchemy.com/v2/b')
rs.removeNode('sol', 'https://solana-mainnet.g.alchemy.com/v2/b')
ok(hosts('sol').join() === `mainnet.helius-rpc.com,solana-rpc.publicnode.com,${SITE}` && JSON.parse(store.get('arcdex:rpc:v1')!).primary.sol === null, 'removing the node in front clears its place')
let heard = 0
const off = (() => { const f = () => { heard++ }; (g.window as EventTarget).addEventListener('arcdex:rpc', f); return () => (g.window as EventTarget).removeEventListener('arcdex:rpc', f) })()
rs.resetRpc('sol')
off()
ok(heard === 1 && hosts('sol').join() === `solana-rpc.publicnode.com,${SITE}`, 'a change is announced (the settings re-render)')

console.log('fastest first')
answers = {
  'rpc.mainnet.chain.robinhood.com': () => ({ delay: 60, body: { result: '0x1000' } }),
  'robinhood-rpc.publicnode.com': () => ({ delay: 30, body: { result: '0x1000' } }),
  [SITE]: () => ({ delay: 1, body: { result: '0x1000' } }),
}
await rs.probeNow('hood')
ok(hosts('hood').join() === `${SITE},robinhood-rpc.publicnode.com,rpc.mainnet.chain.robinhood.com`, 'measured: the fastest node leads (here ARCDEX’s Alchemy node), then the next fastest')
const hood = createPublicClient({ transport: rs.readTransport('hood') })
hits = []
await hood.getBlockNumber({ cacheTime: 0 })
ok(hits.join() === `${SITE}:eth_blockNumber`, 'reads go to it')
hits = []
await hood.request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] } as never)
ok(hits.join() === 'robinhood-rpc.publicnode.com:eth_getLogs', 'a method it doesn’t serve (eth_getLogs) goes to the next node, without asking it')
ok(rs.serves(rs.endpoints('hood')[0], 'hood', 'eth_call') && !rs.serves(rs.endpoints('hood')[0], 'hood', 'eth_sendRawTransaction') && rs.serves(rs.endpoints('sol').slice(-1)[0], 'sol', 'sendTransaction'), 'it serves reads and simulations, Solana’s sendTransaction, never EVM sends')
ok(rs.readSpeed('hood').node === 'Alchemy' && rs.readSpeed('hood').ms !== null && rs.readSpeed('hood').kind === 'alchemy', 'the status line shows the node reads go through, with its time')
answers = {
  'rpc.mainnet.chain.robinhood.com': () => ({ delay: 30, body: { result: '0x1000' } }),
  'robinhood-rpc.publicnode.com': () => ({ delay: 20, body: { result: '0x1000' } }),
  [SITE]: () => ({ delay: 1, body: { result: '0x0f00' } }),
}
await rs.probeNow('hood')
ok(hosts('hood').join() === `robinhood-rpc.publicnode.com,rpc.mainnet.chain.robinhood.com,${SITE}`, 'a node more than a few seconds of blocks behind goes after the up-to-date ones, however fast')
rs.setPrimary('hood', 'https://rpc.mainnet.chain.robinhood.com')
ok(hosts('hood')[0] === 'rpc.mainnet.chain.robinhood.com', 'a pinned node still comes first')
rs.resetRpc('hood')

console.log('before the key is set (Alchemy unconfigured)')
answers = { [SITE]: () => ({ status: 503, headers: { 'x-arcdex-rpc': 'unconfigured' } }), 'solana-rpc.publicnode.com': () => ({ delay: 40, body: { result: 9 } }) }
await rs.probeNow('sol')
ok(hosts('sol').join() === `solana-rpc.publicnode.com,${SITE}`, 'it answers "unconfigured" and steps aside')
hits = []
ok(await rs.rpcRequest<number>('sol', 'getSlot') === 9 && hits.join() === 'solana-rpc.publicnode.com:getSlot', '… and isn’t asked again for 10 minutes')
answers = { [SITE]: () => ({ status: 503, headers: { 'x-arcdex-rpc': 'unconfigured' } }), 'bsc-rpc.publicnode.com': () => ({ fail: true }), 'bsc-dataseed.bnbchain.org': () => ({ fail: true }), 'bnb-mainnet.g.alchemy.com': () => ({ fail: true }) }
hits = []
let err: unknown = null
try { await createPublicClient({ transport: rs.readTransport('bnb') }).getBlockNumber({ cacheTime: 0 }) } catch (e) { err = e }
ok(err !== null && hits[hits.length - 1] === `${SITE}:eth_blockNumber`, 'viem reads try it last, and an "unconfigured" answer fails over like any other')

console.log('plain JSON-RPC (Solana)')
rs.addNode('sol', 'https://mainnet.helius-rpc.com/?api-key=a')
ok(hosts('sol')[0] === 'solana-rpc.publicnode.com', 'a node just added, not measured yet, waits behind the measured ones (the settings panel measures it at once)')
rs.setPrimary('sol', 'https://mainnet.helius-rpc.com/?api-key=a')
answers = { 'mainnet.helius-rpc.com': () => ({ status: 429 }) }
hits = []
ok(await rs.rpcRequest<string>('sol', 'getSlot') === '0x10' && hits.join() === 'mainnet.helius-rpc.com:getSlot,solana-rpc.publicnode.com:getSlot', 'throttled (429): the next node answers the same call')
hits = []
await rs.rpcRequest('sol', 'getSlot')
ok(hits.join() === 'solana-rpc.publicnode.com:getSlot', '… and the throttled one is skipped while it cools off, pinned or not')
answers = { 'solana-rpc.publicnode.com': () => ({ body: { error: { code: -32002, message: 'Transaction simulation failed' } } }) }
hits = []
err = null
try { await rs.rpcRequest('sol', 'simulateTransaction') } catch (e) { err = e }
ok((err as { code?: number })?.code === -32002 && hits.length === 1, 'an error answer (a failed simulation) is thrown at once, never asked of another node')
rs.resetRpc('sol')

console.log('viem reads (Arc, BNB Chain)')
answers = { 'bnb-mainnet.g.alchemy.com': () => ({ fail: true }), 'bsc-rpc.publicnode.com': () => ({ status: 503 }) }
const bnb = createPublicClient({ transport: rs.readTransport('bnb') })
hits = []
ok(await bnb.getBlockNumber({ cacheTime: 0 }) === 16n && hits.join() === 'bnb-mainnet.g.alchemy.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-dataseed.bnbchain.org:eth_blockNumber', 'unreachable, then down (503): the next node answers the same read, in order')
hits = []
await bnb.getBlockNumber({ cacheTime: 0 })
ok(hits.join() === 'bsc-dataseed.bnbchain.org:eth_blockNumber', '… and the next reads skip the ones that failed')
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
ok(!hits.some(h => h.startsWith('fast.test') || h.startsWith(SITE)), 'the status line’s block never polls the paid nodes (the dedicated one, Alchemy)')

console.log('the speed test')
hits = []
const speed = await rs.measureNode('bnb', 'https://bsc-rpc.publicnode.com')
ok(speed.head === 16 && speed.latencyMs >= 0 && speed.callMs >= 0 && hits.join() === 'bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_blockNumber,bsc-rpc.publicnode.com:eth_getBalance', 'three head reads and one balance read, from that node only')
answers = { 'solana-rpc.publicnode.com': m => ({ body: { result: m === 'getSlot' ? 412_000_000 : { value: 1 } } }) }
ok((await rs.measureNode('sol', 'https://solana-rpc.publicnode.com')).head === 412_000_000, 'Solana: its slot')
answers = {}

console.log('the edge function holding the key (netlify/edge-functions/rpc.ts)')
ok(JSON.stringify(edge.RPC_METHODS.evm) === JSON.stringify(rs.ALCHEMY_METHODS.evm) && JSON.stringify(edge.RPC_METHODS.sol) === JSON.stringify(rs.ALCHEMY_METHODS.sol), 'the page and the edge function serve the same methods')
const same = new Headers({ 'sec-fetch-site': 'same-origin' })
const body = (m: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: [] })
ok('ok' in edge.rpcCheck('arc', same, body('eth_call')) && 'ok' in edge.rpcCheck('sol', same, body('sendTransaction')) && 'ok' in edge.rpcCheck('starknet', same, body('starknet_call')), 'reads, simulations and Solana sends pass')
ok((edge.rpcCheck('arc', new Headers({ 'sec-fetch-site': 'cross-site' }), body('eth_call')) as { status: number }).status === 403 && (edge.rpcCheck('arc', new Headers(), body('eth_call')) as { status: number }).status === 403, 'other sites’ pages, and requests that don’t say where they come from, are refused')
ok((edge.rpcCheck('arc', same, body('eth_sendRawTransaction')) as { status: number }).status === 405 && (edge.rpcCheck('arc', same, body('eth_getLogs')) as { status: number }).status === 405 && (edge.rpcCheck('sol', same, body('getProgramAccounts')) as { status: number }).status === 405, 'EVM sends, eth_getLogs and heavy Solana scans are refused')
ok((edge.rpcCheck('eth', same, body('eth_call')) as { status: number }).status === 404, 'a chain ARCDEX doesn’t serve is refused')
ok((edge.rpcCheck('arc', same, JSON.stringify(Array.from({ length: 26 }, () => ({ method: 'eth_call' })))) as { status: number }).status === 400 && 'ok' in edge.rpcCheck('arc', same, JSON.stringify([{ method: 'eth_call' }, { method: 'eth_blockNumber' }])), 'batches up to 25 calls, every one checked')
ok((edge.rpcCheck('arc', same, JSON.stringify([{ method: 'eth_call' }, { method: 'eth_sendRawTransaction' }])) as { status: number }).status === 405, 'one refused call refuses the batch')
ok((edge.rpcCheck('arc', same, 'x'.repeat(edge.MAX_BODY + 1)) as { status: number }).status === 413 && (edge.rpcCheck('arc', same, '{') as { status: number }).status === 400, 'too large, or not JSON')
ok(edge.upstreamUrl('starknet', 'K') === 'https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/K' && edge.upstreamUrl('hood', 'K') === 'https://robinhood-mainnet.g.alchemy.com/v2/K', 'Alchemy’s URLs (Starknet on spec 0.10)')
{
  const envs: Record<string, string> = {}
  ;(globalThis as unknown as { Netlify: unknown }).Netlify = { env: { get: (k: string) => envs[k] } }
  const post = (net: string, m = 'eth_blockNumber', h: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
    edge.default(new Request(`https://${SITE}/rpc/${net}`, { method: 'POST', headers: h, body: body(m) }))
  let r = await post('arc')
  ok(r.status === 503 && r.headers.get('x-arcdex-rpc') === 'unconfigured', 'no key in Netlify: 503, unconfigured')
  envs.ALCHEMY_API_KEY = 'secret-key-123'
  seen = []
  answers = { 'arc-mainnet.g.alchemy.com': () => ({ body: { result: '0x99' } }) }
  r = await post('arc')
  const text = await r.text()
  ok(r.status === 200 && JSON.parse(text).result === '0x99' && r.headers.get('x-arcdex-rpc') === 'alchemy' && seen[seen.length - 1].url === 'https://arc-mainnet.g.alchemy.com/v2/secret-key-123', 'with the key: forwarded to Alchemy, the answer passed back')
  ok(!text.includes('secret-key-123') && ![...r.headers.values()].some(v => v.includes('secret-key-123')), 'the key never comes back to the page')
  seen = []
  r = await post('arc', 'eth_sendRawTransaction')
  ok(r.status === 405 && seen.length === 0, 'a refused method never reaches Alchemy')
  r = await edge.default(new Request(`https://${SITE}/rpc/arc`, { method: 'GET' }))
  ok(r.status === 405, 'POST only')
}

console.log('\nall RPC settings checks passed')
