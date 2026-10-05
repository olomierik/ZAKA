// Trading a four.meme coin on its curve, before it graduates (2026-10-05). four.meme's curve isn't a pool Relay can
// route through, so the trade goes to four.meme's own TokenManager2, from the trader's wallet on BNB Chain, as
// four.meme's site does. ARCDEX takes no fee on these: four.meme charges its own (about 1%).
//
// Quotes come from four.meme's helper (TokenManagerHelper3 `tryBuy` / `trySell`), which says what the manager will
// take: the BNB to send (or the USDT to approve, for a USDT-quoted coin) and the tokens out. A buy is
// `buyTokenAMAP(token, funds, minAmount)`; a sale approves exactly the tokens to the manager, then
// `sellToken(token, amount, minFunds)`. Every call is simulated from the trader before it's signed, and only
// TokenManager2 is used: a coin the helper names any other manager for (four.meme's older V1) isn't traded here.

import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hash, type Hex } from 'viem'
import { bscClient, rememberBsc } from './bsc'
import { evmApprove, evmMined, evmSend } from './across'
import { waitForAllowance } from './rpc'
import { notifyBalances } from './balances'
import type { TraderKind } from './identity'
import { FOUR, BNB_NATIVE } from '../../../api/_bscCore'
import { t as T } from './i18n'

const HELPER_ABI = parseAbi([
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
])
const MANAGER_ABI = parseAbi([
  'function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable',
  'function sellToken(address token, uint256 amount, uint256 minFunds)',
])

export class FourError extends Error {}

/** A buy quote: `funds` of the coin's quote (BNB or USDT, 18 decimals) in, `tokens` out, four.meme's `fee` included. */
export interface FourBuyQuote {
  side: 'buy'
  token: string
  quote: string
  funds: bigint
  tokens: bigint
  fee: bigint
  /** What the manager is sent: BNB as the call's value, or USDT by an exact approval. */
  value: bigint
  approval: bigint
}
/** A sale quote: `amount` of the coin in, `funds` of its quote out after four.meme's `fee`. */
export interface FourSellQuote { side: 'sell'; token: string; quote: string; amount: bigint; funds: bigint; fee: bigint }
export type FourQuote = FourBuyQuote | FourSellQuote

const isManager = (a: string) => a.toLowerCase() === FOUR.manager

export async function fourQuoteBuy(token: string, funds: bigint): Promise<FourBuyQuote> {
  const r = await bscClient.readContract({ address: FOUR.helper as Address, abi: HELPER_ABI, functionName: 'tryBuy', args: [token as Address, 0n, funds] })
  const [manager, quote, tokens, , fee, value, approval, amountFunds] = r
  if (!isManager(manager)) throw new FourError(T('This coin trades on four.meme’s older contract: trade it on four.meme.'))
  if (tokens <= 0n) throw new FourError(T('four.meme has nothing to sell for this amount: the curve may be sold out.'))
  return { side: 'buy', token: token.toLowerCase(), quote: quote.toLowerCase(), funds: amountFunds, tokens, fee, value, approval }
}

export async function fourQuoteSell(token: string, amount: bigint): Promise<FourSellQuote> {
  const r = await bscClient.readContract({ address: FOUR.helper as Address, abi: HELPER_ABI, functionName: 'trySell', args: [token as Address, amount] })
  const [manager, quote, funds, fee] = r
  if (!isManager(manager)) throw new FourError(T('This coin trades on four.meme’s older contract: trade it on four.meme.'))
  return { side: 'sell', token: token.toLowerCase(), quote: quote.toLowerCase(), amount, funds, fee }
}

/** The least a trade may deliver: the quote less `slippageBps`. */
export const fourMinOut = (q: FourQuote, slippageBps: number) => ((q.side === 'buy' ? q.tokens : q.funds) * BigInt(10_000 - slippageBps)) / 10_000n

