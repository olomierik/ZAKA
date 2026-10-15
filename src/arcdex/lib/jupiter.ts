// Solana swaps through Jupiter's Swap API V2 (2026-10-15; the build pack's Phase 2: "Solana (Jupiter Swap API V2 + Jito)").
//
// Checked against Jupiter's own OpenAPI spec (github.com/jup-ag/docs, openapi-spec/swap/v2/swap.yaml) and its
// referral docs: `GET /swap/v2/order` quotes and builds the transaction, the trader signs it, `POST /swap/v2/execute`
// lands it (Jupiter's own landing pipeline, with priority fees and Jito tips set by Jupiter), confirms it and retries.
// The same signed transaction and request id can be sent again for two minutes without running twice, so a lost answer
// is retried, never re-quoted and re-signed.
//
// ARCDEX's fee is Jupiter's referral fee: `referralAccount` (VITE_JUP_REFERRAL_ACCOUNT, created on Jupiter's Ultra
// referral project) and `referralFee` 50 (0.5%, SPOT_FEE_BPS). Jupiter keeps 20% of it and takes no platform fee of
// its own; the rest is paid in the same transaction into the referral account's token account for the fee's mint
// (Jupiter picks the mint: SOL, then stablecoins, …). A mint without that token account falls back to Jupiter's
// platform fee, and ARCDEX takes nothing on that trade.
//
// Requests go through the site's own edge function (netlify/edge-functions/jupiter.ts), which holds the API key. With
// no key there it answers 503, and Solana swaps go through Relay as before.
//
// Before the trader signs, ARCDEX checks:
//   • the order: the mints, the amount and the taker asked for; a minimum received within the slippage ceiling
//     (lib/guardrails.ts); Jupiter's price impact; the fee: ARCDEX's referral account and rate, or none;
//   • the transaction: the taker signs it; its fee payer is the taker or the gas sponsor the order names; when the order
//     says ARCDEX's fee applies, ARCDEX's referral token account is in it; no token approval or authority change on
//     the taker's accounts;
//   • a simulation on Solana's node: it must succeed, the taker's input may fall by at most the amount (SOL: plus
//     0.01 for fees), and the output must rise by at least the minimum received.

import type { VersionedTransaction, PublicKey as PublicKeyT } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { SPOT_FEE_BPS } from './platform'
import { GUARDRAILS, minOutProblem, sizeProblem, driftProblem } from './guardrails'
import { primaryOf } from './rpcSettings'
import { signSolana, type SolSigner } from './solanaWallet'
import { solRpc, rememberSol } from './solana'
import { notifyBalances } from './balances'
import { assertTradingOn } from './tradeSwitch'
import { t as T } from './i18n'

export const WSOL = 'So11111111111111111111111111111111111111112'
/** Relay names native SOL like this; Jupiter takes wSOL's mint for SOL. */
const SOL_NATIVE = '11111111111111111111111111111111'
export const JUP_PROGRAMS = {
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  /** Jupiter's referral program (github.com/TeamRaccoons/referral, packages/sdk/src/constant.ts). */
  referral: 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3',
} as const
/** The most SOL a swap may cost beyond the SOL it puts in: its fees, and a token account now and then. */
export const MAX_SOL_COST = 10_000_000n

const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

/** The referral account from the environment value, or null when it isn't a Solana address. */
export function referralFrom(raw: string | undefined): string | null {
  const v = String(raw ?? '').trim()
  return SOL_ADDRESS.test(v) ? v : null
}
/** ARCDEX's referral account on Jupiter's Ultra referral project. Without one, swaps go through Jupiter with no fee. */
export const JUP_REFERRAL = referralFrom(env.VITE_JUP_REFERRAL_ACCOUNT)
/** ARCDEX's fee on Jupiter swaps: the spot fee, within Jupiter's 50–255 bps referral range. */
export const JUP_FEE_BPS = Math.min(255, Math.max(50, SPOT_FEE_BPS))

