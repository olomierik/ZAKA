// Moving USDC between Arc and a Hyperliquid account through Relay (https://api.relay.link), checked like every other
// Relay route on ARCDEX before anything is signed (lib/relayQuote.ts), and sent the way Relay's own SDK sends it
// (relay-kit packages/sdk/src/utils/hyperliquid.ts, read 2026-10-11).
//
// - Deposit (Arc → Hyperliquid): signed on Arc, USDC paying the gas. An approval of exactly the amount to Relay's
//   depository, then its depositErc20; the USDC lands in the account's perps balance about a second later.
//   Measured 2026-10-11: $10 in, $9.975 out.
// - Withdraw (Hyperliquid → Arc): two signatures by the account's own wallet (an agent can't move money). Relay's
//   authorization (EIP-712 "RelayNonceMapping", posted to Relay with the signature as a query parameter), then a
//   Hyperliquid sendAsset of exactly the amount to Relay's Hyperliquid depository, posted to Hyperliquid; USDC is paid
//   on Arc to the same address. Measured: $10 → $9.977.
// Neither carries an ARCDEX fee: ARCDEX earns on trades (the builder fee), not on getting money in and out.
//
// A quote is refused unless it is exactly what was asked: the same account on both sides, the currencies and the
// amount, Relay's own contracts (its /chains: the Arc depository, and protocol.v2's Hyperliquid depository), an approval
// of exactly the amount, and fees that leave at least 97% of the money.

import { erc20Abi, type Address, type Hex } from 'viem'
import { getAccount, switchChain } from 'wagmi/actions'
import { wagmiConfig } from '../wagmi'
import { RELAY_API, RELAY_ARC_DEPOSITORY, ARC_ID, relayStatus } from '../lib/relayQuote'
import { FundingError, quoteDeposit, quoteWithdraw } from './fundingQuote'
import { ARC_USDC } from '../lib/acrossQuote'
import { evmApprove, evmMined, evmReader, evmSend } from '../lib/across'
import { waitForAllowance } from '../lib/rpc'
import { notifyBalances } from '../lib/balances'
import type { TraderKind } from '../lib/identity'
import { hlExchange } from './client'
import { splitSignature, type TypedDataSigner } from './signing'
import type { HlAccess } from './access'

export type FundingStep = 'quote' | 'approve' | 'sign' | 'send' | 'deliver' | 'done'

async function follow(id: string, onStep: (s: FundingStep, tx?: string) => void): Promise<'filled' | 'refunded' | 'failed' | 'pending'> {
  onStep('deliver')
  const until = Date.now() + 10 * 60_000
  for (let i = 0; ; i++) {
    const s = await relayStatus(id).catch(() => null)
    if (s && s.status !== 'pending') { notifyBalances(); if (s.status === 'filled') onStep('done', s.outTx ?? undefined); return s.status }
    if (Date.now() > until) return 'pending'
    await new Promise(r => setTimeout(r, i < 20 ? 1_500 : 5_000))
  }
}

/** Arc USDC → the Hyperliquid account. Paid from the trading wallet (no pop-ups) or the connected wallet. */
export async function runDeposit(kind: TraderKind, user: string, usd: number, onStep: (s: FundingStep, tx?: string) => void): Promise<'filled' | 'refunded' | 'failed' | 'pending'> {
  onStep('quote')
  let q = await quoteDeposit(user, usd)
  const amount6 = BigInt(Math.floor(usd * 1e6))
  const reader = evmReader(ARC_ID)
  const allowance = await reader.readContract({ address: ARC_USDC as Address, abi: erc20Abi, functionName: 'allowance', args: [user as Address, RELAY_ARC_DEPOSITORY as Address] }).catch(() => 0n)
  if (allowance < amount6) {
    const tx = await evmApprove(kind, ARC_ID, ARC_USDC as Address, RELAY_ARC_DEPOSITORY as Address, amount6)
    onStep('approve', tx)
    await evmMined(ARC_ID, tx)
    await waitForAllowance(reader, ARC_USDC as Address, user as Address, RELAY_ARC_DEPOSITORY as Address, amount6)
    q = await quoteDeposit(user, usd)
  }
  const dep = q.raw.steps!.find(s => s.id === 'deposit')!.items[0].data as { to: Address; data: Hex }
  try { await reader.call({ account: user as Address, to: dep.to, data: dep.data }) }
  catch (e) { throw new FundingError(`The deposit would fail: ${(e as Error).message?.slice(0, 160)}`) }
  const tx = await evmSend(kind, ARC_ID, { to: dep.to, data: dep.data })
  onStep('send', tx)
  await evmMined(ARC_ID, tx)
  notifyBalances()
  return follow(q.id, onStep)
}

/** The Hyperliquid account → Arc USDC, signed by the account's own wallet. */
export async function runWithdraw(a: HlAccess, usd: number, onStep: (s: FundingStep, tx?: string) => void): Promise<'filled' | 'refunded' | 'failed' | 'pending'> {
  onStep('quote')
  const q = await quoteWithdraw(a.user, usd)
  const steps = q.raw.steps!
  const auth = steps[0].items[0].data as { sign: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; value: Record<string, unknown> }; post: { endpoint: string; method: string; body: unknown } }
  const dep = steps[1].items[0].data as { action: { type: string; parameters: Record<string, unknown> }; eip712Types: Record<string, { name: string; type: string }[]>; eip712PrimaryType: string }
  // A browser wallet signs typed data only for the chain it is on: Relay's authorization names Ethereum (chain 1).
  const switched = a.kind === 'external' && getAccount(wagmiConfig).chainId !== 1
  if (switched) await switchChain(wagmiConfig, { chainId: 1 })
  try {
    onStep('sign')
    const signer: TypedDataSigner = a.main
    const authSig = await signer.signTypedData({
      domain: auth.sign.domain as never, types: auth.sign.types, primaryType: auth.sign.primaryType, message: auth.sign.value,
    })
    const posted = await fetch(`${RELAY_API}${auth.post.endpoint}?signature=${authSig}`, { method: auth.post.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(auth.post.body) })
    if (!posted.ok) throw new FundingError('Relay didn’t accept the authorization.')
    const chainId = a.kind === 'external' ? (getAccount(wagmiConfig).chainId ?? 1) : 0x66eee
    const nonce = Number(dep.action.parameters.nonce)
    const action: Record<string, unknown> = { ...dep.action.parameters, type: dep.action.type, signatureChainId: `0x${chainId.toString(16)}` }
    const sig = await signer.signTypedData({
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: dep.eip712Types, primaryType: dep.eip712PrimaryType,
      message: { ...action, nonce: BigInt(nonce) },
    })
    onStep('send')
    await hlExchange({ action, nonce, signature: splitSignature(sig) })
  } finally {
    if (switched) await switchChain(wagmiConfig, { chainId: ARC_ID }).catch(() => {})
  }
  return follow(q.id, onStep)
}