/** The buy and sale calls, exactly as they're sent (tested byte for byte in scripts/test-bsc.ts). */
export function fourBuyCall(q: FourBuyQuote, minTokens: bigint): { to: Address; data: Hex; value: bigint } {
  return { to: FOUR.manager as Address, data: encodeFunctionData({ abi: MANAGER_ABI, functionName: 'buyTokenAMAP', args: [q.token as Address, q.funds, minTokens] }), value: q.value }
}
export function fourSellCall(q: FourSellQuote, minFunds: bigint): { to: Address; data: Hex; value: bigint } {
  return { to: FOUR.manager as Address, data: encodeFunctionData({ abi: MANAGER_ABI, functionName: 'sellToken', args: [q.token as Address, q.amount, minFunds] }), value: 0n }
}

export function fourErrorText(e: unknown): string {
  if (e instanceof FourError) return e.message
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  if (/User rejected|rejected the request|denied|cancel/i.test(m)) return T('You cancelled the transaction.')
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(m)) return T('Not enough BNB for this trade and its gas.')
  if (/Slippage|amount too small|min/i.test(m)) return T('The price moved past your slippage: check the new quote and try again.')
  return m.slice(0, 220)
}

export type FourStep = 'quote' | 'approve' | 'send' | 'done'

async function approveExact(kind: TraderKind, trader: Address, token: Address, amount: bigint, onStep: (s: FourStep, tx?: string) => void) {
  const allowance = await bscClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [trader, FOUR.manager as Address] }).catch(() => 0n)
  if (allowance >= amount) return
  const tx = await evmApprove(kind, 56, token, FOUR.manager as Address, amount)
  onStep('approve', tx)
  await evmMined(56, tx)
  await waitForAllowance(bscClient, token, trader, FOUR.manager as Address, amount)
}

async function simulateAndSend(kind: TraderKind, trader: Address, call: { to: Address; data: Hex; value: bigint }): Promise<Hash> {
  try { await bscClient.call({ account: trader, ...call }) }
  catch (e) { throw new FourError(T('The trade would fail: {why}', { why: fourErrorText(e) })) }
  const gas = await bscClient.estimateGas({ account: trader, ...call }).catch(() => null)
  return evmSend(kind, 56, { ...call, gas: gas ? (gas * 13n) / 10n : undefined })
}

/** Buy on the curve: a fresh quote for the same funds (refused if it gives `drift` less than the one shown), the USDT
 * approved exactly if the coin is USDT-quoted, the buy simulated, sent and mined. */
export async function runFourBuy(kind: TraderKind, trader: string, token: string, funds: bigint, shown: FourBuyQuote, slippageBps: number, onStep: (s: FourStep, tx?: string) => void): Promise<Hash> {
  onStep('quote')
  const q = await fourQuoteBuy(token, funds)
  if (q.tokens * 10_000n < shown.tokens * BigInt(10_000 - slippageBps)) throw new FourError(T('The price moved since your quote: check the new quote and try again.'))
  if (q.quote !== BNB_NATIVE && q.approval > 0n) await approveExact(kind, trader as Address, q.quote as Address, q.approval, onStep)
  // The minimum is from the quote shown, so a price that moved while approving can't fill worse than it allowed.
  const tx = await simulateAndSend(kind, trader as Address, fourBuyCall(q, fourMinOut(shown, slippageBps)))
  onStep('send', tx)
  await evmMined(56, tx)
  rememberBsc(trader, token)
  notifyBalances()
  onStep('done', tx)
  return tx
}

/** Sell on the curve: exactly the tokens approved to the manager, a fresh quote, the sale simulated, sent and mined. */
export async function runFourSell(kind: TraderKind, trader: string, token: string, amount: bigint, shown: FourSellQuote, slippageBps: number, onStep: (s: FourStep, tx?: string) => void): Promise<Hash> {
  onStep('quote')
  await approveExact(kind, trader as Address, token as Address, amount, onStep)
  const q = await fourQuoteSell(token, amount)
  if (q.funds * 10_000n < shown.funds * BigInt(10_000 - slippageBps)) throw new FourError(T('The price moved since your quote: check the new quote and try again.'))
  const tx = await simulateAndSend(kind, trader as Address, fourSellCall(q, fourMinOut(shown, slippageBps)))
  onStep('send', tx)
  await evmMined(56, tx)
  notifyBalances()
  onStep('done', tx)
  return tx
}
