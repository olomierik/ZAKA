// AVNU (docs.avnu.fi, API v3): Starknet's swap aggregator. A quote is AVNU's best route across Starknet's DEXes; the
// build is the calls the trader's wallet signs (an approval of exactly the amount to AVNU's Exchange, then its
// multi_route_swap). Both are checked here word by word before anything reaches the wallet: the tokens, the amount,
// the approval, the contract, the minimum received, who receives the coins, and the fee.

import { N_ } from '../lib/i18n'
import { AVNU_EXCHANGE, SN, SN_FEE, type SnNetwork } from './net'
import { felt, fromU256, sameFelt } from './felt'

export class AvnuError extends Error {}

export interface SnToken { address: string; symbol: string; name: string; decimals: number; logo: string | null; volumeUsd: number }

const TOKENS_KEY = 'arcdex:sn-tokens:v1'
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** AVNU's verified tokens, busiest first (kept in the browser for an hour). */
export async function avnuTokens(net: SnNetwork = 'mainnet'): Promise<SnToken[]> {
  try {
    const raw = localStorage.getItem(TOKENS_KEY)
    if (raw) { const c = JSON.parse(raw) as { at: number; net: string; list: SnToken[] }; if (c.net === net && Date.now() - c.at < 3_600_000 && c.list.length) return c.list }
  } catch { /* storage blocked */ }
  const out: SnToken[] = []
  let whole = true
  for (let page = 0; page < 5; page++) {
    let j: { content?: { address: string; symbol: string; name: string; decimals: number; logoUri?: string | null; lastDailyVolumeUsd?: number }[]; totalPages?: number }
    try {
      const r = await fetch(`${SN[net].avnu}/v1/starknet/tokens?page=${page}&size=50&tag=Verified`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new AvnuError(`AVNU answered ${r.status}`)
      j = await r.json()
      if (!Array.isArray(j.content)) throw new AvnuError('AVNU answered without a token list')
    } catch (e) {
      // A later page that fails (AVNU throttles) leaves the busiest tokens already read; the first one failing is an error.
      if (!out.length) throw e
      whole = false
      break
    }
    for (const t of j.content ?? []) {
      // A name or ticker with control characters in it (one "verified" token has one) isn't listed.
      if (!t.address || !t.symbol || !Number.isInteger(t.decimals) || CONTROL.test(t.symbol) || CONTROL.test(t.name ?? '')) continue
      out.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.logoUri ?? null, volumeUsd: t.lastDailyVolumeUsd ?? 0 })
    }
    if (page + 1 >= (j.totalPages ?? 0)) break
  }
  out.sort((a, b) => b.volumeUsd - a.volumeUsd)
  // A partial list is kept ten minutes, a whole one an hour.
  try { localStorage.setItem(TOKENS_KEY, JSON.stringify({ at: whole ? Date.now() : Date.now() - 50 * 60_000, net, list: out })) } catch { /* storage blocked */ }
  return out
}

export interface AvnuRoute { name: string; address: string; percent: number; sellTokenAddress: string; buyTokenAddress: string; routes?: AvnuRoute[] }
export interface AvnuQuote {
  quoteId: string
  sellTokenAddress: string; sellAmount: string; sellAmountInUsd?: number
  buyTokenAddress: string; buyAmount: string; buyAmountInUsd?: number
  fee: { feeToken: string; avnuFees: string; avnuFeesInUsd?: number; avnuFeesBps: string; integratorFees: string; integratorFeesInUsd?: number; integratorFeesBps: string }
  chainId: string
  expiry: number | null
  routes: AvnuRoute[]
  gasFees: string; gasFeesInUsd?: number
  /** In basis points; negative is a loss. */
  priceImpact: number
  sellTokenPriceInUsd?: number; buyTokenPriceInUsd?: number
}
export interface AvnuCall { contractAddress: string; entrypoint: string; calldata: string[] }

export interface SwapAsk { net: SnNetwork; sellToken: string; buyToken: string; sellAmount: bigint; taker: string }
type Fee = { recipient: string; bps: number } | null

export function quoteUrl(ask: SwapAsk, fee: Fee = SN_FEE): string {
  const p = new URLSearchParams({ sellTokenAddress: ask.sellToken, buyTokenAddress: ask.buyToken, sellAmount: `0x${ask.sellAmount.toString(16)}`, size: '1' })
  // Without a wallet yet, quotes still come (the build needs the trader).
  if (ask.taker) p.set('takerAddress', ask.taker)
  // The fee goes in hex: the API refuses "100" ("integratorFees must start with 0x"), though its docs show "30".
  if (fee) { p.set('integratorFees', `0x${fee.bps.toString(16)}`); p.set('integratorFeeRecipient', fee.recipient); p.set('integratorName', 'ARCDEX') }
  return `${SN[ask.net].avnu}/swap/v3/quotes?${p}`
}

/** What's wrong with a quote for this swap: nothing (null), or the first problem found. */
export function checkQuote(q: AvnuQuote, ask: SwapAsk, fee: Fee = SN_FEE): string | null {
  if (!q || typeof q.quoteId !== 'string' || !q.quoteId) return 'no quote id'
  if (!sameFelt(q.chainId, SN[ask.net].chainId)) return `quote for chain ${q.chainId}`
  if (!sameFelt(q.sellTokenAddress, ask.sellToken)) return 'sell token differs'
  if (!sameFelt(q.buyTokenAddress, ask.buyToken)) return 'buy token differs'
  if (felt(q.sellAmount) !== ask.sellAmount) return 'sell amount differs'
  if (!((felt(q.buyAmount) ?? 0n) > 0n)) return 'nothing to receive'
  if ((felt(q.fee?.integratorFeesBps) ?? -1n) !== BigInt(fee?.bps ?? 0)) return 'integrator fee differs'
  if (!Array.isArray(q.routes) || !q.routes.length) return 'no route'
  const pct = q.routes.reduce((a, r) => a + (Number(r.percent) || 0), 0)
  if (Math.abs(pct - 1) > 0.001) return 'routes don’t add up to the whole amount'
  if (!Number.isFinite(q.priceImpact)) return 'no price impact'
  return null
}

