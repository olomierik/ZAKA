// What the wallet holds on each chain beside Arc, for Portfolio's wallets card: the chain's own coin (ETH, BNB) and its
// dollar tokens (owner, 2026-10-18: "I sent one USDG to the wallet but it doesn't show; read balances from all the chains
// we support, all networks by default"). The trading wallet's EVM address is the same on every EVM chain, so these are
// the same account's. Read with plain JSON-RPC from public nodes, one after another on failure, each with a timeout,
// so a slow node can't hold the card. (Solana is read by lib/solana.ts; Arc by the cash and coin readers.)
//
// Amounts are kept in base units (bigint) and turned into numbers only for display. Dollar tokens count at $1. On Arc,
// USDC is both the ERC-20 at 0x3600… (6 decimals) and the native balance (18 decimals): the same money, read once
// (arcUsdcSame).

import { formatUnits } from 'viem'

export type ExtraChain = 'Ethereum' | 'Base' | 'Arbitrum' | 'Robinhood' | 'BNB'

export interface ChainToken { symbol: string; address: string; decimals: number; /** Shown beside the symbol. */ note?: string }
export interface ChainInfo { name: string; rpcs: string[]; native: 'ETH' | 'BNB'; tokens: ChainToken[]; explorer: string; /** The first dollar token (kept for older callers). */ usdc: string }

const chain = (name: string, rpcs: string[], native: 'ETH' | 'BNB', tokens: ChainToken[], explorer: string): ChainInfo => ({ name, rpcs, native, tokens, explorer, usdc: tokens[0].address })

export const EXTRA_CHAINS: Record<ExtraChain, ChainInfo> = {
  Robinhood: chain('Robinhood Chain', ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'], 'ETH', [
    // Paxos's Global Dollar, the USDG Robinhood Chain's coins and ARCDEX's forms use; and a second token named USDG
    // ("USDG Robinhood"), shown apart so nobody holding it thinks it's missing.
    { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
    { symbol: 'USDG', address: '0x5fc5dc8e93bb982f633101f78d8f679b5ba6d168', decimals: 6, note: 'USDG Robinhood' },
  ], 'https://robinhoodchain.blockscout.com/address/'),
  BNB: chain('BNB Chain', ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'], 'BNB', [
    { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
    { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  ], 'https://bscscan.com/address/'),
  Base: chain('Base', ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], 'ETH', [
    { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  ], 'https://basescan.org/address/'),
  Arbitrum: chain('Arbitrum', ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], 'ETH', [
    { symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  ], 'https://arbiscan.io/address/'),
  Ethereum: chain('Ethereum', ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'], 'ETH', [
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  ], 'https://etherscan.io/address/'),
}
/** Every chain the card reads, in the order it shows them. */
export const EXTRA_CHAIN_LIST: ExtraChain[] = ['Robinhood', 'BNB', 'Base', 'Arbitrum', 'Ethereum']

export interface ChainBalance {
  chain: ExtraChain
  /** The chain's own coin (ETH or BNB), in wei. */
  native: bigint
  /** The first dollar token, in its units (USDC on Ethereum, Base, Arbitrum). */
  usdc: bigint
  /** Every dollar token, in its units. */
  tokens: (ChainToken & { raw: bigint })[]
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

/** The chain's coin and every dollar token held by `address` on `chain`. Throws when no node answers. */
export async function readChainBalance(chain: ExtraChain, address: string, f: Fetch = fetch): Promise<ChainBalance> {
  const c = EXTRA_CHAINS[chain]
  const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const [native, ...raws] = await Promise.all([
    rpc<string>(c.rpcs, 'eth_getBalance', [address, 'latest'], f),
    ...c.tokens.map(t => rpc<string>(c.rpcs, 'eth_call', [{ to: t.address, data }, 'latest'], f)),
  ])
  const tokens = c.tokens.map((t, i) => ({ ...t, raw: raws[i] === '0x' ? 0n : BigInt(raws[i]) }))
  return { chain, native: BigInt(native), usdc: tokens[0].raw, tokens }
}

/** The dollar tokens held, in dollars. */
export const stableUsd = (b: Pick<ChainBalance, 'tokens'>) => b.tokens.reduce((s, t) => s + Number(formatUnits(t.raw, t.decimals)), 0)

/** The balance in dollars, its coin at `nativeUsd` (null when the price isn't known: then only the dollar tokens count). */
export function balanceUsd(b: Pick<ChainBalance, 'tokens' | 'native'>, nativeUsd: number | null): number {
  return stableUsd(b) + (nativeUsd ? Number(formatUnits(b.native, 18)) * nativeUsd : 0)
}

/** Arc's native balance (18 decimals) and its USDC ERC-20 balance (6 decimals) are one and the same money. */
export function arcUsdcSame(native18: bigint, erc6: bigint): boolean {
  return native18 / 1_000_000_000_000n === erc6
}
