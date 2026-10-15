// The ExecutionProvider interface (the build pack's Phase 2): every trade goes intent → quote → checks → simulate →
// sign → submit → record, through a provider that owns those steps for its venue. A provider's quote is always checked
// against what was asked before anyone signs, and its execute() runs the guardrails (lib/guardrails.ts) and the trade
// switch (lib/tradeSwitch.ts) before the signature.
//
// Providers and their venues (each one's own file has the details; lib/routes.ts lists the routes for /routes):
//   arc-router   Arc          ARCDEX swap router (Uniswap v4 and v3)    fee on-chain in the router (feeBps)
//   arc-curve    Arc          ARCDEX curve router (Mercuri, SolonPad)   fee on-chain in the router
//   arc-ur       Arc          Uniswap Universal Router (native pools)   fee paid in the same transaction
//   jupiter      Solana       Jupiter Swap API V2 (lib/jupiter.ts)      Jupiter referral fee, paid in the transaction
//   relay        Solana, BNB  Relay (lib/relay.ts)                      Relay app fee, accrues at Relay
//   across       Robinhood    Across (lib/across.ts)                    Across app fee, paid in the fill
//   four-meme    BNB          four.meme's own contract (lib/fourMeme.ts) no ARCDEX fee
//   avnu         Starknet     AVNU (starknet/avnu.ts)                   AVNU integrator fee, in the transaction
//   hyperliquid  Hyperliquid  Hyperliquid (hl/exec.ts)                  builder fee
//
// Solana swaps (SOL or Solana USDC in or out) pick their provider here: Jupiter first, with ARCDEX's fee paid in the
// transaction; Relay when the site doesn't serve Jupiter (no key, throttled, down) or VITE_FLAG_JUPITER is off.

import { flag } from './flags'
import { getJupOrder, runJupiter, JupiterUnavailable, type JupOrder, type JupStep } from './jupiter'
import { getRelayQuote, type RelayQuote, type RelayRequest } from './relayQuote'
import { runRelaySolana, type RelayProgress } from './relay'
import type { SolSigner } from './solanaWallet'
import type { TradeVenue } from '../../../api/_marketProtocol'

export type ProviderId = 'arc-router' | 'arc-curve' | 'arc-ur' | 'jupiter' | 'relay' | 'across' | 'four-meme' | 'avnu' | 'hyperliquid'

/** What every provider's quote carries, whatever else it has. */
export interface ExecQuote {
  inputAmount: bigint
  expectedOut: bigint
  /** The least the trade may deliver: enforced on-chain, the trade reverts below it. */
  minOut: bigint
  outDecimals: number
}

export interface ExecResult { tx: string; outAmount: bigint | null }

export interface ExecutionProvider<Ask, Q extends ExecQuote, Signer, Step> {
  id: ProviderId
  venue: TradeVenue
  /** A checked quote for `ask`; throws when the provider's answer isn't the trade asked for. */
  quote(ask: Ask): Promise<Q>
  /** Re-quotes, runs the guardrails and the simulation, has `signer` sign, submits and waits for it. */
  execute(signer: Signer, ask: Ask, shown: Q, onStep: (s: Step) => void): Promise<ExecResult>
}

// ── Solana swaps ─────────────────────────────────────────────────────────

/** A swap on Solana alone: SOL or Solana USDC for a coin, or back. */
export interface SolSwapAsk {
  relay: RelayRequest & { side: 'swap' }
  outDecimals: number
  /** The trader's Solana wallet; null for a quote shown before one is connected. */
  taker: string | null
  /** What goes in, in dollars (for the size cap); null when not known. */
  inputUsd: number | null
}
export type SolSwapQuote = (RelayQuote & { provider?: undefined }) | JupOrder
export type SolSwapStep = RelayProgress['step'] | JupStep

const jupAsk = (a: SolSwapAsk) => ({ inputMint: a.relay.inToken!, outputMint: a.relay.outToken!, amount: a.relay.amount, taker: a.taker, outDecimals: a.outDecimals })

export const jupiterProvider: ExecutionProvider<SolSwapAsk, JupOrder, SolSigner, SolSwapStep> = {
  id: 'jupiter',
  venue: 'solana',
  quote: a => getJupOrder(jupAsk(a)),
  async execute(signer, a, shown, onStep) {
    if (!a.taker) throw new Error('Connect a Solana wallet first')
    const r = await runJupiter(signer, { ...jupAsk(a), taker: a.taker }, shown, s => onStep(s), a.inputUsd)
    return { tx: r.signature, outAmount: r.outAmount }
  },
}

export const relaySolanaProvider: ExecutionProvider<SolSwapAsk, RelayQuote, SolSigner, SolSwapStep> = {
  id: 'relay',
  venue: 'solana',
  quote: a => getRelayQuote(a.relay),
  async execute(signer, a, shown, onStep) {
    const r = await runRelaySolana(signer, a.relay, shown, p => onStep(p.step))
    return { tx: r.tx, outAmount: r.quote.expectedOut }
  },
}

/** Jupiter answered that it can't serve: Relay quotes until this time. */
let jupiterDownUntil = 0
export const jupiterOn = (now = Date.now()) => flag('jupiter') && now >= jupiterDownUntil

export const isJupiterQuote = (q: SolSwapQuote | null | undefined): q is JupOrder => !!q && (q as JupOrder).provider === 'jupiter'

/** The provider a Solana swap's quote came from. */
export const providerOf = (q: SolSwapQuote) => (isJupiterQuote(q) ? jupiterProvider : relaySolanaProvider)

/** A quote for a Solana swap: Jupiter's when the site serves it, else Relay's. */
export async function quoteSolanaSwap(a: SolSwapAsk): Promise<SolSwapQuote> {
  if (jupiterOn()) {
    try {
      return await jupiterProvider.quote(a)
    } catch (e) {
      if (!(e instanceof JupiterUnavailable)) throw e
      jupiterDownUntil = Date.now() + 5 * 60_000
    }
  }
  return relaySolanaProvider.quote(a)
}

/** Runs a Solana swap through the provider its quote came from. */
export function executeSolanaSwap(signer: SolSigner, a: SolSwapAsk, shown: SolSwapQuote, onStep: (s: SolSwapStep) => void): Promise<ExecResult> {
  return isJupiterQuote(shown) ? jupiterProvider.execute(signer, a, shown, onStep) : relaySolanaProvider.execute(signer, a, shown, onStep)
}
