// Quotes for moving USDC between Arc and a Hyperliquid account through Relay, and the checks each must pass before
// anything is signed (lib/relayQuote.ts's rules). No wallet code here (funding.ts sends), so the checks run offline in
// scripts/test-hyperliquid.ts. See funding.ts for the two routes and what was measured.

import { decodeFunctionData, erc20Abi, formatUnits, parseAbi, type Hex } from 'viem'
import { RELAY_API, RELAY_ARC_DEPOSITORY, ARC_ID } from '../lib/relayQuote'
import { ARC_USDC } from '../lib/acrossQuote'
import { HL_MAINNET } from './client'

export const HL_RELAY_ID = 1337
/** Relay's name for Hyperliquid's USDC (perps balance), 8 decimals there. */
export const HL_RELAY_USDC = '0x00000000000000000000000000000000'
/** Hyperliquid's USDC token, as sendAsset names it. */
export const HL_USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054'
/** Relay's Hyperliquid depository (its /chains protocol.v2, checked 2026-10-11): where a withdrawal's sendAsset goes. */
export const RELAY_HL_DEPOSITORY = '0x66cf0aace1b4e562593bec10ec7868fba9932224'
/** At least this share of the money must arrive. */
const MIN_RECEIVED = 0.97

export class FundingError extends Error {}

const DEPOSIT_ABI = parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)'])

interface ApiStepItem { data?: Record<string, unknown> }
interface ApiStep { id: string; kind: string; requestId?: string; items: ApiStepItem[] }
interface ApiQuote {
  steps?: ApiStep[]
  details?: {
    recipient?: string
    timeEstimate?: number
    currencyIn?: { amount: string; amountUsd?: string; currency: { chainId: number; address: string; decimals: number } }
    currencyOut?: { amount: string; amountUsd?: string; minimumAmount?: string; currency: { chainId: number; address: string; decimals: number } }
  }
  fees?: Record<string, { amountUsd?: string } | undefined>
  message?: string
  protocol?: { v2?: RelayOrder }
}

/** Relay's v2 order: what its solver pays out, and to whom it refunds. The deposit (or authorization) funds it by id. */
interface RelayOrder {
  orderId?: string
  orderData?: {
    inputs?: { payment?: { chainId?: string; currency?: string; amount?: string }; refunds?: { chainId?: string; recipient?: string; currency?: string }[] }[]
    output?: { chainId?: string; payments?: { recipient?: string; currency?: string; minimumAmount?: string }[]; calls?: unknown[] }
  }
  paymentDetails?: { chainId?: string; depository?: string; currency?: string; amount?: string }
}

export interface FundingQuote {
  direction: 'in' | 'out'
  user: string
  id: string
  /** Dollars going in and arriving. */
  inUsd: number
  outUsd: number
  feeUsd: number
  seconds: number
  raw: ApiQuote
}

async function relayQuote(body: Record<string, unknown>, signal?: AbortSignal): Promise<ApiQuote> {
  const r = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20_000) })
  const j = (await r.json().catch(() => ({}))) as ApiQuote
  if (!r.ok || !j.steps) throw new FundingError(j.message ? `Relay: ${j.message}` : 'Relay couldn’t quote this transfer.')
  return j
}

const lower = (s: unknown) => String(s ?? '').toLowerCase()

/** The order the money funds: paid in exactly the amount to Relay's depository on the chain it leaves, paying only
 * the account (in USDC, on the other chain, with no calls of its own), refunding only to the account. Returns its id. */
function checkOrder(o: RelayOrder | undefined, user: string, from: { chain: string; depository: string; currency: string; amount: bigint }, to: { chain: string; currency: string }, fail: (why: string) => never): string {
  const od = o?.orderData
  if (!o?.orderId || !od?.output) fail('no order')
  const pd = o!.paymentDetails
  if (pd?.chainId !== from.chain || lower(pd.depository) !== lower(from.depository) || lower(pd.currency) !== lower(from.currency) || BigInt(pd.amount ?? '-1') !== from.amount) fail('what the order is paid with')
  const out = od!.output!
  if (out.chainId !== to.chain || !out.payments?.length) fail('where the order pays')
  for (const p of out.payments!) if (lower(p.recipient) !== lower(user) || lower(p.currency) !== lower(to.currency)) fail('whom the order pays')
  if ((out.calls ?? []).length) fail('the order makes calls')
  for (const i of od!.inputs ?? []) for (const r of i.refunds ?? []) if (lower(r.recipient) !== lower(user)) fail('whom the order refunds')
  return lower(o!.orderId)
}

