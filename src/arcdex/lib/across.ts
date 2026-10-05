// Sending a Robinhood Chain trade through Across (quotes and their checks:
// lib/acrossQuote.ts), from the trading wallet (signs here, no pop-ups) or
// the connected wallet (put on the right chain first, as lib/tx.ts does for Arc).
//
// Every trade: a fresh checked quote → an approval of exactly the amount, if
// the allowance is short → a fresh quote again (the approval took a moment)
// → the exact transaction simulated from the trader → sent → mined → then
// Across's fill on the other chain, followed until it lands or is refunded.

import { erc20Abi, type Address, type Hash, type Hex } from 'viem'
import { getAccount, sendTransaction, switchChain, writeContract } from 'wagmi/actions'
import { arc, wagmiConfig } from '../wagmi'
import { client as arcClient } from '../api/launchpad'
import { getEmbeddedWalletClient, getEmbeddedWalletClientOn, recordBroadcasts } from './embeddedWallet'
import { ensureArc, promptWallet, txErrorText } from './tx'
import { hideWalletPrompt } from './walletPrompt'
import { chainTransport, waitForAllowance } from './rpc'
import { waitForReceipt } from './receipts'
import { notifyBalances } from './balances'
import { isContractCode, rememberRh, rhClient, RH_RPC, robinhood } from './robinhood'
import { bscClient, bscWallet } from './bsc'
import type { TraderKind } from './identity'
import { AcrossError, ARC_ID, depositStatus, getAcrossQuote, QUOTE_LIMITS, RH_ID, type AcrossQuote, type FillStatus, type QuoteRequest } from './acrossQuote'
import { t as T } from './i18n'

export { AcrossError }

const readerOf = (chainId: number) => (chainId === RH_ID ? rhClient : chainId === 56 ? bscClient : arcClient)

/** Puts the connected external wallet on `chainId`, adding Robinhood Chain to it first if it doesn't know it. */
async function ensureChain(chainId: number): Promise<void> {
  if (chainId === ARC_ID) return ensureArc()
  const { connector, chainId: current0 } = getAccount(wagmiConfig)
  if (!connector) throw new Error(T('Connect a wallet first'))
  let current = current0
  try { current = await connector.getChainId() } catch { /* keep wagmi's view */ }
  if (current !== chainId) await switchChain(wagmiConfig, { chainId: chainId as typeof robinhood.id })
}

const rhWallet = () => getEmbeddedWalletClientOn(robinhood, recordBroadcasts(chainTransport(RH_RPC)))

async function sendRaw(kind: TraderKind, chainId: number, tx: { to: Address; data: Hex; gas?: bigint; value?: bigint }): Promise<Hash> {
  const req = { to: tx.to, data: tx.data, value: tx.value ?? 0n, ...(tx.gas ? { gas: tx.gas } : {}) }
  if (kind === 'trading-wallet') return chainId === RH_ID ? rhWallet().sendTransaction(req) : chainId === 56 ? bscWallet().sendTransaction(req) : getEmbeddedWalletClient().sendTransaction(req)
  await ensureChain(chainId)
  const prompted = await promptWallet()
  try { return await sendTransaction(wagmiConfig, { ...req, chainId: chainId as typeof arc.id }) }
  finally { if (prompted) hideWalletPrompt() }
}

async function approve(kind: TraderKind, chainId: number, token: Address, spender: Address, amount: bigint): Promise<Hash> {
  const call = { address: token, abi: erc20Abi, functionName: 'approve' as const, args: [spender, amount] as const }
  if (kind === 'trading-wallet') return chainId === RH_ID ? rhWallet().writeContract(call) : chainId === 56 ? bscWallet().writeContract(call) : getEmbeddedWalletClient().writeContract(call)
  await ensureChain(chainId)
  const prompted = await promptWallet()
  try { return await writeContract(wagmiConfig, { ...call, chainId: chainId as typeof arc.id }) }
  finally { if (prompted) hideWalletPrompt() }
}

async function mined(chainId: number, hash: Hash): Promise<void> {
  const r = chainId === RH_ID
    ? await rhClient.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 180_000 })
    : chainId === 56
      ? await bscClient.waitForTransactionReceipt({ hash, pollingInterval: 750, timeout: 180_000 })
      : await waitForReceipt(hash)
  if (r.status !== 'success') throw new AcrossError(T('The transaction failed on-chain.'))
}

/** A failed step in words: Robinhood Chain's gas is ETH, not USDC. */
export function acrossErrorText(e: unknown, chainId?: number): string {
  if (e instanceof AcrossError) return e.message
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  if (chainId === RH_ID && /insufficient funds|exceeds the balance|gas required exceeds/i.test(m)) return T('Not enough ETH on Robinhood Chain for gas: add gas first.')
  return txErrorText(e)
}

export type AcrossStep = 'quote' | 'approve' | 'send' | 'bridge' | 'done'