/** What's wrong with the built calls (null when they're exactly the swap asked for). The minimum received must be the
 * quote's amount less at most the slippage chosen. */
export function checkBuild(calls: AvnuCall[], q: AvnuQuote, ask: SwapAsk & { slippage: number }, fee: Fee = SN_FEE): string | null {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) return 'unexpected number of calls'
  const swap = calls[calls.length - 1]
  if (calls.length === 2) {
    const a = calls[0]
    if (!sameFelt(a.contractAddress, ask.sellToken) || a.entrypoint !== 'approve') return 'first call isn’t an approval of the sell token'
    if (a.calldata?.length !== 3 || !sameFelt(a.calldata[0], AVNU_EXCHANGE)) return 'approval isn’t to AVNU’s Exchange'
    if (fromU256(a.calldata[1], a.calldata[2]) !== ask.sellAmount) return 'approval isn’t exactly the amount'
  }
  if (!sameFelt(swap.contractAddress, AVNU_EXCHANGE) || swap.entrypoint !== 'multi_route_swap') return 'swap isn’t AVNU’s multi_route_swap'
  const c = swap.calldata ?? []
  if (c.length < 13) return 'swap calldata too short'
  if (!sameFelt(c[0], ask.sellToken) || fromU256(c[1], c[2]) !== ask.sellAmount) return 'swap sells something else'
  const buy = felt(q.buyAmount) ?? 0n
  if (!sameFelt(c[3], ask.buyToken) || fromU256(c[4], c[5]) !== buy) return 'swap buys something else'
  const min = fromU256(c[6], c[7])
  const floor = (buy * BigInt(Math.round((1 - ask.slippage) * 1_000_000))) / 1_000_000n
  if (min === null || min > buy || min + 1n < floor) return 'minimum received is below the slippage chosen'
  if (!sameFelt(c[8], ask.taker)) return 'coins go to someone else'
  if ((felt(c[9]) ?? -1n) !== BigInt(fee?.bps ?? 0)) return 'integrator fee differs'
  if (fee ? !sameFelt(c[10], fee.recipient) : (felt(c[10]) ?? -1n) !== 0n) return 'integrator fee goes elsewhere'
  if (!((felt(c[11]) ?? 0n) > 0n)) return 'no route'
  return null
}

/** Quotes a swap (AVNU's best route) and checks it. */
export async function avnuQuote(ask: SwapAsk, signal?: AbortSignal): Promise<AvnuQuote> {
  const r = await fetch(quoteUrl(ask), { signal: signal ?? AbortSignal.timeout(12_000) })
  if (!r.ok) throw new AvnuError(r.status === 429 ? N_('AVNU is busy right now: try again in a moment.') : `AVNU answered ${r.status}`)
  const list = (await r.json()) as AvnuQuote[]
  if (!Array.isArray(list) || !list.length) throw new AvnuError(N_('There’s no route for this swap right now.'))
  const bad = checkQuote(list[0], ask)
  if (bad) throw new AvnuError(`${N_('AVNU’s quote didn’t match the swap asked for')}: ${bad}`)
  return list[0]
}

/** The calls for a quote, checked. */
export async function avnuBuild(q: AvnuQuote, ask: SwapAsk & { slippage: number }): Promise<AvnuCall[]> {
  const r = await fetch(`${SN[ask.net].avnu}/swap/v3/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ quoteId: q.quoteId, takerAddress: ask.taker, slippage: ask.slippage, includeApprove: true }),
  })
  if (!r.ok) throw new AvnuError(r.status === 400 || r.status === 404 ? N_('That quote has expired: get a new one.') : `AVNU answered ${r.status}`)
  const j = (await r.json()) as { chainId?: string; calls?: AvnuCall[] }
  if (j.chainId && !sameFelt(j.chainId, SN[ask.net].chainId)) throw new AvnuError(`${N_('AVNU’s transaction didn’t match the swap asked for')}: chain ${j.chainId}`)
  const bad = checkBuild(j.calls ?? [], q, ask)
  if (bad) throw new AvnuError(`${N_('AVNU’s transaction didn’t match the swap asked for')}: ${bad}`)
  return j.calls!
}

/** Whether a quote may be traded: price impact over 50% is refused, over 15% needs a tick. */
export function swapVerdict(q: AvnuQuote): { ok: boolean; confirm: boolean; lossPct: number } {
  const lossPct = Math.max(0, -q.priceImpact / 100)
  return { ok: lossPct < 50, confirm: lossPct >= 15, lossPct }
}

/** The minimum a built swap pays out (its multi_route_swap's token_to_min_amount). */
export const minReceived = (calls: AvnuCall[]): bigint | null => {
  const c = calls[calls.length - 1]?.calldata ?? []
  return fromU256(c[6], c[7])
}

/** Each route a quote splits into, with its share: a multi-hop route is its first hop with the next ones nested in it
 * ("JediSwap → Ekubo 100%"). */
export function routeNames(routes: AvnuRoute[]): string[] {
  const chain = (r: AvnuRoute): string => (r.routes?.length ? `${r.name} → ${r.routes.map(chain).join(' + ')}` : r.name)
  return routes.map(r => `${chain(r)} ${Math.round((Number(r.percent) || 0) * 100)}%`)
}
