// Copy trading's client (the build pack's Phase 7; the engine side is engine/src/copy). Reads of my copy wallet and
// every change go through the engine with the wallet's session (api/social.ts signs in first when there's none);
// accepting the terms and withdrawing also need the wallet's signature of exactly that action.

import {
  COPY_TERMS_VERSION, copyTermsMessage, copyWithdrawMessage,
  type CopyExecutionV, type CopyLeaderV, type CopyMe, type CopySafety, type CopyStats,
} from '../../../api/_copyProtocol'
import type { Trader } from '../lib/identity'
import { authedRequest, sessionToken, signIn } from './social'
import { engineApiUrl } from './marketStream'

export interface CopyStatusV { on: boolean; why: string | null; terms: number; feeBps: number | null; limits: Record<string, number>; stats: CopyStats }
export interface CopyMeV extends CopyMe { inFlight: { id: string; leader: string; token: string; side: 'buy' | 'sell'; at: number }[] }
export interface RuleInput { leader: string; maxPerTradeUsd: number; slippageBps: number; safety: CopySafety; enabled: boolean }

async function get<T>(path: string, token?: string | null): Promise<T | null> {
  if (!engineApiUrl) return null
  try {
    const r = await fetch(`${engineApiUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) })
    if (r.status === 401) throw Object.assign(new Error('signed out'), { signedOut: true })
    return r.ok ? await r.json() as T : null
  } catch (e) {
    if ((e as { signedOut?: boolean }).signedOut) throw e
    return null
  }
}

export const copyAvailable = () => !!engineApiUrl
export const getCopyStatus = () => get<CopyStatusV>('/v1/copy/status')
export const getCopyLeaders = async (limit = 50) => (await get<{ leaders: CopyLeaderV[] }>(`/v1/copy/leaders?limit=${limit}`))?.leaders ?? null

/** My copy wallet, rules and copies. Null when signed out (no session on this device): `signInForCopy` first. */
export async function getCopyMe(address: string | null): Promise<CopyMeV | null> {
  const token = sessionToken(address)
  if (!token) return null
  try { return await get<CopyMeV>('/v1/copy/me', token) } catch { return null }
}
export const signInForCopy = (trader: Trader) => signIn(trader)

export async function getDestinations(trader: Trader): Promise<{ address: string; usd: number | null }[]> {
  const token = sessionToken(trader.address) ?? await signIn(trader)
  return (await get<{ destinations: { address: string; usd: number | null }[] }>('/v1/copy/destinations', token))?.destinations ?? []
}

const post = <T>(trader: Trader, path: string, body: Record<string, unknown>) => authedRequest<T>(trader, path, JSON.stringify(body), 'application/json')

/** Accepts the terms with the wallet's signature: the engine makes the copy wallet (or keeps it, for a new version). */
export async function openCopyWallet(trader: Trader): Promise<CopyMe> {
  if (!trader.address) throw new Error('Connect or unlock a wallet first')
  const at = Date.now()
  const signature = await trader.signMessage(copyTermsMessage(trader.address, COPY_TERMS_VERSION, at))
  return post<CopyMe>(trader, '/v1/copy/open', { at, signature })
}
export const saveRule = (trader: Trader, r: RuleInput) => post<CopyMe>(trader, '/v1/copy/rules', { ...r })
export const deleteRule = (trader: Trader, id: string) => post<CopyMe>(trader, '/v1/copy/rules/delete', { id })
/** The stop switch: every rule paused (or resumed) at once. */
export const setCopyStopped = (trader: Trader, stopped: boolean) => post<CopyMe>(trader, '/v1/copy/stop', { stopped })

/** Sends USDC out of the copy wallet to `to` (me, or a wallet that funded it), signed by the wallet. */
export async function withdrawCopy(trader: Trader, to: string, amountUsd: number): Promise<{ hash: string; me: CopyMe }> {
  if (!trader.address) throw new Error('Connect or unlock a wallet first')
  const at = Date.now()
  const amount = Math.floor(amountUsd * 100) / 100
  const signature = await trader.signMessage(copyWithdrawMessage(trader.address, to, amount, at))
  return post(trader, '/v1/copy/withdraw', { to, amountUsd: amount, at, signature })
}

export type { CopyExecutionV, CopyLeaderV, CopyMe }
