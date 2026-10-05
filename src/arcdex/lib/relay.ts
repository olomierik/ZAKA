// Sending a Solana or BNB Chain trade through Relay (quotes and their checks: lib/relayQuote.ts).
//
// Paid on Arc (a buy, or a gas top-up): a fresh checked quote → an approval of exactly the amount to Relay's depository,
// if the allowance is short → a fresh quote again → the deposit simulated from the trader → sent → mined → Relay's
// delivery, followed until it lands or is refunded. Signed by the trading wallet (no pop-ups) or the connected wallet.
//
// Signed on BNB Chain (a sale to Arc, or a swap there; 2026-10-05): the same, on BNB Chain, with Relay's router or its
// approval proxy (an ERC-20 is approved for exactly the amount, to the proxy), BNB paying the gas.
//
// From a Solana wallet to Arc, BNB Chain or Robinhood Chain (`xin`, 2026-10-05): signed on Solana like a sale, the coin
// delivered to the trader's EVM account. Back (`xout`): signed by that account on its chain, like a BNB Chain sale, SOL
// or USDC paid to the Solana wallet.
//
// Signed on Solana (a sale to Arc, or a swap there): a fresh checked quote → its instructions built into one Solana
// transaction (with Relay's lookup tables and a recent blockhash) → simulated: it must succeed and cost the trader no
// more SOL than it puts in plus a trade's fees → signed by the trading wallet's Solana key or the Solana wallet app →
// sent → confirmed → Relay's delivery.

import { erc20Abi, type Address, type Hash } from 'viem'
import type { VersionedTransaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { client as arcClient } from '../api/launchpad'
import { evmApprove, evmMined, evmReader, evmSend } from './across'
import { waitForAllowance } from './rpc'
import { notifyBalances } from './balances'
import type { TraderKind } from './identity'
import { getRelayQuote, relayStatus, RelayError, ARC_ID, BSC_ID, RH_ID, SOL_NATIVE, QUOTE_LIMITS, type RelayQuote, type RelayRequest, type RelayStatus } from './relayQuote'
import { signSolana, type SolSigner } from './solanaWallet'
import { solBalance, waitSolTx, rememberSol } from './solana'
import { rememberBsc } from './bsc'
import { rememberHolding } from './held'
import { rememberRh } from './robinhood'
import { SOL_RPC_BROWSER } from '../../../api/_solCore'
import { t as T } from './i18n'

export { RelayError }

export type RelayStep = 'quote' | 'approve' | 'sign' | 'send' | 'deliver' | 'done'
export interface RelayProgress { step: RelayStep; tx?: string; outTx?: string | null }
export interface RelayResult { quote: RelayQuote; tx: string; status: RelayStatus; outTx: string | null }

/** How far the price may move between the quote shown and the one signed. */
const DRIFT = 0.03
/** The most SOL a Solana trade may cost beyond the SOL it puts in (fees, and a token account now and then). */
const MAX_SOL_COST = 0.01

export function relayErrorText(e: unknown): string {
  if (e instanceof RelayError) return e.message
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  if (/User rejected|rejected the request|denied|cancel/i.test(m)) return T('You cancelled the transaction.')
  if (/insufficient lamports|Attempt to debit an account but found no record of a prior credit|insufficient funds for fee/i.test(m)) return T('Not enough SOL for fees on Solana: add SOL first.')
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(m)) return T('Not enough gas for this trade on its chain (USDC on Arc, BNB on BNB Chain, ETH on Robinhood Chain): add some first.')
  return m.slice(0, 220)
}

async function freshQuote(req: RelayRequest, shown: RelayQuote | null): Promise<RelayQuote> {
  const q = await getRelayQuote(req)
  if (shown && Number(q.expectedOut) < Number(shown.expectedOut) * (1 - DRIFT)) throw new RelayError(T('The price moved since your quote: check the new quote and try again.'))
  if (shown && Number(q.expectedOut) > Number(shown.expectedOut) * (1 + QUOTE_LIMITS.offMarket)) throw new RelayError(T('Relay’s route changed since your quote: check the new quote and try again.'))
  return q
}

async function follow(q: RelayQuote, tx: string, onStep: (p: RelayProgress) => void): Promise<RelayResult> {
  onStep({ step: 'deliver', tx })
  const until = Date.now() + 15 * 60_000
  for (let i = 0; ; i++) {
    const s = await relayStatus(q.id).catch(() => null)
    if (s && s.status !== 'pending') {
      notifyBalances()
      if (s.status === 'filled') onStep({ step: 'done', tx, outTx: s.outTx })
      return { quote: q, tx, status: s.status, outTx: s.outTx }
    }
    if (Date.now() > until) return { quote: q, tx, status: 'pending', outTx: null }
    await new Promise(r => setTimeout(r, i < 30 ? 1_500 : 6_000))
  }
}

/** A trade signed on an EVM chain: paid on Arc (a buy or gas top-up), on BNB Chain (a sale to Arc, or a swap there), or
 * from the trader's account on Arc, BNB Chain or Robinhood Chain to a Solana wallet (xout). */
