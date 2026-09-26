// ── Cross-chain bridge (Circle CCTP v2 via official Bridge Kit) ────────
// Arc is CCTP v2 domain 26 in Circle's own chain definitions
// (@circle-fin/bridge-kit/chains), and a supported *destination* for
// Circle's Forwarder — so both directions work:
//
//   Arc → chain X   the user signs approve + burn on Arc; Circle's relayer
//                    mints on X (no second signature, no network switch)
//   chain X → Arc   the user signs approve + burn on X (the wallet switches
//                    to X, and adds it if it doesn't know it); the relayer
//                    mints on Arc
//
// Estimated with a throwaway wallet on 2026-09-26: Arc → Base, Base → Arc,
// Arbitrum → Arc and Arc → Ethereum all quote (see Bridge.tsx for the fees).

import { createPublicClient, createWalletClient, http, type Chain, type EIP1193Provider, type Transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { BridgeKit, type BridgeChain } from '@circle-fin/bridge-kit'
import * as Chains from '@circle-fin/bridge-kit/chains'
import { createViemAdapterFromProvider, ViemAdapter } from '@circle-fin/adapter-viem-v2'
import { getEmbeddedWalletClient, recordBroadcasts } from './embeddedWallet'
import { chainTransport } from './rpc'

/** Reads, simulations and gas estimates for the kit: lag-tolerant, because
 * the kit simulates the burn the moment the approval confirms, and a
 * trailing RPC node then reports "transfer amount exceeds allowance"
 * (lib/rpc.ts). */
const kitPublicClient = ({ chain }: { chain: Chain }) => createPublicClient({ chain, transport: chainTransport() })

export const kit = new BridgeKit()

/** Same wallet ArcDexRouter and ArcLaunchpad already send fees to — see
 * AGENTS.md. Not env-configurable: it's a fixed constant on both deployed
 * contracts, so the bridge fee matches that rather than drifting from it. */
export const PLATFORM_FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb'

/** Bridge fee: 0.5% of the transfer, bounded so it's never trivial on tiny
 * transfers or excessive on large ones — same "predictable, capped, no
 * surprises" spirit as ArcDexRouter's swap fee and ArcLaunchpad's caps. */
export const BRIDGE_FEE_BPS = 50
export const BRIDGE_FEE_MIN_USDC = 0.05
export const BRIDGE_FEE_MAX_USDC = 50

export function computeBridgeFee(amount: string): number {
  const n = parseFloat(amount)
  if (!n || n <= 0) return 0
  const fee = (n * BRIDGE_FEE_BPS) / 10_000
  return Math.min(Math.max(fee, BRIDGE_FEE_MIN_USDC), BRIDGE_FEE_MAX_USDC)
}

// Bridge Kit adds this fee ON TOP of the transfer amount (the wallet debits
// amount + fee) on the source chain and splits it 10% to Circle / 90% to our
// recipient — Circle's own mechanic. USDC only, which is all this app bridges.
kit.setCustomFeePolicy({
  computeFee: params => computeBridgeFee(params.amount).toFixed(6),
  resolveFeeRecipientAddress: () => PLATFORM_FEE_WALLET,
})

export interface BridgeChainOption { label: string; chain: BridgeChain; evm: boolean }

/** The chains offered opposite Arc (a curated subset of Circle's CCTP v2
 * mainnet chains). Solana can only receive: bridging *from* it needs a
 * Solana wallet, which this app doesn't connect. */
export const BRIDGE_CHAINS: BridgeChainOption[] = [
  { label: 'Base', chain: 'Base' as BridgeChain, evm: true },
  { label: 'Ethereum', chain: 'Ethereum' as BridgeChain, evm: true },
  { label: 'Arbitrum', chain: 'Arbitrum' as BridgeChain, evm: true },
  { label: 'Optimism', chain: 'Optimism' as BridgeChain, evm: true },
  { label: 'Polygon', chain: 'Polygon' as BridgeChain, evm: true },
  { label: 'Avalanche', chain: 'Avalanche' as BridgeChain, evm: true },
  { label: 'Linea', chain: 'Linea' as BridgeChain, evm: true },
  { label: 'Unichain', chain: 'Unichain' as BridgeChain, evm: true },
  { label: 'World Chain', chain: 'WorldChain' as BridgeChain, evm: true },
  { label: 'Sonic', chain: 'Sonic' as BridgeChain, evm: true },
  { label: 'Solana', chain: 'Solana' as BridgeChain, evm: false },
]
/** Kept for older imports: the chains USDC can be sent to from Arc. */
export const BRIDGE_DESTINATIONS = BRIDGE_CHAINS

type EvmChainDef = { chainId: number; title: string; name: string; rpcEndpoints: readonly string[]; explorerUrl: string; nativeCurrency: { name: string; symbol: string; decimals: number } }
const chainDef = (name: string) => (Chains as unknown as Record<string, EvmChainDef | undefined>)[name]

/** Puts an external wallet on `name` before it signs there: switch, or add
 * the chain first if the wallet doesn't know it (error 4902). */
export async function ensureWalletChain(provider: EIP1193Provider, name: string): Promise<void> {
  const d = chainDef(name)
  if (!d) return
  const hexId = `0x${d.chainId.toString(16)}` as const
  const current = await provider.request({ method: 'eth_chainId' }).catch(() => null)
  if (current && parseInt(String(current), 16) === d.chainId) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((e as Error).message))) throw e
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId, chainName: d.title, nativeCurrency: d.nativeCurrency,
        rpcUrls: [...d.rpcEndpoints], blockExplorerUrls: [d.explorerUrl.replace(/\/tx\/\{hash\}$/, '')],
      }],
    })
  }
}

