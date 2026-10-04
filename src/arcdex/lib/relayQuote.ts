// Quotes for trading Solana coins from Arc, through Relay (https://api.relay.link, 2026-10-04), and the checks every
// quote must pass before anything is signed. No wallet code here (lib/relay.ts sends), so the checks run offline in
// scripts/test-solana.ts.
//
//  • buy:  USDC on Arc → the coin on Solana, delivered to the buyer's Solana address. Signed on Arc (USDC pays the
//          gas): an approval of exactly the amount to Relay's depository, then its depositErc20. Relay's solver delivers
//          the coin in about a second and pays Solana's fees, the coin's token account included: no SOL needed.
//  • sell: the coin on Solana → USDC on Arc. Signed on Solana by the wallet holding it (a few cents of SOL in fees):
//          Relay's instructions swap it (DFlow or Jupiter) and deposit the USDC with Relay, which pays it out on Arc.
//  • gas:  a little USDC on Arc → SOL on Solana, for selling later.
//
// ARCDEX's fee is Relay's app fee: 2% (the swap router's feeBps) of what goes in, accrued for the fee wallet
// 0x2742…86Bb as a USDC balance at Relay and claimed from there (Relay pays app fees out on a claim, signed by that
// wallet; https://docs.relay.link/features/app-fees). The gas top-up carries no fee.
//
// A quote is refused unless it's exactly the trade asked for: the buyer and the Solana address, the coin, the amount,
// Relay's own depository on Arc (approved for exactly the amount), and for a sale only the programs a sale uses
// (`SOL_PROGRAMS`), signed by the seller alone, with Relay's memo naming the quote.

import { decodeFunctionData, erc20Abi, formatUnits, type Hex } from 'viem'
import { FEE_WALLET } from './platform'
import { ARC_USDC, QUOTE_LIMITS, quoteVerdict, type QuoteValue, type QuoteVerdict } from './acrossQuote'
import { t as T } from './i18n'

export const RELAY_API = 'https://api.relay.link'
export const ARC_ID = 5042
/** Relay's id for Solana. */
export const SOLANA_ID = 792703809
/** Relay's name for native SOL. */
export const SOL_NATIVE = '11111111111111111111111111111111'
/** Relay's depository on Arc: takes buys' USDC (checked 2026-10-04). */
export const RELAY_ARC_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
/** depositErc20(address depositor, address token, uint256 amount, bytes32 id). */
const DEPOSIT_SELECTOR = '0xe8017952'

/** The only programs a sale's transaction may call: Solana's token accounts, the swap aggregators Relay routes
 * through (DFlow, Jupiter), Relay's depository, and the memo naming the quote. Plus the system's own. */
export const SOL_PROGRAMS = new Set([
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated token accounts
  'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', // DFlow
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr', // Relay's depository on Solana
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // memo
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])
export const RELAY_SOL_DEPOSITORY = 'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

export type RelaySide = 'buy' | 'sell' | 'gas'

export interface RelayRequest {
  side: RelaySide
  /** The coin on Solana (its mint; unused for gas). */
  mint: string
  /** What goes in, in its smallest units: USDC (6 decimals) for a buy or gas, the coin for a sale. */
  amount: bigint
  /** The trader on Arc: pays a buy, is paid a sale. */
  evm: string
  /** The trader on Solana: receives a buy, signs a sale. */
  sol: string
  /** ARCDEX's fee in basis points (200); 0 for gas. */
  feeBps: number
}

export interface SolInstruction { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }

export interface RelayQuote {
  /** Relay's request id: what its status and memo name. */
  id: string
  side: RelaySide
  mint: string
  evm: string
  sol: string
  inputAmount: bigint
  expectedOut: bigint
  minOut: bigint
  outDecimals: number
  outSymbol: string
  /** ARCDEX's fee and Relay's own (its relayer and the other chain's gas), in dollars. */
  appFeeUsd: number
  relayFeeUsd: number
  /** Seconds Relay expects delivery to take. */
  fillSeconds: number
  /** Arc's side (buys and gas): the approval it needs (null when none) and the deposit. */
  evmTx: { approve: { to: Hex; data: Hex } | null; deposit: { to: Hex; data: Hex } } | null
  /** Solana's side (sales): the instructions to sign and the lookup tables they use. */
  solTx: { instructions: SolInstruction[]; lookupTables: string[] } | null
}

