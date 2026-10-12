// Starknet JSON-RPC (spec 0.9–0.10), straight from the browser to public endpoints (they allow any origin). Each call
// goes to the first endpoint and moves to the next on a network error, a throttle or a server error; a JSON-RPC error
// (a revert, a bad call) is an answer and isn't retried elsewhere.

import { SN, type SnNetwork } from './net'
import { SEL, fromU256 } from './felt'

export class SnRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message) }
}

let seq = 0

export async function snRpc<T>(net: SnNetwork, method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
  let last: unknown = null
  for (const url of SN[net].rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(timeoutMs),
      })
      if (r.status === 429 || r.status >= 500) { last = new SnRpcError(`${url} answered ${r.status}`); continue }
      const j = (await r.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } }
      if (j.error) {
        // Some providers answer a method they don't serve with an error: that one is worth another endpoint.
        if (j.error.code === -32601) { last = new SnRpcError(j.error.message, j.error.code); continue }
        throw new SnRpcError(j.error.message, j.error.code, j.error.data)
      }
      return j.result as T
    } catch (e) {
      if (e instanceof SnRpcError && e.code !== undefined && e.code !== -32601) throw e
      last = e
    }
  }
  throw last instanceof Error ? last : new SnRpcError('No Starknet RPC answered')
}

/** A view call; the answer is the returned felts. */
export const snCall = (net: SnNetwork, contract: string, entrySelector: string, calldata: string[] = []) =>
  snRpc<string[]>(net, 'starknet_call', { request: { contract_address: contract, entry_point_selector: entrySelector, calldata }, block_id: 'latest' })

/** An ERC-20 balance (u256), 0 for an account the token has never seen. */
export async function snBalance(net: SnNetwork, token: string, account: string): Promise<bigint> {
  const r = await snCall(net, token, SEL.balanceOf, [account])
  return fromU256(r[0], r[1] ?? '0x0') ?? 0n
}

export const snChainId = (net: SnNetwork) => snRpc<string>(net, 'starknet_chainId', [])
export const snNonce = (net: SnNetwork, address: string) => snRpc<string>(net, 'starknet_getNonce', { block_id: 'latest', contract_address: address })

export interface SnReceipt {
  finality_status: 'RECEIVED' | 'PRE_CONFIRMED' | 'ACCEPTED_ON_L2' | 'ACCEPTED_ON_L1' | string
  execution_status?: 'SUCCEEDED' | 'REVERTED'
  revert_reason?: string
  block_number?: number
}

/** A transaction's receipt, or null while the network doesn't know it yet. */
export async function snReceipt(net: SnNetwork, hash: string): Promise<SnReceipt | null> {
  try { return await snRpc<SnReceipt>(net, 'starknet_getTransactionReceipt', { transaction_hash: hash }) }
  catch (e) {
    // 29: TXN_HASH_NOT_FOUND.
    if (e instanceof SnRpcError && e.code === 29) return null
    throw e
  }
}