export class JupiterError extends Error {}
/** Jupiter isn't reachable through the site (no key, throttled, down): the form asks Relay instead. */
export class JupiterUnavailable extends JupiterError {}

export interface JupAsk {
  /** Mints (SOL as wSOL's mint or Relay's native address: both mean SOL). */
  inputMint: string
  outputMint: string
  /** In the input mint's smallest units. */
  amount: bigint
  /** The wallet that signs; null for a quote only. */
  taker: string | null
  outDecimals: number
  slippageBps?: number
}

export interface JupOrder {
  provider: 'jupiter'
  requestId: string
  inputMint: string
  outputMint: string
  inputAmount: bigint
  expectedOut: bigint
  minOut: bigint
  outDecimals: number
  slippageBps: number
  /** Jupiter's own price impact, as a fraction (0.01 = 1% worse). */
  impact: number | null
  inUsd: number
  outUsdRelay: number
  /** The whole fee rate the trader pays, and ARCDEX's part of it (0 when it didn't apply). */
  feeBps: number
  arcdexFeeBps: number
  feeMint: string | null
  /** ARCDEX's fee in dollars (the share the trader pays, before Jupiter keeps its 20%), and nothing else for the form. */
  appFeeUsd: number
  relayFeeUsd: 0
  fillSeconds: number
  router: string | null
  gasless: boolean
  signatureFeePayer: string | null
  transaction: string | null
  lastValidBlockHeight: string | null
}

const big = (v: unknown): bigint | null => { try { return /^[0-9]+$/.test(String(v)) ? BigInt(String(v)) : null } catch { return null } }
const mintOf = (m: string) => (m === SOL_NATIVE ? WSOL : m)

/** The site's path for an order. */
export function jupOrderPath(a: JupAsk, referral: string | null = JUP_REFERRAL, feeBps: number = JUP_FEE_BPS): string {
  const q = new URLSearchParams({ inputMint: mintOf(a.inputMint), outputMint: mintOf(a.outputMint), amount: a.amount.toString(), swapMode: 'ExactIn' })
  if (a.taker) q.set('taker', a.taker)
  if (a.slippageBps !== undefined) q.set('slippageBps', String(a.slippageBps))
  if (referral) { q.set('referralAccount', referral); q.set('referralFee', String(feeBps)) }
  return `/jup/swap/v2/order?${q}`
}

/** Jupiter's reasons a built order has no transaction, in words a trader can act on. */
function orderErrorText(router: string, code: number, message: string): string {
  if (router === 'jupiterz') {
    if (code === 1) return T('Not enough balance for this trade.')
    if (code === 2) return T('A token account this trade needs is missing: try again in a moment.')
  } else {
    if (code === 1) return T('Not enough balance for this trade.')
    if (code === 2) return T('Not enough SOL for fees on Solana: add SOL first.')
    if (code === 3) return T('This amount is below what Jupiter can route: try a little more.')
  }
  return message ? message.slice(0, 200) : T('Jupiter couldn’t build this trade: try again.')
}

