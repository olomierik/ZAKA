// Quotes for trading Robinhood Chain coins from Arc, through Across's Swap
// API (https://app.across.to/api/swap/approval), and the checks every quote
// must pass before anything is signed. No wallet code here (lib/across.ts
// sends), so the checks run offline in scripts/test-robinhood.ts.
//
//  • buy:  USDC on Arc → the coin on Robinhood Chain, at the same address.
//          Signed on Arc (USDC pays the gas): SpokePool.deposit, then Across's
//          relayer fills it on Robinhood Chain and swaps there (~2–10s).
//  • sell: the coin on Robinhood Chain → USDC on Arc. Signed on Robinhood
//          Chain (ETH pays the gas): SpokePoolPeriphery.swapAndBridge.
//  • gas:  a little USDC on Arc → ETH on Robinhood Chain, for selling later.
//
// ARCSENSE's fee is Across's `appFee`, taken from what the trade delivers and
// sent to the fee wallet in the same fill: a buy's in the coin (on Robinhood
// Chain), a sale's in USDC (on Arc). The gas top-up carries no fee.
//
// A quote is refused unless its transaction is exactly the trade asked for:
// the contract Across publishes for that chain, the trader as depositor, the
// token and amount asked for, the right destination, and a recipient that is
// the trader or Across's own handler (whose instructions name the trader and,
// with a fee, the fee wallet). Approvals are always for the exact amount, so
// nothing beyond the trade can move.

import { decodeFunctionData, formatUnits, parseAbi, type Address, type Hex } from 'viem'
import { FEE_WALLET } from './platform'
import { t as T } from './i18n'

export const ACROSS_API = 'https://app.across.to/api'
export const ARC_ID = 5042
export const RH_ID = 4663
export const ARC_USDC = '0x3600000000000000000000000000000000000000'
const ZERO = '0x0000000000000000000000000000000000000000'

/** Across's contracts that take ARCSENSE's deposits (Across's deployments, checked 2026-10-04). */
export const ACROSS_TARGETS = {
  /** SpokePool on Arc: buys and gas top-ups. */
  [ARC_ID]: '0x9b4a302a548c7e313c2b74c461db7b84d3074a84',
  /** SpokePoolPeriphery on Robinhood Chain: sales (swap, then bridge). */
  [RH_ID]: '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4',
} as Record<number, string>

/** Across's MulticallHandler on each destination: it receives a fill that
 * has instructions (the swap, the fee, the transfer to the trader). */
export const ACROSS_HANDLERS = {
  [RH_ID]: '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd',
  [ARC_ID]: '0xa07480456c4ebad7626e4fdf4a180709e238547b',
} as Record<number, string>

export const ACROSS_ABI = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'struct Fees { uint256 amount; address recipient; }',
  'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
  'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
  'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
])

export type AcrossSide = 'buy' | 'sell' | 'gas'

export interface QuoteRequest {
  side: AcrossSide
  /** The coin on Robinhood Chain (unused for gas). */
  token: string
  /** What goes in, in the input token's smallest units (USDC: 6 decimals). */
  amount: bigint
  trader: string
  /** ARCSENSE's fee in basis points (the swap router's, 200); 0 for gas. */
  feeBps: number
}

export interface AcrossQuote {
  id: string
  side: AcrossSide
  token: string
  trader: string
  /** The chain the transaction is signed on. */
  chainId: number
  inputToken: string
  inputAmount: bigint
  expectedOut: bigint
  /** The least the trade can deliver: below it, Across refunds. */
  minOut: bigint
  outDecimals: number
  outSymbol: string
  /** ARCSENSE's fee, in the output token. */
  appFee: bigint
  /** Across's bridge fee and destination gas, in dollars. */
  bridgeFeeUsd: number
  /** The slippage Across set for its swap (0.05 = 5%). */
  slippage: number
  /** Who must be allowed to take `inputAmount` of `inputToken`. */
  spender: string
  /** The allowance the trader already gave it. */
  allowance: bigint
  tx: { to: Address; data: Hex; gas: bigint | null }
  /** Seconds Across expects the fill to take. */
  fillSeconds: number
  /** When the quote stops being honoured (ms). */
  expiresAt: number
}

export class AcrossError extends Error {}

const lc = (v: unknown) => String(v ?? '').toLowerCase()
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')) } catch { return 0n } }
const fromWord = (w: string) => `0x${w.toLowerCase().slice(-40)}`
const hasWord = (w: string) => /^0x0{24}[0-9a-f]{40}$/.test(w.toLowerCase())

