// The brain: Claude Opus 5.5 for the slow, deep calls (ANTHROPIC_API_KEY on the engine; without it
// the code decides alone and says so).
//
//   escalate  an open position the reflex stopped backing (confidence under 0.60, the direction
//             flipped, volatility spiked): hold or close, with why. It can't open, add or move a
//             limit; a crisis is closed by code before it is asked.
//   review    the nightly review: what worked and what didn't from the day's fills and misses and
//             the calibration, and at most three bounded changes to the reflex's tuning. Each one
//             ships only if a replay shows it does better (review.ts); gates and risk limits are
//             never among them.
//
// Answers come back as typed JSON (structured outputs), checked against their schema.

import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import type { AlgoCalibration, AlgoStats, AlgoTrade } from '../../../api/_algoProtocol'
import { errMsg, log } from '../log'

export const BRAIN_MODEL = 'claude-opus-5-5'

const EscalationAnswer = z.object({
  action: z.enum(['hold', 'close']),
  why: z.string(),
})

const ReviewAnswer = z.object({
  summary: z.string(),
  lessons: z.array(z.string()),
  proposals: z.array(z.object({ param: z.string(), to: z.number(), why: z.string() })),
})

export type ReviewAnswer = z.infer<typeof ReviewAnswer>

export interface EscalationInput {
  snapshot: string
  trade: AlgoTrade
  trigger: string
  decision: string
}

export interface ReviewInput {
  day: string
  stats: AlgoStats
  calibration: AlgoCalibration
  trades: AlgoTrade[]
  decisions: number
  setups: number
  gateFailures: Record<string, number>
  missedWinners: number
  tunables: { param: string; value: number; min: number; max: number; meaning: string }[]
}

const SYSTEM = `You are the slow, careful layer of ARCDEX Algo, an automated futures agent trading BTC, ETH and SOL perpetuals with test USDC on Arc testnet. A deterministic reflex scores every one-minute candle; code owns every gate, size and risk limit. You are asked only when judgement helps: re-reading a position the reflex stopped backing, or reviewing a day.

Be skeptical and plain. Prefer closing a position whose thesis is gone over hoping. Never invent data: work only from the numbers given. Snapshot fields: r5m..r24h are % returns; rv1h/rv24h % volatility a minute; vr their ratio; trend is the 5-minute EMA20−EMA60 gap in hourly sigmas; z1h the distance from the hour's mean in hourly sigmas; jump the last minute in one-minute sigmas; rng24 the place in the day's range (0 low, 1 high); ref1h the reference major's hour; sigH the volatility over the hold time; inv the position (side:unrealized%:age); dd the drawdown and day the day's P&L, %.`

export class Brain {
  private client: Anthropic | null
  readonly model = BRAIN_MODEL
  calls = 0
  errors = 0
  lastError: string | null = null

  constructor(apiKey: string | null | undefined) {
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) : null
  }

  get enabled() { return this.client !== null }

  private async ask<T extends z.ZodType>(schema: T, prompt: string, effort: 'medium' | 'high'): Promise<{ answer: z.infer<T>; model: string } | null> {
    if (!this.client) return null
    this.calls++
    try {
      const r = await this.client.beta.messages.parse({
        model: BRAIN_MODEL,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        output_config: { effort, format: betaZodOutputFormat(schema) },
        messages: [{ role: 'user', content: prompt }],
      })
      if (r.stop_reason === 'refusal' || !r.parsed_output) {
        this.errors++
        this.lastError = r.stop_reason === 'refusal' ? 'the model declined' : `no parsed answer (${r.stop_reason})`
        return null
      }
      return { answer: r.parsed_output as z.infer<T>, model: r.model }
    } catch (e) {
      this.errors++
      if (e instanceof Anthropic.RateLimitError) this.lastError = 'rate limited'
      else if (e instanceof Anthropic.AuthenticationError) this.lastError = 'the API key was refused'
      else if (e instanceof Anthropic.APIConnectionError) this.lastError = 'could not reach the API'
      else if (e instanceof Anthropic.APIError) this.lastError = `API error ${e.status}`
      else this.lastError = errMsg(e)
      log.warn('algo brain: call failed', { error: this.lastError })
      return null
    }
  }

  /** Hold or close an open position. null when the brain can't answer (the code then closes). */
  async escalate(i: EscalationInput): Promise<{ action: 'hold' | 'close'; why: string; by: string } | null> {
    const t = i.trade
    const prompt = `An open ${t.side} position in ${t.market} lost the reflex's support: ${i.trigger}.

Position: entry ${t.entry}, take-profit ${t.tp.toFixed(4)}, stop-loss ${t.sl.toFixed(4)} (both on-chain), size $${t.sizeUsd.toFixed(2)} at ${t.leverage}x, opened ${new Date(t.openedAt).toISOString()} with calibrated confidence ${t.confidence.toFixed(3)} in a ${t.regime} regime.
The reflex now says: ${i.decision}
State now: ${i.snapshot}

Answer hold (the thesis still stands; the stop protects the downside) or close (the thesis is gone, or the risk is no longer worth it), with one or two sentences of why.`
    const r = await this.ask(EscalationAnswer, prompt, 'high')
    return r ? { ...r.answer, by: r.model } : null
  }

  /** The nightly review's notes and proposed tuning changes. null without a brain. */
  async review(i: ReviewInput): Promise<(ReviewAnswer & { by: string }) | null> {
    const trades = i.trades.slice(-30).map(t => `${t.market} ${t.side} ${t.regime} conf=${t.confidence.toFixed(2)} kelly=${t.kelly.toFixed(2)} pnl=$${(t.pnlUsd ?? 0).toFixed(2)} (${t.reason})${t.escalations.length ? ` escalated: ${t.escalations.map(e => `${e.trigger} → ${e.action}`).join('; ')}` : ''}`).join('\n') || 'none'
    const cal = i.calibration
    const prompt = `Review ${i.day} (UTC).

Results: ${i.stats.trades} trades, ${i.stats.wins} won, P&L $${i.stats.pnlUsd} (${i.stats.pnlPct}%), fees $${i.stats.feesUsd}, max drawdown ${i.stats.maxDrawdownPct}%.
Decisions: ${i.decisions}; setups that passed every gate: ${i.setups}; directional decisions that would have reached their target but were held back by a gate: ${i.missedWinners}.
Gate failures (decisions with a direction): ${Object.entries(i.gateFailures).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.
Calibration on the held-out day: Brier ${cal.brier ?? '-'} vs ${cal.brierBaseRate ?? '-'} for the base rate (skill ${cal.skill ?? '-'}), ECE ${cal.ece ?? '-'}, base rate ${cal.baseRate ?? '-'}, ${cal.nTest} test labels, ${cal.n} training labels.
Reliability (predicted → observed, n): ${cal.bins.map(b => `${b.predicted.toFixed(2)}→${b.observed.toFixed(2)} (${b.n})`).join(', ') || 'none'}.
Trades:
${trades}

Tunable settings (current, allowed range, meaning):
${i.tunables.map(t => `- ${t.param} = ${t.value} [${t.min}, ${t.max}]: ${t.meaning}`).join('\n')}

Write a short summary (3–5 sentences), up to five concrete lessons, and at most three proposals, each changing one tunable within its range with why. Propose nothing when the evidence is thin; every proposal is tested by a replay before it ships, and most should be rejected.`
    const r = await this.ask(ReviewAnswer, prompt, 'high')
    return r ? { ...r.answer, by: r.model } : null
  }
}