/** The order Jupiter answered, checked against what was asked. Throws JupiterError when it isn't that trade. */
export function checkJupOrder(raw: unknown, a: JupAsk, referral: string | null = JUP_REFERRAL, feeBps: number = JUP_FEE_BPS): JupOrder {
  const fail = (why: string): never => { throw new JupiterError(T('ARCDEX refused this quote: {why}.', { why })) }
  if (!raw || typeof raw !== 'object') fail(T('Jupiter’s answer was empty'))
  const o = raw as Record<string, unknown>
  if (typeof o.error === 'string' && !o.requestId) throw new JupiterError(o.error.slice(0, 200))
  if (o.inputMint !== mintOf(a.inputMint) || o.outputMint !== mintOf(a.outputMint)) fail(T('it trades other tokens'))
  if (big(o.inAmount) !== a.amount) fail(T('it spends another amount'))
  if (o.swapMode !== undefined && o.swapMode !== 'ExactIn') fail(T('it isn’t an exact-in swap'))
  const out = big(o.outAmount), min = big(o.otherAmountThreshold)
  if (out === null || min === null) fail(T('it names no amount out'))
  const minWhy = minOutProblem(out!, min!, a.slippageBps ?? GUARDRAILS.maxSlippageBps)
  if (minWhy) throw new JupiterError(minWhy)
  if (typeof o.requestId !== 'string' || !o.requestId) fail(T('it has no request id'))
  // The taker: the wallet that signs, or none for a quote.
  const tx = typeof o.transaction === 'string' ? o.transaction : null
  if (a.taker) {
    if (o.taker !== a.taker) fail(T('it’s for another wallet'))
    if (!tx) throw new JupiterError(orderErrorText(String(o.router ?? ''), Number(o.errorCode ?? 0), String(o.errorMessage ?? o.error ?? '')))
  }
  // The fee: ARCDEX's referral account at ARCDEX's rate, or Jupiter's own fallback; never anyone else's referral.
  const ref = typeof o.referralAccount === 'string' ? o.referralAccount : null
  if (ref && ref !== referral) fail(T('it pays someone else’s referral account'))
  const total = Number(o.feeBps ?? 0)
  if (!(total >= 0) || total > feeBps + 100) fail(T('its fee is higher than shown'))
  const applied = !!referral && ref === referral && total >= feeBps
  const inUsd = Number(o.inUsdValue ?? 0) || 0
  const pi = Number(o.priceImpact)
  return {
    provider: 'jupiter',
    requestId: o.requestId as string,
    inputMint: o.inputMint as string,
    outputMint: o.outputMint as string,
    inputAmount: a.amount,
    expectedOut: out!,
    minOut: min!,
    outDecimals: a.outDecimals,
    slippageBps: Number(o.slippageBps ?? 0),
    // Jupiter's priceImpact is in percentage points, negative for a loss.
    impact: Number.isFinite(pi) ? Math.max(0, -pi / 100) : null,
    inUsd,
    outUsdRelay: Number(o.outUsdValue ?? 0) || 0,
    feeBps: total,
    arcdexFeeBps: applied ? feeBps : 0,
    feeMint: typeof o.feeMint === 'string' ? o.feeMint : null,
    appFeeUsd: applied ? (inUsd * feeBps) / 10_000 : 0,
    relayFeeUsd: 0,
    fillSeconds: 2,
    router: typeof o.router === 'string' ? o.router : null,
    gasless: o.gasless === true,
    signatureFeePayer: typeof o.signatureFeePayer === 'string' ? o.signatureFeePayer : null,
    transaction: tx,
    lastValidBlockHeight: typeof o.lastValidBlockHeight === 'string' ? o.lastValidBlockHeight : null,
  }
}