export class RelayError extends Error {}

const lc = (v: unknown) => String(v ?? '').toLowerCase()
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')) } catch { return 0n } }
const word = (data: string, i: number) => data.slice(10 + 64 * i, 10 + 64 * (i + 1))

/** The request Relay's /quote takes. */
export function quoteBody(r: RelayRequest): Record<string, unknown> {
  const buyLike = r.side !== 'sell'
  return {
    user: buyLike ? r.evm : r.sol,
    recipient: buyLike ? r.sol : r.evm,
    originChainId: buyLike ? ARC_ID : SOLANA_ID,
    destinationChainId: buyLike ? SOLANA_ID : ARC_ID,
    originCurrency: buyLike ? ARC_USDC : r.mint,
    destinationCurrency: r.side === 'gas' ? SOL_NATIVE : buyLike ? r.mint : ARC_USDC,
    amount: r.amount.toString(),
    tradeType: 'EXACT_INPUT',
    ...(r.side !== 'gas' && r.feeBps > 0 ? { appFees: [{ recipient: FEE_WALLET, fee: String(r.feeBps) }] } : {}),
  }
}

interface ApiCurrency { currency?: { chainId?: number; address?: string; decimals?: number; symbol?: string }; amount?: string; amountUsd?: string; minimumAmount?: string }
interface ApiStep { id?: string; kind?: string; requestId?: string; items?: { data?: Record<string, unknown> }[] }
interface ApiQuote {
  steps?: ApiStep[]
  fees?: Record<string, ApiCurrency | undefined>
  details?: { sender?: string; recipient?: string; currencyIn?: ApiCurrency; currencyOut?: ApiCurrency; timeEstimate?: number }
  message?: string
  errorCode?: string
}

function fail(why: string): never {
  throw new RelayError(T('This quote didn’t pass ARCDEX’s checks ({why}), so nothing was sent.', { why }))
}

/** Checks a Relay answer against what was asked for, and returns it as a quote. Throws `RelayError` on anything
 * unexpected. */