/** The checks a deposit quote must pass (exported for scripts/test-hyperliquid.ts). */
export function checkDeposit(user: string, amount6: bigint, j: ApiQuote): FundingQuote {
  const d = j.details
  const steps = j.steps ?? []
  const fail = (why: string): never => { throw new FundingError(`Relay’s quote doesn’t match this deposit (${why}).`) }
  if (!d?.currencyIn || !d.currencyOut) fail('no details')
  if (d!.currencyIn!.currency.chainId !== ARC_ID || lower(d!.currencyIn!.currency.address) !== lower(ARC_USDC) || BigInt(d!.currencyIn!.amount) !== amount6) fail('what goes in')
  if (d!.currencyOut!.currency.chainId !== HL_RELAY_ID || lower(d!.currencyOut!.currency.address) !== HL_RELAY_USDC) fail('what comes out')
  if (lower(d!.recipient) !== lower(user)) fail('who receives it')
  const deposit = steps.find(s => s.id === 'deposit')
  const id = deposit?.requestId
  if (!deposit || !id || steps.some(s => s.id !== 'deposit' && s.id !== 'approve')) fail('the steps')
  const orderId = checkOrder(j.protocol?.v2, user, { chain: 'arc', depository: RELAY_ARC_DEPOSITORY, currency: ARC_USDC, amount: amount6 }, { chain: 'hyperliquid', currency: HL_RELAY_USDC }, fail)
  for (const s of steps) for (const it of s.items) {
    const tx = it.data as { to?: string; data?: Hex; value?: string } | undefined
    if (!tx?.to || !tx.data) fail('a step without a transaction')
    if (BigInt(tx!.value ?? '0') !== 0n) fail('native value')
    if (s.id === 'approve') {
      if (lower(tx!.to) !== lower(ARC_USDC)) fail('the approval’s token')
      const a = decodeFunctionData({ abi: erc20Abi, data: tx!.data! })
      if (a.functionName !== 'approve' || lower(a.args[0]) !== RELAY_ARC_DEPOSITORY || a.args[1] !== amount6) fail('the approval')
    } else {
      if (lower(tx!.to) !== RELAY_ARC_DEPOSITORY) fail('the depository')
      const c = decodeFunctionData({ abi: DEPOSIT_ABI, data: tx!.data! })
      if (lower(c.args[0]) !== lower(user) || lower(c.args[1]) !== lower(ARC_USDC) || c.args[2] !== amount6 || lower(c.args[3]) !== orderId) fail('the deposit’s arguments')
    }
  }
  const inUsd = Number(formatUnits(amount6, 6))
  const outUsd = Number(formatUnits(BigInt(d!.currencyOut!.amount), d!.currencyOut!.currency.decimals))
  if (outUsd < inUsd * MIN_RECEIVED) fail('fees over 3%')
  return { direction: 'in', user, id: id!, inUsd, outUsd, feeUsd: Math.max(0, inUsd - outUsd), seconds: d!.timeEstimate ?? 0, raw: j }
}

