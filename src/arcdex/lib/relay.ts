// Sending a Solana trade through Relay (quotes and their checks: lib/relayQuote.ts).
//
// Buy (and gas): a fresh checked quote → an approval of exactly the amount to Relay's depository on Arc, if the
// allowance is short → a fresh quote again → the deposit simulated from the trader → sent → mined → Relay's delivery
// on Solana, followed until it lands or is refunded. Signed by the trading wallet (no pop-ups) or the connected wallet,
// as Robinhood Chain's buys are (lib/across.ts).
//
// Sale: a fresh checked quote → its instructions built into one Solana transaction (with Relay's lookup tables and a
// recent blockhash) → simulated: it must succeed and cost the seller no more than a sale's fees in SOL → signed by the
// trading wallet's Solana key or the Solana wallet app → sent → confirmed → Relay pays the USDC out on Arc.

import { erc20Abi, type Address, type Hash } from 'viem'
import type { VersionedTransaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { client as arcClient } from '../api/launchpad'
import { evmApprove, evmMined, evmSend } from './across'
import { waitForAllowance } from './rpc'
import { notifyBalances } from './balances'
import type { TraderKind } from './identity'
import { getRelayQuote, relayStatus, RelayError, RELAY_ARC_DEPOSITORY, QUOTE_LIMITS, type RelayQuote, type RelayRequest, type RelayStatus } from './relayQuote'
import { signSolana, type SolSigner } from './solanaWallet'
import { solBalance, waitSolTx, rememberSol } from './solana'
import { SOL_RPC_BROWSER } from '../../../api/_solCore'
import { ARC_USDC } from './acrossQuote'
import { t as T } from './i18n'

export { RelayError }

export type RelayStep = 'quote' | 'approve' | 'sign' | 'send' | 'deliver' | 'done'
export interface RelayProgress { step: RelayStep; tx?: string; outTx?: string | null }
export interface RelayResult { quote: RelayQuote; tx: string; status: RelayStatus; outTx: string | null }

/** How far the price may move between the quote shown and the one signed. */
const DRIFT = 0.03
/** The most SOL a sale may cost the seller beyond the coin (fees, and a USDC account if Relay's swap needs one). */
const MAX_SOL_COST = 0.01

export function relayErrorText(e: unknown): string {
  if (e instanceof RelayError) return e.message
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  if (/User rejected|rejected the request|denied|cancel/i.test(m)) return T('You cancelled the transaction.')
  if (/insufficient lamports|Attempt to debit an account but found no record of a prior credit|insufficient funds for fee/i.test(m)) return T('Not enough SOL for fees on Solana: add SOL first.')
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

/** A buy or gas top-up: signed on Arc. */
export async function runRelayBuy(kind: TraderKind, req: RelayRequest, shown: RelayQuote | null, onStep: (p: RelayProgress) => void): Promise<RelayResult> {
  const trader = req.evm as Address
  onStep({ step: 'quote' })
  let q = await freshQuote(req, shown)
  const allowance = await arcClient.readContract({ address: ARC_USDC as Address, abi: erc20Abi, functionName: 'allowance', args: [trader, RELAY_ARC_DEPOSITORY as Address] }).catch(() => 0n)
  if (allowance < req.amount) {
    const approveTx = await evmApprove(kind, 5042, ARC_USDC as Address, RELAY_ARC_DEPOSITORY as Address, req.amount)
    onStep({ step: 'approve', tx: approveTx })
    await evmMined(5042, approveTx)
    await waitForAllowance(arcClient, ARC_USDC as Address, trader, RELAY_ARC_DEPOSITORY as Address, req.amount)
    q = await freshQuote(req, shown)
  }
  const dep = q.evmTx!.deposit
  try { await arcClient.call({ account: trader, to: dep.to, data: dep.data, value: 0n }) }
  catch (e) { throw new RelayError(T('The trade would fail: {why}', { why: relayErrorText(e) })) }
  const est = await arcClient.estimateGas({ account: trader, to: dep.to, data: dep.data, value: 0n }).catch(() => null)
  const tx: Hash = await evmSend(kind, 5042, { to: dep.to, data: dep.data, gas: est ? (est * 13n) / 10n : undefined })
  onStep({ step: 'send', tx })
  await evmMined(5042, tx)
  notifyBalances()
  if (req.side === 'buy') rememberSol(req.sol, req.mint)
  return follow(q, tx, onStep)
}

/** Relay's instructions as one signed-ready transaction, paid for by the seller. */
async function buildSale(q: RelayQuote): Promise<VersionedTransaction> {
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

/** The sale run on Solana's own node first: it must succeed, and cost the seller no more than fees in SOL. */
async function simulateSale(tx: VersionedTransaction, seller: string): Promise<void> {
  const { Connection } = await import('@solana/web3.js')
  const conn = new Connection(SOL_RPC_BROWSER, 'confirmed')
  const before = await solBalance(seller).catch(() => null)
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [seller] } })
  if (sim.value.err) {
    const log = (sim.value.logs ?? []).filter(l => /Error|failed|insufficient/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err)
    throw new RelayError(T('The sale would fail: {why}', { why: relayErrorText(new Error(log)) }))
  }
  const after = sim.value.accounts?.[0]?.lamports
  if (before !== null && typeof after === 'number' && before - after / 1e9 > MAX_SOL_COST) throw new RelayError(T('This sale would cost more SOL than a sale’s fees, so ARCDEX won’t send it.'))
}

/** A sale: signed on Solana by `signer` (the trading wallet or the Solana wallet app). */
export async function runRelaySell(signer: SolSigner, req: RelayRequest, shown: RelayQuote | null, onStep: (p: RelayProgress) => void): Promise<RelayResult> {
  const sol = await solBalance(req.sol).catch(() => null)
  if (sol !== null && sol < 0.0003) throw new RelayError(T('Not enough SOL for fees on Solana: add SOL first.'))
  onStep({ step: 'quote' })
  const q = await freshQuote(req, shown)
  const tx = await buildSale(q)
  await simulateSale(tx, req.sol)
  onStep({ step: 'sign' })
  const signed = await signSolana(signer, tx)
  const { Connection } = await import('@solana/web3.js')
  const conn = new Connection(SOL_RPC_BROWSER, 'confirmed')
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 })
  onStep({ step: 'send', tx: sig })
  const s = await waitSolTx(sig)
  if (s === 'failed') throw new RelayError(T('The transaction failed on-chain.'))
  return follow(q, sig, onStep)
}

