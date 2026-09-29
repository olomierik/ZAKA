// RPC transports that tolerate a load-balanced node lagging behind.
//
// Arc's public RPC answers from several nodes that can trail each other by
// a block (measured 2026-09-26: 6 of 240 requests came from a node one block
// behind). Right after a transaction confirms, the next call can land on a
// node that hasn't seen it yet: an approval that "isn't there", a balance
// that hasn't arrived. The trade's simulation or gas estimate then fails with
// "transfer amount exceeds allowance" although the approval is on-chain.
// `lagTolerant` retries exactly those calls for a moment before giving up.

import { fallback, http, type Address, type Transport } from 'viem'
import { RECENT_RPC } from '../../../api/_arcLogs'

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

// A dedicated Arc endpoint (QuickNode, 2026-09-29), when the build has one:
// tried first for reads, receipts and the live feeds, with the public RPC
// behind it. Its URL carries its token and ships in the page, so QuickNode
// only answers pages from arcdex.online and localhost (referrer whitelist).
// Unset, everything uses the public endpoints as before.
const env = (v: string | undefined) => (typeof v === 'string' && /^(https|wss):\/\//.test(v.trim()) ? v.trim() : null)
export const FAST_RPC = env(import.meta.env.VITE_ARC_RPC_URL as string | undefined)
export const FAST_WS = env(import.meta.env.VITE_ARC_WSS_URL as string | undefined)

// Throttled, out of credits, refusing this page or down: the dedicated
// endpoint is left alone for a while and the public RPC answers instead,
// so it can make things faster but never slower.
let benchedUntil = 0
export const fastUp = () => FAST_RPC !== null && Date.now() >= benchedUntil
/** How long to leave the dedicated endpoint alone after this failure (0: it
 * answered, e.g. a revert). */
export function benchFor(e: unknown): number {
  const x = e as { status?: unknown; code?: unknown; name?: unknown }
  const status = typeof x?.status === 'number' ? x.status : x?.code === 429 ? 429 : 0
  if (status === 401 || status === 402 || status === 403) return 10 * 60_000 // refused / out of credits
  // (Not every message mentioning a limit: a revert can say "slippage limit".)
  if (status === 429 || x?.code === -32005 || x?.code === -32029 || /rate limit|credits|capacity|too many requests/i.test(errText(e))) return 60_000
  if (status >= 500 || x?.name === 'TimeoutError' || x?.name === 'HttpRequestError' || x?.name === 'TypeError') return 30_000
  return 0
}
export function benchFast(ms: number) { if (ms > 0) benchedUntil = Math.max(benchedUntil, Date.now() + ms) }

/** The dedicated endpoint as the first of a fallback: while benched it
 * steps aside at once, and a failure benches it. (viem's fallback gives the
 * transports in it no retries of their own.) */
function fastTransport(url: string): Transport {
  const inner = lagTolerant(http(url, { timeout: 4_000 }))
  return (opts => {
    const t = inner(opts)
    const request = (async (args: unknown, options?: unknown) => {
      if (!fastUp()) throw new Error('dedicated Arc RPC benched')
      try { return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options) }
      catch (e) { benchFast(benchFor(e)); throw e }
    }) as typeof t.request
    return { ...t, request }
  }) as Transport
}

/** Arc over the public RPC, lag-tolerant. (Transactions are sent here, not
 * through the dedicated endpoint: a fallback could send one twice.) */
export const arcTransport = () => lagTolerant(http(ARC_RPC))
/** Reads on Arc (balances, quotes, simulations): the dedicated endpoint if
 * there is one, then the public RPC, and Blockdaemon the moment it throttles
 * or fails — instead of backing off and retrying the same busy node. A
 * revert is an answer, not a failure: it's never retried elsewhere.
 * Lag-tolerant either way. */
export const arcReadTransport = () => fallback([
  ...(FAST_RPC ? [fastTransport(FAST_RPC)] : []),
  lagTolerant(http(ARC_RPC)), lagTolerant(http(RECENT_RPC)),
], { retryCount: 1 })
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