export function checkRelayQuote(r: RelayRequest, j: ApiQuote): RelayQuote {
  const buyLike = r.side !== 'sell'
  const d = j.details
  const cin = d?.currencyIn, cout = d?.currencyOut
  const steps = j.steps ?? []
  const outAddr = r.side === 'gas' ? SOL_NATIVE : buyLike ? r.mint : ARC_USDC
  if (!d || !cin?.currency || !cout?.currency || !steps.length) fail('Relay sent no trade')
  if (buyLike) {
    if (lc(d.sender) !== lc(r.evm)) fail('the trade isn’t from you')
    if (d.recipient !== r.sol) fail('the trade goes to another Solana address')
    if (Number(cin.currency.chainId) !== ARC_ID || lc(cin.currency.address) !== ARC_USDC) fail('the quote spends another token')
    if (Number(cout.currency.chainId) !== SOLANA_ID || cout.currency.address !== outAddr) fail('the quote delivers another token')
  } else {
    if (d.sender !== r.sol) fail('the sale isn’t from your Solana wallet')
    if (lc(d.recipient) !== lc(r.evm)) fail('the sale pays another address')
    if (Number(cin.currency.chainId) !== SOLANA_ID || cin.currency.address !== r.mint) fail('the quote sells another coin')
    if (Number(cout.currency.chainId) !== ARC_ID || lc(cout.currency.address) !== ARC_USDC) fail('the sale isn’t paid in USDC on Arc')
  }
  if (big(cin.amount) !== r.amount) fail('the quote spends another amount')
  const expectedOut = big(cout.amount), minOut = big(cout.minimumAmount)
  if (minOut <= 0n || expectedOut < minOut) fail('the quote has no minimum received')

  const app = j.fees?.app
  const appFee = big(app?.amount)
  if (r.side === 'gas' && appFee !== 0n) fail('a fee on gas')
  if (r.side === 'buy' && r.feeBps > 0) {
    // A buy's fee is taken in Arc USDC: its share of what goes in.
    const want = (r.amount * BigInt(r.feeBps)) / 10_000n
    if (Number(app?.currency?.chainId) !== ARC_ID || appFee < want - 1n || appFee > want + 1n) fail('the fee isn’t ARCDEX’s')
  }
  if (r.side === 'sell' && r.feeBps > 0 && appFee <= 0n) fail('the fee isn’t ARCDEX’s')

  const ids = new Set(steps.map(s => s.requestId).filter(Boolean))
  if (ids.size !== 1) fail('the quote names no single request')
  const id = String([...ids][0])

  let evmTx: RelayQuote['evmTx'] = null, solTx: RelayQuote['solTx'] = null
  if (buyLike) {
    let approve: { to: Hex; data: Hex } | null = null, deposit: { to: Hex; data: Hex } | null = null
    for (const s of steps) {
      if (s.id !== 'approve' && s.id !== 'deposit') fail(`an unexpected step (${s.id ?? '?'})`)
      if (s.kind !== 'transaction' || (s.items?.length ?? 0) !== 1) fail('an unexpected step')
      const x = s.items![0].data ?? {}
      if (Number(x.chainId) !== ARC_ID) fail('a transaction for another chain')
      if (big(x.value) !== 0n) fail('the transaction would send native funds')
      const to = lc(x.to) as Hex, data = lc(x.data) as Hex
      if (s.id === 'approve') {
        if (to !== ARC_USDC) fail('the approval is for another token')
        const a = (() => { try { return decodeFunctionData({ abi: erc20Abi, data }) } catch { return null } })()
        if (!a || a.functionName !== 'approve') fail('an unexpected approval')
        const [spender, amount] = a.args as readonly [string, bigint]
        if (lc(spender) !== RELAY_ARC_DEPOSITORY) fail('the approval is for a contract ARCDEX doesn’t know')
        if (amount !== r.amount) fail('the approval isn’t for exactly the amount')
        approve = { to, data }
      } else {
        if (to !== RELAY_ARC_DEPOSITORY) fail('the deposit goes to a contract ARCDEX doesn’t know')
        if (!data.startsWith(DEPOSIT_SELECTOR) || data.length !== 10 + 64 * 4) fail('an unexpected deposit')
        if (`0x${word(data, 0).slice(24)}` !== lc(r.evm)) fail('the deposit isn’t from you')
        if (`0x${word(data, 1).slice(24)}` !== ARC_USDC) fail('the deposit isn’t USDC')
        if (BigInt(`0x${word(data, 2)}`) !== r.amount) fail('the deposit isn’t the amount asked for')
        deposit = { to, data }
      }
    }
    if (!deposit) fail('the quote has no deposit')
    evmTx = { approve, deposit }
  } else {
    if (steps.length !== 1 || steps[0].id !== 'deposit' || steps[0].kind !== 'transaction' || (steps[0].items?.length ?? 0) !== 1) fail('an unexpected step')
    const x = steps[0].items![0].data as { instructions?: SolInstruction[]; addressLookupTableAddresses?: string[] }
    const ins = x.instructions ?? []
    if (!ins.length) fail('the sale has no instructions')
    for (const i of ins) {
      if (!SOL_PROGRAMS.has(i.programId)) fail(`a program ARCDEX doesn’t know (${i.programId.slice(0, 6)}…)`)
      for (const k of i.keys) if (k.isSigner && k.pubkey !== r.sol) fail('the sale needs another signer')
      if (!/^[0-9a-f]*$/i.test(i.data)) fail('the sale’s instructions can’t be read')
    }
    if (!ins.some(i => i.programId === RELAY_SOL_DEPOSITORY)) fail('the sale isn’t deposited with Relay')
    const memo = ins.find(i => i.programId === MEMO)
    const memoText = memo ? decodeHexAscii(memo.data) : ''
    if (lc(memoText) !== lc(id)) fail('the sale’s memo names another request')
    solTx = { instructions: ins, lookupTables: (x.addressLookupTableAddresses ?? []).filter(a => typeof a === 'string') }
  }

  const usd = (k: string) => parseFloat(String(j.fees?.[k]?.amountUsd ?? '0')) || 0
  return {
    id, side: r.side, mint: r.mint, evm: lc(r.evm), sol: r.sol,
    inputAmount: r.amount, expectedOut, minOut,
    outDecimals: Number(cout.currency.decimals ?? (buyLike ? 6 : 6)),
    outSymbol: String(cout.currency.symbol ?? ''),
    appFeeUsd: usd('app'),
    relayFeeUsd: usd('relayer'),
    fillSeconds: Number(d.timeEstimate ?? 0) || 0,
    evmTx, solTx,
  }
}

