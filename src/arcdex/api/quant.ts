// The signal engine's REST API (engine/src/quant/api.ts) for the Signal engine dashboard on /autotrade.

import { quantControlMessage, type QuantControl, type QuantPosition, type QuantRadarRow, type QuantSignal, type QuantStatus, type QuantValidationRun, type QuantWallet } from '../../../api/_quantProtocol'
import { engineApiUrl } from './marketStream'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${engineApiUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`the engine answered ${r.status}`)
  return r.json() as Promise<T>
}

export const getQuantStatus = () => get<QuantStatus>('/v1/quant/status')
export const getQuantSignals = (limit = 100) => get<{ signals: QuantSignal[] }>(`/v1/quant/signals?limit=${limit}`).then(r => r.signals)
export const getQuantRadar = (limit = 100) => get<{ coins: QuantRadarRow[] }>(`/v1/quant/radar?limit=${limit}`).then(r => r.coins)
export const getQuantPositions = (mode: 'paper' | 'live', limit = 200) => get<{ positions: QuantPosition[] }>(`/v1/quant/positions?mode=${mode}&limit=${limit}`).then(r => r.positions)
export const getQuantWallets = () => get<{ summary: Record<string, number>; top: QuantWallet[] }>('/v1/quant/wallets?limit=25')
export const getQuantValidations = () => get<{ runs: QuantValidationRun[]; running: boolean }>('/v1/quant/validations?limit=5')

/** An owner's control, signed by the owner's wallet (the engine checks the signature against BOT_OWNER_ADDRESS). */
export async function sendQuantControl(control: QuantControl, sign: (message: string) => Promise<`0x${string}`>): Promise<QuantStatus> {
  const at = Date.now()
  const signature = await sign(quantControlMessage(control, at))
  const res = await fetch(`${engineApiUrl}/v1/quant/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...control, at, signature }), signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({})) as { status?: QuantStatus; error?: string }
  if (!res.ok || !body.status) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return body.status
}