type Fetch = typeof fetch
/** One checked order. Throws JupiterUnavailable when the site's proxy can't serve it, so the form can ask Relay. */
export async function getJupOrder(a: JupAsk, f: Fetch = fetch): Promise<JupOrder> {
  let r: Response
  try {
    r = await f(jupOrderPath(a), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
  } catch { throw new JupiterUnavailable('Jupiter did not answer') }
  if (r.status === 503 || r.status === 429 || r.status === 502 || r.status === 404) throw new JupiterUnavailable(`Jupiter unavailable (${r.status})`)
  const body = await r.json().catch(() => null) as unknown
  // Not JSON: the site has no Jupiter route here (local dev, a page served in its place).
  if (body === null || typeof body !== 'object') throw new JupiterUnavailable(`Jupiter unavailable (not JSON, ${r.status})`)
  if (!r.ok) throw new JupiterError(String((body as { error?: string }).error ?? `Jupiter answered ${r.status}`).slice(0, 200))
  return checkJupOrder(body, a)
}

// ── The transaction ──────────────────────────────────────────────────────

export interface TxShape {
  /** Every account the transaction names (its own and those from lookup tables), in its order. */
  keys: string[]
  feePayer: string
  /** The accounts that must sign it. */
  signers: string[]
  instructions: { program: string; accounts: string[]; data: Uint8Array }[]
}

/** The accounts ARCDEX's referral fee can be paid into for `mint`: the referral account's token account under either
 * token program (Jupiter's V2 referral token accounts are associated token accounts of the referral account), and the
 * referral program's older account for it. */
export async function referralTokenAccounts(referral: string, mint: string): Promise<string[]> {
  const { PublicKey } = await import('@solana/web3.js')
  const ref = new PublicKey(referral), m = new PublicKey(mint)
  const pda = (seeds: Uint8Array[], program: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58()
  const ata = (tokenProgram: string) => pda([ref.toBytes(), new PublicKey(tokenProgram).toBytes(), m.toBytes()], JUP_PROGRAMS.ata)
  return [ata(JUP_PROGRAMS.token), ata(JUP_PROGRAMS.token2022), pda([Buffer.from('referral_ata'), ref.toBytes(), m.toBytes()], JUP_PROGRAMS.referral)]
}

/** SPL Token instructions that hand the taker's tokens to someone else: Approve, SetAuthority, ApproveChecked. */
const DELEGATING = new Set([4, 6, 13])

/** Why the transaction isn't the order's trade, or null. Pure: the caller resolves lookup tables (`shape`). */
export function txProblem(shape: TxShape, o: JupOrder, taker: string, feeAccounts: string[] | null): string | null {
  if (!shape.signers.includes(taker)) return T('the wallet isn’t asked to sign it')
  const payer = o.signatureFeePayer && o.signatureFeePayer !== taker ? o.signatureFeePayer : taker
  if (shape.feePayer !== payer) return T('someone else pays its fees')
  for (const ix of shape.instructions) {
    if ((ix.program === JUP_PROGRAMS.token || ix.program === JUP_PROGRAMS.token2022) && DELEGATING.has(ix.data[0] ?? -1)) {
      // Approve: [source, delegate, owner]; ApproveChecked: [source, mint, delegate, owner]; SetAuthority: [account, owner].
      const owner = ix.data[0] === 13 ? ix.accounts[3] : ix.data[0] === 4 ? ix.accounts[2] : ix.accounts[1]
      if (owner === taker) return T('it hands the wallet’s tokens to someone else')
    }
  }
  if (o.arcdexFeeBps > 0 && feeAccounts && !feeAccounts.some(a => shape.keys.includes(a))) return T('the fee in it isn’t ARCDEX’s')
  return null
}

/** The transaction's shape, with its lookup tables read from Solana. */
export async function txShape(tx: VersionedTransaction): Promise<TxShape> {
  const { Connection, PublicKey } = await import('@solana/web3.js')
  const msg = tx.message
  const lookups = 'addressTableLookups' in msg ? msg.addressTableLookups : []
  const statics = msg.staticAccountKeys.map((k: PublicKeyT) => k.toBase58())
  const writable: string[] = [], readonly: string[] = []
  if (lookups.length) {
    const conn = new Connection(primaryOf('sol').url, 'confirmed')
    for (const l of lookups) {
      const t = (await conn.getAddressLookupTable(new PublicKey(l.accountKey))).value
      if (!t) throw new JupiterError(T('Jupiter’s transaction names a table Solana doesn’t have: try again.'))
      for (const i of l.writableIndexes) writable.push(t.state.addresses[i].toBase58())
      for (const i of l.readonlyIndexes) readonly.push(t.state.addresses[i].toBase58())
    }
  }
  const keys = [...statics, ...writable, ...readonly]
  return {
    keys,
    feePayer: statics[0],
    signers: statics.slice(0, msg.header.numRequiredSignatures),
    instructions: msg.compiledInstructions.map(ix => ({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map(i => keys[i]), data: ix.data })),
  }
}

// ── The simulation ───────────────────────────────────────────────────────

/** A token account's balance from its base64 data (the amount is a u64 at byte 64, under both token programs). */
export function tokenAmount(dataB64: string | null | undefined): bigint {
  if (!dataB64) return 0n
  const b = Buffer.from(dataB64, 'base64')
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n
}

interface SimAccount { lamports: number; data: [string, string] | string[] }
export interface SimInputs { before: (SimAccount | null)[]; after: (SimAccount | null)[]; err: unknown; logs: string[] }

/** Why the simulated balances aren't the order's trade, or null. Accounts: [taker, input ATAs (both programs), output
 * ATAs (both programs)]. */
export function simProblem(s: SimInputs, o: JupOrder): string | null {
  if (s.err) {
    const log = s.logs.filter(l => /Error|failed|insufficient|slippage/i.test(l)).slice(-1)[0] ?? JSON.stringify(s.err)
    return T('The trade would fail: {why}', { why: log.slice(0, 160) })
  }
  const lam = (i: number, a: (SimAccount | null)[]) => BigInt(a[i]?.lamports ?? 0)
  const tok = (i: number, a: (SimAccount | null)[]) => tokenAmount(a[i]?.data?.[0])
  const solIn = o.inputMint === WSOL, solOut = o.outputMint === WSOL
  const lamDrop = lam(0, s.before) - lam(0, s.after)
  if (solIn) {
    if (lamDrop > o.inputAmount + MAX_SOL_COST) return T('This trade would cost more SOL than it should, so ARCDEX won’t send it.')
  } else {
    const inDrop = tok(1, s.before) + tok(2, s.before) - tok(1, s.after) - tok(2, s.after)
    if (inDrop > o.inputAmount) return T('This trade would take more than the amount shown, so ARCDEX won’t send it.')
    if (!solOut && lamDrop > MAX_SOL_COST) return T('This trade would cost more SOL than it should, so ARCDEX won’t send it.')
  }
  const gained = solOut ? -lamDrop + MAX_SOL_COST : tok(3, s.after) + tok(4, s.after) - tok(3, s.before) - tok(4, s.before)
  if (gained < o.minOut) return T('This trade would deliver less than its minimum, so ARCDEX won’t send it.')
  return null
}

/** The accounts the simulation watches, in simProblem's order. */
export async function watchedAccounts(taker: string, o: JupOrder): Promise<string[]> {
  const { PublicKey } = await import('@solana/web3.js')
  const t = new PublicKey(taker)
  const ata = (mint: string, program: string) => PublicKey.findProgramAddressSync([t.toBytes(), new PublicKey(program).toBytes(), new PublicKey(mint).toBytes()], new PublicKey(JUP_PROGRAMS.ata))[0].toBase58()
  const both = (mint: string) => [ata(mint, JUP_PROGRAMS.token), ata(mint, JUP_PROGRAMS.token2022)]
  return [taker, ...both(o.inputMint), ...both(o.outputMint)]
}

async function simulate(tx: VersionedTransaction, taker: string, o: JupOrder): Promise<void> {
  const addresses = await watchedAccounts(taker, o)
  const pre = await solRpc<{ value: (SimAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])
  const sim = await solRpc<{ value: { err: unknown; logs: string[] | null; accounts: (SimAccount | null)[] | null } }>('simulateTransaction', [
    Buffer.from(tx.serialize()).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } },
  ])
  const why = simProblem({ before: pre.value, after: sim.value.accounts ?? [], err: sim.value.err, logs: sim.value.logs ?? [] }, o)
  if (why) throw new JupiterError(why)
}

