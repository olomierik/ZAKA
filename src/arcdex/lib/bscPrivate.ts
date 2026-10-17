// Anti-MEV mode on BNB Chain (2026-10-17): the trading wallet's BNB Chain transactions go to a private RPC instead of
// the public mempool, where sandwich bots watch for swaps to trade around.
//
// A private RPC hands a transaction straight to builders and validators and doesn't gossip it to the public network
// before it's in a block, so a bot can't see it in time to buy just ahead of it and sell just after. Two, checked live
// on 2026-10-17 (both answer browsers from any origin, both validate the transaction as a node would):
//   - 48 Club's privacy RPC (https://rpc.48.club): into the Puissant builder's private mempool (docs.48.club).
//   - bloXroute's BSC Protect RPC (https://bsc.rpc.blxrbdn.com): its private relay, straight to block proposers, out of
//     the public mempool until confirmed (docs.bloxroute.com).
//
// The rule, so a transaction can't be spent twice or leak:
//   - Only `eth_sendRawTransaction` goes there; reads, estimates and nonces stay on the BNB Chain nodes in RPC settings.
//   - The same signed bytes are sent each time (one hash, one nonce): at most one copy can ever be mined. Nothing is
//     re-signed here.
//   - Busy (429), down or no answer: the next private RPC gets those same bytes.
//   - A refusal of the transaction itself (a JSON-RPC error: no funds, bad nonce, too little gas) ends it there; another
//     node would refuse it too.
//   - "Already known" means a node already has it: that's a send, and its hash is returned.
//   - Never the public RPC from here. With every private RPC out, the trade stops (BscPrivateError) and the trader can
//     try again or turn anti-MEV off in Settings.
//   - When an answer was lost after the bytes went out, the wallet's nonce isn't counted as used: a retry signs the same
//     nonce again, so if the first copy did land, the retry can't land too.
//
// What it can't do: the builder that gets the transaction still sees it, and the private RPCs only promise to keep it
// out of the public mempool until it's mined. External wallets (MetaMask and others) send through their own RPC, so
// they aren't covered: set a private RPC in the wallet itself.

import { keccak256, type Hash, type Hex, type Transport } from 'viem'

export const BSC_PRIVATE_RPCS = [
  { name: '48 Club', url: 'https://rpc.48.club' },
  { name: 'bloXroute', url: 'https://bsc.rpc.blxrbdn.com' },
] as const

export class BscPrivateError extends Error {}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** A node saying it already has this transaction: it was sent. */
const ALREADY = /already known|known transaction|already imported|already exists|ALREADY_EXISTS/i

/** Sends a signed BNB Chain transaction through the private RPCs, in order, under the rule above. Its hash, or
 * BscPrivateError. */
export async function sendRawPrivately(raw: Hex, f: Fetch = fetch, timeoutMs = 10_000): Promise<Hash> {
  const hash = keccak256(raw)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
  let last = ''
  for (const rpc of BSC_PRIVATE_RPCS) {
    let r: Response
    try {
      r = await f(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) { last = `${rpc.name}: ${e instanceof Error ? e.message : String(e)}`; continue }
    const j = await r.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null
    if (r.ok && typeof j?.result === 'string') {
      if (j.result.toLowerCase() !== hash) throw new BscPrivateError(`${rpc.name} answered another transaction’s hash`)
      return hash
    }
    const msg = j?.error?.message ?? ''
    if (j?.error && ALREADY.test(msg)) return hash
    last = `${rpc.name}: ${msg || `HTTP ${r.status}`}`
    // Busy, down, or an answer that isn't JSON-RPC: the next private RPC. A refusal of the transaction itself: stop.
    const busy = r.status === 429 || r.status >= 500 || !j || /rate limit|too many requests|timeout|timed out|unavailable|busy/i.test(msg)
    if (!busy) throw new BscPrivateError(msg || `HTTP ${r.status}`)
  }
  throw new BscPrivateError(last || 'no private RPC answered')
}

/** What a BNB Chain trade form says about MEV protection: `private` (the trading wallet, anti-MEV on), `off` (the
 * trading wallet, anti-MEV off), or `wallet` (an external wallet sends it through its own RPC: not covered). */
export function bscMevStatus(kind: string | null | undefined, antiMev: boolean): 'private' | 'off' | 'wallet' {
  if (kind !== 'trading-wallet') return 'wallet'
  return antiMev ? 'private' : 'off'
}

/** Wraps a BNB Chain transport so `eth_sendRawTransaction` goes through the private RPCs while `isOn()` (Settings →
 * anti-MEV); every other request, and every send while it's off, goes to `inner` as before. */
export function privateSendTransport(inner: Transport, isOn: () => boolean, f?: Fetch): Transport {
  return (opts => {
    const t = inner(opts)
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      if (args.method === 'eth_sendRawTransaction' && isOn()) return sendRawPrivately((args.params as [Hex])[0], f)
      return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options)
    }) as typeof t.request
    return { ...t, request }
  }) as Transport
}
