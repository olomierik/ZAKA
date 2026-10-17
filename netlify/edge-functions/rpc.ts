// ARCDEX's Alchemy nodes for the site's reads (2026-10-12, owner: "Alchemy endpoints for the chains we support, to be
// faster"). The key is a secret in Netlify's environment (ALCHEMY_API_KEY), never in the page or the repository: the
// page posts JSON-RPC to /rpc/<chain> and this forwards it to Alchemy.
//
// Only the site's own pages pass (browsers say where a request comes from), and only the methods the site's reads use,
// plus Solana's sendTransaction (a sale is sent through the node that simulated it). EVM transactions are still sent
// through the public RPCs, and eth_getLogs stays off (Alchemy's free plan answers only 10-block ranges). The page keeps
// the same lists (src/arcdex/lib/rpcSettings.ts ALCHEMY_METHODS; scripts/test-rpc-settings.ts checks they match), so
// it never sends this anything it would refuse. Without a key it answers 503 with x-arcdex-rpc: unconfigured, and the
// page reads through the public nodes as before.

declare const Netlify: { env: { get(name: string): string | undefined } }

export type RpcFamily = 'evm' | 'sol' | 'starknet'

/** The chains served, Alchemy's name for each, and its kind of JSON-RPC. */
export const RPC_NETS: Record<string, { host: string; family: RpcFamily }> = {
  arc: { host: 'arc-mainnet', family: 'evm' },
  hood: { host: 'robinhood-mainnet', family: 'evm' },
  bnb: { host: 'bnb-mainnet', family: 'evm' },
  sol: { host: 'solana-mainnet', family: 'sol' },
  starknet: { host: 'starknet-mainnet', family: 'starknet' },
}

export const RPC_METHODS: Record<RpcFamily, readonly string[]> = {
  evm: [
    'eth_blockNumber', 'eth_chainId', 'net_version', 'eth_call', 'eth_estimateGas', 'eth_createAccessList', 'eth_getBalance',
    'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  ],
  sol: [
    'getSlot', 'getBlockHeight', 'getHealth', 'getVersion', 'getEpochInfo', 'getBalance', 'getAccountInfo', 'getMultipleAccounts',
    'getTokenAccountsByOwner', 'getTokenAccountBalance', 'getTokenSupply', 'getLatestBlockhash', 'isBlockhashValid',
    'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'simulateTransaction',
    'sendTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction',
  ],
  starknet: [
    'starknet_blockNumber', 'starknet_chainId', 'starknet_specVersion', 'starknet_call', 'starknet_getNonce',
    'starknet_getClassHashAt', 'starknet_getTransactionReceipt', 'starknet_getTransactionStatus', 'starknet_estimateFee',
    'starknet_simulateTransactions',
  ],
}

export const MAX_BODY = 256 * 1024
export const MAX_BATCH = 25

export function upstreamUrl(net: string, key: string): string {
  const n = RPC_NETS[net]
  return n.family === 'starknet'
    ? `https://${n.host}.g.alchemy.com/starknet/version/rpc/v0_10/${key}`
    : `https://${n.host}.g.alchemy.com/v2/${key}`
}

/** Whether a request may go to Alchemy, or why not. */
export function rpcCheck(net: string, headers: Headers, body: string): { ok: true } | { status: number; error: string } {
  const n = RPC_NETS[net]
  if (!n) return { status: 404, error: 'chain not served' }
  if (headers.get('sec-fetch-site') !== 'same-origin') return { status: 403, error: 'not from this site' }
  if (body.length > MAX_BODY) return { status: 413, error: 'too large' }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return { status: 400, error: 'not JSON' } }
  const calls = Array.isArray(parsed) ? parsed : [parsed]
  if (!calls.length || calls.length > MAX_BATCH) return { status: 400, error: 'batch size' }
  const allowed = RPC_METHODS[n.family]
  for (const c of calls) {
    const m = (c as { method?: unknown } | null)?.method
    if (typeof m !== 'string' || !allowed.includes(m)) return { status: 405, error: `method not served: ${String(m).slice(0, 40)}` }
  }
  return { ok: true }
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...extra } })

export default async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const net = new URL(req.url).pathname.replace(/^\/rpc\//, '').replace(/\/$/, '')
  const key = Netlify.env.get('ALCHEMY_API_KEY')?.trim()
  if (!key) return json(503, { error: 'not configured' }, { 'x-arcdex-rpc': 'unconfigured' })
  const body = await req.text()
  const r = rpcCheck(net, req.headers, body)
  if ('error' in r) return json(r.status, { error: r.error })
  try {
    const up = await fetch(upstreamUrl(net, key), { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return new Response(up.body, {
      status: up.status,
      headers: { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'private, no-store', 'x-arcdex-rpc': 'alchemy' },
    })
  } catch {
    return json(502, { error: 'Alchemy did not answer' })
  }
}

export const config = { path: '/rpc/*' }
