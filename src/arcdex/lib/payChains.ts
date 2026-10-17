// Paying from Ethereum, Base or Arbitrum (owner, 2026-10-16: "the limitation of having to be on Arc to trade"). USDC or
// ETH there buys a coin on Arc, BNB Chain or Robinhood Chain in one signature on the chain the money is on, through
// Relay (lib/relayQuote.ts `xevm`); the coin lands at the same address on the coin's chain about a second later. No
// bridge first, and no switching the wallet to Arc.
//
// Relay's depository is the same contract at the same address on these chains as on Arc (0x4cd0…bc31: same code size
// on all four, checked 2026-10-16): USDC is approved for exactly the amount to it and deposited (depositErc20), ETH is
// deposited with the call (depositNative), and lib/relayQuote.ts checks both word by word.

import { createPublicClient, erc20Abi, fallback, formatUnits, http, type Address, type Chain, type PublicClient } from 'viem'
import { arbitrum, base, mainnet } from 'viem/chains'

export interface PayChain {
  id: number
  chain: Chain
  name: string
  /** Native USDC (Circle's) on the chain. */
  usdc: Address
  rpcs: string[]
  explorer: string
  /** ETH a payment keeps back for its own gas. */
  gasKeepEth: number
}

export const PAY_CHAINS: PayChain[] = [
  { id: base.id, chain: base, name: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], explorer: 'https://basescan.org', gasKeepEth: 0.0002 },
  { id: arbitrum.id, chain: arbitrum, name: 'Arbitrum', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], explorer: 'https://arbiscan.io', gasKeepEth: 0.0002 },
  { id: mainnet.id, chain: mainnet, name: 'Ethereum', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], explorer: 'https://etherscan.io', gasKeepEth: 0.002 },
]
export const PAY_CHAIN_IDS = PAY_CHAINS.map(c => c.id)
export const payChain = (id: number): PayChain | undefined => PAY_CHAINS.find(c => c.id === id)
export const isPayChain = (id: number) => PAY_CHAIN_IDS.includes(id)

const clients = new Map<number, PublicClient>()
/** A reader for a pay chain: its public nodes, the next one when a node fails. */
export function payClient(id: number): PublicClient {
  let c = clients.get(id)
  if (!c) {
    const p = payChain(id)
    if (!p) throw new Error(`not a pay chain: ${id}`)
    c = createPublicClient({ chain: p.chain, transport: fallback(p.rpcs.map(u => http(u, { timeout: 8_000 }))) }) as PublicClient
    clients.set(id, c)
  }
  return c
}

export const payTx = (id: number, hash: string) => `${payChain(id)?.explorer ?? ''}/tx/${hash}`

export interface PayBalance { chainId: number; usdc: bigint; eth: bigint }

/** USDC and ETH held at `owner` on a pay chain. */
export async function payBalance(id: number, owner: string): Promise<PayBalance> {
  const c = payClient(id), p = payChain(id)!
  const [usdc, eth] = await Promise.all([
    c.readContract({ address: p.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] }),
    c.getBalance({ address: owner as Address }),
  ])
  return { chainId: id, usdc, eth }
}

/** The pay chain with the most USDC at `owner` (ETH valued at `ethUsd`), so the form opens on the money the trader has. */
export function richest(bals: PayBalance[], ethUsd: number): PayBalance | null {
  let best: PayBalance | null = null, bestUsd = 0
  for (const b of bals) {
    const usd = Number(formatUnits(b.usdc, 6)) + Number(formatUnits(b.eth, 18)) * ethUsd
    if (usd > bestUsd) { best = b; bestUsd = usd }
  }
  return best
}