function decodeHexAscii(h: string): string {
  let s = ''
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16))
  return s
}

// ── what a quote is worth (the same guard as Robinhood Chain's: lib/acrossQuote.ts) ──

/** A quote valued at the coin's market price. `input` is what's paid: dollars for a buy, coins for a sale. */
export function relayValue(q: Pick<RelayQuote, 'side' | 'expectedOut' | 'outDecimals' | 'appFeeUsd' | 'relayFeeUsd'>, input: number, priceUsd: number): QuoteValue | null {
  if (q.side === 'gas' || !(priceUsd > 0) || !(input > 0)) return null
  const out = Number(formatUnits(q.expectedOut, q.outDecimals))
  if (q.side === 'buy') {
    const swapIn = input - q.appFeeUsd - q.relayFeeUsd
    if (!(swapIn > 0)) return null
    const rate = (out * priceUsd) / swapIn
    return { rate, impact: 1 - rate, cost: 1 - (out * priceUsd) / input }
  }
  const worth = input * priceUsd
  const rate = (out + q.appFeeUsd + q.relayFeeUsd) / worth
  return { rate, impact: 1 - rate, cost: 1 - out / worth }
}

export { QUOTE_LIMITS, quoteVerdict, type QuoteVerdict }

/** Relay's own reasons, in words a trader can act on. */
export function relayErrorText(code: string | undefined, message: string | undefined): string {
  const m = `${code ?? ''} ${message ?? ''}`
  if (/NO_SWAP_ROUTES_FOUND|no routes/i.test(m)) return T('Relay can’t route this coin right now: it may have too little liquidity, or a token setup Relay doesn’t trade.')
  if (/AMOUNT_TOO_LOW|too low|too small/i.test(m)) return T('This amount is below what Relay can route: try a little more.')
  if (/INSUFFICIENT_LIQUIDITY|liquidity/i.test(m)) return T('Not enough liquidity for this amount right now: try less.')
  if (/INSUFFICIENT_FUNDS|insufficient/i.test(m)) return T('Not enough balance for this trade.')
  return message ? message.slice(0, 200) : T('Relay couldn’t quote this trade.')
}

/** A checked quote for `r`. Never cached: Relay's quotes follow the market. */
export async function getRelayQuote(r: RelayRequest, signal?: AbortSignal): Promise<RelayQuote> {
  const res = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteBody(r)), signal: signal ?? AbortSignal.timeout(20_000) })
  let j: ApiQuote
  try { j = await res.json() as ApiQuote } catch { throw new RelayError(T('Relay couldn’t quote this trade.')) }
  if (!res.ok || !j.steps) throw new RelayError(relayErrorText(j.errorCode, j.message))
  return checkRelayQuote(r, j)
}

export type RelayStatus = 'pending' | 'filled' | 'refunded' | 'failed'

/** Where a request stands at Relay, and the delivery's transaction once there is one. */
export async function relayStatus(id: string): Promise<{ status: RelayStatus; outTx: string | null }> {
  const res = await fetch(`${RELAY_API}/intents/status/v3?requestId=${id}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const j = await res.json().catch(() => ({})) as { status?: string; txHashes?: string[] }
  const s = j.status === 'success' ? 'filled' : j.status === 'refund' ? 'refunded' : j.status === 'failure' ? 'failed' : 'pending'
  return { status: s, outTx: j.txHashes?.[0] ?? null }
}