/** The checks a withdrawal quote must pass. `amount8` is in Hyperliquid's 8-decimal USDC. */
export function checkWithdraw(user: string, amount8: bigint, j: ApiQuote): FundingQuote {
  const d = j.details
  const steps = j.steps ?? []
  const fail = (why: string): never => { throw new FundingError(`Relay’s quote doesn’t match this withdrawal (${why}).`) }
  if (!d?.currencyIn || !d.currencyOut) fail('no details')
  if (d!.currencyIn!.currency.chainId !== HL_RELAY_ID || lower(d!.currencyIn!.currency.address) !== HL_RELAY_USDC || BigInt(d!.currencyIn!.amount) !== amount8) fail('what goes in')
  if (d!.currencyOut!.currency.chainId !== ARC_ID || lower(d!.currencyOut!.currency.address) !== lower(ARC_USDC)) fail('what comes out')
  if (lower(d!.recipient) !== lower(user)) fail('who receives it')
  if (steps.length !== 2 || steps[0].id !== 'authorize' || steps[1].id !== 'deposit') fail('the steps')
  const auth = steps[0].items[0]?.data as { sign?: { domain?: { name?: string }; primaryType?: string; value?: Record<string, unknown> }; post?: { endpoint?: string; method?: string } } | undefined
  const dep = steps[1].items[0]?.data as { action?: { type?: string; parameters?: Record<string, unknown> }; nonce?: number } | undefined
  const id = steps[1].requestId ?? steps[0].requestId
  if (!id) fail('no request')
  const orderId = checkOrder(j.protocol?.v2, user, { chain: 'hyperliquid', depository: RELAY_HL_DEPOSITORY, currency: HL_RELAY_USDC, amount: amount8 }, { chain: 'arc', currency: ARC_USDC }, fail)
  if (!auth?.sign?.value || auth.sign.domain?.name !== 'RelayNonceMapping' || auth.sign.primaryType !== 'NonceMapping' || auth.post?.endpoint !== '/authorize') fail('the authorization')
  const v = auth!.sign!.value!
  if (v.chainId !== 'hyperliquid' || lower(v.wallet) !== lower(user) || lower(v.depositor) !== lower(user) || lower(v.id) !== orderId) fail('what the authorization names')
  const p = dep?.action?.parameters
  if (dep?.action?.type !== 'sendAsset' || !p) fail('the transfer')
  if (lower(p!.destination) !== RELAY_HL_DEPOSITORY || p!.sourceDex !== '' || p!.destinationDex !== '' || p!.token !== HL_USDC_TOKEN || p!.fromSubAccount !== '') fail('where the transfer goes')
  if (p!.hyperliquidChain !== (HL_MAINNET ? 'Mainnet' : 'Testnet')) fail('the network')
  if (Math.round(Number(p!.amount) * 1e8) !== Number(amount8)) fail('the amount')
  if (Number(p!.nonce) !== Number(v.nonce) || Number(dep!.nonce) !== Number(v.nonce)) fail('the nonces')
  const inUsd = Number(formatUnits(amount8, 8))
  const outUsd = Number(formatUnits(BigInt(d!.currencyOut!.amount), d!.currencyOut!.currency.decimals))
  if (outUsd < inUsd * MIN_RECEIVED) fail('fees over 3%')
  return { direction: 'out', user, id: id!, inUsd, outUsd, feeUsd: Math.max(0, inUsd - outUsd), seconds: d!.timeEstimate ?? 0, raw: j }
}

export async function quoteDeposit(user: string, usd: number, signal?: AbortSignal): Promise<FundingQuote> {
  const amount6 = BigInt(Math.floor(usd * 1e6))
  const j = await relayQuote({ user, recipient: user, originChainId: ARC_ID, destinationChainId: HL_RELAY_ID, originCurrency: ARC_USDC, destinationCurrency: HL_RELAY_USDC, amount: amount6.toString(), tradeType: 'EXACT_INPUT' }, signal)
  return checkDeposit(user, amount6, j)
}

export async function quoteWithdraw(user: string, usd: number, signal?: AbortSignal): Promise<FundingQuote> {
  const amount8 = BigInt(Math.floor(usd * 1e6)) * 100n // whole cents of a cent: 6 decimals, in 8-decimal units
  const j = await relayQuote({ user, recipient: user, originChainId: HL_RELAY_ID, destinationChainId: ARC_ID, originCurrency: HL_RELAY_USDC, destinationCurrency: ARC_USDC, amount: amount8.toString(), tradeType: 'EXACT_INPUT' }, signal)
  return checkWithdraw(user, amount8, j)
}