export interface AcrossProgress {
  step: AcrossStep
  approveTx?: Hash
  depositTx?: Hash
  /** The fill on the other chain. */
  fillTx?: string | null
}

export interface AcrossResult {
  quote: AcrossQuote
  depositTx: Hash
  status: FillStatus
  fillTx: string | null
  refundTx: string | null
}

/** Whether `trader` is a contract wallet on Arc: a buy delivers to the same
 * address on Robinhood Chain, where that contract may not exist. */
export async function isContractWallet(trader: string): Promise<boolean> {
  const code = await arcClient.getCode({ address: trader as Address }).catch(() => undefined)
  return isContractCode(code)
}

/** How far the price may move between the quote shown and the one signed. */
const DRIFT = 0.03

/**
 * Runs one trade end to end. `shown` is the quote the trader agreed to: a
 * fresh quote that would deliver over 3% less stops the trade, so they see
 * the new one first. So does one delivering over 25% more: Across's route
 * changed, maybe to an off-market pool (acrossQuote.ts `quoteValue`). Resolves once Across has filled (or refunded) it, or
 * after 15 minutes with the status then (a late fill still lands by itself).
 * `approveExtra`: USDC the next trade will spend right after this one (a
 * buy's gas top-up), approved together, so it takes one approval, not two.
 */
export async function runAcross(kind: TraderKind, req: QuoteRequest, shown: AcrossQuote | null, onStep: (p: AcrossProgress) => void,
  { approveExtra = 0n }: { approveExtra?: bigint } = {}): Promise<AcrossResult> {
  const chainId = req.side === 'sell' ? RH_ID : ARC_ID
  const trader = req.trader as Address
  if (kind === 'wallet' && req.side !== 'sell' && await isContractWallet(trader)) {
    throw new AcrossError(T('A contract wallet may not exist at the same address on Robinhood Chain: use your trading wallet or an ordinary wallet.'))
  }
  if (req.side === 'sell') {
    const eth = await rhClient.getBalance({ address: trader }).catch(() => null)
    if (eth === 0n) throw new AcrossError(T('Not enough ETH on Robinhood Chain for gas: add gas first.'))
  }
  const fresh = async () => {
    const q = await getAcrossQuote(req)
    if (shown && Number(q.expectedOut) < Number(shown.expectedOut) * (1 - DRIFT)) {
      throw new AcrossError(T('The price moved since your quote: check the new quote and try again.'))
    }
    if (shown && Number(q.expectedOut) > Number(shown.expectedOut) * (1 + QUOTE_LIMITS.offMarket)) {
      throw new AcrossError(T('Across’s route changed since your quote: check the new quote and try again.'))
    }
    return q
  }

  onStep({ step: 'quote' })
  let q = await fresh()
  let approveTx: Hash | undefined
  if (q.allowance < q.inputAmount) {
    approveTx = await approve(kind, chainId, q.inputToken as Address, q.spender as Address, q.inputAmount + approveExtra)
    onStep({ step: 'approve', approveTx })
    await mined(chainId, approveTx)
    await waitForAllowance(readerOf(chainId), q.inputToken as Address, trader, q.spender as Address, q.inputAmount + approveExtra)
    q = await fresh()
  }

  // The exact transaction, from the trader, before anything is signed.
  const reader = readerOf(chainId)
  try { await reader.call({ account: trader, to: q.tx.to, data: q.tx.data, value: 0n }) }
  catch (e) { throw new AcrossError(T('The trade would fail: {why}', { why: acrossErrorText(e, chainId) })) }
  const est = await reader.estimateGas({ account: trader, to: q.tx.to, data: q.tx.data, value: 0n }).catch(() => q.tx.gas)
  const gas = est ? (est * 13n) / 10n : undefined

  const depositTx = await sendRaw(kind, chainId, { to: q.tx.to, data: q.tx.data, gas })
  onStep({ step: 'send', approveTx, depositTx })
  await mined(chainId, depositTx)
  notifyBalances()
  if (req.side === 'buy') rememberRh(trader, req.token)
  onStep({ step: 'bridge', approveTx, depositTx })

  const until = Date.now() + 15 * 60_000
  for (let i = 0; ; i++) {
    const s = await depositStatus(depositTx).catch(() => null)
    if (s && s.status !== 'pending') {
      notifyBalances()
      if (s.status === 'filled') onStep({ step: 'done', approveTx, depositTx, fillTx: s.fillTx })
      return { quote: q, depositTx, status: s.status, fillTx: s.fillTx, refundTx: s.refundTx }
    }
    if (Date.now() > until) return { quote: q, depositTx, status: 'pending', fillTx: null, refundTx: null }
    await new Promise(r => setTimeout(r, i < 30 ? 2_000 : 6_000))
  }
}

/** Arc's side of a Solana trade (lib/relay.ts) is sent the same way: an exact approval, the transaction, its receipt. */
export { approve as evmApprove, sendRaw as evmSend, mined as evmMined, readerOf as evmReader }