// ── Sending ──────────────────────────────────────────────────────────────

export type JupStep = 'quote' | 'sign' | 'send' | 'done'
export interface JupResult { order: JupOrder; signature: string; outAmount: bigint | null }

/** Jupiter's /execute codes, in words. */
export function executeErrorText(code: number, error: string): string {
  if (code === -1 || code === -1004 || code === -1005 || code === -2003) return T('The quote expired before it landed: try again.')
  if (code === -1000 || code === -2000) return T('The trade didn’t land on Solana: try again.')
  if (code === -2004) return T('The market maker rejected the trade: try again for another route.')
  if (code === -2 || code === -3 || code === -1002 || code === -1003 || code === -2002) return T('The signed transaction wasn’t accepted: try again.')
  return error ? error.slice(0, 200) : T('Jupiter couldn’t complete the trade: try again.')
}

/** Posts the signed transaction; a lost answer is sent again (the same transaction and request id never run twice). */
export async function executeOrder(signedB64: string, o: JupOrder, f: Fetch = fetch): Promise<{ signature: string; outAmount: bigint | null }> {
  const body = JSON.stringify({ signedTransaction: signedB64, requestId: o.requestId })
  let last: unknown = null
  for (let i = 0; i < 4; i++) {
    try {
      const r = await f('/jup/swap/v2/execute', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body, signal: AbortSignal.timeout(60_000) })
      const j = await r.json().catch(() => null) as { status?: string; signature?: string; code?: number; error?: string; totalOutputAmount?: string } | null
      if (r.status === 429 || r.status >= 500) { last = new JupiterError(j?.error ?? `Jupiter answered ${r.status}`); await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue }
      if (j?.status === 'Success' && j.signature) return { signature: j.signature, outAmount: big(j.totalOutputAmount) }
      throw new JupiterError(executeErrorText(Number(j?.code ?? 0), String(j?.error ?? '')))
    } catch (e) {
      if (e instanceof JupiterError) throw e
      last = e
      await new Promise(res => setTimeout(res, 1500 * (i + 1)))
    }
  }
  throw last instanceof Error ? last : new JupiterError(T('Jupiter couldn’t complete the trade: try again.'))
}