export async function runRelayEvm(kind: TraderKind, req: RelayRequest, shown: RelayQuote | null, onStep: (p: RelayProgress) => void): Promise<RelayResult> {
  const trader = req.evm as Address
  onStep({ step: 'quote' })
  let q = await freshQuote(req, shown)
  const chainId = q.signChain
  if (chainId !== ARC_ID && chainId !== BSC_ID && chainId !== RH_ID) throw new RelayError(T('An unexpected chain to sign on.'))
  const reader = evmReader(chainId)
  // What goes in, and who must be allowed to take it, as the checked quote says (Relay's depository for Arc's USDC, its
  // approval proxy for any other token; native coins go with the call, no approval).
  const need = q.evmTx?.approve
  if (need) {
    const allowance = await reader.readContract({ address: need.token as Address, abi: erc20Abi, functionName: 'allowance', args: [trader, need.spender as Address] }).catch(() => 0n)
    if (allowance < need.amount) {
      const approveTx = await evmApprove(kind, chainId, need.token as Address, need.spender as Address, need.amount)
      onStep({ step: 'approve', tx: approveTx })
      await evmMined(chainId, approveTx)
      await waitForAllowance(reader, need.token as Address, trader, need.spender as Address, need.amount)
      q = await freshQuote(req, shown)
    }
  }
  const call = q.evmTx!.call
  try { await reader.call({ account: trader, to: call.to, data: call.data, value: call.value }) }
  catch (e) { throw new RelayError(T('The trade would fail: {why}', { why: relayErrorText(e) })) }
  const est = await reader.estimateGas({ account: trader, to: call.to, data: call.data, value: call.value }).catch(() => null)
  const tx: Hash = await evmSend(kind, chainId, { to: call.to, data: call.data, value: call.value, gas: est ? (est * 13n) / 10n : undefined })
  onStep({ step: 'send', tx })
  await evmMined(chainId, tx)
  notifyBalances()
  if (req.side === 'buy' && req.chain === 'bsc') rememberBsc(req.evm, req.mint)
  if (req.side === 'buy' && (req.chain ?? 'solana') === 'solana') rememberSol(req.sol, req.mint)
  if (req.side === 'swap' && req.chain === 'bsc' && req.outToken) rememberBsc(req.evm, req.outToken)
  return follow(q, tx, onStep)
}

/** Kept for the Solana form: a buy or gas top-up paid on Arc. */
export const runRelayBuy = runRelayEvm

/** Relay's instructions as one transaction, paid for by the trader. */
async function buildSolana(q: RelayQuote): Promise<VersionedTransaction> {
  const { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js')
  const conn = new Connection(SOL_RPC_BROWSER, 'confirmed')
  const tables = (await Promise.all(q.solTx!.lookupTables.map(a => conn.getAddressLookupTable(new PublicKey(a)).then(r => r.value))))
  if (tables.some(t => !t)) throw new RelayError(T('Relay’s transaction couldn’t be built: try again.'))
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const instructions = q.solTx!.instructions.map(i => new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(i.data, 'hex'),
  }))
  const msg = new TransactionMessage({ payerKey: new PublicKey(q.sol), recentBlockhash: blockhash, instructions }).compileToV0Message(tables.filter(t => t !== null))
  return new VersionedTransaction(msg)
}

/** The trade run on Solana's node first: it must succeed, and cost the trader no more SOL than `maxSol`. */
async function simulateSolana(tx: VersionedTransaction, trader: string, maxSol: number): Promise<void> {
  const { Connection } = await import('@solana/web3.js')
  const conn = new Connection(SOL_RPC_BROWSER, 'confirmed')
  const before = await solBalance(trader).catch(() => null)
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [trader] } })
  if (sim.value.err) {
    const log = (sim.value.logs ?? []).filter(l => /Error|failed|insufficient/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err)
    throw new RelayError(T('The trade would fail: {why}', { why: relayErrorText(new Error(log)) }))
  }
  const after = sim.value.accounts?.[0]?.lamports
  if (before !== null && typeof after === 'number' && before - after / 1e9 > maxSol) throw new RelayError(T('This trade would cost more SOL than it should, so ARCDEX won’t send it.'))
}

/** A trade signed on Solana by `signer` (the trading wallet or the Solana wallet app): a sale to Arc, a swap there, or
 * SOL or USDC into another chain's coin (xin). */
export async function runRelaySolana(signer: SolSigner, req: RelayRequest, shown: RelayQuote | null, onStep: (p: RelayProgress) => void): Promise<RelayResult> {
  const solIn = (req.side === 'swap' || req.side === 'xin') && req.inToken === SOL_NATIVE ? Number(req.amount) / 1e9 : 0
  const sol = await solBalance(req.sol).catch(() => null)
  if (sol !== null && sol < solIn + 0.0003) throw new RelayError(T('Not enough SOL for this trade and its fees.'))
  onStep({ step: 'quote' })
  const q = await freshQuote(req, shown)
  const tx = await buildSolana(q)
  await simulateSolana(tx, req.sol, solIn + MAX_SOL_COST)
  onStep({ step: 'sign' })
  const signed = await signSolana(signer, tx)
  const { Connection } = await import('@solana/web3.js')
  const conn = new Connection(SOL_RPC_BROWSER, 'confirmed')
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 })
  onStep({ step: 'send', tx: sig })
  const s = await waitSolTx(sig)
  if (s === 'failed') throw new RelayError(T('The transaction failed on-chain.'))
  if (req.side === 'swap' && req.outToken && req.outToken !== SOL_NATIVE) rememberSol(req.sol, req.outToken)
  // A coin bought on another chain: Portfolio checks it first.
  if (req.side === 'xin') {
    if (req.evmChain === BSC_ID) rememberBsc(req.evm, req.mint)
    else if (req.evmChain === RH_ID) rememberRh(req.evm, req.mint)
    else rememberHolding(req.evm, req.mint)
  }
  return follow(q, sig, onStep)
}

/** Kept for the Solana form: a sale to Arc. */
export const runRelaySell = runRelaySolana
