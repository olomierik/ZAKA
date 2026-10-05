// BNB Chain for ARCDEX's pages (2026-10-05): reads through a public RPC, balances, explorer links, and the trading
// wallet's signer there (the same address as on Arc; gas is BNB). Trading is lib/relay.ts; the market list is
// api/bscMarket.ts.

import { createPublicClient, erc20Abi, formatUnits, type Address } from 'viem'
import { bsc } from 'viem/chains'
import { chainTransport } from './rpc'
import { getEmbeddedWalletClientOn, recordBroadcasts } from './embeddedWallet'
import { BSC_RPC_BROWSER } from '../../../api/_bscCore'

export { bsc }
export const BSC_EXPLORER = 'https://bscscan.com'
export const bscToken = (t: string) => `${BSC_EXPLORER}/token/${t}`
export const bscAddress = (a: string) => `${BSC_EXPLORER}/address/${a}`
export const bscTx = (h: string) => `${BSC_EXPLORER}/tx/${h}`

/** BNB a sale or swap needs for gas there: about $0.10. */
export const SELL_GAS_BNB = 0.0002

export const bscClient = createPublicClient({ chain: bsc, transport: chainTransport(BSC_RPC_BROWSER), batch: { multicall: true } })

/** The trading wallet on BNB Chain (same key, same address). Throws if locked. */
export const bscWallet = () => getEmbeddedWalletClientOn(bsc, recordBroadcasts(chainTransport(BSC_RPC_BROWSER)))

export async function bnbBalance(owner: string): Promise<number> {
  return Number(formatUnits(await bscClient.getBalance({ address: owner as Address }), 18))
}

export interface BscHolding { token: string; raw: bigint; amount: number; decimals: number }

/** How much of one token `owner` holds on BNB Chain. */
export async function bscTokenBalance(token: string, owner: string, decimals?: number): Promise<BscHolding> {
  const [raw, dec] = await Promise.all([
    bscClient.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] }),
    decimals !== undefined ? Promise.resolve(decimals) : bscClient.readContract({ address: token as Address, abi: erc20Abi, functionName: 'decimals' }).then(Number),
  ])
  return { token, raw, decimals: dec, amount: Number(formatUnits(raw, dec)) }
}

/** Balances of many tokens at once (one multicall), for the Portfolio. */
export async function bscBalances(tokens: string[], owner: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const res = await bscClient.multicall({ contracts: tokens.map(t => ({ address: t as Address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner as Address] as const })), allowFailure: true })
  res.forEach((r, i) => { if (r.status === 'success' && (r.result as bigint) > 0n) out.set(tokens[i], r.result as bigint) })
  return out
}

// ── coins bought from this browser (Portfolio checks them first) ─────────

const HELD_KEY = (owner: string) => `arcdex:held-bsc:v1:${owner.toLowerCase()}`
export function rememberBsc(owner: string, token: string) {
  try {
    const list = new Set<string>(JSON.parse(localStorage.getItem(HELD_KEY(owner)) ?? '[]'))
    list.add(token.toLowerCase())
    localStorage.setItem(HELD_KEY(owner), JSON.stringify([...list].slice(-200)))
  } catch { /* storage blocked */ }
}
export function heldBsc(owner: string): string[] {
  try { return JSON.parse(localStorage.getItem(HELD_KEY(owner)) ?? '[]') as string[] } catch { return [] }
}