const INTEGRATOR = (() => {
  const v = String((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ACROSS_INTEGRATOR_ID ?? '').trim()
  return /^0x[0-9a-f]{4}$/i.test(v) ? v : null
})()

/** The Swap API's query for a request. */
export function quoteUrl(r: QuoteRequest): string {
  const buyLike = r.side !== 'sell'
  const q = new URLSearchParams({
    tradeType: 'exactInput',
    amount: r.amount.toString(),
    inputToken: buyLike ? ARC_USDC : r.token,
    outputToken: r.side === 'gas' ? ZERO : buyLike ? r.token : ARC_USDC,
    originChainId: String(buyLike ? ARC_ID : RH_ID),
    destinationChainId: String(buyLike ? RH_ID : ARC_ID),
    depositor: r.trader,
    recipient: r.trader,
    // A buy that can't fill comes back as USDC on Arc, not as USDG on
    // Robinhood Chain (where a new trader has no gas to move it).
    ...(buyLike ? { refundOnOrigin: 'true' } : {}),
    slippage: 'auto',
  })
  if (r.side !== 'gas' && r.feeBps > 0) {
    q.set('appFee', String(r.feeBps / 10_000))
    q.set('appFeeRecipient', FEE_WALLET)
  }
  if (INTEGRATOR) q.set('integratorId', INTEGRATOR)
  return `${ACROSS_API}/swap/approval?${q}`
}

/** Off once the site's /across proxy said it has no key, or isn't there (local dev): Across directly from then on. */
let proxyOff = false

/** Across, through the site's own /across (netlify/edge-functions/across.ts), which adds
 * ARCSENSE's API key (Across rate-limits requests without one); else Across directly. */
async function acrossFetch(path: string, signal?: AbortSignal): Promise<Response> {
  if (typeof window !== 'undefined' && !proxyOff) {
    try {
      const r = await fetch(`/across${path}`, { signal, cache: 'no-store' })
      if (r.headers.get('x-arcsense-across') === 'key') return r
      // No key yet (503), or no proxy at all (the app's HTML): stop asking it.
      if (r.status === 503 || !(r.headers.get('content-type') ?? '').includes('json')) proxyOff = true
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  return fetch(`${ACROSS_API}${path}`, { signal, cache: 'no-store' })
}

interface ApiToken { address?: string; chainId?: number; decimals?: number; symbol?: string }
interface ApiQuote {
  id?: string
  crossSwapType?: string
  checks?: { allowance?: { token?: string; spender?: string; actual?: string } }
  steps?: { originSwap?: { slippage?: number }; destinationSwap?: { slippage?: number } }
  inputToken?: ApiToken
  outputToken?: ApiToken
  inputAmount?: string
  expectedOutputAmount?: string
  minOutputAmount?: string
  fees?: { total?: { details?: { app?: { amount?: string }; bridge?: { amountUsd?: string } } } }
  swapTx?: { chainId?: number; to?: string; data?: string; gas?: string; value?: string }
  expectedFillTime?: number
  quoteExpiryTimestamp?: number
  code?: string
  message?: string
}

function fail(why: string): never {
  throw new AcrossError(T('This quote didn’t pass ARCSENSE’s checks ({why}), so nothing was sent.', { why }))
}

/** Checks a Swap API answer against what was asked for, and returns it as a
 * quote. Throws `AcrossError` (with the reason) on anything unexpected. */
export function checkQuote(r: QuoteRequest, j: ApiQuote): AcrossQuote {
  const buyLike = r.side !== 'sell'
  const chainId = buyLike ? ARC_ID : RH_ID
  const dest = buyLike ? RH_ID : ARC_ID
  const trader = lc(r.trader)
  const token = lc(r.token)
  const inputToken = buyLike ? ARC_USDC : token
  const outputToken = r.side === 'gas' ? ZERO : buyLike ? token : ARC_USDC
  const tx = j.swapTx
  const target = ACROSS_TARGETS[chainId]

  if (!tx?.data || !tx.to) fail('Across sent no transaction')
  if (Number(tx.chainId) !== chainId) fail('the transaction is for another chain')
  if (lc(tx.to) !== target) fail('the transaction goes to a contract ARCSENSE doesn’t know')
  if (big(tx.value) !== 0n) fail('the transaction would send native funds')
  if (j.crossSwapType !== (buyLike ? 'bridgeableToAny' : 'anyToBridgeable')) fail(`an unexpected route (${j.crossSwapType ?? '?'})`)
  if (lc(j.inputToken?.address) !== inputToken || Number(j.inputToken?.chainId) !== chainId) fail('the quote spends another token')
  if (lc(j.outputToken?.address) !== outputToken || Number(j.outputToken?.chainId) !== dest) fail('the quote delivers another token')
  if (big(j.inputAmount) !== r.amount) fail('the quote spends another amount')
  if (lc(j.checks?.allowance?.spender) !== target || lc(j.checks?.allowance?.token) !== inputToken) fail('the quote asks to approve another contract or token')

  const decoded = (() => { try { return decodeFunctionData({ abi: ACROSS_ABI, data: tx.data as Hex }) } catch { return null } })()
  if (!decoded) fail('the transaction can’t be read')
  const handler = ACROSS_HANDLERS[dest]
  let recipient: string
  if (buyLike) {
    if (decoded.functionName !== 'deposit') fail('an unexpected transaction')
    const [depositor, to, inTok, , inAmount, , destChain] = decoded.args as readonly [Hex, Hex, Hex, Hex, bigint, bigint, bigint, ...unknown[]]
    if (!hasWord(depositor) || fromWord(depositor) !== trader) fail('the deposit isn’t from you')
    if (fromWord(inTok) !== ARC_USDC || inAmount !== r.amount) fail('the deposit isn’t the amount asked for')
    if (destChain !== BigInt(dest)) fail('the deposit goes to another chain')
    recipient = hasWord(to) ? fromWord(to) : ''
  } else {
    if (decoded.functionName !== 'swapAndBridge') fail('an unexpected transaction')
    const s = decoded.args[0] as {
      depositData: { depositor: string; outputToken: Hex; recipient: Hex; destinationChainId: bigint }
      swapToken: string; swapTokenAmount: bigint
    }
    if (lc(s.swapToken) !== token || s.swapTokenAmount !== r.amount) fail('the sale isn’t the coin and amount asked for')
    if (lc(s.depositData.depositor) !== trader) fail('the sale isn’t from you')
    if (fromWord(s.depositData.outputToken) !== ARC_USDC || s.depositData.destinationChainId !== BigInt(dest)) fail('the sale isn’t paid in USDC on Arc')
    recipient = hasWord(s.depositData.recipient) ? fromWord(s.depositData.recipient) : ''
  }
  // Delivered straight to the trader, or to Across's handler, whose
  // instructions must then name the trader (and the fee wallet, for a fee).
  const data = lc(tx.data)
  if (recipient !== trader) {
    if (recipient !== handler) fail('the trade is delivered to an address ARCSENSE doesn’t know')
    if (data.split(trader.slice(2)).length - 1 < 2) fail('the trade’s instructions don’t pay you')
  }
  const appFee = big(j.fees?.total?.details?.app?.amount)
  if (r.side !== 'gas' && r.feeBps > 0 && !data.includes(FEE_WALLET.slice(2))) fail('the fee doesn’t go to ARCSENSE')
  if (r.side === 'gas' && appFee !== 0n) fail('a fee on gas')
  const minOut = big(j.minOutputAmount)
  const expectedOut = big(j.expectedOutputAmount)
  if (minOut <= 0n || expectedOut < minOut) fail('the quote has no minimum received')

  const gas = big(tx.gas)
  return {
    id: String(j.id ?? ''),
    side: r.side,
    token,
    trader,
    chainId,
    inputToken,
    inputAmount: r.amount,
    expectedOut,
    minOut,
    outDecimals: Number(j.outputToken?.decimals ?? 18),
    outSymbol: String(j.outputToken?.symbol ?? ''),
    appFee,
    bridgeFeeUsd: parseFloat(String(j.fees?.total?.details?.bridge?.amountUsd ?? '0')) || 0,
    slippage: Number(j.steps?.destinationSwap?.slippage ?? j.steps?.originSwap?.slippage ?? 0) || 0,
    spender: target,
    allowance: big(j.checks?.allowance?.actual),
    tx: { to: tx.to as Address, data: tx.data as Hex, gas: gas > 0n ? gas : null },
    fillSeconds: Number(j.expectedFillTime ?? 0) || 0,
    expiresAt: (Number(j.quoteExpiryTimestamp ?? 0) || 0) * 1000,
  }
}

// ── what a quote is worth ────────────────────────────────────────────────
//
// Across picks its own route on Robinhood Chain, and a coin's pools there can
// include traps: pools with a 20–90% fee priced hundreds of times off the
// market (SHRINU / USDG 20%, 2026-10-04). A $25 buy routed through one quoted
// "771M SHRINU ≈ $5.4K" and a $7 sale quoted $0.01. So every quote is valued
// at the coin's market price (its busiest real pool, api/robinhoodMarket.ts)
// before it can be sent.

export interface QuoteValue {
  /** What the swap delivered (before ARCSENSE's fee and after the bridge's) as a share of its market value: 1 is the market price. */
  rate: number
  /** Price impact: what the swap lost against the market price (0.03 = 3%; negative = better than the market). */
  impact: number
  /** Everything: fees, bridge and price impact, as a share of what's paid (negative = better than the market). */
  cost: number
}

/** A quote valued at the coin's market price. `input` is what's paid: dollars
 * for a buy, coins for a sale. Null without a price (or for the gas top-up). */
export function quoteValue(q: Pick<AcrossQuote, 'side' | 'expectedOut' | 'appFee' | 'outDecimals' | 'bridgeFeeUsd'>, input: number, priceUsd: number): QuoteValue | null {
  if (q.side === 'gas' || !(priceUsd > 0) || !(input > 0)) return null
  const out = Number(formatUnits(q.expectedOut, q.outDecimals))
  const fee = Number(formatUnits(q.appFee, q.outDecimals))
  if (q.side === 'buy') {
    // The bridge's fee comes off the USDC before the swap on Robinhood Chain.
    const swapIn = input - q.bridgeFeeUsd
    if (!(swapIn > 0)) return null
    const rate = ((out + fee) * priceUsd) / swapIn
    return { rate, impact: 1 - rate, cost: 1 - (out * priceUsd) / input }
  }
  // A sale swaps first, then bridges (its fee comes off the proceeds).
  const worth = input * priceUsd
  const rate = (out + fee + q.bridgeFeeUsd) / worth
  return { rate, impact: 1 - rate, cost: 1 - out / worth }
}

/** Where a quote stops: a tick box from 15% (impact or all costs), refused
 * from 50% of price impact, and refused when it pays over 25% more than the
 * market price (a route through an off-market pool, however good it looks). */
export const QUOTE_LIMITS = { confirm: 0.15, refuse: 0.5, offMarket: 0.25 }

export type QuoteVerdict = 'ok' | 'confirm' | 'refuse' | 'off-market' | 'unpriced'

export function quoteVerdict(v: QuoteValue | null): QuoteVerdict {
  if (!v) return 'unpriced'
  if (v.rate > 1 + QUOTE_LIMITS.offMarket) return 'off-market'
  if (v.impact >= QUOTE_LIMITS.refuse) return 'refuse'
  if (v.impact >= QUOTE_LIMITS.confirm || v.cost >= QUOTE_LIMITS.confirm) return 'confirm'
  return 'ok'
}

/** Across's own reasons, in words a trader can act on. */
export function acrossErrorText(code: string | undefined, message: string | undefined): string {
  const m = message ?? ''
  if (/amount too low|too small/i.test(m) || code === 'AMOUNT_TOO_LOW') return T('This amount is below what Across can route: try a little more.')
  if (/amount too high|not enough liquidity|insufficient liquidity/i.test(m) || code === 'AMOUNT_TOO_HIGH') return T('Not enough liquidity for this amount right now: try less.')
  if (/no route|not supported|unsupported|tokenDetails|NO_ROUTE/i.test(m + ' ' + (code ?? ''))) return T('Across can’t route this coin right now.')
  return m ? m.slice(0, 200) : T('Across couldn’t quote this trade.')
}

/** A checked quote for `r`. Never cached: Across's quotes follow each block. */
export async function getAcrossQuote(r: QuoteRequest, signal?: AbortSignal): Promise<AcrossQuote> {
  const res = await acrossFetch(quoteUrl(r).slice(ACROSS_API.length), signal)
  let j: ApiQuote
  try { j = await res.json() as ApiQuote } catch { throw new AcrossError(T('Across couldn’t quote this trade.')) }
  if (!res.ok || !j.swapTx) throw new AcrossError(acrossErrorText(j.code, j.message))
  return checkQuote(r, j)
}

export type FillStatus = 'pending' | 'filled' | 'refunded' | 'expired'

export interface DepositStatus { status: FillStatus; fillTx: string | null; refundTx: string | null }

/** Where a deposit stands (Across's indexer; "not found" for its first seconds). */
export async function depositStatus(depositTx: string): Promise<DepositStatus> {
  const res = await acrossFetch(`/deposit/status?depositTxnRef=${depositTx}`)
  const j = await res.json().catch(() => ({})) as { status?: string; fillTx?: string | null; depositRefundTxHash?: string | null }
  const s = j.status === 'filled' ? 'filled' : j.status === 'refunded' ? 'refunded' : j.status === 'expired' ? 'expired' : 'pending'
  return { status: s, fillTx: j.fillTx ?? null, refundTx: j.depositRefundTxHash ?? null }
}

export const integratorId = () => INTEGRATOR
