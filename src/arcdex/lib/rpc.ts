// RPC transports that tolerate a load-balanced node lagging behind.
//
// Arc's public RPC answers from several nodes that can trail each other by
// a block (measured 2026-09-26: 6 of 240 requests came from a node one block
// behind). Right after a transaction confirms, the next call can land on a
// node that hasn't seen it yet: an approval that "isn't there", a balance
// that hasn't arrived. The trade's simulation or gas estimate then fails with
// "transfer amount exceeds allowance" although the approval is on-chain.
// `lagTolerant` retries exactly those calls for a moment before giving up.

import { http, type Address, type Transport } from 'viem'

/** eth_call / eth_estimateGas failures a lagging node produces. Also
 * OpenZeppelin v5's custom errors (the launchpad's tokens):
 * ERC20InsufficientAllowance 0xfb8f41b2, ERC20InsufficientBalance 0xe450d38c. */
const LAGGY = /allowance|exceeds balance|insufficient balance|transfer amount exceeds|0xfb8f41b2|0xe450d38c|header not found|unknown block/i
// eth_fillTransaction: viem (2.5x) fills a local account's transaction —
// gas included — with it where the node supports it, as Arc's does.
const RETRIED = new Set(['eth_call', 'eth_estimateGas', 'eth_fillTransaction'])

function errText(e: unknown, depth = 0): string {
  if (!e || typeof e !== 'object' || depth > 4) return String(e ?? '')
  const x = e as { message?: unknown; details?: unknown; shortMessage?: unknown; data?: unknown; cause?: unknown }
  return [x.message, x.details, x.shortMessage, typeof x.data === 'string' ? x.data : '', x.cause ? errText(x.cause, depth + 1) : '']
    .filter(v => typeof v === 'string').join(' ')
}

/** Wraps a transport: a call, gas estimate or transaction fill that fails
 * the way a lagging node would is retried (4 tries, 600ms apart) before the error surfaces.
 * A real failure still surfaces, about 2s later. */
export function lagTolerant(inner: Transport, { retries = 3, delayMs = 600 } = {}): Transport {
  return (opts => {
    const t = inner(opts)
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      for (let i = 0; ; i++) {
        try { return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options) }
        catch (e) {
          if (i >= retries || !RETRIED.has(args.method) || !LAGGY.test(errText(e))) throw e
          await new Promise(r => setTimeout(r, delayMs))
        }
      }
    }) as typeof t.request
    return { ...t, request }
  }) as Transport
}

export const ARC_RPC = 'https://rpc.mainnet.arc.io'

/** Arc over the public RPC, lag-tolerant. */
export const arcTransport = () => lagTolerant(http(ARC_RPC))
/** Any chain over its default RPC, lag-tolerant. */
export const chainTransport = (url?: string) => lagTolerant(http(url))

const ALLOWANCE_ABI = [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const

/** After an approval confirms: waits (up to ~6s) until the RPC reports it,
 * so the next transaction isn't estimated against a node that trails. */
export async function waitForAllowance(
  client: { readContract: (a: never) => Promise<unknown> },
  token: Address, owner: Address, spender: Address, amount: bigint, timeoutMs = 6_000,
): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const a = await client.readContract({ address: token, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [owner, spender] } as never).catch(() => 0n) as bigint
    if (a >= amount || Date.now() > until) return
    await new Promise(r => setTimeout(r, 400))
  }
}
