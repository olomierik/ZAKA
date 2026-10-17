// Practice predictions on /predict: the client for the engine's practice book (engine/src/practice/predict.ts).
//
// The account lives on the engine, which fills every order at the mid it reads from Hyperliquid and settles from
// Hyperliquid's own result. This browser keeps only the account's key (arcdex:practice-key); without it the account
// can't be reached, so "Start practising" makes a new one.

import { useCallback, useEffect, useState } from 'react'
import { engineApiUrl } from '../api/marketStream'
import type { BoardPeriod, PracticeBoard, PracticeFill, PracticeSide, PracticeView } from '../../../api/_practiceProtocol'

export { PRACTICE, cleanPracticeName } from '../../../api/_practiceProtocol'
export type { BoardPeriod, PracticeBoard, PracticeFill, PracticeView, PracticeTrade, PracticeSpec } from '../../../api/_practiceProtocol'

const KEY = 'arcdex:practice-key'
export const PRACTICE_EVENT = 'arcdex:practice'

export const practiceAvailable = !!engineApiUrl

function readKey(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}
function writeKey(k: string | null) {
  try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY) } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(PRACTICE_EVENT))
}

export class PracticeError extends Error {}

async function call<T>(path: string, init: RequestInit & { key?: string | null } = {}): Promise<T> {
  if (!engineApiUrl) throw new PracticeError('Practice isn’t available on this build.')
  const res = await fetch(`${engineApiUrl}/v1/practice/predict/${path}`, {
    ...init,
    // text/plain for posts: the engine checks the page's origin; the key is the only custom header.
    headers: { ...(init.method === 'POST' ? { 'Content-Type': 'text/plain' } : {}), ...(init.key ? { 'X-Practice-Key': init.key } : {}) },
    signal: AbortSignal.timeout(12_000),
  })
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null
  if (!res.ok || !body) {
    if (res.status === 404 && path === 'account') writeKey(null)
    throw new PracticeError(body?.error ?? `The engine answered ${res.status}`)
  }
  return body
}

export async function startPractice(name?: string): Promise<PracticeView> {
  const r = await call<{ key: string; account: PracticeView }>('accounts', { method: 'POST', body: JSON.stringify({ name: name ?? null }) })
  writeKey(r.key)
  return r.account
}

const act = <T,>(body: Record<string, unknown>) => {
  const key = readKey()
  if (!key) throw new PracticeError('Start practising first.')
  return call<T>('account', { method: 'POST', key, body: JSON.stringify(body) })
}
export const practiceBuy = (outcome: number, side: PracticeSide, usd: number) => act<{ fill: PracticeFill; account: PracticeView }>({ action: 'buy', outcome, side, usd })
export const practiceSell = (outcome: number, side: PracticeSide, fraction: number) => act<{ fill: PracticeFill; account: PracticeView }>({ action: 'sell', outcome, side, fraction })
export const practiceReset = (start: number) => act<PracticeView>({ action: 'reset', start })
export const practiceRename = (name: string) => act<PracticeView>({ action: 'rename', name })

/** The practice account (null before "Start practising"), read every 5 seconds while the tab is visible. */
export function usePracticeAccount(): { account: PracticeView | null; hasKey: boolean; error: string | null; set: (v: PracticeView) => void; refresh: () => void } {
  const [account, setAccount] = useState<PracticeView | null>(null)
  const [hasKey, setHasKey] = useState(() => !!readKey())
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    const key = readKey()
    setHasKey(!!key)
    if (!key) { setAccount(null); return }
    call<PracticeView>('account', { key }).then(v => { setAccount(v); setError(null) }, e => { setError((e as Error).message); if (!readKey()) { setHasKey(false); setAccount(null) } })
  }, [])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 5_000)
    window.addEventListener(PRACTICE_EVENT, refresh)
    return () => { clearInterval(id); window.removeEventListener(PRACTICE_EVENT, refresh) }
  }, [refresh])
  return { account, hasKey, error, set: setAccount, refresh }
}

/** The leaderboard for a window, read every 10 seconds while shown. */
export function usePracticeBoard(period: BoardPeriod, on = true): { board: PracticeBoard | null; error: string | null } {
  const [board, setBoard] = useState<PracticeBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!on || !engineApiUrl) return
    let live = true
    const load = () => call<PracticeBoard>(`board?period=${period}`).then(b => { if (live) { setBoard(b); setError(null) } }, e => { if (live) setError((e as Error).message) })
    void load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 10_000)
    return () => { live = false; clearInterval(id) }
  }, [period, on])
  return { board, error }
}
