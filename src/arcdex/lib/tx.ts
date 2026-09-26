// Sending a transaction on Arc from whoever is trading.
//
// The trading wallet signs locally (no pop-up). An external wallet is first
// put on Arc: wagmi refuses to send while the wallet sits on another chain
// ("current chain … does not match the target chain"), which is what a
// trade used to fail with when MetaMask was left on Ethereum or Base. With
// WalletConnect on a phone, the request waits in the wallet app, so a
// prompt offers to open it.

import { getAccount, switchChain, writeContract } from 'wagmi/actions'
import type { Abi, Address, Hex } from 'viem'
import { arc, wagmiConfig } from '../wagmi'
import { getEmbeddedWalletClient } from './embeddedWallet'
import { hideWalletPrompt, showWalletPrompt } from './walletPrompt'
import { t as T } from './i18n'

export interface ArcCall {
  address: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Puts the connected external wallet on Arc, adding Arc to it first if it
 * doesn't know the network. Throws if there's no wallet or the user refuses. */
export async function ensureArc(): Promise<void> {
  const { connector, chainId } = getAccount(wagmiConfig)
  if (!connector) throw new Error(T('Connect a wallet first'))
  let current = chainId
  try { current = await connector.getChainId() } catch { /* keep wagmi's view */ }
  if (current === arc.id) return
  await switchChain(wagmiConfig, { chainId: arc.id })
}

type WcProvider = { session?: { peer?: { metadata?: { name?: string; redirect?: { native?: string; universal?: string } } } } }

/** WalletConnect on a phone: show "Confirm in <wallet>" with a button that
 * opens the wallet app. Returns whether a prompt is showing. */
export async function promptWallet(): Promise<boolean> {
  const { connector } = getAccount(wagmiConfig)
  if (!connector || connector.type !== 'walletConnect' || !isPhone()) return false
  const p = (await connector.getProvider().catch(() => null)) as WcProvider | null
  const m = p?.session?.peer?.metadata
  showWalletPrompt({ walletName: m?.name || T('your wallet'), href: m?.redirect?.native || m?.redirect?.universal || null })
  return true
}

/** Sends `call` on Arc from the trading wallet (`kind === 'trading-wallet'`)
 * or the connected external wallet, and returns the transaction hash. */
export async function sendArc(kind: 'trading-wallet' | 'wallet' | null, call: ArcCall): Promise<Hex> {
  if (kind === 'trading-wallet') return getEmbeddedWalletClient().writeContract(call as never)
  await ensureArc()
  const prompted = await promptWallet()
  try {
    return await writeContract(wagmiConfig, { ...call, chainId: arc.id } as never)
  } finally {
    if (prompted) hideWalletPrompt()
  }
}

/** A failed transaction or wallet error, in words: cancelled, wrong
 * network, not enough gas — or the wallet's own message. */
export function txErrorText(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  if (/rejected|denied|cancel/i.test(m)) return T('You cancelled the transaction.')
  if (/does not match the target chain|chain ?mismatch/i.test(m)) return T('Your wallet is on another network — switch it to Arc and try again.')
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(m)) return T('Not enough USDC in this wallet for the amount plus network fee.')
  return m.split('\n')[0].slice(0, 200)
}