/** A swap on Solana through Jupiter, signed by `signer` (the trading wallet's Solana key or the wallet app). */
export async function runJupiter(signer: SolSigner, a: JupAsk & { taker: string }, shown: JupOrder | null, onStep: (s: JupStep, sig?: string) => void, inputUsd?: number | null): Promise<JupResult> {
  await assertTradingOn('solana')
  const tooBig = sizeProblem(inputUsd)
  if (tooBig) throw new JupiterError(tooBig)
  onStep('quote')
  const o = await getJupOrder(a)
  const drift = shown ? driftProblem(shown.expectedOut, o.expectedOut) : null
  if (drift === 'worse') throw new JupiterError(T('The price moved since your quote: check the new quote and try again.'))
  if (drift === 'changed') throw new JupiterError(T('Jupiter’s route changed since your quote: check the new quote and try again.'))
  const { VersionedTransaction } = await import('@solana/web3.js')
  const tx = VersionedTransaction.deserialize(Buffer.from(o.transaction!, 'base64'))
  const feeAccounts = o.arcdexFeeBps > 0 && o.feeMint && JUP_REFERRAL ? await referralTokenAccounts(JUP_REFERRAL, o.feeMint) : null
  const why = txProblem(await txShape(tx), o, a.taker, feeAccounts)
  if (why) throw new JupiterError(T('ARCDEX refused this transaction: {why}.', { why }))
  await simulate(tx, a.taker, o)
  onStep('sign')
  const signed = await signSolana(signer, tx)
  onStep('send')
  const res = await executeOrder(Buffer.from(signed.serialize()).toString('base64'), o)
  if (o.outputMint !== WSOL) rememberSol(a.taker, o.outputMint)
  notifyBalances()
  onStep('done', res.signature)
  return { order: o, signature: res.signature, outAmount: res.outAmount }
}