/** Builds a Bridge Kit adapter from whatever wallet is actually connected
 * (injected, WalletConnect, Coinbase, etc.) via its own EIP-1193 provider
 * — not hardcoded to `window.ethereum`, which only exists for injected
 * wallets and would silently break WalletConnect sessions. */
export async function getBridgeAdapter(provider: EIP1193Provider) {
  return createViemAdapterFromProvider({ provider, getPublicClient: kitPublicClient } as never)
}

/** In a browser, Bridge Kit's adapter asks the wallet to switch chains
 * (`wallet_switchEthereumChain`) before every step. The trading wallet has
 * no wallet app to ask: it signs locally, and its client is already built
 * for the chain the kit wants — so the switch is answered here instead of
 * being sent to an RPC node, which rejects it ("method not supported").
 * Without this, sending from the trading wallet failed at the approve step. */
function localChainSwitch(inner: Transport): Transport {
  return (opts => {
    const t = inner(opts)
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) =>
      args.method === 'wallet_switchEthereumChain' || args.method === 'wallet_addEthereumChain'
        ? null
        : (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options)) as typeof t.request
    return { ...t, request }
  }) as Transport
}

/** The in-browser trading wallet as a Bridge Kit adapter — Arc only (it
 * holds USDC on Arc, so it can send out; it has no funds elsewhere to bring
 * in). It signs locally, like every trading-wallet trade: no pop-up. */
export function tradingWalletAdapter() {
  const account = getEmbeddedWalletClient().account
  if (!account) throw new Error('Unlock your trading wallet first')
  return new ViemAdapter({
    getPublicClient: kitPublicClient,
    getWalletClient: ({ chain }) => createWalletClient({ account, chain, transport: localChainSwitch(recordBroadcasts(chainTransport())) }),
  }, { addressContext: 'user-controlled', supportedChains: [Chains.Arc] })
}

// Quotes don't need the user's wallet: a throwaway, never-funded account
// made in this tab is enough for Bridge Kit to price a route. It never signs.
let quoteAdapterCache: ViemAdapter | null = null
function quoteAdapter() {
  if (!quoteAdapterCache) {
    const account = privateKeyToAccount(generatePrivateKey())
    quoteAdapterCache = new ViemAdapter({
      getPublicClient: ({ chain }) => createPublicClient({ chain, transport: http() }),
      getWalletClient: ({ chain }) => createWalletClient({ account, chain, transport: http() }),
    }, { addressContext: 'user-controlled', supportedChains: BRIDGE_CHAINS.filter(c => c.evm).map(c => chainDef(c.chain)).filter(Boolean).concat([Chains.Arc]) as never })
  }
  return quoteAdapterCache
}

export interface BridgeQuote {
  /** Circle's fees (forwarding the mint, fast transfer), in USDC. */
  circleUsdc: number
  /** ARCDEX's fee, in USDC — on top of the amount. */
  platformUsdc: number
  /** What leaves the wallet: amount + platform fee. */
  debitUsdc: number
  /** What arrives: amount − Circle's fees. */
  receiveUsdc: number
}

/** Fees for a route, from Circle's own estimate. */
export async function quoteBridge(from: string, to: string, amount: string): Promise<BridgeQuote> {
  const n = parseFloat(amount)
  const e = await kit.estimate({
    from: { adapter: quoteAdapter(), chain: from as BridgeChain },
    to: { chain: to as BridgeChain, recipientAddress: to === 'Solana' ? '11111111111111111111111111111111' : PLATFORM_FEE_WALLET, useForwarder: true },
    amount,
  } as never)
  const fees = (e.fees ?? []) as { type: string; amount: string | null }[]
  const circleUsdc = fees.filter(f => f.type !== 'kit').reduce((s, f) => s + (parseFloat(f.amount ?? '0') || 0), 0)
  const platformUsdc = fees.filter(f => f.type === 'kit').reduce((s, f) => s + (parseFloat(f.amount ?? '0') || 0), 0) || computeBridgeFee(amount)
  return { circleUsdc, platformUsdc, debitUsdc: n + platformUsdc, receiveUsdc: Math.max(0, n - circleUsdc) }
}
