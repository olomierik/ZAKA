// Balances on Ethereum and Arbitrum for the Portfolio's wallets card (the build pack's Phase 1: "portfolio card across
// chains"; decision D3 adds Ethereum and Arbitrum). The trading wallet's EVM address is the same on every EVM chain, so
// these are the same account's ETH and USDC there. Read with plain JSON-RPC from public nodes, one after another on
// failure, each with a timeout, so a slow node can't hold the card.
//
// Amounts are kept in base units (bigint) and turned into numbers only for display. On Arc, USDC is both the ERC-20 at
// 0x3600… (6 decimals) and the native balance (18 decimals): the same money, read once (arcUsdcSame).

import { formatUnits } from 'viem'

export type ExtraChain = 'Ethereum' | 'Arbitrum'

export const EXTRA_CHAINS: Record<ExtraChain, { rpcs: string[]; usdc: string; explorer: string }> = {
  Ethereum: {
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'],
    usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    explorer: 'https://etherscan.io/address/',
  },
  Arbitrum: {
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    explorer: 'https://arbiscan.io/address/',
  },
}

export interface ChainBalance {
  chain: ExtraChain
  /** ETH, in wei. */
  native: bigint
  /** USDC, in its 6-decimal units. */
  usdc: bigint
}

type Fetch = typeof fetch

async function rpc<T>(urls: string[], method: string, params: unknown[], f: Fetch): Promise<T> {
  let last: unknown = new Error('no node')
  for (const url of urls) {
    try {
      const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6_000) })
      const j = await r.json() as { result?: T; error?: { message?: string } }
      if (j.result !== undefined) return j.result
      last = new Error(j.error?.message ?? `answered ${r.status}`)
    } catch (e) { last = e }
  }
  throw last
}

/** ETH and USDC held by `address` on `chain`. Throws when no node answers. */
export async function readChainBalance(chain: ExtraChain, address: string, f: Fetch = fetch): Promise<ChainBalance> {
  const c = EXTRA_CHAINS[chain]
  const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const [native, usdc] = await Promise.all([
    rpc<string>(c.rpcs, 'eth_getBalance', [address, 'latest'], f),
    rpc<string>(c.rpcs, 'eth_call', [{ to: c.usdc, data }, 'latest'], f),
  ])
  return { chain, native: BigInt(native), usdc: usdc === '0x' ? 0n : BigInt(usdc) }
}

/** The balance in dollars, at `ethUsd` (null when the price isn't known: then only the USDC counts). */
export function balanceUsd(b: ChainBalance, ethUsd: number | null): number {
  const usdc = Number(formatUnits(b.usdc, 6))
  return usdc + (ethUsd ? Number(formatUnits(b.native, 18)) * ethUsd : 0)
}

/** Arc's native balance (18 decimals) and its USDC ERC-20 balance (6 decimals) are one and the same money. */
export function arcUsdcSame(native18: bigint, erc6: bigint): boolean {
  return native18 / 1_000_000_000_000n === erc6
}
