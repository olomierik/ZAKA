// ARCDEX Algo's REST API (engine/src/algo/api.ts) for the Algo page on /autotrade.

import { algoControlMessage, type AlgoControl, type AlgoDecisionRow, type AlgoReview, type AlgoStatus, type AlgoTrade } from '../../../api/_algoProtocol'
import { engineApiUrl } from './marketStream'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${engineApiUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`the engine answered ${r.status}`)
  return r.json() as Promise<T>
}

export const getAlgoStatus = () => get<AlgoStatus>('/v1/algo/status')
export const getAlgoDecisions = (limit = 60, market: string | null = null) => get<{ decisions: AlgoDecisionRow[] }>(`/v1/algo/decisions?limit=${limit}${market ? `&market=${market}` : ''}`).then(r => r.decisions)
export const getAlgoTrades = (limit = 200) => get<{ trades: AlgoTrade[] }>(`/v1/algo/trades?limit=${limit}`).then(r => r.trades)
export const getAlgoReviews = (limit = 14) => get<{ reviews: AlgoReview[] }>(`/v1/algo/reviews?limit=${limit}`).then(r => r.reviews)

/** An owner's control, signed by the owner's wallet (the engine checks it against BOT_OWNER_ADDRESS). */
export async function sendAlgoControl(control: AlgoControl, sign: (message: string) => Promise<`0x${string}`>): Promise<AlgoStatus> {
  const at = Date.now()
  const signature = await sign(algoControlMessage(control, at))
  const res = await fetch(`${engineApiUrl}/v1/algo/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...control, at, signature }), signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({})) as { status?: AlgoStatus; error?: string }
  if (!res.ok || !body.status) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return body.status
}
